// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The viewer's Clip button (overhaul wave 2, D3.7; watch.md P4) in the live and video player bars.
 * `clips.create` cuts the last 30 seconds of a live stream, or the 30 seconds of a video that end
 * at the playhead. A small dialog asks for the title, then a toast carries the clip's link. Signed
 * out, the button opens the sign-up prompt (d2-gate, intent `clip`), which brings the viewer back
 * here. Counted as `clip.viewer` (closed lists).
 */
import { formatDuration, IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import { Scissor01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { AuthGatePrompt } from "../auth-gate/auth-gate-prompt.tsx";
import { IntentConfirm, usePendingIntent } from "../auth-gate/intent-confirm.tsx";
import { isMatureGate } from "../safety/client.ts";
import { watchUrl } from "./share.ts";

/** How much a viewer's clip covers. */
export const VIEWER_CLIP_SECONDS = 30;
/** `clips.create`'s shortest clip. */
export const MIN_CLIP_SECONDS = 5;
/** `clips.create`'s longest title. */
export const CLIP_TITLE_MAX = 100;

/** What the button clips: the live stream, or a video at the playhead. */
export type ClipTarget =
  | { kind: "live"; channel: string }
  | {
      kind: "vod";
      channel: string;
      vodId: string;
      /** `Vod.durationSeconds`: the clip must lie inside it. */
      durationSeconds: number;
      /** The playhead in seconds, or null while unknown. */
      position: () => number | null;
    };

export interface ClipRange {
  startOffset: number;
  durationSeconds: number;
}

/**
 * The part of a video a viewer's clip covers: the 30 s that end at the playhead, inside the video,
 * in whole seconds. Near the start it is the first 30 s instead. Null when the video is shorter
 * than the shortest clip or the playhead is unknown.
 */
export function vodClipRange(position: number | null, durationSeconds: number): ClipRange | null {
  if (position === null || !Number.isFinite(position) || !Number.isFinite(durationSeconds)) return null;
  const length = Math.floor(Math.max(0, durationSeconds));
  if (length < MIN_CLIP_SECONDS) return null;
  const end = Math.min(Math.max(0, Math.floor(position)), length);
  if (end >= MIN_CLIP_SECONDS) {
    const start = Math.max(0, end - VIEWER_CLIP_SECONDS);
    return { startOffset: start, durationSeconds: end - start };
  }
  return { startOffset: 0, durationSeconds: Math.min(VIEWER_CLIP_SECONDS, length) };
}

/** What `clips.create` is sent. */
export type ClipCreateInput = { channel: string; title: string; durationSeconds: number } & Partial<{
  vodId: string;
  startOffset: number;
}>;

export interface ClipCreated {
  id: string;
  channelSlug: string;
}

export type ClipCreate = (input: ClipCreateInput) => Promise<ClipCreated>;

const apiCreate: ClipCreate = (input) => api().clips.create(input);

/** The toast or inline message for a refused clip. */
export function clipErrorMessage(err: unknown): string {
  if (isMatureGate(err)) return t("d3Watch.clip.error.mature");
  switch (errorCode(err)) {
    case "UNAUTHORIZED":
      return t("d3Watch.clip.error.signIn");
    case "RATE_LIMITED":
      return t("d3Watch.clip.error.rateLimited");
    case "PRECONDITION_FAILED":
      return t("d3Watch.clip.error.unavailable");
    case "NOT_FOUND":
      return t("d3Watch.clip.error.notFound");
    default:
      return t("d3Watch.clip.error.generic");
  }
}

const browserCopy = async (text: string): Promise<void> => {
  if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("no clipboard");
  await navigator.clipboard.writeText(text);
};

export interface ClipButtonProps {
  target: ClipTarget;
  signedIn: boolean;
  /** The instance's public URL, for the clip's link (defaults to this page's origin). */
  publicUrl?: string;
  /** The title the dialog starts with (the video's title; empty live). */
  defaultTitle?: string;
  /** The player bar stays up while the dialog is open. */
  onOpenChange?: (open: boolean) => void;
  create?: ClipCreate;
  copy?: (text: string) => Promise<void>;
}

export function ClipButton({
  target,
  signedIn,
  publicUrl,
  defaultTitle = "",
  onOpenChange,
  create = apiCreate,
  copy = browserCopy,
}: ClipButtonProps): React.JSX.Element {
  const [open, setOpenState] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [range, setRange] = React.useState<ClipRange | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const titleId = React.useId();
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  // Back from sign-up with `intent=clip`: a one-tap confirm that only opens the clip dialog.
  const intent = usePendingIntent("clip", signedIn);
  const confirming = intent.pending !== null && !open;
  // The player bar stays up while the confirm is showing; Not now lets it hide again.
  const barOpen = React.useRef(onOpenChange);
  React.useEffect(() => {
    barOpen.current = onOpenChange;
  });
  React.useEffect(() => {
    if (confirming) barOpen.current?.(true);
  }, [confirming]);

  if (!signedIn)
    return (
      <AuthGatePrompt
        intent="clip"
        side="top"
        align="end"
        trigger={
          <IconButton
            data-testid="clip-button"
            data-signed-in="false"
            label={t("d3Watch.clip.label")}
            tooltip={t("d3Watch.clip.signInTooltip")}
            icon={Scissor01Icon}
            onClick={() => trackUi("clip.viewer", "signin", "clip")}
            className="text-overlay-foreground"
          />
        }
      />
    );

  const vodRange = target.kind === "vod" ? range : null;
  const unavailable = target.kind === "vod" && vodRange === null;
  const start = () => {
    // The range is read once, so it does not move while the viewer types.
    setRange(target.kind === "vod" ? vodClipRange(target.position(), target.durationSeconds) : null);
    setTitle(defaultTitle.slice(0, CLIP_TITLE_MAX));
    setError(null);
    setOpen(true);
    trackUi("clip.viewer", "click");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = title.trim();
    if (name === "" || pending || unavailable) return;
    setPending(true);
    setError(null);
    try {
      const input: ClipCreateInput =
        target.kind === "live"
          ? { channel: target.channel, title: name, durationSeconds: VIEWER_CLIP_SECONDS }
          : {
              channel: target.channel,
              title: name,
              vodId: target.vodId,
              startOffset: vodRange?.startOffset ?? 0,
              durationSeconds: vodRange?.durationSeconds ?? VIEWER_CLIP_SECONDS,
            };
      const clip = await create(input);
      trackUi("clip.viewer", "create");
      setOpen(false);
      const base = publicUrl ?? (typeof window === "undefined" ? "" : window.location.origin);
      const url = watchUrl(base, "clip", clip.channelSlug, clip.id);
      toast.success(t("d3Watch.clip.created"), {
        description: t("d3Watch.clip.createdBody"),
        duration: 10_000,
        action: {
          label: t("d3Watch.clip.copyLink"),
          onClick: () => {
            copy(url).then(
              () => toast.success(t("watch.share.copied")),
              () => toast.error(t("watch.share.failed")),
            );
          },
        },
      });
    } catch (err) {
      trackUi("clip.viewer", "error", errorCode(err) === "RATE_LIMITED" ? "rate_limited" : "none");
      setError(clipErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const what =
    target.kind === "live"
      ? t("d3Watch.clip.whatLive", { seconds: VIEWER_CLIP_SECONDS })
      : vodRange
        ? t("d3Watch.clip.whatVideo", {
            from: formatDuration(vodRange.startOffset),
            to: formatDuration(vodRange.startOffset + vodRange.durationSeconds),
          })
        : t("d3Watch.clip.tooShort");

  const button = (
    <IconButton
      data-testid="clip-button"
      data-signed-in="true"
      label={t("d3Watch.clip.label")}
      icon={Scissor01Icon}
      onClick={start}
      className="text-overlay-foreground"
    />
  );
  return (
    <>
      {confirming ? (
        <IntentConfirm
          open
          message={t("d4Follow.confirm.clip")}
          onDismiss={() => {
            intent.dismiss();
            onOpenChange?.(false);
          }}
          trigger={button}
          action={
            <Button
              data-testid="intent-confirm-clip"
              data-filled-cta=""
              variant="brand"
              onClick={() => {
                intent.confirm();
                start();
              }}
            >
              <HugeiconsIcon icon={Scissor01Icon} strokeWidth={2} aria-hidden />
              {t("d4Follow.confirm.clipAction")}
            </Button>
          }
        />
      ) : (
        button
      )}
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent data-testid="clip-dialog" data-kind={target.kind}>
          <form className="flex min-w-0 flex-col gap-4" onSubmit={(e) => void submit(e)}>
            <DialogHeader>
              <DialogTitle>{t("d3Watch.clip.title")}</DialogTitle>
              <DialogDescription data-testid="clip-dialog-range">{what}</DialogDescription>
            </DialogHeader>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor={titleId}>{t("d3Watch.clip.nameLabel")}</FieldLabel>
              <Input
                id={titleId}
                data-testid="clip-dialog-title"
                value={title}
                maxLength={CLIP_TITLE_MAX}
                required
                autoComplete="off"
                disabled={unavailable}
                placeholder={t("d3Watch.clip.namePlaceholder")}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <FieldDescription>
                {t("d3Watch.clip.nameHint", { count: CLIP_TITLE_MAX - title.length })}
              </FieldDescription>
            </Field>
            {error ? (
              <p data-testid="clip-dialog-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                {t("d3Watch.clip.cancel")}
              </Button>
              <Button
                type="submit"
                data-testid="clip-dialog-create"
                disabled={pending || unavailable || title.trim() === ""}
                aria-busy={pending}
              >
                {pending ? t("d3Watch.clip.creating") : t("d3Watch.clip.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
