import { Schema } from "effect";

export const DoctorResult = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  platform: Schema.String,
  compiled: Schema.Boolean,
  configFile: Schema.String,
  dataDir: Schema.String,
  greeting: Schema.NullOr(Schema.String),
  configError: Schema.NullOr(Schema.String),
  codexVersion: Schema.NullOr(Schema.String),
  protocolMatches: Schema.NullOr(Schema.Boolean),
  loggedIn: Schema.NullOr(Schema.Boolean),
  daemon: Schema.Union([
    Schema.Struct({ state: Schema.Literal("not running") }),
    Schema.Struct({ state: Schema.Literal("running"), version: Schema.String, pid: Schema.Int }),
  ]),
});
