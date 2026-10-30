// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Discord webhook section on `/dashboard` (ADR 0028 decision 5). The URL is write-only: the
 * input is never pre-filled, and the status line says only whether one is set and how the last
 * post went. Optional, proprietary, and linked to the FOSS alternatives.
 */
import { ConfirmDialog, RelativeTime, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { fillNode } from "../../lib/fill.tsx";
import { cleanWebhookUrl, ERROR_MESSAGE, type DiscordWebhookClient, type DiscordWebhookStatusDto } from "./shared.ts";

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; status: DiscordWebhookStatusDto };

export function DiscordWebhookPanel({
  client,
  docsUrl,
}: {
  client: DiscordWebhookClient;
  /** The setup guide (docs/streamers/discord.md in the running source); hidden when unknown. */
  docsUrl: string | null;
}): React.JSX.Element {
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  const [url, setUrl] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "test" | null>(null);
  const inputId = React.useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  React.useEffect(() => {
    let live = true;
    client
      .get()
      .then((status) => {
        if (live) setLoad({ kind: "loaded", status });
      })
      .catch(() => {
        if (live) setLoad({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [client, attempt]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = cleanWebhookUrl(url);
    if (!clean) {
      setInvalid(true);
      return;
    }
    setBusy("save");
    try {
      const status = await client.set(clean);
      setLoad({ kind: "loaded", status });
      setUrl("");
      setInvalid(false);
      toast.success(t("discord.saved"));
    } catch (err) {
      // The contract refuses a URL that is not a Discord webhook: show it where the URL is.
      if (errorCode(err) === "BAD_REQUEST") setInvalid(true);
      else toastActionError(err, t("discord.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      const status = await client.test();
      setLoad({ kind: "loaded", status });
      // The API only queues the post, and queues nothing when the webhook is gone (say, removed by
      // the worker after repeated failures): the refreshed status then reads "Not set up".
      if (status.configured) toast.success(t("discord.testSent"));
      else toast.warning(t("discord.status.off"));
    } catch (err) {
      toastActionError(err, t("discord.testFailed"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    await client.remove();
    setLoad({ kind: "loaded", status: { configured: false, setAt: null, lastPostedAt: null, lastError: null } });
    toast.success(t("discord.removed"));
  };

  if (load.kind === "failed")
    return (
      <AlertCallout
        data-testid="discord-webhook-section"
        tone="danger"
        live
        title={t("discord.title")}
        description={t("discord.loadFailed")}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("common.retry")}
          </Button>
        }
      />
    );

  const status = load.kind === "loaded" ? load.status : null;
  const configured = status?.configured ?? false;
  return (
    <Card data-testid="discord-webhook-section" className="min-w-0">
      <CardHeader>
        <CardTitle>{t("discord.title")}</CardTitle>
        <CardDescription>{t("discord.intro")}</CardDescription>
      </CardHeader>
      <form onSubmit={(e) => void save(e)} noValidate className="flex min-w-0 flex-col gap-4">
        <CardContent className="flex min-w-0 flex-col gap-4">
          {status ? (
            <StatusLine status={status} />
          ) : (
            <SkeletonGroup label={t("discord.loading")}>
              <SkeletonText lines={1} />
            </SkeletonGroup>
          )}
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={inputId}>
              {configured ? t("discord.url.replaceLabel") : t("discord.url.label")}
            </FieldLabel>
            <Input
              id={inputId}
              data-testid="discord-webhook-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              placeholder={t("discord.url.placeholder")}
              value={url}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
              onChange={(e) => {
                setUrl(e.currentTarget.value);
                if (invalid) setInvalid(false);
              }}
            />
            <FieldDescription id={hintId}>{t("discord.url.hint")}</FieldDescription>
            {invalid && <FieldError id={errorId}>{t("discord.url.invalid")}</FieldError>}
          </Field>
          <p className="text-sm break-words text-muted-foreground">{t("discord.terms")}</p>
          {docsUrl && (
            <div>
              {/* The label is Button's child; the lint rule cannot see through `render`, so it is named here too. */}
              <Button
                variant="link"
                className="h-auto px-0"
                nativeButton={false}
                render={<a href={docsUrl} rel="noopener" aria-label={t("discord.guide")} />}
              >
                {t("discord.guide")}
              </Button>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {configured && (
            <>
              <ConfirmDialog
                trigger={
                  <Button data-testid="discord-webhook-remove" type="button" variant="ghost" disabled={busy !== null}>
                    {t("discord.remove")}
                  </Button>
                }
                title={t("discord.removeTitle")}
                description={t("discord.removeBody")}
                confirmLabel={t("discord.removeConfirm")}
                variant="destructive"
                onConfirm={remove}
                onError={(err) => toastActionError(err, t("discord.removeFailed"))}
                contentProps={{ "data-testid": "discord-webhook-remove-confirm" }}
              />
              <Button
                data-testid="discord-webhook-test"
                type="button"
                variant="outline"
                disabled={busy !== null}
                aria-busy={busy === "test" || undefined}
                onClick={() => void sendTest()}
              >
                {t("discord.test")}
              </Button>
            </>
          )}
          <Button
            data-testid="discord-webhook-save"
            type="submit"
            disabled={busy !== null || status === null}
            aria-busy={busy === "save" || undefined}
          >
            {t("discord.save")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function StatusLine({ status }: { status: DiscordWebhookStatusDto }): React.JSX.Element {
  return (
    <div
      data-testid="discord-webhook-status"
      data-configured={String(status.configured)}
      data-error={status.lastError ?? ""}
      className="flex min-w-0 flex-col gap-1 text-sm break-words"
    >
      <p>{status.configured ? t("discord.status.on") : t("discord.status.off")}</p>
      {status.configured && (
        <p className="text-muted-foreground">
          {status.lastPostedAt
            ? fillNode(t("discord.status.lastPost"), "time", <RelativeTime date={status.lastPostedAt} />)
            : t("discord.status.never")}
        </p>
      )}
      {status.configured && status.lastError && (
        <p className="text-destructive">{t(ERROR_MESSAGE[status.lastError])}</p>
      )}
    </div>
  );
}
