// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The checklist's per-step words, as literal keys (never built at runtime). */
import type { StreamSetupStep } from "@commonair/contracts/enums";
import type { MessageKey } from "../../i18n/index.ts";

export interface StepKeys {
  title: MessageKey;
  hint: MessageKey;
  summary: MessageKey;
}

export const STEP_KEYS: Readonly<Record<StreamSetupStep, StepKeys>> = {
  channel_profile: {
    title: "d5Dashboard.step.channel_profile.title",
    hint: "d5Dashboard.step.channel_profile.hint",
    summary: "d5Dashboard.step.channel_profile.summary",
  },
  stream_info: {
    title: "d5Dashboard.step.stream_info.title",
    hint: "d5Dashboard.step.stream_info.hint",
    summary: "d5Dashboard.step.stream_info.summary",
  },
  stream_key: {
    title: "d5Dashboard.step.stream_key.title",
    hint: "d5Dashboard.step.stream_key.hint",
    summary: "d5Dashboard.step.stream_key.summary",
  },
  encoder_connected: {
    title: "d5Dashboard.step.encoder_connected.title",
    hint: "d5Dashboard.step.encoder_connected.hint",
    summary: "d5Dashboard.step.encoder_connected.summary",
  },
  rehearsal: {
    title: "d5Dashboard.step.rehearsal.title",
    hint: "d5Dashboard.step.rehearsal.hint",
    summary: "d5Dashboard.step.rehearsal.summary",
  },
  first_live: {
    title: "d5Dashboard.step.first_live.title",
    hint: "d5Dashboard.step.first_live.hint",
    summary: "d5Dashboard.step.first_live.summary",
  },
  import_twitch: {
    title: "d5Dashboard.step.import_twitch.title",
    hint: "d5Dashboard.step.import_twitch.hint",
    summary: "d5Dashboard.step.import_twitch.summary",
  },
  get_paid: {
    title: "d6Studio.getPaid.title",
    hint: "d6Studio.getPaid.hint",
    summary: "d6Studio.getPaid.summary",
  },
  bring_your_audience: {
    title: "d5Dashboard.step.bring_your_audience.title",
    hint: "d5Dashboard.step.bring_your_audience.hint",
    summary: "d5Dashboard.step.bring_your_audience.summary",
  },
};

export const GUIDE_TAB_KEYS = {
  obs: "d5Dashboard.guide.tab.obs",
  streamlabs: "d5Dashboard.guide.tab.streamlabs",
  larix: "d5Dashboard.guide.tab.larix",
  whip: "d5Dashboard.guide.tab.whip",
} as const satisfies Record<string, MessageKey>;
