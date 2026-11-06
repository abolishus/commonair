// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/move` page's content (ADR 0037; docs/testing/b7-selectors.md "Portability"), drawn from
 * props so tests render every state: move links (create, copy once, revoke with confirmation,
 * conversions), "moved to" (set with confirmation, clear) with the note that subscriptions are
 * untouched (decision (m)), and the bundle export. The import is its own card (`import-card.tsx`).
 */
import { ConfirmDialog, EmptyState, IconButton, RelativeTime, StatusBadge, type StatusTone } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Copy01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { FormError } from "../form-error.tsx";
import {
  EXPIRY_CHOICES,
  EXPIRY_KEYS,
  isValidMovedTo,
  LINK_STATE_KEYS,
  linkState,
  sortLinks,
  type ExpiryChoice,
  type LinkState,
  type MoveLinkDto,
} from "./lib.ts";

export interface CreatedLink {
  id: string;
  url: string;
}

export interface MovePanelProps {
  /** Null while loading. */
  links: readonly MoveLinkDto[] | null;
  /** The link just created, shown once with its full address. */
  created: CreatedLink | null;
  movedTo: { url: string; at: string } | null;
  loadFailed: boolean;
  nowMs: number;
  onCreate: (expiry: ExpiryChoice) => Promise<void>;
  onCopy: (url: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onSetMovedTo: (url: string) => Promise<void>;
  onClearMovedTo: () => Promise<void>;
  onExport: () => Promise<void>;
  /** The import card (`ImportCard`), rendered last. */
  importCard?: React.ReactNode;
}

const STATE_TONE: Record<LinkState, StatusTone> = { active: "success", revoked: "neutral", expired: "neutral" };

export function MovePanel(props: MovePanelProps): React.JSX.Element {
  return (
    <div data-testid="move-page" className="flex min-w-0 flex-col gap-6">
      {props.loadFailed && <FormError>{t("portability.loadFailed")}</FormError>}
      <LinksCard {...props} />
      <MovedToCard {...props} />
      <ExportCard onExport={props.onExport} />
      {props.importCard}
    </div>
  );
}

function LinksCard(props: MovePanelProps): React.JSX.Element {
  const [expiry, setExpiry] = React.useState<ExpiryChoice>("never");
  const [busy, setBusy] = React.useState(false);
  const expiryId = React.useId();
  const items = Object.fromEntries(EXPIRY_CHOICES.map((c) => [c, t(EXPIRY_KEYS[c])]));
  const links = props.links ? sortLinks(props.links, props.nowMs) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("portability.links.title")}</CardTitle>
        <CardDescription>{t("portability.links.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-auto">
            <FieldLabel htmlFor={expiryId}>{t("portability.links.expiryLabel")}</FieldLabel>
            <Select<string> value={expiry} items={items} onValueChange={(v) => setExpiry(v as ExpiryChoice)}>
              <SelectTrigger id={expiryId} data-testid="move-link-expiry" data-value={expiry} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_CHOICES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {items[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            data-testid="move-link-create"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => {
              setBusy(true);
              void props.onCreate(expiry).finally(() => setBusy(false));
            }}
          >
            {t("portability.links.create")}
          </Button>
        </div>
        {props.created && (
          <AlertCallout tone="info" title={t("portability.links.newTitle")}>
            <div className="flex min-w-0 items-center gap-2">
              <code data-testid="move-link-new" data-url={props.created.url} className="min-w-0 break-all text-sm">
                {props.created.url}
              </code>
              <IconButton
                type="button"
                icon={Copy01Icon}
                label={t("portability.links.copy")}
                size="icon-sm"
                data-testid="move-link-copy"
                onClick={() => void props.onCopy(props.created?.url ?? "")}
              />
            </div>
            <p className="text-muted-foreground">{t("portability.links.newHint")}</p>
          </AlertCallout>
        )}
        {links === null ? null : links.length === 0 ? (
          <EmptyState
            icon={Link01Icon}
            headingLevel={3}
            title={t("portability.links.empty")}
            description={t("portability.links.emptyHint")}
          />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y" aria-label={t("portability.links.listLabel")}>
            {links.map((l) => {
              const state = linkState(l, props.nowMs);
              return (
                <li
                  key={l.id}
                  data-testid="move-link"
                  data-link-id={l.id}
                  data-conversions={l.conversions}
                  data-state={state}
                  className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium">
                      {t("portability.links.conversions", { count: l.conversions })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("portability.links.created")} <RelativeTime date={l.createdAt} />
                      {l.expiresAt && state === "active" && (
                        <>
                          {" · "}
                          {t("portability.links.expires")} <RelativeTime date={l.expiresAt} />
                        </>
                      )}
                    </span>
                  </div>
                  <StatusBadge tone={STATE_TONE[state]}>{t(LINK_STATE_KEYS[state])}</StatusBadge>
                  {state === "active" && (
                    <ConfirmDialog
                      trigger={
                        <Button variant="outline" size="sm" data-testid="move-link-revoke">
                          {t("portability.links.revoke")}
                        </Button>
                      }
                      title={t("portability.links.revokeTitle")}
                      description={t("portability.links.revokeBody")}
                      confirmLabel={t("portability.links.revoke")}
                      variant="destructive"
                      contentProps={{ "data-testid": "move-link-revoke-confirm" }}
                      onConfirm={() => props.onRevoke(l.id)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MovedToCard(props: MovePanelProps): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const inputId = React.useId();
  const hintId = React.useId();
  const valid = isValidMovedTo(draft);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("portability.moved.title")}</CardTitle>
        <CardDescription>{t("portability.moved.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {/* A note: the card's hint size, not a larger body size (F35). */}
        <FieldDescription data-testid="move-subscriptions-note">
          {t("portability.moved.subscriptions")}
        </FieldDescription>
        {props.movedTo && (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="min-w-0 text-sm">
              {t("portability.moved.current")}{" "}
              <code data-testid="move-to-current" data-url={props.movedTo.url} className="break-all">
                {props.movedTo.url}
              </code>{" "}
              <span className="text-muted-foreground">
                (<RelativeTime date={props.movedTo.at} />)
              </span>
            </span>
            <ConfirmDialog
              trigger={
                <Button variant="outline" size="sm" data-testid="move-to-clear">
                  {t("portability.moved.clear")}
                </Button>
              }
              title={t("portability.moved.clearTitle")}
              description={t("portability.moved.clearBody")}
              confirmLabel={t("portability.moved.clear")}
              onConfirm={props.onClearMovedTo}
            />
          </div>
        )}
        <Field>
          <FieldLabel htmlFor={inputId}>{t("portability.moved.url")}</FieldLabel>
          <Input
            id={inputId}
            data-testid="move-to-url"
            type="url"
            inputMode="url"
            maxLength={500}
            placeholder={t("portability.moved.urlPlaceholder")}
            value={draft}
            aria-describedby={hintId}
            aria-invalid={touched && !valid ? true : undefined}
            onBlur={() => setTouched(true)}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <FieldDescription id={hintId}>{t("portability.moved.urlHint")}</FieldDescription>
          {touched && draft !== "" && !valid && <FormError>{t("portability.moved.invalid")}</FormError>}
        </Field>
        <div>
          <ConfirmDialog
            trigger={
              <Button data-testid="move-to-save" disabled={!valid}>
                {t("portability.moved.save")}
              </Button>
            }
            title={t("portability.moved.confirmTitle")}
            description={t("portability.moved.confirmBody", { url: draft.trim() })}
            confirmLabel={t("portability.moved.save")}
            contentProps={{ "data-testid": "move-to-confirm" }}
            onConfirm={async () => {
              await props.onSetMovedTo(draft.trim());
              setDraft("");
              setTouched(false);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ExportCard({ onExport }: { onExport: () => Promise<void> }): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("portability.export.title")}</CardTitle>
        <CardDescription>{t("portability.export.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          data-testid="bundle-export"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => {
            setBusy(true);
            void onExport().finally(() => setBusy(false));
          }}
        >
          {t("portability.export.request")}
        </Button>
      </CardContent>
    </Card>
  );
}
