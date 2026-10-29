// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/developer/bots`: bot accounts you own and the tokens you mint for them (shown once, with the
 * IRC hint for Twitch-style bot libraries), then every token authorized on your account or your
 * bots', with revocation.
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@commonair/ui/components/dialog";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { toast } from "@commonair/ui/toast";
import { Add01Icon, Delete02Icon, Key01Icon, RoboticIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useLoad } from "../money/use-load.ts";
import { StudioSection, TextField, fillNodes } from "../interact-studio/shared.tsx";
import type { AccessTokenDto, BotDto, DeveloperClient } from "./client.ts";
import {
  ALL_SCOPES,
  BOT_LIMITS,
  type BotDraft,
  type BotField,
  type FieldErrors,
  TOKEN_KIND_KEYS,
  type TokenDraft,
  type TokenField,
  botInput,
  developerError,
  emptyTokenDraft,
  ircPass,
  toggleScope,
  tokenInput,
} from "./model.ts";
import { CopyButton, LoadError } from "./shared.tsx";

export function DeveloperBotsPage({ client }: { client: DeveloperClient }): React.JSX.Element {
  const [tokensVersion, setTokensVersion] = React.useState(0);
  return (
    <div className="flex flex-col gap-6">
      <BotsPanel client={client} onTokenMinted={() => setTokensVersion((v) => v + 1)} />
      <TokensPanel client={client} version={tokensVersion} />
    </div>
  );
}

// ── Bots ─────────────────────────────────────────────────────────────────────────────────────

