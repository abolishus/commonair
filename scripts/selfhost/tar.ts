// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A reproducible `.tar.gz` writer (POSIX ustar): entries sorted by path, fixed owner, mode and
 * mtime, and a normalised gzip header, so the same inputs give the same bytes on any machine.
 */
import { gzipSync } from "node:zlib";

export interface TarEntry {
  /** Relative path inside the archive, `/`-separated, no leading `/` and no `..`. */
  path: string;
  /** File contents; omit for a directory. */
  data?: Uint8Array;
  mode: number;
}

const BLOCK = 512;
const enc = new TextEncoder();

function field(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = enc.encode(value);
  if (bytes.length > length) throw new Error(`tar: ${value} does not fit in ${length} bytes`);
  buf.set(bytes, offset);
}

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, "0")}\0`;

/** Splits a long path into ustar's prefix (155) and name (100) at a `/`. */
function splitPath(path: string): { prefix: string; name: string } {
  if (enc.encode(path).length <= 100) return { prefix: "", name: path };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return { prefix, name };
  }
  throw new Error(`tar: path too long: ${path}`);
}

function header(entry: TarEntry, mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const dir = entry.data === undefined;
  const { prefix, name } = splitPath(dir ? `${entry.path}/` : entry.path);
  field(h, 0, 100, name);
  field(h, 100, 8, octal(entry.mode, 8));
  field(h, 108, 8, octal(0, 8));
  field(h, 116, 8, octal(0, 8));
  field(h, 124, 12, octal(dir ? 0 : (entry.data?.length ?? 0), 12));
  field(h, 136, 12, octal(mtime, 12));
  field(h, 148, 8, "        ");
  field(h, 156, 1, dir ? "5" : "0");
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  field(h, 265, 32, "root");
  field(h, 297, 32, "root");
  field(h, 345, 155, prefix);
  const sum = h.reduce((a, b) => a + b, 0);
  field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

function validPath(p: string): boolean {
  return p !== "" && !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === "..");
}

/** The uncompressed archive. Parent directories are added for every file. */
export function tar(entries: TarEntry[], mtime = 0): Uint8Array {
  const all = new Map<string, TarEntry>();
  for (const e of entries) {
    if (!validPath(e.path)) throw new Error(`tar: invalid path ${JSON.stringify(e.path)}`);
    if (all.has(e.path)) throw new Error(`tar: duplicate path ${e.path}`);
    all.set(e.path, e);
  }
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const existing = all.get(dir);
      if (existing?.data !== undefined) throw new Error(`tar: ${dir} is both a file and a directory`);
      if (!existing) all.set(dir, { path: dir, mode: 0o755 });
    }
  }
  const sorted = [...all.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Uint8Array[] = [];
  for (const e of sorted) {
    chunks.push(header(e, mtime));
    if (e.data !== undefined && e.data.length > 0) {
      chunks.push(e.data);
      const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(new Uint8Array(pad));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** gzip with a header that does not depend on the machine (mtime 0, OS = Unix). */
export function gzipReproducible(data: Uint8Array): Uint8Array {
  const gz = new Uint8Array(gzipSync(data, { level: 9 }));
  gz.set([0, 0, 0, 0], 4);
  gz[9] = 3;
  return gz;
}
