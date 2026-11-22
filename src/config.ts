import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  SchemaIssue,
} from "effect";
import { InvalidConfig, PermissionDenied } from "./errors";
import { redactDiagnosticText } from "./logging";
import { Host } from "./services/host";

export const levels = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "None",
} as const;
const Level = Schema.Literals(["trace", "debug", "info", "warn", "error", "fatal", "none"]);
const CodexBin = Schema.String.check(Schema.isPattern(/\S/));
const DefaultModel = Schema.String.check(Schema.isPattern(/\S/));
const ConfigFile = Schema.Struct({
  codexBin: Schema.optionalKey(CodexBin),
  agyBin: Schema.optionalKey(CodexBin),
  defaultModel: Schema.optionalKey(DefaultModel),
  logLevel: Schema.optionalKey(Level),
});
const configDiagnosis = (file: string, issue: SchemaIssue.Issue) => {
  const key = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues[0]?.path?.[0];
  let diagnosis =
    "Expected a JSON object with optional codexBin, agyBin, defaultModel and logLevel fields.";
  if (key === "codexBin") diagnosis = "codexBin must be a nonempty executable name or path.";
  else if (key === "agyBin") diagnosis = "agyBin must be a nonempty executable name or path.";
  else if (key === "defaultModel") diagnosis = "defaultModel must be a nonempty model name.";
  else if (key === "logLevel")
    diagnosis = `logLevel must be one of: ${Object.keys(levels).join(", ")}.`;
  else if (typeof key === "string")
    diagnosis = `Unknown key ${JSON.stringify(redactDiagnosticText(key))}. Allowed keys: codexBin, agyBin, defaultModel, logLevel.`;
  return new InvalidConfig({
    detail: `${JSON.stringify(file)}: ${diagnosis} Update this file and retry.`,
  });
};
export type Settings = { codexBin: string; agyBin: string; defaultModel: string | null };
export type LogSettings = {
  level: (typeof levels)[keyof typeof levels];
  format: "json" | "pretty";
  file: string;
};

export class AppConfig extends Context.Service<
  AppConfig,
  {
    load: Effect.Effect<Settings, InvalidConfig | PermissionDenied>;
    logging: Effect.Effect<LogSettings>;
    configFile: string;
    home: string;
    defaultHome: string;
    userHome: string | null;
    codexBin: string;
    agyBin: string;
    defaultModel: string | null;
    codexHome: string;
    launcher: string | null;
    inDelegate: boolean;
    inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  }
