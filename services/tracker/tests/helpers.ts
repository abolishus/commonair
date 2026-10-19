// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A 20-character binary id whose bytes are all `byte` (or a fixed latin1 pattern). */
export const id = (byte: number): string => String.fromCharCode(...Array<number>(20).fill(byte));

/** Ids that exercise the whole 0–255 range, as real SHA-1 info hashes do. */
export const binaryId = (seed: number): string =>
  String.fromCharCode(...Array.from({ length: 20 }, (_, i) => (seed * 31 + i * 97) % 256));

export const offerSdp = (n = 0) => ({ type: "offer", sdp: `v=0\r\no=- ${n} 2 IN IP4 127.0.0.1\r\n` });
export const answerSdp = { type: "answer", sdp: "v=0\r\no=- 9 2 IN IP4 127.0.0.1\r\n" };
