// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `bundle` export kind (ADR 0037): a ZIP with `bundle.json` (`PortabilityBundle` v1), `files/`
 * and the manifest. `buildExport` (`build.ts`) calls `buildBundle` for a `bundle` export and keeps
 * the rest of the export pipeline (claim, upload, TTL, mail, cleanup). Owned by W3-portability; a
 * stub until it lands, so a bundle export fails as `build_failed` (nothing creates one yet:
 * `portability.bundle.create` answers 501).
 */
import type { WorkerContext } from "../context.ts";

export interface BundleInput {
  exportId: string;
  userId: string;
  /** The requester's channel (a bundle is always a channel's). */
  channelId: string;
  generatedAt: Date;
}

/** The finished archive's bytes. */
export async function buildBundle(_ctx: WorkerContext, _input: BundleInput): Promise<Uint8Array> {
  throw new Error("bundle export is not implemented yet");
}
