// The project's Schema conventions as running checks: a branded id, a transformation that
// round-trips, a property over generated values, readable failures, a closed JSON Schema
// document and the Standard Schema adapter. Copy these patterns for new boundary schemas.
import { Arbitrary, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DaemonRequestBody, DaemonResult } from "../src/schemas/daemon";
import { Overview, SubAgentView } from "../src/schemas/monitor";

const OrderId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("OrderId"));

const Order = Schema.Struct({
  id: OrderId,
  quantity: Schema.Int.check(Schema.isGreaterThan(0)),
  placedAt: Schema.DateTimeUtcFromString,
  note: Schema.optionalKey(Schema.String),
}).annotate({ title: "Order", description: "An order as it crosses the API boundary" });
type Order = typeof Order.Type;

const decode = Schema.decodeUnknownSync(Order);
const encode = Schema.encodeSync(Order);

describe("Schema conventions", () => {
  it("round-trips Overview and ISO child timestamps through the daemon protocol", () => {
    const wire = {
      _tag: "Overview",
      version: 3,
      daemon: { version: "test", build: "test", startedAt: "2026-01-02T03:04:05.000Z" },
      runs: [],
    };
    expect(Schema.encodeSync(DaemonResult)(Schema.decodeUnknownSync(DaemonResult)(wire))).toEqual(
      wire,
    );
    const child = {
      threadId: "child",
      path: "/root/tests",
      model: null,
      effort: null,
      state: "working",
      startedAt: wire.daemon.startedAt,
      lastInteractionAt: wire.daemon.startedAt,
      interactions: 1,
    };
    expect(Schema.encodeSync(SubAgentView)(Schema.decodeUnknownSync(SubAgentView)(child))).toEqual(
      child,
    );
    expect(
      Schema.toJsonSchemaDocument(Overview, { onExcessProperty: "error" }).schema,
    ).toMatchObject({ additionalProperties: false });
  });

  it.each([0, 60001, 1.5])("rejects invalid Overview timeout %s", (timeoutMs) => {
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(DaemonRequestBody)({ _tag: "Overview", timeoutMs })),
    ).toBe(true);
  });

  it.each([1, 60000])("accepts bounded Overview timeout %s and integer versions", (timeoutMs) => {
    const request = { _tag: "Overview", timeoutMs, after: 2 };
    expect(
      Schema.encodeSync(DaemonRequestBody)(Schema.decodeUnknownSync(DaemonRequestBody)(request)),
    ).toEqual(request);
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(DaemonRequestBody)({ ...request, after: 0.5 })),
    ).toBe(true);
  });
  it("round-trips wire input: encode(decode(x)) equals x", () => {
    const wire = { id: "order-1", quantity: 2, placedAt: "2026-01-02T03:04:05.000Z" };
    const order: Order = decode(wire);
    expect(encode(order)).toEqual(wire);
  });

  it("round-trips every generated value", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(Arbitrary.schema(Order), (order) => {
        const wire = encode(order);
        return JSON.stringify(encode(decode(wire))) === JSON.stringify(wire);
      }),
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
  });

  it("names the failing field in a readable error", () => {
    const exit = Schema.decodeUnknownExit(Order)({
      id: "order-1",
      quantity: 0,
      placedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("quantity");
  });

  it("emits a closed JSON Schema document for tools", () => {
    const document = Schema.toJsonSchemaDocument(Order, { onExcessProperty: "error" });
    expect(document.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("adapts to Standard Schema for validation-only libraries", async () => {
    const standard = Schema.toStandardSchemaV1(Order);
    const result = await standard["~standard"].validate({ id: "", quantity: 1 });
    expect("issues" in result && result.issues !== undefined).toBe(true);
  });
});
