// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { Field, FieldError, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { cn } from "@commonair/ui/lib/utils";
import { ConfirmDialog } from "../../primitives/confirm-dialog.tsx";
import { RelativeTime } from "../../primitives/relative-time.tsx";
import { SkeletonGroup, SkeletonText } from "../../primitives/skeletons.tsx";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { CopyField } from "../forms/copy-field.tsx";
import { SelectField } from "../forms/select-field.tsx";

/** The spec's expiry choices (`overlay-expiry`), in menu order. */
export const OVERLAY_EXPIRY_CHOICES = ["none", "1d", "7d", "30d", "90d", "6mo", "date"] as const;
export type OverlayExpiryChoice = (typeof OVERLAY_EXPIRY_CHOICES)[number];

export const isOverlayExpiryChoice = (value: string): value is OverlayExpiryChoice =>
  (OVERLAY_EXPIRY_CHOICES as readonly string[]).includes(value);

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS: Partial<Record<OverlayExpiryChoice, number>> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };
/** `datetime-local` text: no zone, read in the viewer's own time zone (as the browser shows it). */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export type OverlayExpiryResult = { ok: true; expiresAt: string | null } | { ok: false; reason: "invalid" | "past" };

/** Six calendar months later, clamped to the last day of a shorter month (Aug 31 → Feb 28/29). */
function addMonthsUtc(from: Date, months: number): Date {
  const target = new Date(from.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/**
 * The `expiresAt` to send to `interact.overlays.token` for a choice: `null` for no expiry, an ISO
 * instant for a quick pick (from `now`), or the `datetime-local` text read in local time for
 * `date`, which must parse and lie in the future.
 */
export function resolveOverlayExpiry(
  choice: OverlayExpiryChoice,
  now: Date | number,
  dateText = "",
): OverlayExpiryResult {
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (choice === "none") return { ok: true, expiresAt: null };
  if (choice === "6mo") return { ok: true, expiresAt: addMonthsUtc(new Date(nowMs), 6).toISOString() };
  if (choice === "date") {
    const m = LOCAL_DATE_TIME.exec(dateText.trim());
    if (!m) return { ok: false, reason: "invalid" };
    const [year, month, day, hour, minute, second] = m.slice(1).map((part) => Number(part ?? 0));
    const local = new Date(year ?? 0, (month ?? 1) - 1, day, hour, minute, second);
    // Date rolls over impossible dates (Feb 30 → Mar 2); refuse them instead.
    if (Number.isNaN(local.getTime()) || local.getMonth() !== (month ?? 1) - 1 || local.getDate() !== day)
      return { ok: false, reason: "invalid" };
    if (local.getTime() <= nowMs) return { ok: false, reason: "past" };
    return { ok: true, expiresAt: local.toISOString() };
  }
  const days = DAYS[choice] ?? 0;
  return { ok: true, expiresAt: new Date(nowMs + days * DAY_MS).toISOString() };
}

/** The three OBS browser sources one token opens (`interact.overlays.token`'s URLs). */
export const OVERLAY_KINDS = ["alerts", "chat", "goals"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

/** Recommended OBS browser-source size per overlay, in pixels (creator-studio.md P4). */
export const OVERLAY_SIZES: Readonly<Record<OverlayKind, { width: number; height: number }>> = {
  alerts: { width: 800, height: 600 },
  chat: { width: 400, height: 800 },
  goals: { width: 800, height: 120 },
};

/** The URLs from the create response; held by the page only until revoke or leaving it. */
export type OverlayLinkUrls = Record<OverlayKind, string>;

/** `overlay-url` (alerts, the E6 id) and `overlay-url-chat` / `overlay-url-goals`. */
export const overlayUrlTestId = (kind: OverlayKind): string =>
  kind === "alerts" ? "overlay-url" : `overlay-url-${kind}`;

export interface OverlayTokenStatusView {
  active: boolean;
  createdAt: string | null;
  /** `null` while active: no expiry. */
  expiresAt: string | null;
}

export interface OverlayTokenLabels {
  title: React.ReactNode;
  description?: React.ReactNode;
  active: string;
  inactive: string;
  /** "Created {time}". */
  created: (time: React.ReactNode) => React.ReactNode;
  /** "Expires {time}". */
  expires: (time: React.ReactNode) => React.ReactNode;
  noExpiry: React.ReactNode;
  expiry: React.ReactNode;
  /** One label per `OVERLAY_EXPIRY_CHOICES` entry. */
  expiryOptions: Record<OverlayExpiryChoice, string>;
  expiryDate: React.ReactNode;
  expiryDateInvalid: React.ReactNode;
  expiryDatePast: React.ReactNode;
  create: string;
  rotate: string;
  rotateTitle: React.ReactNode;
  rotateDescription?: React.ReactNode;
  /** Per overlay: its name ("Alerts") and what it shows. */
  links: Record<OverlayKind, { name: string; hint: React.ReactNode }>;
  /** "800 × 600 px" (the page formats the numbers). */
  size: (width: number, height: number) => React.ReactNode;
  /** Shown once beside the links: copy now, keep them off stream. */
  urlHint?: React.ReactNode;
  /** While a link exists but was shown on an earlier visit: it cannot be shown again. */
  linksHidden: React.ReactNode;
  /** "How to add a link in OBS" and its steps, in order. */
  obsTitle: string;
  obsSteps: readonly React.ReactNode[];
  /** Reveal / hide the masked URL (it holds the token; keep it off a captured screen). */
  showUrl: string;
  hideUrl: string;
  copy: string;
  copied: string;
  copyFailed: string;
  revoke: string;
  revokeTitle: React.ReactNode;
  revokeDescription?: React.ReactNode;
}

export interface OverlayTokenPanelProps extends Omit<React.ComponentProps<"div">, "children" | "title" | "onError"> {
  /** `interact.overlays.status`; `null` while loading. */
  status: OverlayTokenStatusView | null;
  /**
   * The three URLs from the create response: shown once (masked until revealed), never
   * refetched, and only while `status.active`. The page must clear them on revoke.
   */
  createdUrls?: OverlayLinkUrls | null;
  labels: OverlayTokenLabels;
  /** Gets `null` (no expiry) or the ISO instant from `resolveOverlayExpiry`. */
  onCreate: (expiresAt: string | null) => void | Promise<void>;
  onRevoke: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Clock for the quick picks (tests). */
  now?: () => number;
}

/**
 * The overlay links: status with expiry, expiry choice (quick picks or an exact date), create or
 * rotate (confirmed when a token is active), the three once-shown links (alerts, chat, goals),
 * each with its OBS browser-source size, OBS steps, and revoke. Renders the spec's
 * `overlay-token`, `overlay-expiry`, `overlay-expiry-date`, `overlay-token-create`, `overlay-url`
 * (alerts) and `overlay-token-revoke` (docs/testing/e6-selectors.md), plus `overlay-url-chat`,
 * `overlay-url-goals` (each with `data-url`, `data-width`, `data-height`), `overlay-sizes` (the
 * sizes while no link is on screen) and `overlay-obs-help`.
 */
export function OverlayTokenPanel({
  status,
  createdUrls,
  labels,
  onCreate,
  onRevoke,
  onError,
  now = Date.now,
  className,
  ...props
}: OverlayTokenPanelProps): React.JSX.Element {
  const id = React.useId();
  const [choice, setChoice] = React.useState<OverlayExpiryChoice>("none");
  const [dateText, setDateText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const active = status?.active ?? false;
  // Validated as typed; the instant itself is computed at click time so quick picks count from then.
  const preview = choice === "date" ? resolveOverlayExpiry(choice, now(), dateText) : null;
  const dateProblem = preview && !preview.ok && dateText !== "" ? preview.reason : null;
  const canCreate = status !== null && !pending && (choice !== "date" || (preview?.ok ?? false));

  const create = async (): Promise<void> => {
    const result = resolveOverlayExpiry(choice, now(), dateText);
    if (!result.ok) return;
    setPending(true);
    try {
      await onCreate(result.expiresAt);
    } finally {
      setPending(false);
    }
  };
  const createDirect = async (): Promise<void> => {
    try {
      await create();
    } catch (caught) {
      onError?.(caught);
    }
  };

  const createButton = (
    <Button
      type="button"
      data-testid="overlay-token-create"
      disabled={!canCreate}
      aria-busy={pending || undefined}
      onClick={active ? undefined : () => void createDirect()}
    >
      {active ? labels.rotate : labels.create}
    </Button>
  );

  return (
    <Card
      data-testid="overlay-token"
      data-active={String(active)}
      data-expires-at={status?.expiresAt ?? ""}
      className={cn("min-w-0", className)}
      {...props}
    >
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        {labels.description ? <CardDescription>{labels.description}</CardDescription> : null}
        {status ? (
          <CardAction>
            <StatusBadge tone={active ? "success" : "neutral"}>{active ? labels.active : labels.inactive}</StatusBadge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === null ? (
          <SkeletonGroup>
            <SkeletonText lines={3} />
          </SkeletonGroup>
        ) : (
          <>
            {active ? (
              <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {status.createdAt ? <span>{labels.created(<RelativeTime date={status.createdAt} />)}</span> : null}
                <span>
                  {status.expiresAt ? labels.expires(<RelativeTime date={status.expiresAt} />) : labels.noExpiry}
                </span>
              </p>
            ) : null}
            {active && createdUrls ? (
              <div className="flex min-w-0 flex-col gap-4">
                {labels.urlHint ? <p className="text-xs text-muted-foreground">{labels.urlHint}</p> : null}
                {OVERLAY_KINDS.map((kind) => {
                  const { width, height } = OVERLAY_SIZES[kind];
                  const testId = overlayUrlTestId(kind);
                  return (
                    // `data-url` lets e2e read the URL without revealing it on screen.
                    <div
                      key={kind}
                      data-testid={testId}
                      data-kind={kind}
                      data-url={createdUrls[kind]}
                      data-width={width}
                      data-height={height}
                      className="min-w-0"
                    >
                      <CopyField
                        data-value-testid={`${testId}-value`}
                        data-reveal-testid={`${testId}-reveal`}
                        label={labels.links[kind].name}
                        value={createdUrls[kind]}
                        secret
                        showLabel={labels.showUrl}
                        hideLabel={labels.hideUrl}
                        hint={
                          <>
                            <span className="tabular-nums">{labels.size(width, height)}</span>
                            <span aria-hidden> · </span>
                            {labels.links[kind].hint}
                          </>
                        }
                        copyLabel={labels.copy}
                        copiedLabel={labels.copied}
                        copyFailedLabel={labels.copyFailed}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-2">
                {active ? <p className="text-xs text-muted-foreground">{labels.linksHidden}</p> : null}
                <ul data-testid="overlay-sizes" className="flex flex-col gap-1 text-sm">
                  {OVERLAY_KINDS.map((kind) => (
                    <li key={kind} data-kind={kind} className="flex flex-wrap justify-between gap-x-2">
                      <span>{labels.links[kind].name}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {labels.size(OVERLAY_SIZES[kind].width, OVERLAY_SIZES[kind].height)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Collapsible data-testid="overlay-obs-help">
              <CollapsibleTrigger render={<Button type="button" variant="link" size="sm" className="px-0" />}>
                {labels.obsTitle}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-muted-foreground">
                  {labels.obsSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </CollapsibleContent>
            </Collapsible>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label={labels.expiry}
                options={OVERLAY_EXPIRY_CHOICES.map((value) => ({
                  value,
                  label: labels.expiryOptions[value],
                  "data-testid": `overlay-expiry-option-${value}`,
                }))}
                value={choice}
                onValueChange={(value) => {
                  if (isOverlayExpiryChoice(value)) setChoice(value);
                }}
                data-testid="overlay-expiry"
                data-value={choice}
              />
              {choice === "date" ? (
                <Field data-invalid={dateProblem ? true : undefined}>
                  <FieldLabel htmlFor={`${id}-date`}>{labels.expiryDate}</FieldLabel>
                  <Input
                    id={`${id}-date`}
                    data-testid="overlay-expiry-date"
                    type="datetime-local"
                    value={dateText}
                    aria-invalid={dateProblem ? true : undefined}
                    onChange={(event) => setDateText(event.currentTarget.value)}
                  />
                  {dateProblem ? (
                    <FieldError>{dateProblem === "past" ? labels.expiryDatePast : labels.expiryDateInvalid}</FieldError>
                  ) : null}
                </Field>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2">
        {active ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="ghost" data-testid="overlay-token-revoke" disabled={pending}>
                {labels.revoke}
              </Button>
            }
            title={labels.revokeTitle}
            description={labels.revokeDescription}
            confirmLabel={labels.revoke}
            variant="destructive"
            onConfirm={onRevoke}
            onError={onError}
          />
        ) : null}
        {active ? (
          <ConfirmDialog
            trigger={createButton}
            title={labels.rotateTitle}
            description={labels.rotateDescription}
            confirmLabel={labels.rotate}
            onConfirm={create}
            onError={onError}
          />
        ) : (
          createButton
        )}
      </CardFooter>
    </Card>
  );
}
