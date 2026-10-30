// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton, StatusBadge, formatNumber } from "@commonair/ui";
import { ChatMessage } from "@commonair/ui/blocks/media";
import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { ReportClient } from "../../components/safety/client.ts";
import { activeLocale, t } from "../../i18n/index.ts";
import type { ChatMessageFrame } from "../connection.ts";
import { nameColorIndex } from "../view.ts";
import type { Wave } from "./reducer.ts";
import { ReportWaveButton } from "./report-wave.tsx";

export interface WaveRowProps {
  wave: Wave;
  expanded: boolean;
  onToggle: () => void;
  /** Signed-in viewers can report the wave. */
  canReport: boolean;
  /** Renders one of the wave's messages when it is expanded. */
  renderMessage: (message: ChatMessageFrame) => React.ReactNode;
  reportClient?: ReportClient;
  /** Roving focus (j/k): the row's tab index. */
  tabIndex?: number;
}

/**
 * One wave of identical messages (Calm Chat): the text once, `×count`, and for a wave from several
 * people (harassment, copypasta) how many sent it. Expands to its messages.
 */
export function WaveRow({
  wave,
  expanded,
  onToggle,
  canReport,
  renderMessage,
  reportClient,
  tabIndex,
}: WaveRowProps): React.JSX.Element {
  const locale = activeLocale();
  const { first } = wave;
  return (
    <>
      <ChatMessage
        data-testid="chat-wave"
        data-id={wave.id}
        data-count={wave.count}
        data-senders={wave.senders}
        data-calm-row=""
        tabIndex={tabIndex}
        aria-label={t("calmChat.wave.summary", { body: first.body, count: wave.count, senders: wave.senders })}
        className="motion-safe:transition-colors focus-visible:bg-muted focus-visible:outline-none"
        author={first.user.displayName}
        colorIndex={nameColorIndex(first.user.username)}
        action={first.isAction}
        body={
          <>
            {first.body}{" "}
            <StatusBadge tone="neutral" className="align-middle tabular-nums">
              {t("calmChat.wave.count", { count: formatNumber(wave.count, locale) })}
            </StatusBadge>
            {wave.senders > 1 && (
              <span className="ms-1 text-muted-foreground">{t("calmChat.wave.senders", { count: wave.senders })}</span>
            )}
          </>
        }
        actions={
          <span className="flex shrink-0 items-center">
            <IconButton
              data-testid="chat-wave-expand"
              aria-expanded={expanded}
              label={expanded ? t("calmChat.wave.collapse") : t("calmChat.wave.expand")}
              icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
              size="icon-xs"
              className="text-muted-foreground"
              onClick={onToggle}
            />
            {canReport && <ReportWaveButton wave={wave} client={reportClient} />}
          </span>
        }
      />
      {expanded && (
        <div data-slot="chat-wave-messages" className="flex flex-col gap-1 border-s border-border ps-2">
          {wave.messages.map((m) => (
            <React.Fragment key={m.id}>{renderMessage(m)}</React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}