>()("app/AppConfig") {
  static layer = (env: Readonly<Record<string, string | undefined>>) =>
    Layer.effect(
      AppConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = path.resolve(".");
        const absolute = (value: string) => path.resolve(cwd, value);
        const executablePath = (value: string) =>
          value.includes("/") || value.includes(path.sep) ? absolute(value) : value;
        const host = yield* Host;
        const prefix = host.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        const provider = ConfigProvider.fromEnvRecord(
          Object.fromEntries(
            Object.entries(env).map(([key, value]) => [key, value?.trim() ? value : undefined]),
          ),
        );
        const read = <A>(config: Config.Config<A>) =>
          config.pipe(Effect.provide(ConfigProvider.layer(provider)));
        const text = (key: string, fallback = "") =>
          read(Config.String(key).pipe(Config.withDefault(fallback))).pipe(Effect.orDie);
        const homeSetting = yield* text("HOME");
        const userHome = homeSetting === "" ? null : absolute(homeSetting);
        const defaultHome = absolute(path.join(userHome ?? ".", ".foreman"));
        const home = absolute(yield* text("FOREMAN_HOME", defaultHome));
        const configFile = path.join(home, "config.json");
        const environmentCodexBin = yield* text("CODEX_BIN");
        const environmentAgyBin = yield* text("AGY_BIN");
        const codexHome = absolute(yield* text("CODEX_HOME", path.join(userHome ?? ".", ".codex")));
        const launcherSetting = yield* read(
          Config.schema(CodexBin, "FOREMAN_LAUNCHER").pipe(Config.withDefault("")),
        ).pipe(Effect.orDie);
        const launcher = launcherSetting === "" ? null : absolute(launcherSetting);
        const file = yield* Effect.cached(
          fs.readFileString(configFile).pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed("{}")
                : Effect.fail(
                    error.reason._tag === "PermissionDenied"
                      ? new PermissionDenied({
                          detail: `Cannot read config file ${JSON.stringify(configFile)}. Check its permissions and retry.`,
                        })
                      : new InvalidConfig({
                          detail: `Cannot read config file ${JSON.stringify(configFile)} (${error.reason._tag}). Choose a readable JSON file for this path and retry.`,
                        }),
                  ),
            ),
            Effect.flatMap((content) =>
              Effect.try({
                try: () => JSON.parse(content) as unknown,
                catch: () =>
                  new InvalidConfig({
                    detail: `${JSON.stringify(configFile)}: Invalid JSON. Correct the JSON syntax and retry.`,
                  }),
              }),
            ),
          ),
        );
        const load = yield* Effect.cached(
          Effect.gen(function* () {
            const config = yield* file.pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(ConfigFile)(value, { onExcessProperty: "error" }).pipe(
                  Effect.mapError((error) => configDiagnosis(configFile, error.issue)),
                ),
              ),
            );
            return {
              codexBin: executablePath(environmentCodexBin || config.codexBin || "codex"),
              agyBin: executablePath(environmentAgyBin || config.agyBin || "agy"),
              defaultModel: config.defaultModel ?? null,
            };
          }),
        );
        const codexBin = yield* file.pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Schema.Struct({ codexBin: Schema.optionalKey(CodexBin) }))(
              value,
            ),
          ),
          Effect.map((settings) =>
            executablePath(environmentCodexBin || settings.codexBin || "codex"),
          ),
          Effect.orElseSucceed(() => executablePath(environmentCodexBin || "codex")),
        );
        // Like codexBin above: a bad config file is reported by `load`, not here. Each key is
        // decoded on its own so an invalid one cannot discard the other.
        const fileAgyBin = yield* file.pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Schema.Struct({ agyBin: Schema.optionalKey(CodexBin) }))(
              value,
            ),
          ),
          Effect.map((settings) => settings.agyBin),
          Effect.orElseSucceed(() => undefined),
        );
        const fileDefaultModel = yield* file.pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({ defaultModel: Schema.optionalKey(DefaultModel) }),
            )(value),
          ),
          Effect.map((settings) => settings.defaultModel),
          Effect.orElseSucceed(() => undefined),
        );
        const agyBin = executablePath(environmentAgyBin || fileAgyBin || "agy");
        const defaultModel = fileDefaultModel ?? null;
        const logging = Effect.gen(function* () {
          const config = yield* file.pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(Schema.Struct({ logLevel: Schema.optionalKey(Level) }))(
                value,
              ),
            ),
            Effect.catch(() => Effect.succeed({ logLevel: undefined })),
          );
          const raw = (yield* text("LOG_LEVEL", config.logLevel ?? "warn")).toLowerCase();
          const level = yield* Schema.decodeUnknownEffect(Level)(raw).pipe(
            Effect.orElseSucceed(() => "warn" as const),
          );
          const format = yield* text(`${prefix}_LOG_FORMAT`);
          const logFile = yield* text(`${prefix}_LOG_FILE`);
          return {
            level: levels[level],
            format: format === "json" ? ("json" as const) : ("pretty" as const),
            file: logFile === "" ? "" : absolute(logFile),
          };
        });
        return {
          load,
          logging,
          configFile,
          home,
          defaultHome,
          userHome,
          codexBin,
          agyBin,
          defaultModel,
          codexHome,
          launcher,
          inDelegate:
            (yield* text("CODEX_DELEGATE")) !== "" || (yield* text("AGY_DELEGATE")) !== "",
          inheritedEnvironment: { ...env },
        };
      }),
    );
}
