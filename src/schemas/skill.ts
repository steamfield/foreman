import { Schema } from "effect";

export const SkillResult = Schema.Struct({
  name: Schema.Literal("foreman"),
  path: Schema.NullOr(Schema.String),
  action: Schema.Literals(["written", "unchanged", "printed"]),
  text: Schema.optionalKey(Schema.String),
});
