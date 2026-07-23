import { describe, it, expect } from "vitest";
import {
  methodToPolicy,
  parseOrderMethod,
  resolveForecastKnobs,
  policyForClass,
  METHOD_DEFAULTS,
  ORDER_METHODS,
} from "../src/config";
import { SERVICE_Z_DEFAULTS } from "../src/baseline";
import { DEFAULT_CAP_MULTIPLE } from "../src/layered";

describe("methodToPolicy", () => {
  it("stay_in_stock → calibrated cover at 95%", () => {
    expect(methodToPolicy("stay_in_stock")).toEqual({ serviceLevel: 0.95, rule: "calibrated" });
  });

  it("balanced → calibrated cover at 90%", () => {
    expect(methodToPolicy("balanced")).toEqual({ serviceLevel: 0.90, rule: "calibrated" });
  });

  it("lean_cash → min/max, no cover quantile", () => {
    expect(methodToPolicy("lean_cash")).toEqual({ serviceLevel: null, rule: "min_max" });
  });

  it("stay_in_stock services higher than balanced", () => {
    const stay = methodToPolicy("stay_in_stock").serviceLevel!;
    const balanced = methodToPolicy("balanced").serviceLevel!;
    expect(stay).toBeGreaterThan(balanced);
  });
});

describe("recommended defaults", () => {
  it("A stays in stock, B balanced, C leans on cash", () => {
    expect(METHOD_DEFAULTS).toEqual({ A: "stay_in_stock", B: "balanced", C: "lean_cash" });
  });

  it("every default is a valid method", () => {
    for (const m of Object.values(METHOD_DEFAULTS)) expect(ORDER_METHODS).toContain(m);
  });
});

describe("parseOrderMethod", () => {
  it("accepts stored method strings", () => {
    expect(parseOrderMethod("balanced")).toBe("balanced");
  });
  it("rejects garbage/null as null (use default)", () => {
    expect(parseOrderMethod("aggressive")).toBeNull();
    expect(parseOrderMethod(null)).toBeNull();
    expect(parseOrderMethod(undefined)).toBeNull();
    expect(parseOrderMethod("")).toBeNull();
  });
});

describe("resolveForecastKnobs", () => {
  it("no config row → pure code defaults", () => {
    const knobs = resolveForecastKnobs(null);
    expect(knobs.serviceZ).toEqual(SERVICE_Z_DEFAULTS);
    expect(knobs.capMultiple).toBe(DEFAULT_CAP_MULTIPLE);
    expect(knobs.methods).toEqual(METHOD_DEFAULTS);
  });

  it("tenant overrides win field by field; nulls mean default", () => {
    const knobs = resolveForecastKnobs({
      serviceLevelZA: 3.0,
      serviceLevelZB: null,
      orderCapMultiple: 5,
      methodA: "lean_cash",
      methodB: "not-a-method",
      methodC: null,
    });
    expect(knobs.serviceZ.A).toBe(3.0);
    expect(knobs.serviceZ.B).toBe(SERVICE_Z_DEFAULTS.B);
    expect(knobs.serviceZ.C).toBe(SERVICE_Z_DEFAULTS.C);
    expect(knobs.capMultiple).toBe(5);
    expect(knobs.methods.A).toBe("lean_cash");
    expect(knobs.methods.B).toBe(METHOD_DEFAULTS.B); // invalid string → default
    expect(knobs.methods.C).toBe(METHOD_DEFAULTS.C);
  });
});

describe("policyForClass", () => {
  const methods = resolveForecastKnobs(null).methods;

  it("maps a product's class through the resolved methods", () => {
    expect(policyForClass(methods, "A")).toEqual(methodToPolicy("stay_in_stock"));
    expect(policyForClass(methods, "C")).toEqual(methodToPolicy("lean_cash"));
  });

  it("unclassified products take the C policy", () => {
    expect(policyForClass(methods, null)).toEqual(methodToPolicy(METHOD_DEFAULTS.C));
    expect(policyForClass(methods, "X")).toEqual(methodToPolicy(METHOD_DEFAULTS.C));
  });
});
