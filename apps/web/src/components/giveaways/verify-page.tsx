// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public giveaway verify page (`/$channel/giveaways/$giveawayId`, ADR 0039 §1–§2): the seed
 * commitment published at open, the seed revealed at the draw, the entry pseudonyms in draw order
 * and the winners, and the draw re-run here in the browser with `@commonair/draw` ("matches" or
 * "does not match"). A signed-in entrant sees which pseudonym is theirs; nobody else can tell (the
 * salt is never published). Public; a missing giveaway, or giveaways off, is not found.
 */
import { RelativeTime, SkeletonText, StatusBadge } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Alert, AlertDescription, AlertTitle } from "@commonair/ui/components/alert";
import { PageContainer } from "@commonair/ui/layouts";
import * as React from "react";
import { type MessageKey, t } from "../../i18n/index.ts";
import { api, type Api } from "../../lib/api.ts";
import { fillNode } from "../../lib/fill.tsx";
import { giveawaysEnabled } from "../../chat/interact/client.ts";
import { FormError } from "../form-error.tsx";
import { NotFoundState } from "../money/not-found.tsx";
import { STATUS_KEYS, verifyDraw, type GiveawayVerificationDto, type VerifyOutcome } from "./logic.ts";

export type VerifyClient = Pick<Api, "interact" | "instance">;

type Loaded =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; v: GiveawayVerificationDto; mine: string | null };

async function load(client: VerifyClient, channel: string, id: string, signedIn: boolean): Promise<Loaded> {
  if (!(await giveawaysEnabled(client))) return { kind: "missing" };
  let v: GiveawayVerificationDto;
  try {
    v = await client.interact.giveaways.verify({ channel, id });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : null;
    return code === "NOT_FOUND" ? { kind: "missing" } : { kind: "failed" };
  }
  // CR9: `verify.me` is the signed-in caller's own pseudonym on any giveaway they entered.
  let mine: string | null = signedIn ? (v.me?.pseudonym ?? null) : null;
  // Only a pseudonym that is in the published list is marked (never a name: decision (n)).
  if (mine !== null && !v.entries.includes(mine)) mine = null;
  return { kind: "ready", v, mine };
}

export interface GiveawayVerifyPageProps {
  channel: string;
  giveawayId: string;
  signedIn: boolean;
  client?: VerifyClient;
}

