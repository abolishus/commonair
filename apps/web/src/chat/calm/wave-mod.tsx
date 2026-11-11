// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { toast } from "@commonair/ui/toast";
import type { CHAT_TIMEOUT_SECONDS } from "@commonair/contracts/enums";
import { Clock01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { TIMEOUT_OPTIONS, durationLabel } from "../modes.ts";
import type { Wave } from "./reducer.ts";
import { waveMessageIds } from "./wave-mod-model.ts";

export type WaveTimeoutSeconds = (typeof CHAT_TIMEOUT_SECONDS)[number];

/** What the wave row calls; the panel passes the API, tests a fake. */
export interface WaveModClient {
  bulkTimeout(input: {
    channel: string;
    messageIds: string[];
    durationSeconds: WaveTimeoutSeconds;
    deleteMessages: boolean;
  }): Promise<{ timedOut: unknown[]; skipped: unknown[]; deletedMessages: number }>;
  deleteMessage(input: { channel: string; id: string }): Promise<unknown>;
}

export const apiWaveModClient = (): WaveModClient => ({
  bulkTimeout: (input) => api().chat.bans.bulk(input),
  deleteMessage: (input) => api().chat.deleteMessage(input),
});

/** "Delete all" sends the single delete per message, a few at a time. */
const DELETE_CONCURRENCY = 4;

async function deleteEach(client: WaveModClient, channel: string, ids: readonly string[]) {
  let deleted = 0;
  let failed = 0;
  let firstError: unknown = null;
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        await client.deleteMessage({ channel, id });
        deleted += 1;
      } catch (err) {
        failed += 1;
        firstError ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, ids.length) }, worker));
  return { deleted, failed, firstError };
}

export interface ModWaveRowProps {
  channel: string;
  wave: Wave;
  client?: WaveModClient;
}

/**
 * The moderator's row under a wave (J5-d): "Time out all {n} senders" with a length (1 minute,
 * 10 minutes, 1 hour, 24 hours) and "Delete all", each behind a ConfirmDialog, then a toast with
 * what happened. The server skips the channel's team and anyone timed out for longer; it never bans.
 */
export function ModWaveRow({ channel, wave, client }: ModWaveRowProps): React.JSX.Element {
  const [timeoutOpen, setTimeoutOpen] = React.useState(false);
  // Kept after the dialog closes, so its title does not change while it animates out.
  const [duration, setDuration] = React.useState<WaveTimeoutSeconds>(600);
  const [deleting, setDeleting] = React.useState(false);
  const [alsoDelete, setAlsoDelete] = React.useState(true);
  const checkboxId = React.useId();
  const ids = waveMessageIds(wave);
  const inSet = new Set(ids);
  const senders = new Set(wave.messages.filter((m) => inSet.has(m.id)).map((m) => m.user.id)).size;
  const calls = () => client ?? apiWaveModClient();

  const timeOut = async () => {
    const res = await calls().bulkTimeout({
      channel,
      messageIds: ids,
      durationSeconds: duration,
      deleteMessages: alsoDelete,
    });
    toast.success(
      t("d7Mod.timeout.done", {
        timedOut: res.timedOut.length,
        deleted: res.deletedMessages,
        skipped: res.skipped.length,
      }),
    );
  };

  const deleteAll = async () => {
    const { deleted, failed, firstError } = await deleteEach(calls(), channel, ids);
    if (deleted === 0 && firstError !== null) throw firstError;
    if (failed > 0) toast.error(t("d7Mod.delete.partial", { deleted, failed }));
    else toast.success(t("d7Mod.delete.done", { deleted }));
  };

  return (
    <article
      data-testid="chat-mod-wave"
      data-id={wave.id}
      data-count={wave.count}
      data-senders={senders}
      aria-label={t("d7Mod.wave.label", { body: wave.first.body })}
      className="flex flex-wrap items-center gap-2 border-s-2 border-border bg-muted px-2 py-1 text-sm"
    >
      <span className="min-w-0 flex-1 text-muted-foreground">
        {t("d7Mod.wave.summary", { count: wave.count, senders: wave.senders })}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button data-testid="chat-mod-wave-timeout" variant="outline" size="xs">
                <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                {t("d7Mod.wave.timeoutAll", { senders })}
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("d7Mod.wave.timeoutFor")}</DropdownMenuLabel>
              {TIMEOUT_OPTIONS.map((seconds) => (
                <DropdownMenuItem
                  key={seconds}
                  data-testid="chat-mod-wave-timeout-option"
                  data-seconds={seconds}
                  onClick={() => {
                    setAlsoDelete(true);
                    setDuration(seconds);
                    setTimeoutOpen(true);
                  }}
                >
                  {durationLabel(seconds)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button data-testid="chat-mod-wave-delete" variant="outline" size="xs" onClick={() => setDeleting(true)}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("d7Mod.wave.deleteAll")}
        </Button>
      </span>
      <ConfirmDialog
        open={timeoutOpen}
        onOpenChange={setTimeoutOpen}
        variant="destructive"
        icon={Clock01Icon}
        title={t("d7Mod.timeout.title", { senders, duration: durationLabel(duration) })}
        description={t("d7Mod.timeout.body")}
        confirmLabel={t("d7Mod.timeout.confirm")}
        onConfirm={timeOut}
        onError={(err) => toastActionError(err, t("d7Mod.failed"))}
        contentProps={{ "data-testid": "chat-mod-wave-timeout-dialog" }}
      >
        <Field orientation="horizontal">
          <Checkbox
            id={checkboxId}
            data-testid="chat-mod-wave-also-delete"
            checked={alsoDelete}
            onCheckedChange={(checked) => setAlsoDelete(checked === true)}
          />
          <FieldLabel htmlFor={checkboxId}>{t("d7Mod.timeout.alsoDelete", { count: ids.length })}</FieldLabel>
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        variant="destructive"
        icon={Delete02Icon}
        title={t("d7Mod.delete.title", { count: ids.length })}
        description={t("d7Mod.delete.body")}
        confirmLabel={t("d7Mod.delete.confirm")}
        onConfirm={deleteAll}
        onError={(err) => toastActionError(err, t("d7Mod.failed"))}
        contentProps={{ "data-testid": "chat-mod-wave-delete-dialog" }}
      />
    </article>
  );
}
