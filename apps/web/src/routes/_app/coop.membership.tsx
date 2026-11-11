// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { isNewMember, useFirstVote } from "../../components/coop/first-vote.tsx";
import { CoopLoadGate, CoopSectionError } from "../../components/coop/load-error.tsx";
import {
  MemberVoteCard,
  MembershipPanel,
  MembershipPitch,
  MembershipPitchLead,
  PitchDetails,
  isMember,
  pitchFacts,
  type ShareInstructionsDto,
} from "../../components/coop/membership.tsx";
import { CoopTabs } from "../../components/coop/nav.tsx";
import { SharePayByCard, cardSharesAllowed } from "../../components/coop/shares-card.tsx";
import { coopLoads, toastCoopError, useCoopLoad, useMyMembership } from "../../components/coop/use-coop.ts";
import { t } from "../../i18n/index.ts";
import { isSessionExpired } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import { useBootstrap, useSessionRetry } from "../../lib/bootstrap.ts";
import { classLabel, errorRequirement, shareRules, type MemberClass } from "../../lib/coop.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * Public since overhaul wave 2 (D2.5): signed out, the membership pitch; signed in without an
 * active membership, the pitch's hero above today's page (eligibility and the share); a member
 * keeps today's page, with their first vote from the real electorate on top.
 */
export const Route = createFileRoute("/_app/coop/membership")({
  head: () => titleHead(t("pageTitle.coopMembership")),
  component: MembershipPage,
});

/** Why `coop.join` was refused, as a toast. */
function toastRejoinError(err: unknown): void {
  if (isSessionExpired(err)) toastCoopError(err);
  else if (errorCode(err) === "CONFLICT") toast.error(t("coop.rejoin.conflict"));
  else if (errorCode(err) === "FORBIDDEN") toast.error(t("coop.rejoin.notQualified"));
  else toastCoopError(err);
}

/** How many months the pitch reads (member counts, the last decisions). */
const PITCH_MONTHS = 3;

function MembershipPage(): React.JSX.Element {
  const { me, config, instance: site, sessionUnresolved } = useBootstrap();
  const session = useSessionRetry();
  const membership = useMyMembership(me);
  const settings = useCoopLoad("settings", () => api().coop.settings());
  // The pitch's numbers: a failed read only leaves the stats and decisions out.
  const months = useCoopLoad("months", () => api().coop.transparency({ months: PITCH_MONTHS }));
  // Batch 8 (M1-coop-money): card payment for shares needs Stripe on the instance and the setting
  // on. A failed read only hides "Pay by card"; the bank-transfer path stays.
  const instance = useCoopLoad("instance", () => Promise.resolve().then(() => api().instance.info()));
  const card = cardSharesAllowed(instance.data?.features.payments ?? null, settings.data);
  const member = isMember(membership.data);
  const firstVote = useFirstVote(member, me?.id ?? "-");
  // The clock is read once per mount, so a render never flips the wording.
  const [mountedAt] = React.useState(() => Date.now());
  const newMember = isNewMember(membership.data?.memberships, mountedAt);
  const [instructions, setInstructions] = React.useState<ShareInstructionsDto | null>(null);
  const [buying, setBuying] = React.useState(false);
  const facts = pitchFacts(settings.data);
  const pitch = {
    facts,
    currency: config.currency,
    siteName: site.name,
    sourceUrl: site.sourceUrl,
    months: months.data,
  };

  const buy = async () => {
    if (buying) return;
    setBuying(true);
    try {
      const result = await api().coop.buyShare({ returnPath: "/coop/membership" });
      if (result.kind === "redirect") {
        window.location.assign(result.url);
        return;
      }
      setInstructions(result);
      membership.reload();
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("coop.share.conflict"));
      else if (errorRequirement(err) === "manual_shares") toast.error(t("coop.share.manualOnly"));
      else if (card && errorRequirement(err) === "payment_provider") toast.error(t("coopMoney.card.failed"));
      else toastCoopError(err);
    } finally {
      setBuying(false);
    }
  };

  const exit = async (cls: MemberClass) => {
    await api().coop.exit({ class: cls });
    toast.success(t("coop.exit.done", { class: classLabel(cls) }));
    membership.reload();
  };

  const rejoin = async () => {
    try {
      await api().coop.join({ class: "viewer" });
      toast.success(t("coop.rejoin.done"));
    } finally {
      // Refused or not, the view may have changed (a sync, another tab): show the current one.
      membership.reload();
    }
  };

  if (!me) {
    // F1: a member whose session the API could not confirm is not shown the join pitch.
    if (sessionUnresolved)
      return (
        <PageContainer data-testid="membership" width="wide" className="flex flex-col gap-6 py-8">
          <PageHeader title={t("coop.membership.title")} tabs={<CoopTabs current="membership" />} />
          <CoopSectionError
            section={t("coop.membership.title")}
            headingLevel={2}
            load={{
              state: "failed",
              failed: true,
              busy: session.retrying,
              gaveUp: session.gaveUp,
              reload: session.retry,
            }}
          />
        </PageContainer>
      );
    return (
      <CoopLoadGate status={coopLoads([settings])} tab="membership">
        <MembershipPitch {...pitch} signedIn={false} />
      </CoopLoadGate>
    );
  }

  // Signed in: the pitch frames the page until the view says they are a member.
  const showPitch = membership.data !== null && !member;
  return (
    <CoopLoadGate status={coopLoads([membership, settings])} tab="membership">
      <MembershipPanel
        view={membership.data}
        rules={shareRules(settings.data)}
        currency={config.currency}
        instructions={instructions}
        buying={buying}
        onBuy={buy}
        onExit={exit}
        onExitError={toastCoopError}
        onRejoin={rejoin}
        onRejoinError={toastRejoinError}
        hideBuy={card}
        lead={
          showPitch ? (
            <MembershipPitchLead {...pitch} signedIn />
          ) : member ? (
            <MemberVoteCard choice={firstVote} newMember={newMember} />
          ) : null
        }
      />
      {card && <SharePayByCard view={membership.data} paying={buying} onPay={buy} />}
      {showPitch && (
        <PageContainer width="wide" className="pb-8">
          <PitchDetails {...pitch} />
        </PageContainer>
      )}
    </CoopLoadGate>
  );
}
