// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hash lists and the matcher. Operator files: one PDQ hex per line, optional trailing `,`-separated
 * fields or `# comment`, blank lines and `#` lines ignored; any other line is a parse error (the
 * caller keeps the last good list). An empty path is an empty list, which is valid. The local
 * block list is read from `local_hash_list` by the service and passed to `staticHashList`.
 */
import type { HashListCategory } from "@commonair/contracts/enums";
import { pending } from "./pending.ts";
import type { HashList, HashListProvider, HashMatcher } from "./types.ts";

export class HashListParseError extends Error {
  override name = "HashListParseError";
  constructor(readonly line: number) {
    super(`hash list line ${line} is not a PDQ hash`);
  }
}

/** Parse a list file's text. `version` = `sha256:<hex of text>:<count>`. */
export function parseHashList(_text: string, _category: HashListCategory): HashList {
  return pending("parseHashList");
}

/** Load a list file (empty path → an empty list with version `empty:0`). */
export async function loadHashListFile(_path: string, _category: HashListCategory): Promise<HashList> {
  return pending("loadHashListFile");
}

export function staticHashList(
  _category: HashListCategory,
  _provider: HashListProvider,
  _hashes: readonly string[],
  _version: string,
): HashList {
  return pending("staticHashList");
}

export function createHashMatcher(_lists: readonly HashList[]): HashMatcher {
  return pending("createHashMatcher");
}

/**
 * Reload the operator lists on SIGHUP and on file change; on a parse error keep the last good
 * list and call `onError` (ids and line numbers only). Returns a stop function.
 */
export function watchHashListFiles(
  _files: { path: string; category: HashListCategory }[],
  _matcher: HashMatcher,
  _onError: (err: Error, category: HashListCategory) => void,
): () => void {
  return pending("watchHashListFiles");
}
