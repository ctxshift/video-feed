import { describe, expect, test } from "bun:test";

import { applyCorrections } from "../src/render";
import type { Correction, Segment } from "../src/types";

const seg = (start: number, text: string): Segment => ({ start, end: start + 1, text });
const corr = (was: string, now: string, confidence = "high"): Correction =>
  ({ t: "0:00", was, now, evidence: "test", confidence }) as Correction;
const texts = (r: { segments: Segment[] }) => r.segments.map((s) => s.text);

describe("applyCorrections", () => {
  test("replaces within a single segment", () => {
    const r = applyCorrections([seg(0, "activate the vent now")], [corr("the vent", "the venv")]);
    expect(texts(r)).toEqual(["activate the venv now"]);
  });

  // ASR splits on pauses, not on meaning, so a quoted phrase regularly
  // straddles a boundary. These were a fifth of all corrections on the first
  // real video tested, and were being dropped.
  test("replaces across two segments", () => {
    const r = applyCorrections(
      [seg(0, "so run git check"), seg(5, "windows main and then continue")],
      [corr("git check windows main", "git checkout windows-main")],
    );
    expect(texts(r)).toEqual(["so run git checkout windows-main", "and then continue"]);
  });

  test("replaces across three segments", () => {
    const r = applyCorrections(
      [seg(0, "type python minus"), seg(5, "m vent"), seg(9, "vent to begin")],
      [corr("python minus m vent vent", "python -m venv venv")],
    );
    expect(texts(r)).toEqual(["type python -m venv venv", "to begin"]);
  });

  test("skips a correction whose text is absent, changing nothing", () => {
    const r = applyCorrections([seg(0, "hello world")], [corr("nope", "yep")]);
    expect(texts(r)).toEqual(["hello world"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.applied).toHaveLength(0);
  });

  test("honours the confidence floor", () => {
    const r = applyCorrections([seg(0, "the vent")], [corr("the vent", "the venv", "low")], "medium");
    expect(texts(r)).toEqual(["the vent"]);
    expect(r.skipped).toHaveLength(1);
  });

  test("applies a repeated phrase once per correction", () => {
    const r = applyCorrections(
      [seg(0, "the vent here"), seg(5, "and the vent there")],
      [corr("the vent", "the venv"), corr("the vent", "the venv")],
    );
    expect(texts(r)).toEqual(["the venv here", "and the venv there"]);
  });

  test("does not mutate its input", () => {
    const original = [seg(0, "the vent")];
    applyCorrections(original, [corr("the vent", "the venv")]);
    expect(original[0]!.text).toBe("the vent");
  });
});