export function GiveawayVerifyPage({
  channel,
  giveawayId,
  signedIn,
  client: clientProp,
}: GiveawayVerifyPageProps): React.JSX.Element {
  const [client] = React.useState<VerifyClient>(() => clientProp ?? api());
  const [loaded, setLoaded] = React.useState<Loaded>({ kind: "loading" });
  const [outcome, setOutcome] = React.useState<VerifyOutcome | null>(null);

  React.useEffect(() => {
    let live = true;
    void load(client, channel, giveawayId, signedIn)
      .catch((): Loaded => ({ kind: "failed" }))
      .then((r) => {
        if (live) setLoaded(r);
      });
    return () => {
      live = false;
    };
  }, [client, channel, giveawayId, signedIn]);

  React.useEffect(() => {
    if (loaded.kind !== "ready") return;
    let live = true;
    void verifyDraw(loaded.v)
      // A malformed published seed or list is a mismatch, not a crash.
      .catch((): VerifyOutcome => ({ state: "checked", match: false, problem: "entries", skipped: 0 }))
      .then((o) => {
        if (live) setOutcome(o);
      });
    return () => {
      live = false;
    };
  }, [loaded]);

  if (loaded.kind === "missing") return <NotFoundState />;
  if (loaded.kind === "loading")
    return (
      <PageContainer className="flex max-w-3xl flex-col gap-6 py-8">
        <SkeletonText lines={8} />
      </PageContainer>
    );
  if (loaded.kind === "failed")
    return (
      <PageContainer className="flex max-w-3xl flex-col gap-6 py-8">
        <FormError>{t("giveaways.verify.loadFailed")}</FormError>
      </PageContainer>
    );
  const { v, mine } = loaded;
  return (
    <PageContainer
      data-testid="giveaway-verify-page"
      data-giveaway-id={v.id}
      data-status={v.status}
      className="flex max-w-3xl min-w-0 flex-col gap-6 py-8"
    >
      <PageHeader title={v.title} description={t("giveaways.verify.intro", { channel: v.channelSlug })} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={v.status === "open" ? "success" : "neutral"}>{t(STATUS_KEYS[v.status])}</StatusBadge>
        {v.drawnAt ? (
          <span className="text-xs text-muted-foreground">
            {fillNode(t("giveaways.verify.drawnAt"), "time", <RelativeTime date={v.drawnAt} />)}
          </span>
        ) : null}
      </div>
      <div aria-live="polite" aria-atomic="true">
        <VerifyResult outcome={outcome} />
      </div>
      <dl className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs text-muted-foreground">{t("giveaways.verify.commitment")}</dt>
          <dd data-testid="giveaway-verify-commitment" className="font-mono text-xs break-all">
            {v.seedCommitment}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs text-muted-foreground">{t("giveaways.verify.seed")}</dt>
          <dd data-testid="giveaway-verify-seed" className="font-mono text-xs break-all">
            {v.seed ?? ""}
          </dd>
          {v.seed === null ? <dd className="text-xs">{t("giveaways.verify.seedPending")}</dd> : null}
        </div>
      </dl>
      <section aria-labelledby="giveaway-verify-winners" className="flex min-w-0 flex-col gap-2">
        <h2 id="giveaway-verify-winners" className="text-sm font-semibold">
          {t("giveaways.verify.winners", { count: v.winners.length, of: v.winnerCount })}
        </h2>
        {v.winners.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("giveaways.verify.noWinners")}</p>
        ) : (
          <ol className="flex min-w-0 flex-col gap-1">
            {v.winners.map((w) => (
              <li
                key={w.rank}
                data-testid="giveaway-verify-winner"
                data-rank={w.rank}
                data-index={w.index}
                className="font-mono text-xs break-all"
              >
                {t("giveaways.verify.winnerRow", { rank: w.rank, pseudonym: w.pseudonym })}
                {w.pseudonym === mine ? ` ${t("giveaways.verify.you")}` : ""}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="giveaway-verify-entries" className="flex min-w-0 flex-col gap-2">
        <h2 id="giveaway-verify-entries" className="text-sm font-semibold">
          {t("giveaways.verify.entries", { count: v.entries.length })}
        </h2>
        <p className="text-xs text-muted-foreground">{t("giveaways.verify.entriesHint")}</p>
        {mine !== null ? <p className="text-xs">{t("giveaways.verify.mineHint")}</p> : null}
        <ol className="flex min-w-0 flex-col gap-1">
          {v.entries.map((p, i) => (
            <li
              key={p}
              data-testid="giveaway-verify-entry"
              data-index={i}
              data-mine={p === mine ? "true" : undefined}
              className={p === mine ? "font-mono text-xs font-semibold break-all" : "font-mono text-xs break-all"}
            >
              {t("giveaways.verify.entryRow", { index: i, pseudonym: p })}
              {p === mine ? (
                <>
                  {" "}
                  <span data-testid="giveaway-verify-mine" data-pseudonym={p}>
                    {t("giveaways.verify.you")}
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </PageContainer>
  );
}

const PROBLEM_KEYS: Record<"commitment" | "entries" | "winners", MessageKey> = {
  commitment: "giveaways.verify.problem.commitment",
  entries: "giveaways.verify.problem.entries",
  winners: "giveaways.verify.problem.winners",
};

export function VerifyResult({ outcome }: { outcome: VerifyOutcome | null }): React.JSX.Element {
  if (outcome === null) return <p className="text-xs text-muted-foreground">{t("giveaways.verify.checking")}</p>;
  if (outcome.state === "pending") return <p className="text-xs">{t("giveaways.verify.pending")}</p>;
  if (outcome.state === "cancelled") return <p className="text-xs">{t("giveaways.verify.cancelled")}</p>;
  return (
    <Alert
      data-testid="giveaway-verify-result"
      data-match={outcome.match ? "true" : "false"}
      variant={outcome.match ? "default" : "destructive"}
    >
      <AlertTitle>{outcome.match ? t("giveaways.verify.matches") : t("giveaways.verify.mismatch")}</AlertTitle>
      <AlertDescription>
        {outcome.problem
          ? t(PROBLEM_KEYS[outcome.problem])
          : outcome.skipped > 0
            ? t("giveaways.verify.matchesSkipped", { count: outcome.skipped })
            : t("giveaways.verify.matchesHint")}
      </AlertDescription>
    </Alert>
  );
}
