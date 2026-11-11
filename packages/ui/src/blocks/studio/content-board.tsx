// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Delete02Icon, Edit02Icon, Link01Icon, Scissor01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@commonair/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { cn } from "@commonair/ui/lib/utils";
import { MediaFallback } from "../../art/media-fallback.tsx";
import { formatDuration } from "../../lib/format.ts";
import { TargetLink } from "../../lib/link.tsx";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { EmptyState } from "../../primitives/empty-state.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { OverlayBadge } from "../../primitives/overlay-badge.tsx";
import { RelativeTime } from "../../primitives/relative-time.tsx";
import { MediaCardSkeleton } from "../../primitives/skeletons.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { SelectField, type SelectFieldOption } from "../forms/select-field.tsx";

/** `VOD_STATUSES` / `CLIP_STATUSES` → badge tone. */
export function mediaStatusTone(status: string): StatusTone {
  if (status === "ready") return "success";
  if (status === "recording") return "info";
  if (status === "processing") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}

export interface VodRowData {
  id: string;
  title: string;
  /** `VISIBILITIES` value. */
  visibility: string;
  /** "Public", "Subscribers", "Only me". */
  visibilityLabel?: React.ReactNode;
  /** `VOD_STATUSES` value. */
  status: string;
  statusLabel: string;
  durationSeconds: number;
  createdAt: string;
  thumbnailUrl?: string | null;
  /** `Vod.views`, for sorting; `viewsLabel` is what shows. */
  views?: number;
  /** "312 views", formatted by the page. */
  viewsLabel?: React.ReactNode;
  /** Clips cut from this video, for sorting; `clipsLabel` is what shows. */
  clips?: number;
  clipsLabel?: React.ReactNode;
  /** The watch page; null while the video cannot play (recording, processing, failed). */
  href?: string | null;
}

export interface ClipRowData {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  durationSeconds: number;
  createdAt: string;
  /** The clipper's display name; `null` when unknown. */
  creatorName: string | null;
  views?: number;
  /** "1.2K views", formatted by the page. */
  viewsLabel?: React.ReactNode;
  thumbnailUrl?: string | null;
  href?: string | null;
}

export interface VodUpdate {
  title: string;
  visibility: string;
}

export type ContentTab = "vods" | "clips";
/** The library's order: newest first, most watched, or (videos) most clipped. */
export type ContentSort = "newest" | "views" | "clips";
export const CONTENT_SORTS = ["newest", "views", "clips"] as const satisfies readonly ContentSort[];
const isSort = (value: string): value is ContentSort => (CONTENT_SORTS as readonly string[]).includes(value);

/** Pure: items in `sort` order; ties (and `newest`) go newest first, then by id for stability. */
export function sortContent<T extends { id: string; createdAt: string; views?: number; clips?: number }>(
  items: readonly T[],
  sort: ContentSort,
): T[] {
  const newest = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  const by = (key: "views" | "clips") => (a: T, b: T) => (b[key] ?? 0) - (a[key] ?? 0) || newest(a, b);
  return [...items].sort(sort === "newest" ? newest : by(sort));
}

export interface ContentBoardLabels {
  vods: React.ReactNode;
  clips: React.ReactNode;
  vodsEmptyTitle: React.ReactNode;
  vodsEmptyDescription?: React.ReactNode;
  clipsEmptyTitle: React.ReactNode;
  clipsEmptyDescription?: React.ReactNode;
  vodsListLabel: string;
  clipsListLabel: string;
  /** The sort select's label and one label per `CONTENT_SORTS` entry. */
  sort: React.ReactNode;
  sorts: Record<ContentSort, string>;
  /** Accessible name of a card's edit button. */
  edit: (title: string) => string;
  /** The visible text of the edit button. */
  editShort: string;
  editTitle: React.ReactNode;
  editDescription?: React.ReactNode;
  title: string;
  titleError: React.ReactNode;
  visibility: React.ReactNode;
  /** `VISIBILITIES` with labels. */
  visibilities: readonly SelectFieldOption[];
  save: string;
  cancel: string;
  /** Accessible name and tooltip of a card's copy-link button. */
  copyLink: (title: string) => string;
  /** Accessible name of a row's delete button. */
  deleteVod: (title: string) => string;
  deleteVodTitle: (title: string) => React.ReactNode;
  /** Say that the broadcast's clips go with it. */
  deleteVodDescription?: React.ReactNode;
  deleteClip: (title: string) => string;
  deleteClipTitle: (title: string) => React.ReactNode;
  deleteClipDescription?: React.ReactNode;
  deleteConfirm: string;
  /** "Clipped by {name}". */
  clippedBy: (name: string) => React.ReactNode;
}

