// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Delete02Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@commonair/ui/components/item";
import { Switch } from "@commonair/ui/components/switch";
import { cn } from "@commonair/ui/lib/utils";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { EmptyState } from "../../primitives/empty-state.tsx";
import { SkeletonGroup, SkeletonText } from "../../primitives/skeletons.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";
import { SelectField, type SelectFieldOption } from "../forms/select-field.tsx";

/** The contract's `MAX_SIMULCAST_TARGETS`. */
export const SIMULCAST_TARGET_LIMIT = 5;

/** `SIMULCAST_STATUSES` → badge tone. */
export function simulcastStatusTone(status: string): StatusTone {
  if (status === "live") return "success";
  if (status === "connecting") return "info";
  if (status === "error") return "danger";
  return "neutral";
}

export interface SimulcastTargetRow {
  id: string;
  name: string;
  /** `SIMULCAST_PLATFORMS` value. */
  platform: string;
  platformLabel: string;
  rtmpUrl: string;
  enabled: boolean;
  /** `SIMULCAST_STATUSES` value; set as `data-status`. */
  status: string;
  statusLabel: string;
  /** The media service's stable error code, shown verbatim (it is a code, not prose). */
  lastError: string | null;
}

export interface SimulcastAddValues {
  name: string;
  platform: string;
  rtmpUrl: string;
  /** Write-only: never shown again after submit. */
  streamKey: string;
}

export interface SimulcastPanelLabels {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Accessible name of the target list. */
  listLabel: string;
  emptyTitle: React.ReactNode;
  emptyDescription?: React.ReactNode;
  addTitle: React.ReactNode;
  name: string;
  platform: string;
  url: string;
  urlPlaceholder?: string;
  urlHint?: React.ReactNode;
  key: string;
  keyHint?: React.ReactNode;
  add: string;
  /** Shown instead of the form once `limit` targets exist. */
  limitReached: React.ReactNode;
  /** Accessible name of a row's switch ("Send to Twitch"). */
  enabled: (name: string) => string;
  /** "Last error: {code}". */
  lastError: (code: string) => React.ReactNode;
  /** Accessible name of a row's remove button. */
  remove: (name: string) => string;
  removeTitle: (name: string) => React.ReactNode;
  removeDescription?: React.ReactNode;
  removeConfirm: string;
}

export interface SimulcastPanelProps extends Omit<
  React.ComponentProps<"section">,
  "children" | "onError" | "onToggle"
> {
  /** `null` while loading (skeleton). */
  targets: readonly SimulcastTargetRow[] | null;
  platforms: readonly SelectFieldOption[];
  labels: SimulcastPanelLabels;
  /** Resolve to clear the form; reject to keep what was typed (and show `error`). */
  onAdd: (values: SimulcastAddValues) => void | Promise<void>;
  onToggle: (id: string, enabled: boolean) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** The API's refusal (`outboundUrlProblem` reason or contract code), shown inline with `data-reason`. */
  error?: { reason: string; message: React.ReactNode } | null;
  /** Row ids with a toggle in flight (their switch is disabled). */
  busyIds?: readonly string[];
  limit?: number;
}

const EMPTY_FORM: SimulcastAddValues = { name: "", platform: "", rtmpUrl: "", streamKey: "" };

/**
 * The studio's simulcast section: targets (status, enabled switch, last error, remove behind a
 * `ConfirmDialog`), the add form with a write-only key, the empty state and the target cap.
 * Renders the spec's `simulcast-*` test ids (docs/testing/e6-selectors.md).
 */
