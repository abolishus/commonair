// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatCompactNumber, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { ContentBoard, type ContentBoardLabels, type VodUpdate } from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import {
  CONTENT_PAGE_SIZE,
  clipRows,
  isVisibility,
  loadAllPages,
  visibilityOptions,
  vodRows,
  type ClipDto,
  type VodDto,
} from "../lib/content.ts";
import { useLoad } from "./money/use-load.ts";

function labels(): ContentBoardLabels {
  return {
    vods: t("content.vods"),
    clips: t("content.clips"),
    vodsEmptyTitle: t("content.vodsEmpty"),
    vodsEmptyDescription: t("content.vodsEmptyHint"),
    clipsEmptyTitle: t("content.clipsEmpty"),
    clipsEmptyDescription: t("content.clipsEmptyHint"),
    vodsListLabel: t("content.vods"),
    clipsListLabel: t("content.clips"),
    title: t("content.vodTitle"),
    titleError: t("content.vodTitleError"),
    visibility: t("content.visibility"),
    visibilities: visibilityOptions(),
    save: t("content.save"),
    deleteVod: (title) => t("content.deleteVod", { title }),
    deleteVodTitle: (title) => t("content.deleteVodTitle", { title }),
    deleteVodDescription: t("content.deleteVodBody"),
    deleteClip: (title) => t("content.deleteClip", { title }),
    deleteClipTitle: (title) => t("content.deleteClipTitle", { title }),
    deleteClipDescription: t("content.deleteClipBody"),
    deleteConfirm: t("content.deleteConfirm"),
    clippedBy: (name) => t("content.clippedBy", { name }),
  };
}

/**
 * `/content`: the owner's VODs and clips (`vods.*`, `clips.*`) on `ContentBoard`. Removing a VOD
 * removes its broadcast's clips on the server, so the clip list is loaded again after it.
 */
export function ContentManager({ channel }: { channel: string }): React.JSX.Element {
  const { locale } = useLocale();
  const vods = useLoad(`vods:${channel}`, () =>
    loadAllPages((cursor) => api().vods.list({ channel, cursor, limit: CONTENT_PAGE_SIZE })),
  );
  const clips = useLoad(`clips:${channel}`, () =>
    loadAllPages((cursor) => api().clips.list({ channel, cursor, limit: CONTENT_PAGE_SIZE, sort: "recent" })),
  );
  // Local results of the owner's own actions, applied over the loaded lists until they reload.
  const [updatedVods, setUpdatedVods] = React.useState<Record<string, VodDto>>({});
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(() => new Set());

  if ((vods.data === null && vods.failed) || (clips.data === null && clips.failed))
    return (
      <AlertCallout
        data-testid="content-load-error"
        tone="danger"
        live
        description={t("content.loadFailed")}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              vods.reload();
              clips.reload();
            }}
          >
            {t("common.retry")}
          </Button>
        }
      />
    );

  const vodList: VodDto[] | null =
    vods.data?.filter((vod) => !removed.has(vod.id)).map((vod) => updatedVods[vod.id] ?? vod) ?? null;
  const clipList: ClipDto[] | null = clips.data?.filter((clip) => !removed.has(clip.id)) ?? null;

  const saveVod = async (id: string, update: VodUpdate): Promise<void> => {
    if (!isVisibility(update.visibility)) return;
    const result = await api().vods.update({ id, title: update.title, visibility: update.visibility });
    setUpdatedVods((current) => ({ ...current, [id]: result }));
    toast.success(t("content.saved"));
  };
  const deleteVod = async (id: string): Promise<void> => {
    await api().vods.remove({ id });
    setRemoved((current) => new Set(current).add(id));
    // The broadcast's clips went with it.
    clips.reload();
    toast.success(t("content.vodDeleted"));
  };
  const deleteClip = async (id: string): Promise<void> => {
    await api().clips.remove({ id });
    setRemoved((current) => new Set(current).add(id));
    toast.success(t("content.clipDeleted"));
  };

  return (
    <ContentBoard
      vods={vodList ? vodRows(vodList) : null}
      clips={
        clipList
          ? clipRows(clipList, (views) => t("content.views", { count: formatCompactNumber(views, locale) }))
          : null
      }
      labels={labels()}
      onSaveVod={saveVod}
      onDeleteVod={deleteVod}
      onDeleteClip={deleteClip}
      onError={(err) => toastActionError(err, t("content.actionFailed"))}
    />
  );
}