export interface ContentBoardProps extends Omit<React.ComponentProps<"div">, "children" | "onError"> {
  /** `null` while loading. */
  vods: readonly VodRowData[] | null;
  clips: readonly ClipRowData[] | null;
  labels: ContentBoardLabels;
  tab?: ContentTab;
  defaultTab?: ContentTab;
  onTabChange?: (tab: ContentTab) => void;
  onSaveVod: (id: string, update: VodUpdate) => void | Promise<void>;
  onDeleteVod: (id: string) => void | Promise<void>;
  onDeleteClip: (id: string) => void | Promise<void>;
  /** Copy the item's watch link; without it no copy button shows. */
  onCopyLink?: (kind: "vod" | "clip", id: string) => void;
  onError?: (error: unknown) => void;
  /** Each empty list's way forward (F25), e.g. "Open stream settings" to turn recording on. */
  emptyActions?: { vods?: React.ReactNode; clips?: React.ReactNode };
  /** A router link for a card's title (Base UI `render`); plain anchors without it. */
  renderLink?: (href: string) => React.ReactElement;
}

const TITLE_MAX = 140;

const STRETCHED =
  "outline-none after:absolute after:inset-0 after:z-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background";

function CardTitle({
  title,
  href,
  renderLink,
}: {
  title: string;
  href: string | null | undefined;
  renderLink?: (href: string) => React.ReactElement;
}): React.JSX.Element {
  const target = href ? { href, render: renderLink?.(href) } : {};
  return (
    <h3 dir="auto" className="line-clamp-2 text-sm leading-snug font-medium break-words">
      <TargetLink target={target} className={cn(href && STRETCHED)} data-slot="content-card-link">
        {title}
      </TargetLink>
    </h3>
  );
}

function Thumbnail({
  url,
  duration,
  kind,
}: {
  url: string | null | undefined;
  duration: number;
  kind: "vod" | "clip";
}): React.JSX.Element {
  const [failed, setFailed] = React.useState<string | null>(null);
  const show = Boolean(url) && failed !== url;
  return (
    <div className="relative aspect-video w-full overflow-hidden bg-muted">
      {show ? (
        <img
          src={url ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(url ?? null)}
          className="size-full object-cover"
        />
      ) : (
        <MediaFallback kind="vod" />
      )}
      <OverlayBadge aria-hidden className="absolute start-2 top-2">
        <HugeiconsIcon icon={kind === "clip" ? Scissor01Icon : Video01Icon} strokeWidth={2} aria-hidden />
      </OverlayBadge>
      <OverlayBadge data-slot="content-duration" className="absolute end-2 bottom-2 tabular-nums">
        {formatDuration(duration)}
      </OverlayBadge>
    </div>
  );
}

/** One line of facts: each part separated by a dot, the time last. */
function Meta({ parts, createdAt }: { parts: React.ReactNode[]; createdAt: string }): React.JSX.Element {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
      {shown.map((part, i) => (
        <React.Fragment key={i}>
          <span>{part}</span>
          <span aria-hidden>·</span>
        </React.Fragment>
      ))}
      <RelativeTime date={createdAt} />
    </p>
  );
}

const CARD = "relative flex min-w-0 flex-col gap-2 overflow-hidden border bg-card pb-2";

