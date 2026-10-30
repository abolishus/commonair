// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `surge-guard` steps 1–7 (docs/testing/w1-selectors.md, "Scenarios"; ADR 0015 "Consequences").
 * Stub: W1-watch-gate fills it.
 */
import type { W1Run } from "./kit.ts";

const notMerged = (): never => {
  throw new Error("W1-watch-gate not merged");
};

export async function stepBotsRefused(_run: W1Run): Promise<void> {
  notMerged();
}

export async function stepCdnBotRefused(_run: W1Run): Promise<void> {
  notMerged();
}

export async function stepPerAddressCap(_run: W1Run): Promise<void> {
  notMerged();
}

export async function stepRealViewersChat(_run: W1Run): Promise<void> {
  notMerged();
}

export async function stepAudioOnlyViewer(_run: W1Run): Promise<void> {
  notMerged();
}

export async function stepSurgeTripsAndReverts(_run: W1Run): Promise<void> {
  notMerged();
}

export async function stepStudioAndBanner(_run: W1Run): Promise<void> {
  notMerged();
}
