// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The P2P device policy (ADR 0005 amendment 1, decision 3): every branch. */
import { describe, expect, it } from "vite-plus/test";
import {
  deviceSignals,
  noticeDue,
  p2pAllowed,
  type P2PDefault,
  type P2PPolicyInput,
  type P2PPreference,
} from "../src/player/p2p/policy.ts";

const PREFS: P2PPreference[] = ["on", "off", null];
const DEFAULTS: P2PDefault[] = ["off", "on"];
const BOOLS = [false, true];

function* allInputs(): Generator<P2PPolicyInput> {
  for (const preference of PREFS)
    for (const operatorDefault of DEFAULTS)
      for (const finePointer of BOOLS)
        for (const saveData of BOOLS)
          for (const cellular of BOOLS)
            for (const dataMode of BOOLS)
              for (const native of BOOLS)
                yield { preference, operatorDefault, finePointer, saveData, cellular, dataMode, native };
}

/** The rule written out independently of the implementation. */
function expected(i: P2PPolicyInput): boolean {
  if (i.native) return false;
  if (i.dataMode) return false;
  switch (i.preference) {
    case "off":
      return false;
    case "on":
      return true;
    case null:
      return i.operatorDefault === "on" && i.finePointer && !i.saveData && !i.cellular;
  }
}

describe("p2pAllowed", () => {
  const inputs = [...allInputs()];

  it("covers the whole matrix", () => {
    expect(inputs).toHaveLength(3 * 2 * 2 * 2 * 2 * 2 * 2);
  });

  it.each(inputs)("%o", (input) => {
    expect(p2pAllowed(input)).toBe(expected(input));
  });

  it("never allows P2P with the operator default off and no preference", () => {
    const hits = inputs.filter((i) => i.preference === null && i.operatorDefault === "off" && p2pAllowed(i));
    expect(hits).toEqual([]);
  });

  it("an explicit opt-in counts on a touch device on mobile data with save-data", () => {
    expect(
      p2pAllowed({
        preference: "on",
        operatorDefault: "off",
        finePointer: false,
        saveData: true,
        cellular: true,
        dataMode: false,
        native: false,
      }),
    ).toBe(true);
  });

  it("native HLS and data mode win over an opt-in", () => {
    const base = {
      preference: "on" as const,
      operatorDefault: "on" as const,
      finePointer: true,
      saveData: false,
      cellular: false,
    };
    expect(p2pAllowed({ ...base, dataMode: false, native: true })).toBe(false);
    expect(p2pAllowed({ ...base, dataMode: true, native: false })).toBe(false);
  });
});

describe("noticeDue", () => {
  const base: P2PPolicyInput = {
    preference: null,
    operatorDefault: "on",
    finePointer: true,
    saveData: false,
    cellular: false,
    dataMode: false,
    native: false,
  };

  it("is due only with the default on, no choice, not yet seen, and the device policy allowing", () => {
    expect(noticeDue({ ...base, noticeSeen: false })).toBe(true);
    expect(noticeDue({ ...base, noticeSeen: true })).toBe(false);
    expect(noticeDue({ ...base, operatorDefault: "off", noticeSeen: false })).toBe(false);
    expect(noticeDue({ ...base, preference: "on", noticeSeen: false })).toBe(false);
    expect(noticeDue({ ...base, preference: "off", noticeSeen: false })).toBe(false);
    expect(noticeDue({ ...base, finePointer: false, noticeSeen: false })).toBe(false);
    expect(noticeDue({ ...base, native: true, noticeSeen: false })).toBe(false);
  });

  it("never with the shipped default", () => {
    const due = [...allInputs()].filter((i) => i.operatorDefault === "off" && noticeDue({ ...i, noticeSeen: false }));
    expect(due).toEqual([]);
  });
});

describe("deviceSignals", () => {
  const media = (fine: boolean) => (q: string) => ({ matches: q === "(pointer: fine)" && fine });

  it("reads pointer, save-data and connection type", () => {
    expect(
      deviceSignals({ matchMedia: media(true), navigator: { connection: { saveData: true, type: "cellular" } } }),
    ).toEqual({ finePointer: true, saveData: true, cellular: true });
    expect(
      deviceSignals({ matchMedia: media(false), navigator: { connection: { saveData: false, type: "wifi" } } }),
    ).toEqual({ finePointer: false, saveData: false, cellular: false });
  });

  it("leaves the pointer test to decide without navigator.connection (Firefox, Safari)", () => {
    expect(deviceSignals({ matchMedia: media(true), navigator: {} })).toEqual({
      finePointer: true,
      saveData: false,
      cellular: false,
    });
    const allowed = p2pAllowed({
      ...deviceSignals({ matchMedia: media(true), navigator: {} }),
      preference: null,
      operatorDefault: "on",
      dataMode: false,
      native: false,
    });
    expect(allowed).toBe(true);
  });

  it("treats a missing or throwing matchMedia as a coarse pointer", () => {
    expect(deviceSignals({ navigator: {} }).finePointer).toBe(false);
    expect(
      deviceSignals({
        matchMedia: () => {
          throw new Error("no");
        },
      }).finePointer,
    ).toBe(false);
  });

  it("only a literal true save-data and a literal cellular type count", () => {
    expect(
      deviceSignals({ matchMedia: media(true), navigator: { connection: { saveData: "yes", type: "CELLULAR" } } }),
    ).toEqual({ finePointer: true, saveData: false, cellular: false });
  });
});
