// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton } from "@commonair/ui";
import { Dialog, DialogContent, DialogTrigger } from "@commonair/ui/components/dialog";
import { Flag01Icon } from "@hugeicons/core-free-icons";
import { MESSAGE_SET_RULES } from "@commonair/contracts/enums";
import * as React from "react";
import { reportClient, type ReportClient } from "../../components/safety/client.ts";
import { ReportForm } from "../../components/safety/report-dialog.tsx";
import { t } from "../../i18n/index.ts";
import { waveReport, type Wave } from "./reducer.ts";

/**
 * "Report wave" (`chat-report-wave`): one report for the whole wave as a `message_set`, its first
 * message the subject and up to `MESSAGE_SET_RULES.maxMessages` of its messages, newest first.
 */
export function ReportWaveButton({ wave, client }: { wave: Wave; client?: ReportClient }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const report = waveReport(wave, MESSAGE_SET_RULES.maxMessages);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <IconButton
            data-testid="chat-report-wave"
            label={t("calmChat.wave.report")}
            icon={Flag01Icon}
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
          />
        }
      />
      {open && (
        <DialogContent
          data-testid="report-dialog"
          data-subject-type="message_set"
          data-subject-id={report.subjectId}
          data-count={report.messageIds.length}
          className="max-h-svh overflow-y-auto sm:max-w-lg"
        >
          <ReportForm
            onSubmit={async (reason, details) => {
              await (client ?? reportClient()).report({
                subjectType: "message_set",
                subjectId: report.subjectId,
                messageIds: report.messageIds,
                reason,
                details,
              });
              setOpen(false);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
