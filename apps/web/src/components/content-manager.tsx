// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { ContentBoard, type ContentBoardLabels, type VodUpdate } from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import {
  CONTENT_PAGE_SIZE,
  isVisibility,
  loadAllPages,
  visibilityOptions,
  type ClipDto,
  type VodDto,
} from "../lib/content.ts";
import { clipCards, vodCards, watchPath } from "./content-library/model.ts";
import { useLoad } from "./money/use-load.ts";
import { StudioLinkAction } from "./studio/empty-action.tsx";
import { watchUrl } from "./watch/share.ts";

function labels(): ContentBoardLabels {
  return {
    vods: t("content.vods"),
    clips: t("content.clips"),
    vodsEmptyTitle: t("content.vodsEmpty"),
    vodsEmptyDescription: t("d5Content.vodsEmptyBody"),
    clipsEmptyTitle: t("content.clipsEmpty"),
    clipsEmptyDescription: t("content.clipsEmptyHint"),
    vodsListLabel: t("content.vods"),
    clipsListLabel: t("content.clips"),
    sort: t("d5Content.sort"),
    sorts: {
      newest: t("d5Content.sort.newest"),
      views: t("d5Content.sort.views"),
      clips: t("d5Content.sort.clips"),
    },
    edit: (title) => t("d5Content.edit", { title }),
    editShort: t("d5Content.editShort"),
    editTitle: t("d5Content.editTitle"),
    editDescription: t("d5Content.editDescription"),
    title: t("content.vodTitle"),
    titleError: t("content.vodTitleError"),
    visibility: t("content.visibility"),
    visibilities: visibilityOptions(),
    save: t("content.save"),
    cancel: t("d5Content.cancel"),
    copyLink: (title) => t("d5Content.copyLink", { title }),
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

/** The watch page as a router link (the cards' title). */
const renderLink = (href: string): React.ReactElement => <Link to={href} />;

/**
 * `/content`: the owner's video and clip library (`vods.*`, `clips.*`) on `ContentBoard`, every
 * page loaded as before (`loadAllPages`). Removing a video removes its broadcast's clips on the
 * server, so the clip list is loaded again after it.
 */
export function ContentManager({ channel }: { channel: string }): React.JSX.Element {
  const { locale } = useLocale();
  const { config } = useBootstrap();
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
  const slugOf = (kind: "vod" | "clip", id: string): string =>
    (kind === "vod"
      ? vodList?.find((v) => v.id === id)?.channelSlug
      : clipList?.find((c) => c.id === id)?.channelSlug) ?? channel;

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
  const copyLink = (kind: "vod" | "clip", id: string): void => {
    const url = config.publicUrl
      ? watchUrl(config.publicUrl, kind, slugOf(kind, id), id)
      : `${window.location.origin}${watchPath(kind, slugOf(kind, id), id)}`;
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => toast.success(t("d5Content.linkCopied")),
        () => toast.error(t("d5Content.linkCopyFailed")),
      );
  };

  return (
    <ContentBoard
      vods={vodList ? vodCards(vodList, clipList, locale) : null}
      clips={clipList ? clipCards(clipList, locale) : null}
      labels={labels()}
      onSaveVod={saveVod}
      onDeleteVod={deleteVod}
      onDeleteClip={deleteClip}
      onCopyLink={copyLink}
      onError={(err) => toastActionError(err, t("content.actionFailed"))}
      renderLink={renderLink}
      // F25: recording is a stream setting; clips come from live viewers, so both go to the stream.
      emptyActions={{
        vods: <StudioLinkAction to="/dashboard/settings">{t("studio.empty.turnOnRecording")}</StudioLinkAction>,
        clips: <StudioLinkAction to="/dashboard">{t("studio.empty.openStreamManager")}</StudioLinkAction>,
      }}
    />
  );
}
