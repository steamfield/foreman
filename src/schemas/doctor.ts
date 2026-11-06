import { Schema } from "effect";

export const RepoHookTrust = Schema.Struct({
  state: Schema.Literals(["known", "unknown", "not applicable"]),
  mainCheckout: Schema.NullOr(Schema.String),
  hooks: Schema.Array(Schema.Struct({ key: Schema.String, status: Schema.String })),
  acceptsStart: Schema.NullOr(Schema.Boolean),
  detail: Schema.NullOr(Schema.String),
});

export const DoctorResult = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  platform: Schema.String,
  compiled: Schema.Boolean,
  formanOnPath: Schema.Boolean,
  configFile: Schema.String,
  dataDir: Schema.String,
  codexBin: Schema.String,
  configError: Schema.NullOr(Schema.String),
  codexVersion: Schema.NullOr(Schema.String),
  protocolMatches: Schema.NullOr(Schema.Boolean),
  loggedIn: Schema.NullOr(Schema.Boolean),
  repoHooks: RepoHookTrust,
  daemon: Schema.Union([
    Schema.Struct({ state: Schema.Literal("not running") }),
    Schema.Struct({
      state: Schema.Literal("running"),
      version: Schema.String,
      pid: Schema.Int,
      build: Schema.NullOr(Schema.String),
      buildMatches: Schema.NullOr(Schema.Boolean),
    }),
  ]),
});