function BotsPanel({
  client,
  onTokenMinted,
}: {
  client: DeveloperClient;
  onTokenMinted: () => void;
}): React.JSX.Element {
  const loaded = useLoad("developer:bots", () => client.bots.list());
  const [added, setAdded] = React.useState<BotDto[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [mintFor, setMintFor] = React.useState<BotDto | null>(null);
  const bots = loaded.data ? [...loaded.data, ...added.filter((b) => !loaded.data?.some((x) => x.id === b.id))] : null;

  return (
    <StudioSection
      icon={RoboticIcon}
      title={t("developer.bots.title")}
      description={t("developer.bots.intro")}
      data-testid="devbots"
      action={
        <Button type="button" size="sm" data-testid="devbot-new" onClick={() => setCreating(true)}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("developer.bots.new")}
        </Button>
      }
    >
      {bots === null && loaded.failed ? (
        <LoadError message={t("developer.bots.loadFailed")} onRetry={loaded.reload} />
      ) : bots === null ? (
        <SkeletonGroup label={t("developer.loading")}>
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : bots.length === 0 ? (
        <EmptyState
          data-testid="devbots-empty"
          icon={RoboticIcon}
          headingLevel={3}
          title={t("developer.bots.empty")}
          description={t("developer.bots.emptyHint")}
        />
      ) : (
        <ul className="flex flex-col divide-y" aria-label={t("developer.bots.title")}>
          {bots.map((bot) => (
            <li
              key={bot.id}
              data-testid="devbot"
              data-bot-id={bot.id}
              data-username={bot.username}
              className="flex flex-wrap items-center gap-2 py-3"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium break-words">{bot.displayName}</span>
                <span className="text-xs break-all text-muted-foreground">@{bot.username}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="devbot-token-new"
                onClick={() => setMintFor(bot)}
              >
                <HugeiconsIcon icon={Key01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                {t("developer.bots.mint")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <BotDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSave={async (draft) => {
          const checked = botInput(draft);
          if (!checked.ok) return checked.errors;
          const bot = await client.bots.create(checked.input);
          setAdded((list) => [...list, bot]);
          setCreating(false);
          toast.success(t("developer.bots.created", { username: bot.username }));
          return null;
        }}
      />
      <TokenDialog bot={mintFor} client={client} onClose={() => setMintFor(null)} onMinted={onTokenMinted} />
    </StudioSection>
  );
}

function BotDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (draft: BotDraft) => Promise<FieldErrors<BotField> | null>;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {open ? <BotForm onClose={onClose} onSave={onSave} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function BotForm({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (draft: BotDraft) => Promise<FieldErrors<BotField> | null>;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<BotDraft>({ username: "", displayName: "" });
  const [errors, setErrors] = React.useState<FieldErrors<BotField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      setErrors((await onSave(draft)) ?? {});
    } catch (err) {
      setFailure(developerError(err, "developer.bots.createFailed", { CONFLICT: "developer.bots.taken" }));
    } finally {
      setPending(false);
    }
  };

  return (
    <form data-testid="devbot-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("developer.bots.newTitle")}</DialogTitle>
        <DialogDescription>{t("developer.bots.formHint")}</DialogDescription>
      </DialogHeader>
      <TextField
        label={t("developer.bots.username")}
        value={draft.username}
        onChange={(v) => setDraft((d) => ({ ...d, username: v }))}
        data-testid="devbot-username"
        error={errors.username}
        description={t("developer.bots.usernameHint", { min: BOT_LIMITS.usernameMin, max: BOT_LIMITS.usernameMax })}
      />
      <TextField
        label={t("developer.bots.displayName")}
        value={draft.displayName}
        onChange={(v) => setDraft((d) => ({ ...d, displayName: v }))}
        data-testid="devbot-display-name"
        error={errors.displayName}
      />
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {t("developer.cancel")}
        </Button>
        <Button type="submit" data-testid="devbot-submit" disabled={pending}>
          {t("developer.bots.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── Minting a token ──────────────────────────────────────────────────────────────────────────

function TokenDialog({
  bot,
  client,
  onClose,
  onMinted,
}: {
  bot: BotDto | null;
  client: DeveloperClient;
  onClose: () => void;
  onMinted: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={bot !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {bot ? <TokenForm key={bot.id} bot={bot} client={client} onClose={onClose} onMinted={onMinted} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The scopes and lifetime, then the token once; closing forgets it. */
function TokenForm({
  bot,
  client,
  onClose,
  onMinted,
}: {
  bot: BotDto;
  client: DeveloperClient;
  onClose: () => void;
  onMinted: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<TokenDraft>(emptyTokenDraft);
  const [errors, setErrors] = React.useState<FieldErrors<TokenField>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(null);
  const scopesId = React.useId();

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const checked = tokenInput(bot.id, draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setPending(true);
    setFailure(null);
    try {
      const minted = await client.bots.createToken(checked.input);
      setToken(minted.accessToken);
      onMinted();
    } catch (err) {
      setFailure(developerError(err, "developer.token.mintFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form data-testid="devbot-token-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("developer.token.title", { username: bot.username })}</DialogTitle>
        <DialogDescription>{token === null ? t("developer.token.intro") : t("developer.token.once")}</DialogDescription>
      </DialogHeader>
      {token === null ? (
        <>
          <FieldSet
            data-invalid={errors.scopes ? true : undefined}
            aria-describedby={errors.scopes ? `${scopesId}-error` : undefined}
          >
            <FieldLegend variant="label">{t("developer.token.scopes")}</FieldLegend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ALL_SCOPES.map((scope) => (
                <Field key={scope} orientation="horizontal">
                  <Checkbox
                    id={`${scopesId}-${scope}`}
                    data-testid={`devbot-scope-${scope}`}
                    checked={draft.scopes.includes(scope)}
                    onCheckedChange={(on) =>
                      setDraft((d) => ({ ...d, scopes: toggleScope(d.scopes, scope, on === true) }))
                    }
                  />
                  <FieldLabel htmlFor={`${scopesId}-${scope}`} className="font-normal">
                    <code className="text-xs">{scope}</code>
                  </FieldLabel>
                </Field>
              ))}
            </div>
            {errors.scopes ? <FieldError id={`${scopesId}-error`}>{errors.scopes}</FieldError> : null}
          </FieldSet>
          <TextField
            label={t("developer.token.days")}
            value={draft.days}
            onChange={(v) => setDraft((d) => ({ ...d, days: v }))}
            data-testid="devbot-token-days"
            numeric
            error={errors.days}
            description={t("developer.token.daysHint", { min: BOT_LIMITS.daysMin, max: BOT_LIMITS.daysMax })}
          />
          {failure ? (
            <p role="alert" className="text-sm break-words text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("developer.cancel")}
            </Button>
            <Button type="submit" data-testid="devbot-token-submit" disabled={pending}>
              {t("developer.token.mint")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <code
              data-testid="devbot-token-value"
              className="min-w-0 flex-1 rounded-sm bg-muted p-2 text-sm break-all select-all"
            >
              {token}
            </code>
            <CopyButton value={token} label={t("developer.token.copy")} />
          </div>
          <AlertCallout tone="warning" description={t("developer.token.onceWarning")} />
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("developer.token.ircTitle")}</span>
            <span className="text-muted-foreground">
              {fillNodes(t("developer.token.ircHint"), {
                pass: <code className="break-all">{ircPass("<token>")}</code>,
                nick: <code>{bot.username}</code>,
              })}
            </span>
          </div>
          <DialogFooter>
            <Button type="button" data-testid="devbot-token-done" onClick={onClose}>
              {t("developer.token.done")}
            </Button>
          </DialogFooter>
        </>
      )}
    </form>
  );
}

// ── Tokens on your account ───────────────────────────────────────────────────────────────────

function TokensPanel({ client, version }: { client: DeveloperClient; version: number }): React.JSX.Element {
  const loaded = useLoad(`developer:tokens:${version}`, () => client.tokens.list());
  const [revoked, setRevoked] = React.useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = React.useState<string | null>(null);
  const tokens = loaded.data?.filter((tk) => !revoked.has(tk.id)) ?? null;

  const revoke = async (token: AccessTokenDto): Promise<void> => {
    setFailure(null);
    await client.tokens.revoke({ id: token.id });
    setRevoked((s) => new Set([...s, token.id]));
    toast.success(t("developer.tokens.revoked"));
  };

  return (
    <StudioSection icon={Key01Icon} title={t("developer.tokens.title")} description={t("developer.tokens.intro")}>
      {failure ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {failure}
        </p>
      ) : null}
      {tokens === null && loaded.failed ? (
        <LoadError message={t("developer.tokens.loadFailed")} onRetry={loaded.reload} />
      ) : tokens === null ? (
        <SkeletonGroup label={t("developer.loading")}>
          <SkeletonText lines={3} />
        </SkeletonGroup>
      ) : tokens.length === 0 ? (
        <EmptyState icon={Key01Icon} headingLevel={3} title={t("developer.tokens.empty")} />
      ) : (
        <ul className="flex flex-col divide-y" aria-label={t("developer.tokens.title")}>
          {tokens.map((token) => (
            <li
              key={token.id}
              data-testid="devtoken"
              data-token-id={token.id}
              data-app-id={token.appId ?? ""}
              data-kind={token.kind}
              className="flex flex-wrap items-start gap-2 py-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium break-words">
                    {token.appName ?? t("developer.tokens.personal")}
                  </span>
                  <StatusBadge tone="neutral">{t(TOKEN_KIND_KEYS[token.kind])}</StatusBadge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {token.scopes.map((s) => (
                    <code key={s} className="rounded-sm bg-muted px-1 text-xs">
                      {s}
                    </code>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  {fillNodes(t("developer.tokens.dates"), {
                    created: <RelativeTime date={token.createdAt} />,
                    expires: <RelativeTime date={token.expiresAt} />,
                  })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {token.lastUsedAt
                    ? fillNodes(t("developer.tokens.lastUsed"), { time: <RelativeTime date={token.lastUsedAt} /> })
                    : t("developer.tokens.neverUsed")}
                </span>
              </div>
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline" size="sm" data-testid="devtoken-revoke">
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                    {t("developer.tokens.revoke")}
                  </Button>
                }
                variant="destructive"
                title={t("developer.tokens.revokeTitle")}
                description={t("developer.tokens.revokeBody")}
                confirmLabel={t("developer.tokens.revokeConfirm")}
                onConfirm={() => revoke(token)}
                onError={(err) => setFailure(developerError(err, "developer.tokens.revokeFailed"))}
              />
            </li>
          ))}
        </ul>
      )}
    </StudioSection>
  );
}
