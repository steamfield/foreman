import { Schema } from "effect";

export const RepoHookTrust = Schema.Struct({
  state: Schema.Literals(["known", "unknown", "not applicable"]),
  mainCheckout: Schema.NullOr(Schema.String),
  hooks: Schema.Array(Schema.Struct({ key: Schema.String, status: Schema.String })),
  acceptsStart: Schema.NullOr(Schema.Boolean),
  detail: Schema.NullOr(Schema.String),
});

/** What `foreman doctor` learned about agy; probes are null when agy isn't installed. */
export const AgyDoctor = Schema.Struct({
  installed: Schema.Boolean,
  bin: Schema.String,
  version: Schema.NullOr(Schema.String),
  signedIn: Schema.NullOr(Schema.Boolean),
  protocolMatches: Schema.NullOr(Schema.Boolean),
  agentVersion: Schema.NullOr(Schema.String),
  hookTrust: Schema.Literals(["accepted", "refused", "not applicable", "unknown"]),
  catalogSize: Schema.NullOr(Schema.Int),
  /** Each problem as what happened, why and the next step. */
  findings: Schema.Array(Schema.String),
});

export const DoctorResult = Schema.Struct({
  orphans: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ path: Schema.String, branch: Schema.String, holdsWork: Schema.Boolean }),
    ),
  ),
  orphanError: Schema.optionalKey(Schema.String),
  name: Schema.String,
  version: Schema.String,
  platform: Schema.String,
  compiled: Schema.Boolean,
  foremanOnPath: Schema.Boolean,
  configFile: Schema.String,
  home: Schema.String,
  homePermissions: Schema.Struct({
    state: Schema.Literals(["ok", "missing", "unsafe", "unusable", "unknown"]),
    path: Schema.String,
    detail: Schema.NullOr(Schema.String),
  }),
  codexBin: Schema.String,
  configError: Schema.NullOr(Schema.String),
  codexVersion: Schema.NullOr(Schema.String),
  protocolMatches: Schema.NullOr(Schema.Boolean),
  loggedIn: Schema.NullOr(Schema.Boolean),
  repoHooks: RepoHookTrust,
  agy: AgyDoctor,
  daemon: Schema.Union([
    Schema.Struct({ state: Schema.Literal("not running") }),
    Schema.Struct({ state: Schema.Literal("unavailable"), detail: Schema.String }),
    Schema.Struct({
      state: Schema.Literal("running"),
      version: Schema.String,
      pid: Schema.Int,
      build: Schema.NullOr(Schema.String),
      buildMatches: Schema.NullOr(Schema.Boolean),
    }),
  ]),
});
