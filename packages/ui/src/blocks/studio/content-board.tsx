// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Delete02Icon, Scissor01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { cn } from "@commonair/ui/lib/utils";
import { formatDuration } from "../../lib/format.ts";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { EmptyState } from "../../primitives/empty-state.tsx";
import { RelativeTime } from "../../primitives/relative-time.tsx";
import { SkeletonGroup, SkeletonText } from "../../primitives/skeletons.tsx";
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
  /** `VOD_STATUSES` value. */
  status: string;
  statusLabel: string;
  durationSeconds: number;
  createdAt: string;
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
  /** "1.2K views", formatted by the page. */
  viewsLabel?: React.ReactNode;
}

export interface VodUpdate {
  title: string;
  visibility: string;
}

export type ContentTab = "vods" | "clips";

export interface ContentBoardLabels {
  vods: React.ReactNode;
  clips: React.ReactNode;
  vodsEmptyTitle: React.ReactNode;
  vodsEmptyDescription?: React.ReactNode;
  clipsEmptyTitle: React.ReactNode;
  clipsEmptyDescription?: React.ReactNode;
  vodsListLabel: string;
  clipsListLabel: string;
  title: string;
  titleError: React.ReactNode;
  visibility: React.ReactNode;
  /** `VISIBILITIES` with labels. */
  visibilities: readonly SelectFieldOption[];
  save: string;
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
  onError?: (error: unknown) => void;
}

const TITLE_MAX = 140;

function VodRow({
  vod,
  labels,
  onSave,
  onDelete,
  onError,
}: {
  vod: VodRowData;
  labels: ContentBoardLabels;
  onSave: ContentBoardProps["onSaveVod"];
  onDelete: ContentBoardProps["onDeleteVod"];
  onError?: (error: unknown) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [saved, setSaved] = React.useState<VodUpdate>({ title: vod.title, visibility: vod.visibility });
  const [draft, setDraft] = React.useState<VodUpdate>(saved);
  const [saving, setSaving] = React.useState(false);
  // The server's copy replaces the draft whenever it changes (adjusting state during render).
  if (saved.title !== vod.title || saved.visibility !== vod.visibility) {
    const next = { title: vod.title, visibility: vod.visibility };
    setSaved(next);
    setDraft(next);
  }
  const titleInvalid = draft.title.trim() === "" || draft.title.length > TITLE_MAX;
  const dirty = draft.title.trim() !== saved.title || draft.visibility !== saved.visibility;
  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!dirty || titleInvalid || saving) return;
    setSaving(true);
    try {
      await onSave(vod.id, { title: draft.title.trim(), visibility: draft.visibility });
    } catch (caught) {
      onError?.(caught);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Item
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
      role="listitem"
      variant="outline"
      data-testid="vod-row"
      data-vod-id={vod.id}
      data-visibility={vod.visibility}
      data-status={vod.status}
      className="items-start"
    >
      <ItemContent className="min-w-0">
        <form
          aria-label={vod.title}
          onSubmit={(event) => void save(event)}
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
        >
          <Field className="min-w-0 flex-1" data-invalid={titleInvalid || undefined}>
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
          </Field>
          <SelectField
            className="sm:w-44"
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
          <div className="flex gap-2">
            <Button
              type="submit"
              data-testid="vod-save"
              disabled={!dirty || titleInvalid || saving}
              aria-busy={saving || undefined}
            >
              {labels.save}
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="vod-delete"
                  aria-label={labels.deleteVod(vod.title)}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
                </Button>
              }
              title={labels.deleteVodTitle(vod.title)}
              description={labels.deleteVodDescription}
              confirmLabel={labels.deleteConfirm}
              variant="destructive"
              onConfirm={() => onDelete(vod.id)}
              onError={onError}
            />
          </div>
        </form>
        <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge tone={mediaStatusTone(vod.status)}>{vod.statusLabel}</StatusBadge>
          <span className="tabular-nums">{formatDuration(vod.durationSeconds)}</span>
          <RelativeTime date={vod.createdAt} />
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * The studio's content page: VOD and clip tabs; VOD rows edit the title and visibility and delete
 * (confirmed), clip rows delete (confirmed). Renders the spec's `content-*`, `vod-*` and `clip-*`
 * test ids (docs/testing/e6-selectors.md); the tabs are `content-tab-vods` / `content-tab-clips`.
 * Both panels stay mounted (the inactive one `hidden`) so either list's ids are always queryable;
 * the two `content-empty` states differ by `data-kind` (`vods` / `clips`).
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
  onError,
  className,
  ...props
}: ContentBoardProps): React.JSX.Element {
  const loading = (
    <SkeletonGroup>
      <SkeletonText lines={5} />
    </SkeletonGroup>
  );
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
        <TabsContent value="vods" data-testid="content-vods" keepMounted className="min-w-0">
          {vods === null ? (
            loading
          ) : vods.length === 0 ? (
            <EmptyState
              data-testid="content-empty"
              data-kind="vods"
              icon={Video01Icon}
              title={labels.vodsEmptyTitle}
              description={labels.vodsEmptyDescription}
              headingLevel={3}
            />
          ) : (
            <ItemGroup aria-label={labels.vodsListLabel} className="gap-2">
              {vods.map((vod) => (
                <VodRow
                  key={vod.id}
                  vod={vod}
                  labels={labels}
                  onSave={onSaveVod}
                  onDelete={onDeleteVod}
                  onError={onError}
                />
              ))}
            </ItemGroup>
          )}
        </TabsContent>
        <TabsContent value="clips" data-testid="content-clips" keepMounted className="min-w-0">
          {clips === null ? (
            loading
          ) : clips.length === 0 ? (
            <EmptyState
              data-testid="content-empty"
              data-kind="clips"
              icon={Scissor01Icon}
              title={labels.clipsEmptyTitle}
              description={labels.clipsEmptyDescription}
              headingLevel={3}
            />
          ) : (
            <ItemGroup aria-label={labels.clipsListLabel} className="gap-2">
              {clips.map((clip) => (
                <Item
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
                  role="listitem"
                  key={clip.id}
                  variant="outline"
                  size="sm"
                  data-testid="clip-row"
                  data-clip-id={clip.id}
                  data-status={clip.status}
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="flex-wrap wrap-anywhere">{clip.title}</ItemTitle>
                    <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <StatusBadge tone={mediaStatusTone(clip.status)}>{clip.statusLabel}</StatusBadge>
                      <span className="tabular-nums">{formatDuration(clip.durationSeconds)}</span>
                      {clip.creatorName ? <span>{labels.clippedBy(clip.creatorName)}</span> : null}
                      {clip.viewsLabel ? <span>{clip.viewsLabel}</span> : null}
                      <RelativeTime date={clip.createdAt} />
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          data-testid="clip-delete"
                          aria-label={labels.deleteClip(clip.title)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
                        </Button>
                      }
                      title={labels.deleteClipTitle(clip.title)}
                      description={labels.deleteClipDescription}
                      confirmLabel={labels.deleteConfirm}
                      variant="destructive"
                      onConfirm={() => onDeleteClip(clip.id)}
                      onError={onError}
                    />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
