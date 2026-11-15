import { Schema } from "effect";

export const InstallMethod = Schema.Literals(["npm", "bun", "pnpm", "npx", "project", "source"]);

export const UpdateResult = Schema.Struct({
  current: Schema.String,
  latest: Schema.String,
  method: InstallMethod,
  action: Schema.Literals(["updated", "current", "available", "manual"]),
  // The install command foreman ran (updated) or would run (available); null when it can't update.
  command: Schema.NullOr(Schema.String),
});
