// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MANUAL_REFERENCE_PATTERN } from "@commonair/contracts/currency";
import { describe, expect, test } from "vite-plus/test";
import { manualReference, normalizeManualReference } from "../src/reference.ts";

describe("manualReference", () => {
  test("matches the contract pattern", () => {
    for (let i = 0; i < 200; i++) expect(manualReference()).toMatch(MANUAL_REFERENCE_PATTERN);
  });
  test("encodes 40 bits big-endian in Crockford base32", () => {
    expect(manualReference(() => new Uint8Array(5))).toBe("CA-00000000");
    expect(manualReference(() => new Uint8Array([255, 255, 255, 255, 255]))).toBe("CA-ZZZZZZZZ");
    expect(manualReference(() => new Uint8Array([0, 0, 0, 0, 1]))).toBe("CA-00000001");
    expect(manualReference(() => new Uint8Array([0, 0, 0, 0, 32]))).toBe("CA-00000010");
  });
  test("refuses a short random source", () => {
    expect(() => manualReference(() => new Uint8Array(4))).toThrow(RangeError);
  });
});

describe("normalizeManualReference", () => {
  test("accepts what people type", () => {
    expect(normalizeManualReference("CA-7K3Q9P2M")).toBe("CA-7K3Q9P2M");
    expect(normalizeManualReference(" ca-7k3q 9p2m ")).toBe("CA-7K3Q9P2M");
    expect(normalizeManualReference("7K3Q9P2M")).toBe("CA-7K3Q9P2M");
    expect(normalizeManualReference("CA-OI1L0000")).toBe("CA-01110000");
  });
  test("rejects anything else", () => {
    expect(normalizeManualReference("")).toBeNull();
    expect(normalizeManualReference("CA-7K3Q9P2")).toBeNull();
    expect(normalizeManualReference("CA-7K3Q9P2MX")).toBeNull();
    expect(normalizeManualReference("CA-7K3Q9P2U")).toBeNull();
  });
});
