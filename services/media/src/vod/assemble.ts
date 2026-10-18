// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * fMP4 HLS segments are fragments of one MP4: the init segment followed by media segments of
 * the same run, concatenated byte for byte, is a valid fragmented MP4 that ffmpeg can seek in.
 */
import type { ObjectStorage } from "@commonair/storage";

export async function concatFiles(paths: readonly string[], out: string): Promise<void> {
  const writer = Bun.file(out).writer();
  try {
    for (const p of paths) {
      await writer.write(await Bun.file(p).bytes());
      await writer.flush();
    }
  } finally {
    await writer.end();
  }
}

export class MissingObjectError extends Error {
  constructor(key: string) {
    super(`object missing: ${key}`);
    this.name = "MissingObjectError";
  }
}

export async function downloadTo(storage: ObjectStorage, bucket: string, key: string, path: string): Promise<void> {
  const res = await storage.get(bucket, key);
  if (!res) throw new MissingObjectError(key);
  await Bun.write(path, res);
}

/** Download `keys` (init first, then segments) and concatenate them into `out`. */
export async function assembleFromStorage(
  storage: ObjectStorage,
  bucket: string,
  keys: readonly string[],
  scratchDir: string,
  out: string,
): Promise<void> {
  const local: string[] = [];
  for (const [i, key] of keys.entries()) {
    const p = `${scratchDir}/part-${i}`;
    await downloadTo(storage, bucket, key, p);
    local.push(p);
  }
  await concatFiles(local, out);
}
