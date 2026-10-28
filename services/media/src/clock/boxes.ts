// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The few ISO BMFF (fMP4) boxes the media clock reads: per-track timescale and handler from an
 * init segment (`moov/trak/{tkhd,mdia/{mdhd,hdlr}}`), and per-track decode time plus the first
 * sample's composition offset from a media segment (`moof/traf/{tfhd,tfdt,trun}`). Only what
 * W0 (ADR 0012, variant A2) needs; anything malformed throws.
 */

export interface InitTrack {
  trackId: number;
  /** `mdhd` timescale (ticks per second). */
  timescale: number;
  /** `hdlr` handler type: `vide`, `soun`, … */
  handler: string;
}

export interface FragmentTrack {
  trackId: number;
  /** `tfdt` baseMediaDecodeTime of the first fragment that carries this track, in track ticks. */
  baseDecodeTime: number;
  /** Composition offset of that fragment's first sample (0 when the `trun` has none). */
  firstCompositionOffset: number;
}

interface Box {
  type: string;
  /** Payload start (after the header) and end, absolute in the buffer. */
  start: number;
  end: number;
}

/**
 * Boxes between `start` and `end`. `lenient`: the buffer is only the head of a file, so a box
 * that runs past the end (an `mdat`) ends the walk instead of failing it.
 */
function* boxes(buf: Uint8Array, start: number, end: number, lenient = false): Generator<Box> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4] ?? 0, buf[pos + 5] ?? 0, buf[pos + 6] ?? 0, buf[pos + 7] ?? 0);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) {
        if (lenient) return;
        throw new Error(`truncated ${type} box`);
      }
      const big = view.getBigUint64(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${type} box too large`);
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) throw new Error(`${type} box has an impossible size`);
    if (pos + size > end) {
      if (lenient && type !== "moof" && type !== "moov") return;
      throw new Error(`${type} box overruns its parent`);
    }
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function child(buf: Uint8Array, parent: Box, type: string): Box | null {
  for (const b of boxes(buf, parent.start, parent.end)) if (b.type === type) return b;
  return null;
}

function children(buf: Uint8Array, parent: Box, type: string): Box[] {
  return [...boxes(buf, parent.start, parent.end)].filter((b) => b.type === type);
}

function top(buf: Uint8Array, type: string, lenient = false): Box[] {
  return [...boxes(buf, 0, buf.byteLength, lenient)].filter((b) => b.type === type);
}

function need(b: Box, bytes: number): void {
  if (b.end - b.start < bytes) throw new Error(`truncated ${b.type} box`);
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Tracks of an fMP4 init segment, in `moov` order. */
export function parseInit(buf: Uint8Array): InitTrack[] {
  const v = view(buf);
  const moov = top(buf, "moov")[0];
  if (!moov) throw new Error("init segment has no moov box");
  const out: InitTrack[] = [];
  for (const trak of children(buf, moov, "trak")) {
    const tkhd = child(buf, trak, "tkhd");
    const mdia = child(buf, trak, "mdia");
    const mdhd = mdia && child(buf, mdia, "mdhd");
    const hdlr = mdia && child(buf, mdia, "hdlr");
    if (!tkhd || !mdhd || !hdlr) throw new Error("trak without tkhd/mdhd/hdlr");
    need(tkhd, 4);
    // Full box: version, then creation/modification times (32 or 64 bit), then track_ID.
    const tkVersion = buf[tkhd.start] ?? 0;
    const idAt = tkhd.start + 4 + (tkVersion === 1 ? 16 : 8);
    need(tkhd, idAt - tkhd.start + 4);
    const mdVersion = buf[mdhd.start] ?? 0;
    const tsAt = mdhd.start + 4 + (mdVersion === 1 ? 16 : 8);
    need(mdhd, tsAt - mdhd.start + 4);
    need(hdlr, 12);
    // hdlr: version/flags (4), pre_defined (4), handler_type (4).
    const handler = String.fromCharCode(...buf.subarray(hdlr.start + 8, hdlr.start + 12));
    const timescale = v.getUint32(tsAt);
    if (timescale === 0) throw new Error("mdhd timescale is 0");
    out.push({ trackId: v.getUint32(idAt), timescale, handler });
  }
  return out;
}

/**
 * For each track, the decode time and first composition offset of its first fragment in the
 * segment. `truncated`: `buf` is only the head of the segment (the media data is cut off).
 */
export function parseFragment(buf: Uint8Array, opts: { truncated?: boolean } = {}): FragmentTrack[] {
  const v = view(buf);
  const out = new Map<number, FragmentTrack>();
  const moofs = top(buf, "moof", opts.truncated);
  if (moofs.length === 0) throw new Error("segment has no moof box");
  for (const moof of moofs) {
    for (const traf of children(buf, moof, "traf")) {
      const tfhd = child(buf, traf, "tfhd");
      const tfdt = child(buf, traf, "tfdt");
      if (!tfhd || !tfdt) throw new Error("traf without tfhd/tfdt");
      need(tfhd, 8);
      const trackId = v.getUint32(tfhd.start + 4);
      if (out.has(trackId)) continue;
      need(tfdt, 8);
      const version = buf[tfdt.start] ?? 0;
      let base: number;
      if (version === 1) {
        need(tfdt, 12);
        const big = v.getBigUint64(tfdt.start + 4);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tfdt beyond 2^53 ticks");
        base = Number(big);
      } else {
        base = v.getUint32(tfdt.start + 4);
      }
      out.set(trackId, { trackId, baseDecodeTime: base, firstCompositionOffset: firstCto(buf, v, traf) });
    }
  }
  return [...out.values()];
}

/** Composition offset of the first sample of the traf's first `trun` (signed in version 1). */
function firstCto(buf: Uint8Array, v: DataView, traf: Box): number {
  const trun = child(buf, traf, "trun");
  if (!trun) return 0;
  need(trun, 8);
  const version = buf[trun.start] ?? 0;
  const flags = v.getUint32(trun.start) & 0xffffff;
  const count = v.getUint32(trun.start + 4);
  if (!(flags & 0x800) || count === 0) return 0;
  let pos = trun.start + 8;
  if (flags & 0x1) pos += 4; // data_offset
  if (flags & 0x4) pos += 4; // first_sample_flags
  if (flags & 0x100) pos += 4; // sample_duration
  if (flags & 0x200) pos += 4; // sample_size
  if (flags & 0x400) pos += 4; // sample_flags
  if (pos + 4 > trun.end) throw new Error("truncated trun box");
  return version === 0 ? v.getUint32(pos) : v.getInt32(pos);
}
