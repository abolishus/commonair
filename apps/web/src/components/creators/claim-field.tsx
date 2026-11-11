// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Slug } from "@commonair/contracts";
import { Button } from "@commonair/ui/components/button";
import { Input } from "@commonair/ui/components/input";
import { Label } from "@commonair/ui/components/label";
import { cn } from "@commonair/ui/lib/utils";
import { Cancel01Icon, LockIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { trackUi } from "../../lib/ui-metrics.ts";

/** The answer of `users.usernameAvailable`. */
export interface Availability {
  username: string;
  available: boolean;
  reason: "taken" | "reserved" | "invalid" | null;
}

export type ClaimStatus =
  | { kind: "idle" }
  | { kind: "invalid" }
  | { kind: "checking"; name: string }
  | { kind: "free"; name: string }
  | { kind: "taken"; name: string }
  | { kind: "reserved"; name: string }
  /** The check did not answer (rate limit, not deployed yet): sign-up checks the name instead. */
  | { kind: "unchecked"; name: string };

/** How long typing must pause before the name is checked. */
export const CLAIM_DEBOUNCE_MS = 350;

/** The name as sign-up would take it, or null when it is not a valid username. */
export function normalizeClaim(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return Slug.safeParse(name).success ? name : null;
}

/** Where "Claim it" goes: sign-up with the stream intent and the name filled in. */
export function claimHref(name: string): string {
  const search = new URLSearchParams({ intent: "stream", username: name });
  return `/signup?${search.toString()}`;
}

/** The status an availability answer maps to. */
export function statusOf(answer: Availability, name: string): ClaimStatus {
  if (answer.available) return { kind: "free", name };
  if (answer.reason === "reserved") return { kind: "reserved", name };
  if (answer.reason === "invalid") return { kind: "invalid" };
  return { kind: "taken", name };
}

export interface ClaimFieldProps {
  /** The instance host shown before the name (`commonair.example/`). */
  host: string;
  /** Tests pass their own; the default asks the API. */
  check?: (username: string) => Promise<Availability>;
  /** Tests pass their own; the default is a full navigation to sign-up. */
  go?: (href: string) => void;
  debounceMs?: number;
}

const defaultCheck = (username: string) => api().users.usernameAvailable({ username });
const defaultGo = (href: string) => {
  window.location.assign(href);
};

/** "Claim your channel name": a debounced availability check, then sign-up with the name. */
export function ClaimField({
  host,
  check = defaultCheck,
  go = defaultGo,
  debounceMs = CLAIM_DEBOUNCE_MS,
}: ClaimFieldProps): React.JSX.Element {
  const id = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState("");
  const [status, setStatus] = React.useState<ClaimStatus>({ kind: "idle" });
  // Only the newest check may set the status: answers can arrive out of order.
  const latest = React.useRef(0);

  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const lookUp = async (name: string, ticket: number) => {
    setStatus({ kind: "checking", name });
    let next: ClaimStatus;
    try {
      next = statusOf(await check(name), name);
    } catch {
      next = { kind: "unchecked", name };
    }
    if (ticket !== latest.current) return;
    setStatus(next);
    if (next.kind === "taken") trackUi("creators.claim", "error", "username_taken");
  };

  const change = (raw: string) => {
    setValue(raw);
    clearTimeout(timer.current);
    const ticket = ++latest.current;
    if (raw.trim() === "") {
      setStatus({ kind: "idle" });
      return;
    }
    const name = normalizeClaim(raw);
    timer.current = setTimeout(() => {
      if (name === null) setStatus({ kind: "invalid" });
      else void lookUp(name, ticket);
    }, debounceMs);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = normalizeClaim(value);
    if (name === null) {
      setStatus({ kind: "invalid" });
      trackUi("creators.claim", "error", "invalid");
      inputRef.current?.focus();
      return;
    }
    // A name we know is unavailable stays here; one we could not check goes on to sign-up.
    if ((status.kind === "taken" || status.kind === "reserved") && status.name === name) {
      inputRef.current?.focus();
      return;
    }
    trackUi("creators.claim", "submit", "stream");
    go(claimHref(name));
  };

  const statusId = `${id}-status`;
  const hintId = `${id}-hint`;
  return (
    <form data-testid="claim-form" noValidate onSubmit={submit} className="flex max-w-xl flex-col gap-2">
      <Label htmlFor={`${id}-input`}>{t("d2Pages.creators.claim.label")}</Label>
      <div className="flex gap-2 max-sm:flex-col">
        <div className="flex min-w-0 flex-1 items-center bg-background ring-1 ring-input ring-inset focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
          <span aria-hidden className="shrink-0 ps-3 text-muted-foreground">
            {host}
          </span>
          <Input
            ref={inputRef}
            id={`${id}-input`}
            data-testid="claim-input"
            value={value}
            onChange={(e) => change(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            aria-describedby={`${statusId} ${hintId}`}
            aria-invalid={status.kind === "invalid" || status.kind === "taken" || status.kind === "reserved"}
            className="min-h-11 min-w-0 flex-1 border-0 bg-transparent ps-0.5 shadow-none focus-visible:ring-0"
          />
        </div>
        <Button type="submit" variant="brand" size="lg" data-filled-cta="" className="min-h-11">
          {t("d2Pages.creators.claim.submit")}
        </Button>
      </div>
      <output
        id={statusId}
        aria-live="polite"
        data-testid="claim-status"
        data-status={status.kind}
        className={cn(
          "flex min-h-5 items-center gap-1.5 text-sm",
          status.kind === "free" && "text-success",
          (status.kind === "taken" || status.kind === "invalid") && "text-destructive",
          status.kind === "reserved" && "text-warning",
          (status.kind === "checking" || status.kind === "unchecked") && "text-muted-foreground",
        )}
      >
        <StatusIcon status={status} />
        <StatusText status={status} />
      </output>
      <p id={hintId} className="text-sm text-muted-foreground">
        {t("d2Pages.creators.claim.hint")}
      </p>
    </form>
  );
}

function StatusIcon({ status }: { status: ClaimStatus }) {
  const icon =
    status.kind === "free"
      ? Tick02Icon
      : status.kind === "taken" || status.kind === "invalid"
        ? Cancel01Icon
        : status.kind === "reserved"
          ? LockIcon
          : null;
  return icon ? <HugeiconsIcon icon={icon} className="size-4 shrink-0" strokeWidth={2} aria-hidden /> : null;
}

function StatusText({ status }: { status: ClaimStatus }): React.ReactNode {
  switch (status.kind) {
    case "idle":
      return null;
    case "invalid":
      return t("d2Pages.creators.claim.invalid");
    case "checking":
      return t("d2Pages.creators.claim.checking", { name: status.name });
    case "free":
      return t("d2Pages.creators.claim.free", { name: status.name });
    case "taken":
      return t("d2Pages.creators.claim.taken", { name: status.name });
    case "reserved":
      return t("d2Pages.creators.claim.reserved", { name: status.name });
    case "unchecked":
      return t("d2Pages.creators.claim.unchecked", { name: status.name });
  }
}
