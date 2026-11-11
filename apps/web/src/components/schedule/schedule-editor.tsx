// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's `/schedule` (overhaul wave 5): the schedule's time zone, the weekly streams, the
 * one-off streams, and the saved "Coming up" list where one occurrence can be skipped. Saving
 * replaces the whole schedule (`channels.schedule.set`); field errors show after the first save
 * attempt, and the limits (`SCHEDULE_RULES`) are stated before they are reached.
 */
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { formatDateTime, formatUnit, IconButton, SkeletonText, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import {
  browserTimeZone,
  comingUp,
  draftChanged,
  draftErrors,
  draftFromSchedule,
  draftToInput,
  durationOptions,
  newOneOff,
  newSlot,
  oneOffRoom,
  timeZoneLabel,
  timeZoneOptions,
  toggleSkip,
  weekdayKey,
  type ChannelSchedule,
  type ChannelScheduleInput,
  type DraftErrors,
  type OneOffDraft,
  type ScheduleDraft,
  type SlotDraft,
} from "./model.ts";

export interface ScheduleCategory {
  id: string;
  name: string;
}

export interface ScheduleClient {
  get(channel: string): Promise<ChannelSchedule>;
  set(channel: string, input: ChannelScheduleInput): Promise<ChannelSchedule>;
  categories(): Promise<ScheduleCategory[]>;
}

export const scheduleClient = (): ScheduleClient => ({
  get: (channel) => api().channels.schedule.get({ channel }),
  set: (channel, input) => api().channels.schedule.set({ channel, ...input }),
  categories: async () => (await api().categories.list({ limit: 100 })).items.map((c) => ({ id: c.id, name: c.name })),
});

const NO_CATEGORY = "none";
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** "2 hours", "1 hour 30 minutes", "45 minutes", in the viewer's language. */
export function durationLabel(minutes: number, locale: string): string {
  const long = { unitDisplay: "long" as const, maximumFractionDigits: 0 };
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return formatUnit(m, "minute", locale, long);
  if (m === 0) return formatUnit(h, "hour", locale, long);
  return `${formatUnit(h, "hour", locale, long)} ${formatUnit(m, "minute", locale, long)}`;
}

export function ScheduleEditor({
  channel,
  client: clientProp,
  now: nowProp,
}: {
  channel: string;
  /** Tests pass a fake; the API otherwise. */
  client?: ScheduleClient;
  /** Tests pin the clock. */
  now?: () => Date;
}): React.JSX.Element {
  const client = React.useMemo(() => clientProp ?? scheduleClient(), [clientProp]);
  const now = React.useCallback(() => (nowProp ? nowProp() : new Date()), [nowProp]);
  const load = useRetryingLoad(`schedule:${channel}`, () => client.get(channel));
  const [categories, setCategories] = React.useState<ScheduleCategory[]>([]);
  // What was saved and the draft: the loaded schedule until the first edit or save.
  const [edited, setEdited] = React.useState<{ saved: ChannelSchedule; draft: ScheduleDraft } | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [zone] = React.useState(() => browserTimeZone());

  React.useEffect(() => {
    let live = true;
    client.categories().then(
      (list) => {
        if (live) setCategories(list);
      },
      // Without the list the pickers offer "No category" and what the schedule already uses.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);

  const loaded = React.useMemo(
    () => (load.data ? { saved: load.data, draft: draftFromSchedule(load.data, zone) } : null),
    [load.data, zone],
  );
  const current = edited ?? loaded;

  if (!current) {
    if (load.state === "failed")
      return (
        <SectionLoadError
          section={t("w5Schedule.section")}
          load={load}
          alone
          data-testid="schedule-load-error"
          retryTestId="schedule-retry"
        />
      );
    return (
      <Card data-testid="schedule-loading" aria-busy>
        <CardContent>
          <SkeletonText lines={6} />
        </CardContent>
      </Card>
    );
  }

  const { saved, draft } = current;
  const setDraft = (next: ScheduleDraft) => setEdited({ saved, draft: next });
  // Every category the schedule names stays pickable, even past the first page of the list.
  const known = new Map(categories.map((c) => [c.id, c.name]));
  for (const s of saved.slots) if (s.category) known.set(s.category.id, s.category.name);
  for (const o of saved.oneOffs) if (o.category) known.set(o.category.id, o.category.name);
  const zones = timeZoneOptions(saved.timezone, zone);
  const errors = draftErrors(draft, now(), zones);
  const hasErrors = Object.keys(errors).length > 0;
  const shown = (key: string): MessageKey | null => (submitted ? (errors[key] ?? null) : null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors || saving) return;
    setSaving(true);
    try {
      const next = await client.set(channel, draftToInput(draft));
      setEdited({ saved: next, draft: draftFromSchedule(next, zone) });
      setSubmitted(false);
      trackUi("studio.schedule", "submit");
      toast.success(t("w5Schedule.saved"));
    } catch (err) {
      toastActionError(err, t("w5Schedule.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const setSlot = (key: string, patch: Partial<SlotDraft>) =>
    setDraft({ ...draft, slots: draft.slots.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  const setOneOff = (key: string, patch: Partial<OneOffDraft>) =>
    setDraft({ ...draft, oneOffs: draft.oneOffs.map((o) => (o.key === key ? { ...o, ...patch } : o)) });
  const slotsFull = draft.slots.length >= SCHEDULE_RULES.maxSlots;
  const oneOffsFull = oneOffRoom(draft) <= 0;

  return (
    <form
      data-testid="schedule-editor"
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(e) => void save(e)}
      noValidate
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t("w5Schedule.section")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TimeZoneField
            value={draft.timezone}
            zones={zones}
            error={shown("timezone")}
            onChange={(timezone) => setDraft({ ...draft, timezone })}
          />
        </CardContent>
      </Card>

      <Card data-testid="schedule-weekly">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t("w5Schedule.weekly.title")}</h2>
          </CardTitle>
          <CardDescription>
            {t("w5Schedule.weekly.description", { max: String(SCHEDULE_RULES.maxSlots) })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {draft.slots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("w5Schedule.weekly.empty")}</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-4">
              {draft.slots.map((slot) => (
                <SlotRow
                  key={slot.key}
                  slot={slot}
                  categories={known}
                  errors={submitted ? errors : {}}
                  onChange={(patch) => setSlot(slot.key, patch)}
                  onRemove={() => setDraft({ ...draft, slots: draft.slots.filter((s) => s.key !== slot.key) })}
                />
              ))}
            </ul>
          )}
          {slotsFull ? (
            <p data-testid="schedule-slots-full" className="text-sm text-muted-foreground">
              {t("w5Schedule.weekly.full", { max: String(SCHEDULE_RULES.maxSlots) })}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="schedule-add-slot"
            disabled={slotsFull}
            onClick={() => setDraft({ ...draft, slots: [...draft.slots, newSlot()] })}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
            {t("w5Schedule.weekly.add")}
          </Button>
        </CardFooter>
      </Card>

      <Card data-testid="schedule-one-offs">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">{t("w5Schedule.oneOff.title")}</h2>
          </CardTitle>
          <CardDescription>{t("w5Schedule.oneOff.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {draft.oneOffs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("w5Schedule.oneOff.empty")}</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-4">
              {draft.oneOffs.map((o) => (
                <OneOffRow
                  key={o.key}
                  oneOff={o}
                  categories={known}
                  errors={submitted ? errors : {}}
                  onChange={(patch) => setOneOff(o.key, patch)}
                  onRemove={() => setDraft({ ...draft, oneOffs: draft.oneOffs.filter((x) => x.key !== o.key) })}
                />
              ))}
            </ul>
          )}
          {oneOffsFull ? (
            <p data-testid="schedule-one-offs-full" className="text-sm text-muted-foreground">
              {t("w5Schedule.oneOff.full", { max: String(SCHEDULE_RULES.maxOneOffs) })}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="schedule-add-one-off"
            disabled={oneOffsFull}
            onClick={() => setDraft({ ...draft, oneOffs: [...draft.oneOffs, newOneOff(now())] })}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden />
            {t("w5Schedule.oneOff.add")}
          </Button>
        </CardFooter>
      </Card>

      <ComingUp
        saved={saved}
        draft={draft}
        now={now()}
        onToggle={(slotId, startsAt, minutes) => setDraft(toggleSkip(draft, slotId, startsAt, minutes))}
        skipFull={oneOffsFull}
      />

      <div className="flex min-w-0 flex-col gap-2">
        {submitted && hasErrors ? (
          <FieldError data-testid="schedule-error-summary">{t("w5Schedule.error.summary")}</FieldError>
        ) : null}
        <div>
          <Button type="submit" data-testid="schedule-save" disabled={saving}>
            {t("w5Schedule.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function TimeZoneField({
  value,
  zones,
  error,
  onChange,
}: {
  value: string;
  zones: readonly string[];
  error: MessageKey | null;
  onChange: (zone: string) => void;
}): React.JSX.Element {
  const id = React.useId();
  const items = Object.fromEntries(zones.map((z) => [z, timeZoneLabel(z)]));
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{t("w5Schedule.timezone.label")}</FieldLabel>
      <Select<string>
        value={value}
        items={items}
        onValueChange={(v) => {
          if (typeof v === "string") onChange(v);
        }}
      >
        <SelectTrigger id={id} data-testid="schedule-timezone" data-value={value} className="w-full sm:w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {zones.map((z) => (
            <SelectItem key={z} value={z}>
              {items[z]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{t("w5Schedule.timezone.hint")}</FieldDescription>
      {error ? <FieldError>{t(error)}</FieldError> : null}
    </Field>
  );
}

function CategoryField({
  value,
  categories,
  onChange,
  testId,
}: {
  value: string | null;
  categories: ReadonlyMap<string, string>;
  onChange: (id: string | null) => void;
  testId: "schedule-slot-category" | "schedule-one-off-category";
}): React.JSX.Element {
  const id = React.useId();
  const items: Record<string, string> = { [NO_CATEGORY]: t("w5Schedule.field.noCategory") };
  for (const [cid, name] of categories) items[cid] = name;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("w5Schedule.field.category")}</FieldLabel>
      <Select<string>
        value={value ?? NO_CATEGORY}
        items={items}
        onValueChange={(v) => onChange(typeof v === "string" && v !== NO_CATEGORY ? v : null)}
      >
        <SelectTrigger id={id} data-testid={testId} data-value={value ?? ""} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([cid, name]) => (
            <SelectItem key={cid} value={cid}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function DurationField({
  value,
  onChange,
  testId,
}: {
  value: number;
  onChange: (minutes: number) => void;
  testId: "schedule-slot-duration" | "schedule-one-off-duration";
}): React.JSX.Element {
  const id = React.useId();
  const { locale } = useLocale();
  const options = durationOptions(value);
  const items = Object.fromEntries(options.map((m) => [String(m), durationLabel(m, locale)]));
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("w5Schedule.field.duration")}</FieldLabel>
      <Select<string>
        value={String(value)}
        items={items}
        onValueChange={(v) => {
          const minutes = Number(v);
          if (Number.isInteger(minutes) && minutes > 0) onChange(minutes);
        }}
      >
        <SelectTrigger id={id} data-testid={testId} data-value={String(value)} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((m) => (
            <SelectItem key={m} value={String(m)}>
              {items[String(m)]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function TitleField({
  value,
  error,
  onChange,
  testId,
}: {
  value: string;
  error: MessageKey | null;
  onChange: (title: string) => void;
  testId: "schedule-slot-title" | "schedule-one-off-title";
}): React.JSX.Element {
  const id = React.useId();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{t("w5Schedule.field.title")}</FieldLabel>
      <Input
        id={id}
        data-testid={testId}
        value={value}
        maxLength={SCHEDULE_RULES.titleMax}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {error ? <FieldError>{t(error, { max: String(SCHEDULE_RULES.titleMax) })}</FieldError> : null}
    </Field>
  );
}

function SlotRow({
  slot,
  categories,
  errors,
  onChange,
  onRemove,
}: {
  slot: SlotDraft;
  categories: ReadonlyMap<string, string>;
  errors: DraftErrors;
  onChange: (patch: Partial<SlotDraft>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const dayId = React.useId();
  const startId = React.useId();
  const startError = errors[`${slot.key}.start`] ?? null;
  const days = Object.fromEntries(WEEKDAYS.map((d) => [String(d), t(weekdayKey(d))]));
  return (
    <li data-testid="schedule-slot" data-weekday={slot.weekday} className="min-w-0 border-b pb-4 last:border-b-0">
      <FieldGroup className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field>
          <FieldLabel htmlFor={dayId}>{t("w5Schedule.field.weekday")}</FieldLabel>
          <Select<string>
            value={String(slot.weekday)}
            items={days}
            onValueChange={(v) => {
              const weekday = Number(v);
              if (Number.isInteger(weekday) && weekday >= 1 && weekday <= 7) onChange({ weekday });
            }}
          >
            <SelectTrigger
              id={dayId}
              data-testid="schedule-slot-weekday"
              data-value={String(slot.weekday)}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {days[String(d)]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field data-invalid={startError ? true : undefined}>
          <FieldLabel htmlFor={startId}>{t("w5Schedule.field.start")}</FieldLabel>
          <Input
            id={startId}
            type="time"
            data-testid="schedule-slot-start"
            value={slot.startLocal}
            aria-invalid={startError ? true : undefined}
            onChange={(e) => onChange({ startLocal: e.currentTarget.value })}
          />
          {startError ? <FieldError>{t(startError)}</FieldError> : null}
        </Field>
        <DurationField
          testId="schedule-slot-duration"
          value={slot.durationMinutes}
          onChange={(durationMinutes) => onChange({ durationMinutes })}
        />
        <TitleField
          testId="schedule-slot-title"
          value={slot.title}
          error={errors[`${slot.key}.title`] ?? null}
          onChange={(title) => onChange({ title })}
        />
        <CategoryField
          testId="schedule-slot-category"
          value={slot.categoryId}
          categories={categories}
          onChange={(categoryId) => onChange({ categoryId })}
        />
        <div className="flex items-end">
          <IconButton
            data-testid="schedule-slot-remove"
            label={t("w5Schedule.weekly.remove")}
            icon={Delete02Icon}
            variant="ghost"
            onClick={onRemove}
          />
        </div>
      </FieldGroup>
    </li>
  );
}

function OneOffRow({
  oneOff,
  categories,
  errors,
  onChange,
  onRemove,
}: {
  oneOff: OneOffDraft;
  categories: ReadonlyMap<string, string>;
  errors: DraftErrors;
  onChange: (patch: Partial<OneOffDraft>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const atId = React.useId();
  const atError = errors[`${oneOff.key}.startsAt`] ?? null;
  return (
    <li data-testid="schedule-one-off" className="min-w-0 border-b pb-4 last:border-b-0">
      <FieldGroup className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field data-invalid={atError ? true : undefined}>
          <FieldLabel htmlFor={atId}>{t("w5Schedule.field.startsAt")}</FieldLabel>
          <Input
            id={atId}
            type="datetime-local"
            data-testid="schedule-one-off-starts-at"
            value={oneOff.startsAtLocal}
            aria-invalid={atError ? true : undefined}
            onChange={(e) => onChange({ startsAtLocal: e.currentTarget.value })}
          />
          {atError ? <FieldError>{t(atError)}</FieldError> : null}
        </Field>
        <DurationField
          testId="schedule-one-off-duration"
          value={oneOff.durationMinutes}
          onChange={(durationMinutes) => onChange({ durationMinutes })}
        />
        <TitleField
          testId="schedule-one-off-title"
          value={oneOff.title}
          error={errors[`${oneOff.key}.title`] ?? null}
          onChange={(title) => onChange({ title })}
        />
        <CategoryField
          testId="schedule-one-off-category"
          value={oneOff.categoryId}
          categories={categories}
          onChange={(categoryId) => onChange({ categoryId })}
        />
        <div className="flex items-end">
          <IconButton
            data-testid="schedule-one-off-remove"
            label={t("w5Schedule.oneOff.remove")}
            icon={Delete02Icon}
            variant="ghost"
            onClick={onRemove}
          />
        </div>
      </FieldGroup>
    </li>
  );
}

function ComingUp({
  saved,
  draft,
  now,
  onToggle,
  skipFull,
}: {
  saved: ChannelSchedule;
  draft: ScheduleDraft;
  now: Date;
  onToggle: (slotId: string, startsAt: string, durationMinutes: number) => void;
  skipFull: boolean;
}): React.JSX.Element {
  const { locale, timeZone } = useLocale();
  const rows = comingUp(saved, draft, now);
  const changed = draftChanged(saved, draft);
  return (
    <Card data-testid="schedule-upcoming">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{t("w5Schedule.upcoming.title")}</h2>
        </CardTitle>
        <CardDescription>{t("w5Schedule.upcoming.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {changed ? (
          <p data-testid="schedule-upcoming-changed" className="text-sm text-muted-foreground">
            {t("w5Schedule.upcoming.changed")}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("w5Schedule.upcoming.empty")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {rows.map((row) => {
              const slotId = row.slotId;
              const minutes = Math.round((Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 60_000);
              return (
                <li
                  key={`${row.slotId ?? "one-off"}|${row.startsAt}`}
                  data-testid="schedule-upcoming-item"
                  data-starts-at={row.startsAt}
                  data-skipped={row.skipped ? "true" : "false"}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className={row.skipped ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                      <time dateTime={row.startsAt}>{formatDateTime(new Date(row.startsAt), locale, timeZone)}</time>
                    </span>
                    <span className="text-sm break-words text-muted-foreground">
                      {row.skipped ? t("w5Schedule.upcoming.skipped") : (row.title ?? t("w5Schedule.untitled"))}
                    </span>
                  </span>
                  {slotId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="schedule-upcoming-skip"
                      aria-pressed={row.skipped}
                      disabled={!row.skipped && skipFull}
                      onClick={() => onToggle(slotId, row.startsAt, minutes)}
                    >
                      {row.skipped ? t("w5Schedule.upcoming.unskip") : t("w5Schedule.upcoming.skip")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
