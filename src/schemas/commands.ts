import { Schema } from "effect";

export const DurationText = Schema.String.check(Schema.isPattern(/^\d+(ms|s|m|h)$/));
export const Milliseconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const EventSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const EventLimit = Schema.Int.check(Schema.isGreaterThan(0));