function VodCard({
  vod,
  labels,
  onEdit,
  onDelete,
  onCopyLink,
  onError,
  renderLink,
}: {
  vod: VodRowData;
  labels: ContentBoardLabels;
  onEdit: () => void;
  onDelete: ContentBoardProps["onDeleteVod"];
  onCopyLink?: ContentBoardProps["onCopyLink"];
  onError?: (error: unknown) => void;
  renderLink?: ContentBoardProps["renderLink"];
}): React.JSX.Element {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <li
      data-testid="vod-row"
      data-vod-id={vod.id}
      data-visibility={vod.visibility}
      data-status={vod.status}
      className={CARD}
    >
      <Thumbnail url={vod.thumbnailUrl} duration={vod.durationSeconds} kind="vod" />
      <div className="flex min-w-0 flex-col gap-1 px-3">
        <CardTitle title={vod.title} href={vod.href} renderLink={renderLink} />
        <Meta parts={[vod.viewsLabel, vod.clipsLabel]} createdAt={vod.createdAt} />
        <div className="flex flex-wrap items-center gap-1">
          {vod.visibilityLabel ? (
            <Badge variant="outline" data-slot="content-visibility">
              {vod.visibilityLabel}
            </Badge>
          ) : null}
          {vod.status !== "ready" ? (
            <StatusBadge tone={mediaStatusTone(vod.status)}>{vod.statusLabel}</StatusBadge>
          ) : null}
        </div>
      </div>
      {/* Above the stretched title link, so the actions stay clickable. */}
      <div className="relative z-10 mt-auto flex items-center gap-1 px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="vod-edit"
          aria-label={labels.edit(vod.title)}
          onClick={onEdit}
        >
          <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {labels.editShort}
        </Button>
        <span className="flex-1" />
        {onCopyLink && vod.href ? (
          <IconButton
            size="icon-sm"
            icon={Link01Icon}
            label={labels.copyLink(vod.title)}
            data-testid="vod-copy-link"
            onClick={() => onCopyLink("vod", vod.id)}
          />
        ) : null}
        <IconButton
          size="icon-sm"
          icon={Delete02Icon}
          label={labels.deleteVod(vod.title)}
          data-testid="vod-delete"
          onClick={() => setConfirming(true)}
        />
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={labels.deleteVodTitle(vod.title)}
          description={labels.deleteVodDescription}
          confirmLabel={labels.deleteConfirm}
          variant="destructive"
          onConfirm={() => onDelete(vod.id)}
          onError={onError}
        />
      </div>
    </li>
  );
}

function ClipCard({
  clip,
  labels,
  onDelete,
  onCopyLink,
  onError,
  renderLink,
}: {
  clip: ClipRowData;
  labels: ContentBoardLabels;
  onDelete: ContentBoardProps["onDeleteClip"];
  onCopyLink?: ContentBoardProps["onCopyLink"];
  onError?: (error: unknown) => void;
  renderLink?: ContentBoardProps["renderLink"];
}): React.JSX.Element {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <li data-testid="clip-row" data-clip-id={clip.id} data-status={clip.status} className={CARD}>
      <Thumbnail url={clip.thumbnailUrl} duration={clip.durationSeconds} kind="clip" />
      <div className="flex min-w-0 flex-col gap-1 px-3">
        <CardTitle title={clip.title} href={clip.href} renderLink={renderLink} />
        <Meta
          parts={[clip.creatorName ? labels.clippedBy(clip.creatorName) : null, clip.viewsLabel]}
          createdAt={clip.createdAt}
        />
        {clip.status !== "ready" ? (
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge tone={mediaStatusTone(clip.status)}>{clip.statusLabel}</StatusBadge>
          </div>
        ) : null}
      </div>
      <div className="relative z-10 mt-auto flex items-center justify-end gap-1 px-2">
        {onCopyLink && clip.href ? (
          <IconButton
            size="icon-sm"
            icon={Link01Icon}
            label={labels.copyLink(clip.title)}
            data-testid="clip-copy-link"
            onClick={() => onCopyLink("clip", clip.id)}
          />
        ) : null}
        <IconButton
          size="icon-sm"
          icon={Delete02Icon}
          label={labels.deleteClip(clip.title)}
          data-testid="clip-delete"
          onClick={() => setConfirming(true)}
        />
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={labels.deleteClipTitle(clip.title)}
          description={labels.deleteClipDescription}
          confirmLabel={labels.deleteConfirm}
          variant="destructive"
          onConfirm={() => onDelete(clip.id)}
          onError={onError}
        />
      </div>
    </li>
  );
}

/**
 * The video edit sheet: title and visibility, one Save. `vod-edit-sheet` carries the video's
 * `data-vod-id`; inside are `vod-title`, `vod-visibility` and `vod-save`.
 */
