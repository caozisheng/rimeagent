import { describe, expect, test } from "bun:test";
import { canonicalJson, cloneJson, isJsonValue } from "../../src/store/json";
import type { JsonValue } from "../../src/store/json";

describe("strict JSON helpers", () => {
  test("sort object keys recursively while preserving array order", () => {
    const value = { z: [{ b: 2, a: 1 }], "10": "ten", "2": "two" };
    expect(canonicalJson(value)).toBe('{"10":"ten","2":"two","z":[{"a":1,"b":2}]}');
  });

  test("clones JSON values and omits undefined object fields", () => {
    const value = { keep: [1, null, "x"], omit: undefined, nested: { omit: undefined, yes: true } };
    const copy = cloneJson<JsonValue>(value);
    expect(copy).toEqual({ keep: [1, null, "x"], nested: { yes: true } });
    expect(copy).not.toBe(value);
    expect((copy as typeof value).keep).not.toBe(value.keep);
  });

  test("accepts duplicate references but rejects cycles and sparse arrays", () => {
    const shared = { value: 1 };
    expect(isJsonValue({ first: shared, second: shared })).toBe(true);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isJsonValue(cycle)).toBe(false);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(isJsonValue(sparse)).toBe(false);
  });

  test("rejects nonfinite, exotic, accessor, and toJSON values without invoking user code", () => {
    expect(isJsonValue(NaN)).toBe(false);
    expect(isJsonValue(Infinity)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue(1n)).toBe(false);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { throw new Error("must not run"); } });
    expect(isJsonValue(accessor)).toBe(false);
    const toJson = { toJSON() { throw new Error("must not run"); } };
    expect(isJsonValue(toJson)).toBe(false);
    expect(() => cloneJson(toJson)).toThrow();
  });

  test("throws for unsupported values and preserves stable canonical output", () => {
    expect(() => canonicalJson({ value: undefined })).not.toThrow();
    expect(() => canonicalJson({ value: () => 1 })).toThrow();
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
