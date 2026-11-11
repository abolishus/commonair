// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton, useLocale } from "@commonair/ui";
import { ProposalKindBadge, ProtectedBadge } from "@commonair/ui/blocks/coop";
import { AmountField, SelectField, SwitchField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { Field, FieldDescription, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@commonair/ui/components/input-group";
import { Textarea } from "@commonair/ui/components/textarea";
import { Add01Icon, ArrowDown01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import {
  changeKeyOptions,
  kindHint,
  kindLabel,
  rowError,
  rowErrorText,
  type ChangeRow,
  type ProposalKind,
  type SettingDto,
} from "../../lib/coop.ts";
import {
  DURATION_UNIT_SECONDS,
  applyField,
  describeCron,
  durationUnit,
  fieldBoundText,
  fieldError,
  formatField,
  fractionFromPercent,
  isKnownSetting,
  percentFromFraction,
  readPath,
  settingFieldSpecs,
  settingTitle,
  typedEditable,
  type DurationUnit,
  type FieldError as FieldProblem,
  type FieldSpec,
} from "../../lib/coop-settings-format.ts";
import { cn } from "@commonair/ui/lib/utils";
import { SettingChange } from "./changes.tsx";

/** The row's value as JSON, or undefined when the text does not parse. */
export function parseRowValue(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Every typed-field problem of the rows (`rowId:fieldId`), for the form to block saving. */
export function typedProblems(rows: readonly ChangeRow[]): Map<string, FieldProblem> {
  const out = new Map<string, FieldProblem>();
  for (const row of rows) {
    if (!isKnownSetting(row.key)) continue;
    const parsed = parseRowValue(row.value);
    if (!parsed.ok) continue;
    for (const f of settingFieldSpecs(row.key)) {
      if (f.kind === "keys" || f.complementOf) continue;
      const raw = readPath(parsed.value, f.path);
      if (raw === undefined) continue;
      const problem = fieldError(f, raw);
      if (problem) out.set(`${row.id}:${f.id}`, problem);
    }
  }
  return out;
}

const PROBLEM_KEYS: Record<FieldProblem, MessageKey> = {
  required: "d6Governance.form.error.required",
  notNumber: "d6Governance.form.error.notNumber",
  notWhole: "d6Governance.form.error.notWhole",
  tooLow: "d6Governance.form.error.tooLow",
  tooHigh: "d6Governance.form.error.tooHigh",
};

function problemText(spec: FieldSpec, problem: FieldProblem, locale: string): string {
  return t(PROBLEM_KEYS[problem], {
    min: fieldBoundText(spec, "min", locale),
    max: fieldBoundText(spec, "max", locale),
  });
}

const UNIT_SUFFIX: Partial<Record<FieldSpec["kind"], MessageKey>> = {
  minutes: "d6Governance.unit.minutes",
  hours: "d6Governance.unit.hours",
  days: "d6Governance.unit.days",
  months: "d6Governance.unit.months",
};

const DURATION_UNITS: { value: DurationUnit; key: MessageKey }[] = [
  { value: "days", key: "d6Governance.unit.days" },
  { value: "hours", key: "d6Governance.unit.hours" },
  { value: "minutes", key: "d6Governance.unit.minutes" },
  { value: "seconds", key: "d6Governance.unit.seconds" },
];

interface FieldEditorProps {
  settingKey: string;
  spec: FieldSpec;
  /** The whole draft value of the setting. */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled: boolean;
  /** Show this field's problem (after blur or a save attempt). */
  showError: boolean;
  onBlur: () => void;
}

/** A number typed into a field, kept as text while it does not parse so typing "8." is not lost. */
function useNumberDraft(stored: number | null): [string, (text: string) => number | null, () => void] {
  const [draft, setDraft] = React.useState<string | null>(null);
  const text = draft ?? (stored === null ? "" : String(stored));
  const set = (next: string): number | null => {
    setDraft(next);
    const n = next.trim() === "" ? Number.NaN : Number(next);
    return Number.isFinite(n) ? n : null;
  };
  return [text, set, () => setDraft(null)];
}

function NumberField({
  id,
  label,
  stored,
  toStored,
  suffix,
  error,
  disabled,
  onValue,
  onBlur,
  hint,
}: {
  id: string;
  label: string;
  /** The value as the member edits it (85 for 0.85). */
  stored: number | null;
  toStored: (shown: number) => number;
  suffix?: string;
  error: string | null;
  disabled: boolean;
  onValue: (storedValue: number | string) => void;
  onBlur: () => void;
  hint?: React.ReactNode;
}): React.JSX.Element {
  const [text, setText, settle] = useNumberDraft(stored);
  const [unparsed, setUnparsed] = React.useState(false);
  const shownError = error ?? (unparsed ? t("d6Governance.form.error.notNumber") : null);
  return (
    <Field data-invalid={shownError ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type="number"
          inputMode="decimal"
          // "any": the browser never blocks a save on step rounding; the bounds are checked here.
          step="any"
          value={text}
          disabled={disabled}
          aria-invalid={shownError ? true : undefined}
          onChange={(event) => {
            const n = setText(event.currentTarget.value);
            setUnparsed(n === null);
            // A text that is not a number reaches the JSON as text, so the problem is visible there too.
            onValue(n === null ? event.currentTarget.value : toStored(n));
          }}
          onBlur={() => {
            if (!unparsed) settle();
            onBlur();
          }}
        />
        {suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      {shownError ? <FieldError>{shownError}</FieldError> : null}
    </Field>
  );
}

/** One field of a known setting, with the editor its kind needs. */
function FieldEditor({
  settingKey,
  spec,
  value,
  onChange,
  disabled,
  showError,
  onBlur,
}: FieldEditorProps): React.JSX.Element | null {
  const { locale } = useLocale();
  const id = React.useId();
  const raw = readPath(value, spec.path);
  const label = t(spec.label);
  const problem = fieldError(spec, raw);
  const error = showError && problem && raw !== undefined ? problemText(spec, problem, locale) : null;
  const set = (next: unknown) => onChange(applyField(settingKey, value, spec, next));
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : null;

  if (spec.complementOf) {
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <p className="text-sm tabular-nums">{formatField(spec, value, locale) ?? ""}</p>
        <FieldDescription>{t("d6Governance.form.complement")}</FieldDescription>
      </Field>
    );
  }
  switch (spec.kind) {
    case "percent":
      return (
        <NumberField
          id={id}
          label={label}
          stored={n === null ? null : percentFromFraction(n)}
          toStored={fractionFromPercent}
          suffix={t("d6Governance.unit.percent")}
          error={error}
          disabled={disabled}
          onValue={set}
          onBlur={onBlur}
        />
      );
    case "seconds": {
      const unit = n === null ? "days" : durationUnit(n);
      return (
        <DurationField
          id={id}
          label={label}
          seconds={n}
          unit={unit}
          error={error}
          disabled={disabled}
          onValue={set}
          onBlur={onBlur}
        />
      );
    }
    case "money":
      return (
        <AmountField
          label={label}
          currency={currencyFor(spec, value)}
          value={n ?? 0}
          min={spec.min}
          max={spec.max}
          rangeError={error ?? problemText(spec, "tooLow", locale)}
          formatError={t("d6Governance.form.error.notNumber")}
          onValueChange={(cents) => set(cents)}
          inputProps={{ disabled, onBlur }}
        />
      );
    case "boolean":
      return (
        <SwitchField
          label={label}
          checked={raw === true}
          disabled={disabled}
          onCheckedChange={(checked) => {
            set(checked);
            onBlur();
          }}
        />
      );
    case "text":
    case "cron":
      return (
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            id={id}
            value={typeof raw === "string" ? raw : ""}
            disabled={disabled}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(event) => set(event.currentTarget.value)}
            onBlur={onBlur}
          />
          {spec.kind === "cron" && typeof raw === "string" && raw.trim() ? (
            <FieldDescription>{describeCron(raw, locale)}</FieldDescription>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      );
    case "keys":
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <p className="text-sm">{formatField(spec, value, locale) ?? ""}</p>
          <FieldDescription>{t("d6Governance.form.keysAdvanced")}</FieldDescription>
        </Field>
      );
    default: {
      const suffixKey = UNIT_SUFFIX[spec.kind];
      return (
        <NumberField
          id={id}
          label={label}
          stored={n}
          toStored={(x) => x}
          suffix={suffixKey ? t(suffixKey) : undefined}
          error={error}
          disabled={disabled}
          onValue={set}
          onBlur={onBlur}
        />
      );
    }
  }
}

function currencyFor(spec: FieldSpec, value: unknown): string {
  const code = spec.currencyPath ? readPath(value, spec.currencyPath) : undefined;
  return typeof code === "string" && /^[a-z]{3}$/i.test(code) ? code : "usd";
}

/** A period: an amount and a unit (days, hours, minutes), stored as seconds. */
function DurationField({
  id,
  label,
  seconds,
  unit: initialUnit,
  error,
  disabled,
  onValue,
  onBlur,
}: {
  id: string;
  label: string;
  seconds: number | null;
  unit: DurationUnit;
  error: string | null;
  disabled: boolean;
  onValue: (seconds: number | string) => void;
  onBlur: () => void;
}): React.JSX.Element {
  const [unit, setUnit] = React.useState<DurationUnit>(initialUnit);
  const size = DURATION_UNIT_SECONDS[unit];
  return (
    <div className="flex min-w-0 items-end gap-2">
      <div className="min-w-0 flex-1">
        <NumberField
          id={id}
          label={label}
          stored={seconds === null ? null : Math.round((seconds / size) * 1000) / 1000}
          toStored={(amount) => Math.round(amount * size)}
          error={error}
          disabled={disabled}
          onValue={onValue}
          onBlur={onBlur}
        />
      </div>
      <SelectField
        className="w-32 shrink-0"
        label={t("d6Governance.form.unit")}
        disabled={disabled}
        options={DURATION_UNITS.map((u) => ({ value: u.value, label: t(u.key) }))}
        value={unit}
        onValueChange={(next) => {
          const found = DURATION_UNITS.find((u) => u.value === next);
          if (!found) return;
          setUnit(found.value);
          if (seconds !== null) {
            // Keep the amount the member typed, now in the new unit.
            const amount = seconds / size;
            onValue(Math.round(amount * DURATION_UNIT_SECONDS[found.value]));
          }
        }}
      />
    </div>
  );
}

export interface ChangeEditorProps {
  rows: readonly ChangeRow[];
  settings: readonly SettingDto[];
  onRowsChange: (rows: ChangeRow[]) => void;
  disabled: boolean;
  kind: ProposalKind;
  /** The member tried to save: show every problem, touched or not. */
  submitted: boolean;
}

let rowSeq = 0;
const newRowId = () => `new-${++rowSeq}`;

/**
 * The setting changes of a proposal draft (overhaul D6.2): per row the setting, then typed fields
 * for a known setting (a percent for the cut, an amount for money, a period with its unit), a
 * before → after preview, and the JSON only under "Edit as JSON" (or as the editor itself for a
 * setting we do not know or a value in another shape). Problems show after a field is left or a
 * save is tried, never while typing.
 */
export function ChangeEditor({
  rows,
  settings,
  onRowsChange,
  disabled,
  kind,
  submitted,
}: ChangeEditorProps): React.JSX.Element {
  const baseId = React.useId();
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const [advanced, setAdvanced] = React.useState<ReadonlySet<string>>(() => new Set());
  const touch = (id: string) => setTouched((s) => (s.has(id) ? s : new Set([...s, id])));
  const options = changeKeyOptions(settings).map((o) => ({ ...o, label: settingTitle(o.value) }));
  const protectedKeys = new Set(settings.filter((s) => s.protected).map((s) => s.key));
  const taken = new Set(rows.map((r) => r.key).filter(Boolean));
  const current = (key: string) => settings.find((s) => s.key === key)?.value;

  const update = (id: string, patch: Partial<Omit<ChangeRow, "id">>) =>
    onRowsChange(
      rows.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row, ...patch };
        // A new key starts from its whole current value: a change replaces the setting.
        if (patch.key !== undefined && patch.key !== row.key) {
          const value = current(patch.key);
          next.value = value === undefined ? "" : JSON.stringify(value ?? null, null, 2);
        }
        return next;
      }),
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <ProposalKindBadge data-testid="proposal-kind" kind={kind} label={kindLabel(kind)} />
        <p className="text-xs text-muted-foreground">{kindHint(kind)}</p>
      </div>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t("coop.form.changesEmpty")}</p> : null}
      {rows.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {rows.map((row, index) => {
            const isProtected = row.key ? protectedKeys.has(row.key) : undefined;
            const problem = rowError(row, rows);
            const parsed = parseRowValue(row.value);
            const typed = row.key !== "" && parsed.ok && typedEditable(row.key, parsed.value);
            const jsonId = `${baseId}-${row.id}-value`;
            const showJsonError =
              (submitted || touched.has(`${row.id}:json`)) && (problem === "invalidJson" || problem === "duplicate");
            const showKeyError = submitted && problem === "noKey";
            const jsonEditor = (
              <Field data-invalid={showJsonError ? true : undefined}>
                <FieldLabel htmlFor={jsonId}>{t("coop.form.changeValue")}</FieldLabel>
                <Textarea
                  data-testid="proposal-change-value"
                  id={jsonId}
                  value={row.value}
                  disabled={disabled}
                  spellCheck={false}
                  aria-invalid={showJsonError ? true : undefined}
                  className="font-mono text-xs"
                  onChange={(event) => update(row.id, { value: event.currentTarget.value })}
                  onBlur={() => touch(`${row.id}:json`)}
                />
                <FieldDescription>{t("coop.form.changeValueHint")}</FieldDescription>
                {showJsonError && problem ? <FieldError>{rowErrorText(problem)}</FieldError> : null}
              </Field>
            );
            const open = advanced.has(row.id);
            return (
              <li
                key={row.id}
                data-testid="proposal-change"
                data-key={row.key || undefined}
                data-protected={isProtected === undefined ? undefined : String(isProtected)}
                data-typed={row.key ? String(typed) : undefined}
                className="flex min-w-0 flex-col gap-3 border p-3"
              >
                <div className="flex min-w-0 items-end gap-2">
                  <SelectField
                    className="min-w-0 flex-1"
                    id={`${baseId}-${row.id}-key`}
                    label={t("coop.form.changeKey")}
                    placeholder={t("coop.form.changeKeyPlaceholder")}
                    disabled={disabled}
                    error={showKeyError ? rowErrorText("noKey") : undefined}
                    options={options.map((option) => ({
                      value: option.value,
                      label: option.label,
                      // A key may appear once per proposal.
                      disabled: option.value !== row.key && taken.has(option.value),
                      "data-testid": option["data-testid"],
                    }))}
                    value={row.key || null}
                    onValueChange={(key) => update(row.id, { key })}
                    triggerProps={{ "data-testid": "proposal-change-key" }}
                  />
                  <IconButton
                    data-testid="proposal-change-remove"
                    label={`${t("coop.form.changeRemove")} ${index + 1}`}
                    tooltip={t("coop.form.changeRemove")}
                    icon={Delete02Icon}
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onRowsChange(rows.filter((r) => r.id !== row.id))}
                  />
                </div>
                {isProtected ? <ProtectedBadge label={t("d6Governance.protected")} /> : null}
                {typed && parsed.ok ? (
                  <div data-testid="proposal-change-fields" className="grid min-w-0 gap-3 sm:grid-cols-2">
                    {settingFieldSpecs(row.key)
                      .filter((spec) => readPath(parsed.value, spec.path) !== undefined)
                      .map((spec) => (
                        <div
                          key={spec.id}
                          className={cn(
                            "min-w-0",
                            (spec.kind === "seconds" || spec.kind === "keys" || spec.kind === "boolean") &&
                              "sm:col-span-2",
                          )}
                        >
                          <FieldEditor
                            settingKey={row.key}
                            spec={spec}
                            value={parsed.value as Record<string, unknown>}
                            disabled={disabled}
                            showError={submitted || touched.has(`${row.id}:${spec.id}`)}
                            onBlur={() => touch(`${row.id}:${spec.id}`)}
                            onChange={(next) => update(row.id, { value: JSON.stringify(next, null, 2) })}
                          />
                        </div>
                      ))}
                  </div>
                ) : null}
                {row.key && !typed && isKnownSetting(row.key) ? (
                  <p className="text-xs text-muted-foreground">{t("d6Governance.form.jsonFallback")}</p>
                ) : null}
                {row.key && parsed.ok && current(row.key) !== undefined ? (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs font-medium">{t("d6Governance.form.preview")}</span>
                    <SettingChange
                      data-testid="proposal-change-preview"
                      settingKey={row.key}
                      from={current(row.key)}
                      to={parsed.value}
                      isProtected={isProtected === true}
                    />
                  </div>
                ) : null}
                {row.key === "" ? null : typed ? (
                  <Collapsible
                    open={open}
                    onOpenChange={(next) =>
                      setAdvanced((s) => {
                        const out = new Set(s);
                        if (next) out.add(row.id);
                        else out.delete(row.id);
                        return out;
                      })
                    }
                    className="min-w-0"
                  >
                    <CollapsibleTrigger
                      data-testid="proposal-change-advanced"
                      render={
                        <Button type="button" variant="ghost" size="xs" className="-ms-2 text-muted-foreground" />
                      }
                    >
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        strokeWidth={2}
                        aria-hidden
                        data-icon="inline-start"
                        className={cn("transition-transform motion-reduce:transition-none", !open && "-rotate-90")}
                      />
                      {t("d6Governance.form.advanced")}
                    </CollapsibleTrigger>
                    <CollapsibleContent keepMounted className="pt-2">
                      {jsonEditor}
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  jsonEditor
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
      <div>
        <Button
          data-testid="proposal-change-add"
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || taken.size >= options.length}
          onClick={() => onRowsChange([...rows, { id: newRowId(), key: "", value: "" }])}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("coop.form.changeAdd")}
        </Button>
      </div>
    </div>
  );
}