function EditSheet({
  vod,
  labels,
  onClose,
  onSave,
  onError,
}: {
  vod: VodRowData | null;
  labels: ContentBoardLabels;
  onClose: () => void;
  onSave: ContentBoardProps["onSaveVod"];
  onError?: (error: unknown) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [draft, setDraft] = React.useState<VodUpdate>({ title: vod?.title ?? "", visibility: vod?.visibility ?? "" });
  const [shownFor, setShownFor] = React.useState<{ id: string; title: string; visibility: string } | null>(null);
  const [saving, setSaving] = React.useState(false);
  // A new video, or the server's copy of this one, replaces the draft (adjusting state during render).
  const key = vod ? { id: vod.id, title: vod.title, visibility: vod.visibility } : null;
  if (key && (shownFor?.id !== key.id || shownFor.title !== key.title || shownFor.visibility !== key.visibility)) {
    setShownFor(key);
    setDraft({ title: key.title, visibility: key.visibility });
  }
  const titleInvalid = draft.title.trim() === "" || draft.title.length > TITLE_MAX;
  const dirty = vod !== null && (draft.title.trim() !== vod.title || draft.visibility !== vod.visibility);
  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!vod || !dirty || titleInvalid || saving) return;
    setSaving(true);
    try {
      await onSave(vod.id, { title: draft.title.trim(), visibility: draft.visibility });
      onClose();
    } catch (caught) {
      onError?.(caught);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet
      open={vod !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" data-testid="vod-edit-sheet" data-vod-id={vod?.id ?? ""}>
        <form onSubmit={(event) => void save(event)} className="flex h-full min-h-0 flex-col">
          <SheetHeader>
            <SheetTitle>{labels.editTitle}</SheetTitle>
            {labels.editDescription ? <SheetDescription>{labels.editDescription}</SheetDescription> : null}
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
            <Field data-invalid={titleInvalid || undefined}>
              <FieldLabel htmlFor={`${id}-title`}>{labels.title}</FieldLabel>
              <Input
                id={`${id}-title`}
                data-testid="vod-title"
                maxLength={TITLE_MAX}
                value={draft.title}
                aria-invalid={titleInvalid || undefined}
                onChange={(event) => {
                  const title = event.currentTarget.value;
                  setDraft((current) => ({ ...current, title }));
                }}
              />
              {titleInvalid ? <FieldError>{labels.titleError}</FieldError> : null}
            </Field>
            <SelectField
              label={labels.visibility}
              options={labels.visibilities.map((option) => ({
                ...option,
                "data-testid": `vod-visibility-option-${option.value}`,
              }))}
              value={draft.visibility}
              onValueChange={(visibility) => setDraft((current) => ({ ...current, visibility }))}
              data-testid="vod-visibility"
              data-value={draft.visibility}
            />
          </div>
          <SheetFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {labels.cancel}
            </Button>
            <Button
              type="submit"
              data-testid="vod-save"
              disabled={!dirty || titleInvalid || saving}
              aria-busy={saving || undefined}
            >
              {labels.save}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function SortBar({
  value,
  options,
  labels,
  onChange,
}: {
  value: ContentSort;
  options: readonly ContentSort[];
  labels: ContentBoardLabels;
  onChange: (sort: ContentSort) => void;
}): React.JSX.Element {
  return (
    <SelectField
      className="sm:w-56"
      orientation="horizontal"
      label={labels.sort}
      options={options.map((v) => ({ value: v, label: labels.sorts[v], "data-testid": `content-sort-option-${v}` }))}
      value={value}
      onValueChange={(v) => {
        if (isSort(v)) onChange(v);
      }}
      data-testid="content-sort"
      data-value={value}
    />
  );
}

const GRID = "grid min-w-0 grid-cols-1 gap-4 @lg:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4";

function Loading({ kind }: { kind: "vod" | "clip" }): React.JSX.Element {
  return (
    <div className="@container min-w-0" aria-busy="true">
      <div className={GRID}>
        {Array.from({ length: 4 }, (_, i) => (
          <MediaCardSkeleton key={i} kind={kind} />
        ))}
      </div>
    </div>
  );
}

/**
 * The studio's content library: video and clip tabs, each a grid of cards with the thumbnail,
 * length, views, date and (videos) visibility and clip count, sorted by newest, most watched or
 * most clipped. A video's title and visibility change in a side sheet; videos and clips are
 * deleted after a `ConfirmDialog`. Test ids (docs/testing/e6-selectors.md and d5-content): tabs
 * `content-tab-vods` / `content-tab-clips`, panels `content-vods` / `content-clips` (both stay
 * mounted, the inactive one `hidden`), `vod-row` (`data-vod-id`, `data-visibility`,
 * `data-status`) with `vod-edit`, `vod-copy-link` and `vod-delete`; `vod-edit-sheet` with
 * `vod-title`, `vod-visibility`, `vod-save`; `clip-row` (`data-clip-id`) with `clip-copy-link`
 * and `clip-delete`; `content-sort`; the two `content-empty` states differ by `data-kind`.
 */
export function ContentBoard({
  vods,
  clips,
  labels,
  tab,
  defaultTab = "vods",
  onTabChange,
  onSaveVod,
  onDeleteVod,
  onDeleteClip,
  onCopyLink,
  onError,
  emptyActions,
  renderLink,
  className,
  ...props
}: ContentBoardProps): React.JSX.Element {
  const [vodSort, setVodSort] = React.useState<ContentSort>("newest");
  const [clipSort, setClipSort] = React.useState<ContentSort>("newest");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editing = vods?.find((v) => v.id === editingId) ?? null;
  const sortedVods = React.useMemo(() => (vods ? sortContent(vods, vodSort) : null), [vods, vodSort]);
  const sortedClips = React.useMemo(() => (clips ? sortContent(clips, clipSort) : null), [clips, clipSort]);
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <Tabs
        value={tab}
        defaultValue={tab === undefined ? defaultTab : undefined}
        onValueChange={(value) => {
          if (value === "vods" || value === "clips") onTabChange?.(value);
        }}
      >
        <TabsList>
          <TabsTrigger value="vods" data-testid="content-tab-vods">
            {labels.vods}
          </TabsTrigger>
          <TabsTrigger value="clips" data-testid="content-tab-clips">
            {labels.clips}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="vods" data-testid="content-vods" keepMounted className="flex min-w-0 flex-col gap-4">
          {sortedVods === null ? (
            <Loading kind="vod" />
          ) : sortedVods.length === 0 ? (
            <EmptyState
              data-testid="content-empty"
              data-kind="vods"
              icon={Video01Icon}
              title={labels.vodsEmptyTitle}
              description={labels.vodsEmptyDescription}
              headingLevel={3}
              action={emptyActions?.vods}
            />
          ) : (
            <>
              {sortedVods.length > 1 ? (
                <SortBar value={vodSort} options={CONTENT_SORTS} labels={labels} onChange={setVodSort} />
              ) : null}
              <div className="@container min-w-0">
                <ul aria-label={labels.vodsListLabel} className={GRID}>
                  {sortedVods.map((vod) => (
                    <VodCard
                      key={vod.id}
                      vod={vod}
                      labels={labels}
                      onEdit={() => setEditingId(vod.id)}
                      onDelete={onDeleteVod}
                      onCopyLink={onCopyLink}
                      onError={onError}
                      renderLink={renderLink}
                    />
                  ))}
                </ul>
              </div>
            </>
          )}
        </TabsContent>
        <TabsContent value="clips" data-testid="content-clips" keepMounted className="flex min-w-0 flex-col gap-4">
          {sortedClips === null ? (
            <Loading kind="clip" />
          ) : sortedClips.length === 0 ? (
            <EmptyState
              data-testid="content-empty"
              data-kind="clips"
              icon={Scissor01Icon}
              title={labels.clipsEmptyTitle}
              description={labels.clipsEmptyDescription}
              headingLevel={3}
              action={emptyActions?.clips}
            />
          ) : (
            <>
              {sortedClips.length > 1 ? (
                <SortBar
                  value={clipSort}
                  options={CONTENT_SORTS.filter((s) => s !== "clips")}
                  labels={labels}
                  onChange={setClipSort}
                />
              ) : null}
              <div className="@container min-w-0">
                <ul aria-label={labels.clipsListLabel} className={GRID}>
                  {sortedClips.map((clip) => (
                    <ClipCard
                      key={clip.id}
                      clip={clip}
                      labels={labels}
                      onDelete={onDeleteClip}
                      onCopyLink={onCopyLink}
                      onError={onError}
                      renderLink={renderLink}
                    />
                  ))}
                </ul>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
      {/* Mounted only while a video is being edited: each opening starts from that video's copy. */}
      {editing ? (
        <EditSheet
          vod={editing}
          labels={labels}
          onClose={() => setEditingId(null)}
          onSave={onSaveVod}
          onError={onError}
        />
      ) : null}
    </div>
  );
}
