// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Edit stream info" (F21): the stream's title, category (a combobox over `categories.list`) and
 * tags, saved with `channels.update`. The save is optimistic: the "Viewers see" line shows the new
 * values at once and goes back to the stored ones if the call fails (with a toast); the form keeps
 * what was typed so a retry is one click.
 */
import type { Category, Channel } from "@commonair/contracts/dto";
import { SkeletonText } from "@commonair/ui";
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
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { StudioNote } from "./note.tsx";

/** The contract's limits on stream info (`ChannelUpdate`). */
export const STREAM_INFO_LIMITS = { titleMax: 140, tagMax: 25, tagsMax: 10 } as const;
const TAG = /^[\p{L}\p{N}-]+$/u;

export interface StreamInfo {
  title: string;
  category: { id: string; name: string } | null;
  tags: string[];
}

export interface StreamInfoClient {
  get: (channel: string) => Promise<StreamInfo>;
  update: (channel: string, info: StreamInfo) => Promise<StreamInfo>;
  /** Categories matching `q` (all, busiest first, when empty). */
  categories: (q: string) => Promise<{ id: string; name: string }[]>;
}

const infoOf = (c: Pick<Channel, "title" | "category" | "tags">): StreamInfo => ({
  title: c.title,
  category: c.category ? { id: c.category.id, name: c.category.name } : null,
  tags: [...c.tags],
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
  return null;
}

export function StreamInfoEditor({
  channel,
  client = apiStreamInfoClient,
}: {
  channel: string;
  client?: StreamInfoClient;
}): React.JSX.Element {
  const [stored, setStored] = React.useState<StreamInfo | null>(null);
  // What viewers see: the stored info, or the pending save's while it is in flight (optimistic).
  const [shown, setShown] = React.useState<StreamInfo | null>(null);
  const [draft, setDraft] = React.useState<StreamInfo | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
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
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [channel, client]);

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
    const next = { ...draft, title: draft.title.trim() };
    const before = stored;
    setShown(next);
    setSaving(true);
    try {
      const saved = await client.update(channel, next);
      setStored(saved);
      setShown(saved);
      setSubmitted(false);
      toast.success(t("studio.info.saved"));
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
          <StudioNote role="alert">{t("studio.info.loadFailed")}</StudioNote>
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
                <FieldLabel htmlFor={`${id}-title`}>{t("studio.info.titleLabel")}</FieldLabel>
                <Input
                  id={`${id}-title`}
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