export function SimulcastPanel({
  targets,
  platforms,
  labels,
  onAdd,
  onToggle,
  onRemove,
  onError,
  error,
  busyIds = [],
  limit = SIMULCAST_TARGET_LIMIT,
  className,
  ...props
}: SimulcastPanelProps): React.JSX.Element {
  const headingId = React.useId();
  const [form, setForm] = React.useState<SimulcastAddValues>(() => ({
    ...EMPTY_FORM,
    platform: platforms[0]?.value ?? "",
  }));
  const [submitting, setSubmitting] = React.useState(false);
  const atLimit = targets !== null && targets.length >= limit;
  const complete =
    form.name.trim() !== "" && form.platform !== "" && form.rtmpUrl.trim() !== "" && form.streamKey !== "";
  const set = (key: keyof SimulcastAddValues) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!complete || atLimit || submitting) return;
    setSubmitting(true);
    try {
      await onAdd({ ...form, name: form.name.trim(), rtmpUrl: form.rtmpUrl.trim() });
      setForm({ ...EMPTY_FORM, platform: form.platform });
    } catch (caught) {
      onError?.(caught);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby={headingId} data-testid="simulcast" className={cn("min-w-0", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle id={headingId}>{labels.title}</CardTitle>
          {labels.description ? <CardDescription>{labels.description}</CardDescription> : null}
          {targets ? (
            <CardAction>
              <StatusBadge tone={atLimit ? "warning" : "neutral"} data-count={targets.length} data-limit={limit}>
                {targets.length} / {limit}
              </StatusBadge>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {targets === null ? (
            <SkeletonGroup>
              <SkeletonText lines={4} />
            </SkeletonGroup>
          ) : targets.length === 0 ? (
            <EmptyState
              data-testid="simulcast-empty"
              icon={Share08Icon}
              title={labels.emptyTitle}
              description={labels.emptyDescription}
              headingLevel={3}
            />
          ) : (
            <ItemGroup aria-label={labels.listLabel} className="gap-2">
              {targets.map((target) => (
                <Item
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a `div role="list"`, and an `li` needs a `ul` parent.
                  role="listitem"
                  key={target.id}
                  variant="outline"
                  size="sm"
                  data-testid="simulcast-target"
                  data-target-id={target.id}
                  data-status={target.status}
                  data-enabled={String(target.enabled)}
                  className="flex-wrap"
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="flex-wrap">
                      {target.name}
                      <StatusBadge tone={simulcastStatusTone(target.status)}>{target.statusLabel}</StatusBadge>
                    </ItemTitle>
                    <ItemDescription className="wrap-anywhere">
                      {target.platformLabel} · {target.rtmpUrl}
                    </ItemDescription>
                    {target.lastError ? (
                      <p className="text-xs text-destructive" data-error-code={target.lastError}>
                        {labels.lastError(target.lastError)}
                      </p>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      data-testid="simulcast-enabled"
                      aria-label={labels.enabled(target.name)}
                      checked={target.enabled}
                      disabled={busyIds.includes(target.id)}
                      onCheckedChange={(checked) => {
                        void Promise.resolve(onToggle(target.id, checked)).catch((caught: unknown) =>
                          onError?.(caught),
                        );
                      }}
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          data-testid="simulcast-remove"
                          aria-label={labels.remove(target.name)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
                        </Button>
                      }
                      title={labels.removeTitle(target.name)}
                      description={labels.removeDescription}
                      confirmLabel={labels.removeConfirm}
                      variant="destructive"
                      onConfirm={() => onRemove(target.id)}
                      onError={onError}
                    />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
          {error ? (
            <p
              role="alert"
              data-testid="simulcast-error"
              data-reason={error.reason}
              className="text-xs text-destructive"
            >
              {error.message}
            </p>
          ) : null}
          {targets !== null && atLimit ? (
            <p className="text-xs text-muted-foreground" data-testid="simulcast-limit">
              {labels.limitReached}
            </p>
          ) : (
            <form onSubmit={(event) => void submit(event)} aria-label={labels.add} className="flex flex-col gap-4">
              <h3 className="text-xs font-medium">{labels.addTitle}</h3>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${headingId}-name`}>{labels.name}</FieldLabel>
                  <Input
                    id={`${headingId}-name`}
                    data-testid="simulcast-name"
                    maxLength={40}
                    autoComplete="off"
                    value={form.name}
                    onChange={(event) => set("name")(event.currentTarget.value)}
                  />
                </Field>
                <SelectField
                  label={labels.platform}
                  options={platforms.map((option) => ({
                    ...option,
                    "data-testid": `simulcast-platform-option-${option.value}`,
                  }))}
                  value={form.platform || null}
                  onValueChange={set("platform")}
                  data-testid="simulcast-platform"
                  data-value={form.platform}
                />
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor={`${headingId}-url`}>{labels.url}</FieldLabel>
                  <Input
                    id={`${headingId}-url`}
                    data-testid="simulcast-url"
                    // Text, not `url`: the API's refusal reason is shown, not the browser's bubble.
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={labels.urlPlaceholder}
                    value={form.rtmpUrl}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) => set("rtmpUrl")(event.currentTarget.value)}
                  />
                  {labels.urlHint ? <FieldDescription>{labels.urlHint}</FieldDescription> : null}
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor={`${headingId}-key`}>{labels.key}</FieldLabel>
                  <Input
                    id={`${headingId}-key`}
                    data-testid="simulcast-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={256}
                    value={form.streamKey}
                    onChange={(event) => set("streamKey")(event.currentTarget.value)}
                  />
                  {labels.keyHint ? <FieldDescription>{labels.keyHint}</FieldDescription> : null}
                </Field>
              </FieldGroup>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  data-testid="simulcast-add"
                  disabled={!complete || submitting || targets === null}
                  aria-busy={submitting || undefined}
                >
                  {labels.add}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
