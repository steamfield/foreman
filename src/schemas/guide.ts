import { Schema } from "effect";

export const GuideResult = Schema.Struct({
  topic: Schema.String,
  text: Schema.String,
  topics: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
});
