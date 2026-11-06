// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The metadata under a VOD or clip (F11, `watch-meta`): the title, the category when the API gives
 * one, when it was recorded or clipped, its length, views where the API has them (clips), who cut a
 * clip, and Share (`watch-share`). Nothing is invented: a field the data lacks is left out.
 */
import { ChannelAvatar, formatDuration, IconButton, RelativeTime } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@commonair/ui/components/popover";
import { toast } from "@commonair/ui/toast";
import { Copy01Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { CategoryLink, type Clipboard } from "../channel/channel-meta.tsx";
import { watchUrl, type WatchKind } from "./share.ts";

const browserClipboard = (): Clipboard | null =>
  typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null;

async function copy(url: string, clipboard: Clipboard | null): Promise<boolean> {
  try {
    if (!clipboard) throw new Error("no clipboard");
    await clipboard.writeText(url);
    toast.success(t("watch.share.copied"));
    return true;
  } catch {
    toast.error(t("watch.share.failed"));
    return false;
  }
}

export interface WatchShareProps {
  kind: WatchKind;
  publicUrl: string;
  slug: string;
  id: string;
  /** VODs: the playhead in whole seconds when Share opens (null while unknown). */
  currentTime?: () => number | null;
  clipboard?: Clipboard | null;
}

/**
 * Share. A clip copies its link at once. A VOD opens a small popover with the link, a "Start at
 * <time>" checkbox that adds `?t=`, and Copy link.
 */
export function WatchShare({
  kind,
  publicUrl,
  slug,
  id,
  currentTime,
  clipboard = browserClipboard(),
}: WatchShareProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [at, setAt] = React.useState<number | null>(null);
  const [withTime, setWithTime] = React.useState(false);
  const checkboxId = React.useId();
  const linkId = React.useId();
  const plain = watchUrl(publicUrl, kind, slug, id);

  if (kind === "clip")
    return (
      <IconButton
        data-testid="watch-share"
        data-url={plain}
        variant="outline"
        size="icon-sm"
        icon={Share08Icon}
        label={t("watch.share.label")}
        onClick={() => void copy(plain, clipboard)}
      />
    );

  const url = withTime && at !== null ? watchUrl(publicUrl, kind, slug, id, at) : plain;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // The time is read when Share opens, so it does not change under the visitor's cursor.
        if (next) setAt(currentTime?.() ?? null);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <IconButton
            data-testid="watch-share"
            data-url={plain}
            variant="outline"
            size="icon-sm"
            icon={Share08Icon}
            label={t("watch.share.label")}
          />
        }
      />
      <PopoverContent align="end" data-testid="watch-share-popover">
        <PopoverTitle>{t("watch.share.title")}</PopoverTitle>
        <Field>
          <FieldLabel htmlFor={linkId} className="sr-only">
            {t("watch.share.linkLabel")}
          </FieldLabel>
          <Input
            id={linkId}
            data-testid="watch-share-url"
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
        <Field orientation="horizontal" data-disabled={at === null ? true : undefined}>
          <Checkbox
            id={checkboxId}
            data-testid="watch-share-time"
            checked={withTime && at !== null}
            disabled={at === null}
            onCheckedChange={(checked) => setWithTime(checked === true)}
          />
          <FieldLabel htmlFor={checkboxId}>{t("watch.share.startAt", { time: formatDuration(at ?? 0) })}</FieldLabel>
        </Field>
        <Button
          data-testid="watch-share-copy"
          size="sm"
          onClick={() => {
            void copy(url, clipboard).then((ok) => ok && setOpen(false));
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
          {t("watch.share.copy")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export interface WatchMetaProps {
  kind: WatchKind;
  id: string;
  slug: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  /** `Vod.category` / `Clip.category`: the broadcast's category, linking to its directory page. */
  category?: { slug: string; name: string } | null;
  /** `Clip.views`; VODs have no count, so null. */
  views?: number | null;
  /** `Clip.creator`. */
  clippedBy?: { displayName: string } | null;
  publicUrl: string;
  currentTime?: () => number | null;
  clipboard?: Clipboard | null;
}

export function WatchMeta(p: WatchMetaProps): React.JSX.Element {
  const title = p.title.trim() || (p.kind === "vod" ? t("channel.tabs.untitledVideo") : t("channel.tabs.untitledClip"));
  return (
    <header data-testid="watch-meta" data-kind={p.kind} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h1 data-testid="watch-title" className="min-w-0 text-lg font-semibold break-words">
          {title}
        </h1>
        <WatchShare
          kind={p.kind}
          publicUrl={p.publicUrl}
          slug={p.slug}
          id={p.id}
          currentTime={p.currentTime}
          clipboard={p.clipboard}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {p.category ? <CategoryLink category={p.category} /> : null}
        <span data-testid="watch-meta-time">
          <span className="sr-only">{p.kind === "vod" ? t("watch.meta.recorded") : t("watch.meta.clipped")} </span>
          <RelativeTime date={p.createdAt} />
        </span>
        <span data-testid="watch-meta-duration" className="tabular-nums">
          {t("replay.watch.duration", { duration: formatDuration(p.durationSeconds) })}
        </span>
        {p.views !== null && p.views !== undefined ? (
          <span data-testid="watch-meta-views" data-count={p.views}>
            {t("watch.meta.views", { count: p.views })}
          </span>
        ) : null}
        {p.clippedBy ? (
          <span data-testid="watch-meta-clipped-by" className="flex min-w-0 items-center gap-2">
            <ChannelAvatar name={p.clippedBy.displayName} size="xs" decorative />
            <span className="min-w-0 truncate">{t("replay.watch.clippedBy", { name: p.clippedBy.displayName })}</span>
          </span>
        ) : null}
      </div>
    </header>
  );
}
