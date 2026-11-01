// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether a broadcast gets live captions, and in which language (ADR 0011 decisions 2 and 3). The
 * channel's own choice (`channels.captions_settings.enabled`) wins; null follows the governance
 * default `captions.defaultEnabled` (seeded false). Never for a rehearsal (decision (g)), never on
 * a host with `CAPTIONS_MAX_STREAMS=0` or without a whisper sidecar.
 */
import { eq } from "drizzle-orm";
import { CaptionsDefaultSetting, ChannelCaptionsSettings } from "@commonair/contracts/shapes";
import { DEFAULT_GOVERNANCE_SETTINGS, schema, type Database } from "@commonair/db";
import type { MediaSessionInfo } from "../hooks.ts";

export type Ineligible = "rehearsal" | "host_off" | "no_whisper" | "channel_off" | "default_off" | "no_channel";

export interface EligibilityInput {
  kind: MediaSessionInfo["kind"];
  maxStreams: number;
  whisperUrl: string | undefined;
  /** The channel's own choice; null follows the instance default. */
  channelEnabled: boolean | null;
  instanceDefault: boolean;
}

/** The pure decision; `null` means captions run (or queue for a slot). */
export function ineligibility(i: EligibilityInput): Ineligible | null {
  if (i.kind === "rehearsal") return "rehearsal";
  if (i.maxStreams <= 0) return "host_off";
  if (!i.whisperUrl) return "no_whisper";
  if (i.channelEnabled === false) return "channel_off";
  if (i.channelEnabled === null && !i.instanceDefault) return "default_off";
  return null;
}

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;

export interface ChannelCaptions {
  enabled: boolean | null;
  /** The spoken language: the setting, else `channels.language`, else `en`. */
  language: string;
  maskWords: string[];
  instanceDefault: boolean;
}

const seededDefault = (): boolean => {
  const seeded = DEFAULT_GOVERNANCE_SETTINGS.find((s) => s.key === "captions.defaultEnabled")?.value;
  const parsed = CaptionsDefaultSetting.safeParse(seeded);
  return parsed.success ? parsed.data.enabled : false;
};

/** The channel's captions settings and the instance default; null when the channel is gone. */
export async function loadChannelCaptions(db: Database, channelId: string): Promise<ChannelCaptions | null> {
  const [row] = await db
    .select({ language: schema.channels.language, settings: schema.channels.captionsSettings })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  if (!row) return null;
  const [setting] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, "captions.defaultEnabled"))
    .limit(1);
  const def = setting ? CaptionsDefaultSetting.safeParse(setting.value) : null;
  const parsed = ChannelCaptionsSettings.safeParse(row.settings);
  const s = parsed.success ? parsed.data : ChannelCaptionsSettings.parse({});
  const language = s.spokenLanguage ?? (LANGUAGE.test(row.language) ? row.language : "en");
  return {
    enabled: s.enabled,
    language,
    maskWords: s.maskWords,
    instanceDefault: def ? def.success && def.data.enabled : seededDefault(),
  };
}
