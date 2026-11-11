// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { StreamRecap } from "../recap/stream-recap.tsx";
import { GoLiveChecklist } from "../setup-checklist/checklist.tsx";
import type { DashboardIntent } from "../setup-checklist/model.ts";
import type { LiveChannel } from "./control-room.tsx";

export interface DashboardTopProps {
  /** From the control room's channel poll; null until the first answer. */
  channel: LiveChannel | null;
  slug: string;
  publicUrl: string;
  intent?: DashboardIntent;
  /** Changes when a save elsewhere on the page can tick a checklist step. */
  refreshKey: string;
  onEditInfo: () => void;
}

/**
 * What sits above the board: the stream recap after a broadcast and the go-live checklist. While the
 * streamer is live neither shows, so the title editor, live numbers and (on phones) chat stay at the
 * top (D5.2). The checklist also waits for the first channel answer, so a live streamer opening the
 * page never sees it flash in and push the board down.
 */
export function DashboardTop({
  channel,
  slug,
  publicUrl,
  intent,
  refreshKey,
  onEditInfo,
}: DashboardTopProps): React.ReactNode {
  if (channel === null || channel.live !== null) return null;
  return (
    <>
      <StreamRecap
        channel={slug}
        publicUrl={publicUrl}
        live={false}
        lastLiveAt={channel.lastLiveAt ?? null}
        vodEnabled={channel.vodEnabled ?? false}
        member={channel.ownerCoop?.member ?? false}
      />
      <GoLiveChecklist
        channel={slug}
        publicUrl={publicUrl}
        intent={intent}
        refreshKey={refreshKey}
        onEditInfo={onEditInfo}
      />
    </>
  );
}
