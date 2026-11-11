// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Edit stream info" (F21): the stream's title, category (a combobox over `categories.list`) and
 * tags, plus the channel's social links (the About tab's list, at most `MAX_CHANNEL_SOCIALS`, in
 * order), saved with `channels.update`. The save is optimistic: the "Viewers see" line shows the
 * new values at once and goes back to the stored ones if the call fails (with a toast); the form
 * keeps what was typed so a retry is one click.
 */
import type { Category, Channel } from "@commonair/contracts/dto";
import { ChannelSocial, MAX_CHANNEL_SOCIALS, SOCIAL_PLATFORMS } from "@commonair/contracts/shapes";
import { IconButton, SkeletonText } from "@commonair/ui";
import { TagsField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@commonair/ui/components/combobox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, ArrowDown01Icon, ArrowUp01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { platformName } from "../channel/about.tsx";
import { StudioNote } from "./note.tsx";

/** The contract's limits on stream info (`ChannelUpdate`). */
export const STREAM_INFO_LIMITS = { titleMax: 140, tagMax: 25, tagsMax: 10 } as const;
const TAG = /^[\p{L}\p{N}-]+$/u;

export interface StreamInfo {
  title: string;
  category: { id: string; name: string } | null;
  tags: string[];
  /** The About tab's links, in order. */
  socials: ChannelSocial[];
}

export interface StreamInfoClient {
  get: (channel: string) => Promise<StreamInfo>;
  update: (channel: string, info: StreamInfo) => Promise<StreamInfo>;
  /** Categories matching `q` (all, busiest first, when empty). */
  categories: (q: string) => Promise<{ id: string; name: string }[]>;
}

const infoOf = (c: Pick<Channel, "title" | "category" | "tags" | "socials">): StreamInfo => ({
  title: c.title,
  category: c.category ? { id: c.category.id, name: c.category.name } : null,
  tags: [...c.tags],
  socials: c.socials.map((s) => ({ ...s })),
});

export const apiStreamInfoClient: StreamInfoClient = {
  get: async (channel) => infoOf(await api().channels.get({ channel })),
  update: async (channel, info) =>
    infoOf(
      await api().channels.update({
        channel,
        title: info.title,
        categoryId: info.category?.id ?? null,
        tags: info.tags,
        // The whole list: the server replaces it.
        socials: info.socials,
      }),
    ),
  categories: async (q) =>
    (await api().categories.list({ limit: 50, ...(q ? { q } : {}) })).items.map((c: Category) => ({
      id: c.id,
      name: c.name,
    })),
};

/** Why a draft cannot be saved, or null. Tags the contract would refuse are caught here first. */
export function streamInfoError(info: StreamInfo): string | null {
  if (info.title.trim().length > STREAM_INFO_LIMITS.titleMax) return t("studio.info.titleTooLong");
  if (info.tags.length > STREAM_INFO_LIMITS.tagsMax) return t("studio.info.tooManyTags");
  if (info.tags.some((tag) => tag.length > STREAM_INFO_LIMITS.tagMax || !TAG.test(tag))) return t("studio.info.badTag");
  if (socialErrors(info.socials).some((e) => e !== null)) return t("fuChannel.editor.fixLinks");
  return null;
}

/** Each link's problem (the contract's `ChannelSocial` check on the trimmed address), or null. */
export function socialErrors(socials: readonly ChannelSocial[]): (string | null)[] {
  return socials.map((s) =>
    ChannelSocial.safeParse({ ...s, url: s.url.trim() }).success ? null : t("fuChannel.editor.badUrl"),
  );
}

/** Moves item `from` one place up (-1) or down (+1); out-of-range moves return a copy unchanged. */
export function moveItem<T>(list: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  const next = [...list];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return next;
  [next[from], next[to]] = [next[to] as T, next[from] as T];
  return next;
}

/** The editor's title input, for "Add a title" in the go-live checklist. */
export const STREAM_INFO_TITLE_ID = "stream-info-title";

/** Moves focus to the editor's title (scrolling it into view); false when it is not on the page. */
export function focusStreamInfoTitle(doc: Document = document): boolean {
  const input = doc.getElementById(STREAM_INFO_TITLE_ID);
  if (!input) return false;
  input.scrollIntoView({ block: "center", behavior: "smooth" });
  input.focus({ preventScroll: true });
  return true;
}

export function StreamInfoEditor({
  channel,
  client = apiStreamInfoClient,
  onSaved,
}: {
  channel: string;
  client?: StreamInfoClient;
  /** After a save the server accepted (the checklist re-reads its steps). */
  onSaved?: () => void;
}): React.JSX.Element {
  const [stored, setStored] = React.useState<StreamInfo | null>(null);
  // What viewers see: the stored info, or the pending save's while it is in flight (optimistic).
  const [shown, setShown] = React.useState<StreamInfo | null>(null);
  const [draft, setDraft] = React.useState<StreamInfo | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  // Retry bumps this to load again.
  const [attempt, setAttempt] = React.useState(0);
  // Each load remounts the links field, so its row keys start from the loaded list.
  const [loads, setLoads] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = React.useState("");
  const id = React.useId();

  React.useEffect(() => {
    let live = true;
    client.get(channel).then(
      (info) => {
        if (!live) return;
        setStored(info);
        setShown(info);
        setDraft(info);
        setLoads((n) => n + 1);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [channel, client, attempt]);

  // The category list follows what is typed, a beat after typing stops.
  React.useEffect(() => {
    let live = true;
    const handle = window.setTimeout(() => {
      client.categories(query.trim()).then(
        (list) => {
          if (live) setCategories(list);
        },
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(handle);
    };
  }, [client, query]);

  const error = draft ? streamInfoError(draft) : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!draft || !stored || error || saving) return;
    const next = {
      ...draft,
      title: draft.title.trim(),
      socials: draft.socials.map((s) => ({ ...s, url: s.url.trim() })),
    };
    const before = stored;
    setShown(next);
    setSaving(true);
    try {
      const saved = await client.update(channel, next);
      setStored(saved);
      setShown(saved);
      setSubmitted(false);
      toast.success(t("studio.info.saved"));
      onSaved?.();
    } catch (err) {
      // Roll back what viewers are told they see; the form keeps the draft for a retry.
      setShown(before);
      toastActionError(err, t("studio.info.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const options =
    draft?.category && !categories.some((c) => c.id === draft.category?.id)
      ? [draft.category, ...categories]
      : categories;
  const nameOf = (cid: string) => options.find((c) => c.id === cid)?.name ?? "";

  return (
    <Card data-testid="stream-info" aria-busy={!draft && !loadFailed}>
      <CardHeader>
        <CardTitle>{t("studio.info.title")}</CardTitle>
        <CardDescription>{t("studio.info.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loadFailed ? (
          <SectionLoadError
            section={t("d5Dashboard.info.section")}
            load={{
              reload: () => {
                setLoadFailed(false);
                setAttempt((n) => n + 1);
              },
            }}
            headingLevel={3}
            data-testid="stream-info-error"
            retryTestId="stream-info-retry"
          />
        ) : !draft || !shown ? (
          <SkeletonText lines={4} />
        ) : (
          <form onSubmit={(e) => void save(e)} noValidate>
            <FieldGroup>
              <StudioNote
                data-testid="stream-info-shown"
                data-title={shown.title}
                data-category={shown.category?.id ?? ""}
                aria-live="polite"
              >
                {t("studio.info.shown", {
                  title: shown.title || t("studio.info.untitled"),
                  category: shown.category?.name ?? t("studio.info.noCategory"),
                })}
              </StudioNote>
              <Field>
                {/* maxLength keeps the title within the limit; the trimmed check is a backstop. */}
                <FieldLabel htmlFor={STREAM_INFO_TITLE_ID}>{t("studio.info.titleLabel")}</FieldLabel>
                <Input
                  id={STREAM_INFO_TITLE_ID}
                  data-testid="stream-info-title"
                  value={draft.title}
                  maxLength={STREAM_INFO_LIMITS.titleMax}
                  autoComplete="off"
                  onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })}
                />
                <FieldDescription>
                  {t("studio.info.titleHint", { count: draft.title.length, max: STREAM_INFO_LIMITS.titleMax })}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-category`}>{t("studio.info.category")}</FieldLabel>
                <Combobox<string>
                  items={options.map((c) => c.id)}
                  value={draft.category?.id ?? null}
                  itemToStringLabel={nameOf}
                  // The server already filtered by what was typed.
                  filter={null}
                  onInputValueChange={(value) => setQuery(value)}
                  onValueChange={(next: string | null) => {
                    const picked = next ? options.find((c) => c.id === next) : undefined;
                    setDraft({ ...draft, category: picked ?? null });
                  }}
                >
                  <ComboboxInput
                    id={`${id}-category`}
                    data-testid="stream-info-category"
                    placeholder={t("studio.info.categoryPlaceholder")}
                    showClear={draft.category !== null}
                    className="w-full"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>{t("studio.info.categoryEmpty")}</ComboboxEmpty>
                    <ComboboxList>
                      {(item: string) => (
                        <ComboboxItem key={item} value={item}>
                          {nameOf(item)}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>
              <TagsField
                data-testid="stream-info-tags"
                data-input-testid="stream-info-tags-input"
                label={t("studio.info.tags")}
                values={draft.tags}
                max={STREAM_INFO_LIMITS.tagsMax}
                hint={t("studio.info.tagsHint")}
                addTagLabel={(value) => t("studio.info.addTag", { tag: value })}
                onValuesChange={(tags) => setDraft({ ...draft, tags })}
              />
              <SocialLinksField
                key={loads}
                value={draft.socials}
                showErrors={submitted}
                onChange={(socials) => setDraft({ ...draft, socials })}
              />
              {submitted && error ? <FieldError data-testid="stream-info-error">{error}</FieldError> : null}
              <div>
                <Button type="submit" data-testid="stream-info-save" disabled={saving} aria-busy={saving || undefined}>
                  {t("studio.info.save")}
                </Button>
              </div>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

type Platform = ChannelSocial["platform"];
type Part = "up" | "down" | "remove" | "url";

/**
 * The social links list: a platform and an https address per row, added, removed and moved one
 * place at a time. Moving or removing keeps keyboard focus on the row that moved (or the next
 * control), so the list can be reordered without a mouse.
 */
function SocialLinksField({
  value,
  showErrors,
  onChange,
}: {
  value: ChannelSocial[];
  showErrors: boolean;
  onChange: (socials: ChannelSocial[]) => void;
}): React.JSX.Element {
  const id = React.useId();
  const root = React.useRef<HTMLFieldSetElement>(null);
  // Stable row keys, so React moves a row's DOM (and its focus) instead of relabelling rows. Every
  // change to the list goes through this field (the editor remounts it on each load).
  const [keys, setKeys] = React.useState<number[]>(() => value.map((_, i) => i));
  const mint = () => Math.max(-1, ...keys) + 1;
  const focusNext = React.useRef<{ key: number | "add"; part: Part } | null>(null);
  React.useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const sel = want.key === "add" ? '[data-part="add"]' : `[data-row-key="${want.key}"] [data-part="${want.part}"]`;
    root.current?.querySelector<HTMLElement>(sel)?.focus();
  });
  const platforms = Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, platformName(p)]));
  const errors = socialErrors(value);
  const full = value.length >= MAX_CHANNEL_SOCIALS;

  const set = (i: number, patch: Partial<ChannelSocial>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) => {
    const key = keys[i] ?? -1;
    const to = i + by;
    // At an end the button that was pressed goes disabled; focus its twin instead.
    const edge = by === -1 ? to === 0 : to === value.length - 1;
    focusNext.current = { key, part: edge ? (by === -1 ? "down" : "up") : by === -1 ? "up" : "down" };
    setKeys(moveItem(keys, i, by));
    onChange(moveItem(value, i, by));
  };
  const remove = (i: number) => {
    const after = keys[i + 1] ?? keys[i - 1];
    focusNext.current = after === undefined ? { key: "add", part: "url" } : { key: after, part: "remove" };
    setKeys(keys.filter((_, j) => j !== i));
    onChange(value.filter((_, j) => j !== i));
  };
  const add = () => {
    if (full) return;
    const key = mint();
    focusNext.current = { key, part: "url" };
    setKeys([...keys, key]);
    onChange([...value, { platform: "website", url: "" }]);
  };

  return (
    <fieldset ref={root} data-testid="stream-info-socials" data-count={value.length} className="flex flex-col gap-3">
      <legend className="text-sm font-medium">{t("fuChannel.editor.socials")}</legend>
      <FieldDescription>{t("fuChannel.editor.socialsHint", { max: MAX_CHANNEL_SOCIALS })}</FieldDescription>
      {value.length === 0 ? (
        <p data-testid="stream-info-socials-empty" className="text-sm text-muted-foreground">
          {t("fuChannel.editor.socialsEmpty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {value.map((social, i) => {
            const key = keys[i] ?? -1 - i;
            const n = i + 1;
            const rowError = showErrors ? errors[i] : null;
            return (
              <li
                key={key}
                data-testid="stream-info-social"
                data-index={i}
                data-row-key={key}
                aria-label={t("fuChannel.editor.row", { n })}
                className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start"
              >
                <Field className="sm:w-40 sm:shrink-0">
                  <FieldLabel htmlFor={`${id}-${key}-platform`} className="sr-only">
                    {t("fuChannel.editor.platform")}
                  </FieldLabel>
                  <Select<string>
                    value={social.platform}
                    items={platforms}
                    onValueChange={(p) => {
                      if ((SOCIAL_PLATFORMS as readonly string[]).includes(p ?? ""))
                        set(i, { platform: p as Platform });
                    }}
                  >
                    <SelectTrigger
                      id={`${id}-${key}-platform`}
                      data-testid="stream-info-social-platform"
                      data-value={social.platform}
                      aria-label={`${t("fuChannel.editor.platform")}, ${t("fuChannel.editor.row", { n })}`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOCIAL_PLATFORMS.map((p) => (
                        <SelectItem key={p} data-testid={`stream-info-social-platform-${p}`} value={p}>
                          {platforms[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field data-invalid={rowError ? true : undefined} className="min-w-0 flex-1">
                  <FieldLabel htmlFor={`${id}-${key}-url`} className="sr-only">
                    {`${t("fuChannel.editor.url")}, ${t("fuChannel.editor.row", { n })}`}
                  </FieldLabel>
                  <Input
                    id={`${id}-${key}-url`}
                    data-testid="stream-info-social-url"
                    data-part="url"
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                    autoComplete="off"
                    maxLength={500}
                    value={social.url}
                    aria-invalid={rowError ? true : undefined}
                    aria-describedby={rowError ? `${id}-${key}-error` : undefined}
                    onChange={(e) => set(i, { url: e.currentTarget.value })}
                  />
                  {rowError ? (
                    <FieldError id={`${id}-${key}-error`} data-testid="stream-info-social-error">
                      {rowError}
                    </FieldError>
                  ) : null}
                </Field>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    type="button"
                    size="icon-sm"
                    icon={ArrowUp01Icon}
                    label={t("fuChannel.editor.moveUp", { n })}
                    data-testid="stream-info-social-up"
                    data-part="up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  />
                  <IconButton
                    type="button"
                    size="icon-sm"
                    icon={ArrowDown01Icon}
                    label={t("fuChannel.editor.moveDown", { n })}
                    data-testid="stream-info-social-down"
                    data-part="down"
                    disabled={i === value.length - 1}
                    onClick={() => move(i, 1)}
                  />
                  <IconButton
                    type="button"
                    size="icon-sm"
                    icon={Delete02Icon}
                    label={t("fuChannel.editor.remove", { n })}
                    data-testid="stream-info-social-remove"
                    data-part="remove"
                    onClick={() => remove(i)}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-col items-start gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="stream-info-social-add"
          data-part="add"
          disabled={full}
          onClick={add}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
          {t("fuChannel.editor.add")}
        </Button>
        {full ? (
          <FieldDescription data-testid="stream-info-socials-full">
            {t("fuChannel.editor.full", { max: MAX_CHANNEL_SOCIALS })}
          </FieldDescription>
        ) : null}
      </div>
    </fieldset>
  );
}
