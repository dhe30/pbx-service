import { describe, expect, it } from "vitest";
import { formToForward, forwardToForm, parseNumberList, toE164 } from "./extension-call-handling";

describe("toE164", () => {
  it("accepts the formats people type (spec §3 outgoing number formats)", () => {
    expect(toE164("(718) 820-6268")).toBe("+17188206268");
    expect(toE164("1 718 820 6268")).toBe("+17188206268");
    expect(toE164("+1 718.820.6268")).toBe("+17188206268");
    expect(toE164("011 44 20 7183 8750")).toBe("+442071838750");
    expect(toE164("+442071838750")).toBe("+442071838750");
  });

  it("rejects what is not a phone number", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("101")).toBeNull();
    expect(toE164("718-820-626")).toBeNull();
    expect(toE164("+0123456789")).toBeNull();
    expect(toE164("call me")).toBeNull();
  });
});

describe("parseNumberList", () => {
  it("splits on lines and commas, normalizes and drops duplicates", () => {
    expect(parseNumberList("(718) 820-6268\n+17188206268, 3472359959")).toEqual({
      numbers: ["+17188206268", "+13472359959"],
      invalid: [],
    });
  });

  it("reports the entries it can't read", () => {
    expect(parseNumberList("7188206268, 12345")).toEqual({ numbers: ["+17188206268"], invalid: ["12345"] });
  });
});

describe("forwarding form", () => {
  it("round-trips each kind of target", () => {
    for (const value of [
      { type: "extension" as const, id: "e1" },
      { type: "voicemail" as const, id: "m1" },
      { type: "external" as const, number: "+17188206268" },
    ]) {
      expect(formToForward(forwardToForm(value), "x")).toEqual({ value });
    }
    expect(formToForward(forwardToForm(null), "x")).toEqual({ value: null });
  });

  it("treats anything unexpected from the API as no forwarding", () => {
    expect(forwardToForm({ type: "ring_group", id: "g" })).toEqual({ kind: "none", targetId: "", number: "" });
    expect(forwardToForm("nonsense")).toEqual({ kind: "none", targetId: "", number: "" });
  });

  it("normalizes a typed number and explains a missing target", () => {
    expect(formToForward({ kind: "external", targetId: "", number: "(718) 820-6268" }, "Busy")).toEqual({
      value: { type: "external", number: "+17188206268" },
    });
    expect(formToForward({ kind: "extension", targetId: "", number: "" }, "Busy")).toEqual({
      error: "Busy: choose an extension.",
    });
    expect("error" in formToForward({ kind: "external", targetId: "", number: "12" }, "Busy")).toBe(true);
  });
});
