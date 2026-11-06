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
const ConfigFile = Schema.Struct({
  codexBin: Schema.optionalKey(CodexBin),
  logLevel: Schema.optionalKey(Level),
});
const configDiagnosis = (file: string, issue: SchemaIssue.Issue) => {
  const key = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues[0]?.path?.[0];
  let diagnosis = "Expected a JSON object with optional codexBin and logLevel fields.";
  if (key === "codexBin") diagnosis = "codexBin must be a nonempty executable name or path.";
  else if (key === "logLevel")
    diagnosis = `logLevel must be one of: ${Object.keys(levels).join(", ")}.`;
  else if (typeof key === "string")
    diagnosis = `Unknown key ${JSON.stringify(redactDiagnosticText(key))}. Allowed keys: codexBin, logLevel.`;
  return new InvalidConfig({
    detail: `${JSON.stringify(file)}: ${diagnosis} Update this file and retry.`,
  });
};
export type Settings = { codexBin: string };
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
    codexBin: string;
    codexHome: string;
    launcher: string | null;
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
        const userHome = yield* text("HOME", ".");
        const defaultHome = absolute(path.join(userHome, ".forman"));
        const home = absolute(yield* text("FORMAN_HOME", defaultHome));
        const configFile = path.join(home, "config.json");
        const environmentCodexBin = yield* text("CODEX_BIN");
        const codexHome = absolute(yield* text("CODEX_HOME", path.join(userHome, ".codex")));
        const launcherSetting = yield* read(
          Config.schema(CodexBin, "FORMAN_LAUNCHER").pipe(Config.withDefault("")),
        ).pipe(Effect.orDie);
        const launcher = launcherSetting === "" ? null : absolute(launcherSetting);
        const file = yield* Effect.cached(
          fs.readFileString(configFile).pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed("{}")
                : Effect.fail(
                    new PermissionDenied({
                      detail: `Cannot read config file ${JSON.stringify(configFile)}. Check its permissions and retry.`,
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
            return { codexBin: executablePath(environmentCodexBin || config.codexBin || "codex") };
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
          codexBin,
          codexHome,
          launcher,
          inheritedEnvironment: { ...env },
        };
      }),
    );
}
