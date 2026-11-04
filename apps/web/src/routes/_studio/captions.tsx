// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/captions` (ADR 0011; docs/testing/w2-selectors.md "Captions"): the channel's live captions
 * (on or off, showing the instance default it follows otherwise; the spoken language; the mask
 * list), the live track's state, the draft privacy text on transcripts, and the per-VOD cue editor
 * (text only: timing is fixed in v1). Form logic is in `player/captions-studio.ts`.
 */
import { EmptyState, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { SwitchField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Textarea } from "@commonair/ui/components/textarea";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { ClosedCaptionIcon, LockIcon, Video01Icon } from "@hugeicons/core-free-icons";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import type { dto } from "@commonair/contracts";
import type { z } from "zod";
import { LanguageLabel } from "../../components/locale/language-label.tsx";
import { StudioLoadError, StudioSection } from "../../components/interact-studio/shared.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { FocusFormAction } from "../../components/studio/empty-action.tsx";
import { StudioNote } from "../../components/studio/note.tsx";
import { t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/keys/index.gen.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode, type Api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import {
  captionsDraft,
  captionsPatch,
  parseMaskWords,
  spokenLanguages,
  type CaptionsDraft,
  type MaskError,
} from "../../player/captions-studio.ts";
import { titleHead } from "../../lib/page-title.ts";

export const Route = createFileRoute("/_studio/captions")({
  head: () => titleHead(t("pageTitle.studioCaptions")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: CaptionsPage,
});

type MediaSettings = z.infer<typeof dto.ChannelMediaSettings>;
type Vod = z.infer<typeof dto.Vod>;
type VodCaptions = z.infer<typeof dto.VodCaptions>;
type TrackState = "off" | "queued" | "active";
type CaptionsApi = Pick<Api, "channels" | "vods">;

const MASK_ERROR_KEYS: Record<MaskError["reason"] | "server", MessageKey> = {
  pattern: "captions.studio.mask.errorPattern",
  length: "captions.studio.mask.errorLength",
  count: "captions.studio.mask.errorCount",
  server: "captions.studio.mask.errorServer",
};
const TRACK_STATE_KEYS: Record<TrackState, MessageKey> = {
  off: "captions.studio.track.off",
  queued: "captions.studio.track.queued",
  active: "captions.studio.track.active",
};

/** The live track's state (`ChannelMediaSettings.captionsState`); `off` when a response lacks it. */
function trackStateOf(s: MediaSettings): TrackState {
  const v: unknown = (s as Record<string, unknown>).captionsState;
  return v === "queued" || v === "active" ? v : "off";
}

function CaptionsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = me.channelSlug ?? me.username;
  return (
    <PageContainer width="wide" data-testid="captions-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("captions.studio.pageTitle")} description={t("captions.studio.pageIntro")} />
      <CaptionsStudio key={channel} channel={channel} />
    </PageContainer>
  );
}

interface Loaded {
  settings: MediaSettings;
  language: string;
}

export function CaptionsStudio({ channel, client }: { channel: string; client?: CaptionsApi }): React.JSX.Element {
  const c = React.useMemo<CaptionsApi>(() => client ?? api(), [client]);
  const loaded = useLoad<Loaded>(channel, async () => {
    const [settings, info] = await Promise.all([c.channels.mediaSettings({ channel }), c.channels.get({ channel })]);
    return { settings, language: info.language };
  });
  if (loaded.failed)
    return (
      <StudioLoadError
        data-testid="captions-load-error"
        message={t("captions.studio.loadFailed")}
        retry={
          <Button type="button" variant="outline" size="sm" data-testid="captions-retry" onClick={loaded.reload}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  if (!loaded.data)
    return (
      <SkeletonGroup>
        <SkeletonText lines={6} />
      </SkeletonGroup>
    );
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <CaptionsSettingsForm channel={channel} client={c} loaded={loaded.data} onSaved={loaded.reload} />
      <VodCueEditor channel={channel} client={c} />
    </div>
  );
}

function CaptionsSettingsForm({
  channel,
  client,
  loaded,
  onSaved,
}: {
  channel: string;
  client: CaptionsApi;
  loaded: Loaded;
  onSaved: () => void;
}): React.JSX.Element {
  const { settings, language: channelLanguage } = loaded;
  const [draft, setDraft] = React.useState<CaptionsDraft>(() =>
    captionsDraft(settings.captions, settings.captionsInstanceDefault, channelLanguage),
  );
  const [maskError, setMaskError] = React.useState<{ line: number | null; key: MessageKey } | null>(null);
  const [pending, setPending] = React.useState(false);
  const id = React.useId();
  const state = trackStateOf(settings);
  const languages = spokenLanguages(channelLanguage);
  const switchProps = {
    "data-testid": "captions-enabled",
    "data-state": draft.enabled ? "on" : "off",
    "data-default": settings.captionsInstanceDefault ? "on" : "off",
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const parsed = parseMaskWords(draft.maskText);
    if (parsed.error) {
      setMaskError({ line: parsed.error.line, key: MASK_ERROR_KEYS[parsed.error.reason] });
      return;
    }
    setMaskError(null);
    setPending(true);
    try {
      const next = await client.channels.updateMediaSettings({
        channel,
        captions: captionsPatch(draft, parsed.words, channelLanguage),
      });
      setDraft(captionsDraft(next.captions, next.captionsInstanceDefault, channelLanguage));
      toast.success(t("captions.studio.saved"));
      onSaved();
    } catch (err) {
      if (errorCode(err) === "PRECONDITION_FAILED") setMaskError({ line: null, key: MASK_ERROR_KEYS.server });
      else toastActionError(err, t("captions.studio.saveFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      aria-label={t("captions.studio.settingsTitle")}
      className="flex flex-col gap-6"
    >
      <StudioSection
        icon={ClosedCaptionIcon}
        title={t("captions.studio.settingsTitle")}
        description={t("captions.studio.settingsIntro")}
        action={
          <StatusBadge
            data-testid="captions-track-state"
            data-state={state}
            tone={state === "active" ? "success" : state === "queued" ? "warning" : "neutral"}
          >
            {t(TRACK_STATE_KEYS[state])}
          </StatusBadge>
        }
      >
        <SwitchField
          label={t("captions.studio.enabled")}
          description={
            draft.own
              ? t("captions.studio.enabledOwn")
              : settings.captionsInstanceDefault
                ? t("captions.studio.enabledDefaultOn")
                : t("captions.studio.enabledDefaultOff")
          }
          checked={draft.enabled}
          onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled, own: true }))}
          switchProps={switchProps}
        />
        {state === "queued" && <StudioNote>{t("captions.studio.track.queuedHint")}</StudioNote>}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-language`}>{t("captions.studio.language")}</Label>
          <Select<string>
            value={draft.language}
            onValueChange={(v) => {
              if (typeof v === "string") setDraft((d) => ({ ...d, language: v }));
            }}
          >
            <SelectTrigger
              id={`${id}-language`}
              data-testid="captions-language"
              data-value={draft.language}
              aria-describedby={`${id}-language-hint`}
              className="w-full sm:w-80"
            >
              <SelectValue>{(v: string) => <LanguageLabel tag={v} />}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {languages.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  <LanguageLabel tag={tag} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={`${id}-language-hint`} className="text-sm text-muted-foreground">
            {t("captions.studio.languageHint")}
          </p>
        </div>
        <Field data-invalid={maskError ? true : undefined}>
          <FieldLabel htmlFor={`${id}-mask`}>{t("captions.studio.mask.label")}</FieldLabel>
          <Textarea
            id={`${id}-mask`}
            data-testid="captions-mask-words"
            rows={4}
            value={draft.maskText}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={maskError ? true : undefined}
            aria-describedby={`${id}-mask-hint${maskError ? ` ${id}-mask-error` : ""}`}
            onChange={(e) => {
              const maskText = e.currentTarget.value;
              setDraft((d) => ({ ...d, maskText }));
            }}
          />
          <FieldDescription id={`${id}-mask-hint`}>{t("captions.studio.mask.hint")}</FieldDescription>
          {maskError ? (
            <FieldError id={`${id}-mask-error`} data-testid="captions-mask-error" data-line={maskError.line ?? ""}>
              {maskError.line === null ? t(maskError.key) : t(maskError.key, { line: String(maskError.line) })}
            </FieldError>
          ) : null}
        </Field>
        <p className="text-sm text-muted-foreground">{t("captions.studio.cost")}</p>
        <div>
          <Button type="submit" data-testid="captions-save" disabled={pending}>
            {t("captions.studio.save")}
          </Button>
        </div>
      </StudioSection>
    </form>
  );
}

/** `HH:MM:SS` (or `MM:SS`) of a cue start, for the editor's labels. */
function cueTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const body = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${h}:${body}` : body;
}

/** Cues shown per step: a long VOD has thousands. */
const CUE_PAGE = 50;

function VodCueEditor({ channel, client }: { channel: string; client: CaptionsApi }): React.JSX.Element {
  const vods = useLoad<Vod[]>(channel, async () => {
    const page = await client.vods.list({ channel, limit: 50 });
    return page.items.filter((v) => v.captions.length > 0);
  });
  const [vodId, setVodId] = React.useState<string | null>(null);
  const selectId = React.useId();
  const list = vods.data ?? [];
  const selected = list.find((v) => v.id === vodId) ?? list[0] ?? null;
  return (
    <StudioSection
      icon={Video01Icon}
      title={t("captions.studio.vod.title")}
      description={t("captions.studio.vod.intro")}
    >
      {/* F35: the drafts' privacy note belongs to the drafts, inside their card, in the note style. */}
      <StudioNote data-testid="captions-privacy-note">{t("captions.studio.privacy")}</StudioNote>
      {vods.failed ? (
        <StudioLoadError
          data-testid="captions-vod-load-error"
          message={t("captions.studio.vod.loadFailed")}
          retry={
            <Button type="button" variant="outline" size="sm" onClick={vods.reload}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : !vods.data ? (
        <SkeletonGroup>
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : !selected ? (
        <EmptyState
          icon={LockIcon}
          title={t("captions.studio.vod.emptyTitle")}
          description={t("captions.studio.vod.emptyDescription")}
          headingLevel={3}
          action={
            <FocusFormAction selector='[data-testid="captions-enabled"]'>
              {t("studio.empty.turnOnCaptions")}
            </FocusFormAction>
          }
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={selectId}>{t("captions.studio.vod.pick")}</Label>
            <Select<string>
              value={selected.id}
              onValueChange={(v) => {
                if (typeof v === "string") setVodId(v);
              }}
            >
              <SelectTrigger id={selectId} className="w-full sm:w-96">
                <SelectValue>{(v: string) => list.find((x) => x.id === v)?.title ?? v}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {list.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CueList key={selected.id} vod={selected} client={client} />
        </div>
      )}
    </StudioSection>
  );
}

function CueList({ vod, client }: { vod: Vod; client: CaptionsApi }): React.JSX.Element {
  const language = vod.captions[0]?.language ?? "en";
  const track = useLoad<VodCaptions>(`${vod.id}:${language}`, () => client.vods.captions.get({ id: vod.id, language }));
  const [edits, setEdits] = React.useState<Record<number, string>>({});
  const [shown, setShown] = React.useState(CUE_PAGE);
  const [pending, setPending] = React.useState(false);
  if (track.failed)
    return (
      <StudioLoadError
        data-testid="captions-vod-load-error"
        message={t("captions.studio.vod.loadFailed")}
        retry={
          <Button type="button" variant="outline" size="sm" onClick={track.reload}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  if (!track.data)
    return (
      <SkeletonGroup>
        <SkeletonText lines={4} />
      </SkeletonGroup>
    );
  const data = track.data;
  const changed = data.cues
    .filter((c) => edits[c.index] !== undefined && edits[c.index] !== c.text)
    .map((c) => ({ index: c.index, text: edits[c.index] ?? c.text }));
  const save = async (): Promise<void> => {
    if (pending || changed.length === 0) return;
    setPending(true);
    try {
      await client.vods.captions.update({ id: vod.id, language, cues: changed });
      setEdits({});
      toast.success(t("captions.studio.vod.saved"));
      track.reload();
    } catch (err) {
      toastActionError(err, t("captions.studio.vod.saveFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <div data-testid="captions-vod-editor" data-vod-id={vod.id} className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("captions.studio.vod.timingFixed")}</p>
      <ol className="flex min-w-0 flex-col gap-2">
        {data.cues.slice(0, shown).map((c) => (
          <li
            key={c.index}
            data-testid="captions-cue"
            data-start-ms={String(c.startMs)}
            data-end-ms={String(c.endMs)}
            className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
          >
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {t("captions.studio.vod.cueTime", { start: cueTime(c.startMs), end: cueTime(c.endMs) })}
            </span>
            <Input
              data-testid="captions-cue-text"
              aria-label={t("captions.studio.vod.cueLabel", { start: cueTime(c.startMs) })}
              value={edits[c.index] ?? c.text}
              maxLength={500}
              autoComplete="off"
              className="min-w-0 flex-1"
              onChange={(e) => {
                const text = e.currentTarget.value;
                setEdits((prev) => ({ ...prev, [c.index]: text }));
              }}
            />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {shown < data.cues.length && (
          <Button type="button" variant="outline" size="sm" onClick={() => setShown((n) => n + CUE_PAGE)}>
            {t("captions.studio.vod.more")}
          </Button>
        )}
        <Button
          type="button"
          data-testid="captions-cue-save"
          disabled={pending || changed.length === 0}
          onClick={() => void save()}
        >
          {t("captions.studio.vod.save")}
        </Button>
      </div>
    </div>
  );
}
