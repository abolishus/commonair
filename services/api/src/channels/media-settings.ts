// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channels.mediaSettings` / `updateMediaSettings` (W2 contract step): a channel's captions
 * (ADR 0011) and DVR (ADR 0016) settings. Captions live in `channels.captions_settings` (jsonb),
 * DVR in `dvr_enabled` / `dvr_window_seconds`.
 *
 * - The DVR window is clamped to `DVR_MAX_WINDOW_SECONDS` on save and on read (never below the
 *   column's 60 s floor; with the cap at 0 DVR is off instance-wide and the stored value is moot).
 * - Mask patterns compile like chat word filters, so each must pass the same linear-time safe-regex
 *   check (`@commonair/safe-regex`); a refused one is PRECONDITION_FAILED `mask_pattern`.
 * - The change and its audit row (field names only: mask words are the owner's free text) commit
 *   together. Nothing else consumes these settings as an event: the captions worker and the
 *   origin read them from the row when a broadcast starts and per request.
 */
import { eq } from "drizzle-orm";
import { CaptionsDefaultSetting, ChannelCaptionsSettings, type ChannelDvrSettings } from "@commonair/contracts/shapes";
import type { dto } from "@commonair/contracts";
import { schema } from "@commonair/db";
import { unsafeFilterRegexReason } from "@commonair/safe-regex";
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { precondition } from "../lib/errors.ts";
import { readSetting } from "../lib/settings.ts";

const { channels } = schema;
type ChannelRow = typeof channels.$inferSelect;
type MediaSettings = z.infer<typeof dto.ChannelMediaSettings>;

/** The column's floor (`channels_dvr_window_range`). */
const DVR_MIN_WINDOW_SECONDS = 60;

/** A stored or requested window, clamped to the instance cap and the column's range. */
export function clampDvrWindow(seconds: number, capSeconds: number): number {
  return Math.max(DVR_MIN_WINDOW_SECONDS, Math.min(seconds, capSeconds, 86_400));
}

/** Trimmed, de-duplicated mask patterns; throws PRECONDITION_FAILED for one the safe-regex check refuses. */
export function checkMaskWords(words: readonly string[]): string[] {
  const out = [...new Set(words.map((w) => w.trim()).filter((w) => w.length > 0))];
  for (const w of out) {
    const reason = unsafeFilterRegexReason(w);
    if (reason) throw precondition("mask_pattern", `Mask pattern refused: ${reason}`);
  }
  return out;
}

export const captionsSettingsOf = (c: ChannelRow) => {
  const parsed = ChannelCaptionsSettings.safeParse(c.captionsSettings);
  return parsed.success ? parsed.data : ChannelCaptionsSettings.parse({});
};

export async function captionsInstanceDefault(deps: Deps): Promise<boolean> {
  const parsed = CaptionsDefaultSetting.safeParse((await readSetting(deps.db, "captions.defaultEnabled")).value);
  return parsed.success ? parsed.data.enabled : false;
}

export async function mediaSettingsOf(deps: Deps, c: ChannelRow): Promise<MediaSettings> {
  const cap = deps.env.DVR_MAX_WINDOW_SECONDS;
  return {
    captions: captionsSettingsOf(c),
    captionsInstanceDefault: await captionsInstanceDefault(deps),
    dvr: { enabled: c.dvrEnabled, windowSeconds: clampDvrWindow(c.dvrWindowSeconds, cap) },
    dvrMaxWindowSeconds: cap,
  };
}

export interface MediaSettingsPatch {
  captions?: Partial<ChannelCaptionsSettings>;
  dvr?: Partial<ChannelDvrSettings>;
}

const definedKeys = (o: object | undefined) =>
  Object.entries(o ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);

export async function updateMediaSettings(
  deps: Deps,
  actorId: string,
  c: ChannelRow,
  patch: MediaSettingsPatch,
): Promise<MediaSettings> {
  const before = captionsSettingsOf(c);
  const captionsPatch = Object.fromEntries(Object.entries(patch.captions ?? {}).filter(([, v]) => v !== undefined));
  if (captionsPatch.maskWords) captionsPatch.maskWords = checkMaskWords(captionsPatch.maskWords as string[]);
  const captions = ChannelCaptionsSettings.parse({ ...before, ...captionsPatch });
  const cap = deps.env.DVR_MAX_WINDOW_SECONDS;
  const dvrEnabled = patch.dvr?.enabled ?? c.dvrEnabled;
  const dvrWindowSeconds =
    patch.dvr?.windowSeconds === undefined ? c.dvrWindowSeconds : clampDvrWindow(patch.dvr.windowSeconds, cap);
  const changed = [
    ...definedKeys(patch.captions).map((k) => `captions.${k}`),
    ...definedKeys(patch.dvr).map((k) => `dvr.${k}`),
  ];
  const [row] = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(channels)
      .set({ captionsSettings: captions, dvrEnabled, dvrWindowSeconds })
      .where(eq(channels.id, c.id))
      .returning();
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "channel.media_settings.update",
      subjectType: "channel",
      subjectId: c.id,
      channelId: c.id,
      details: { changed },
    });
    return updated;
  });
  return mediaSettingsOf(deps, row ?? c);
}
