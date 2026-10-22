// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "@commonair/ui/toast";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { MembershipPanel, type ShareInstructionsDto } from "../../components/coop/membership.tsx";
import { toastCoopError, useMyMembership } from "../../components/coop/use-coop.ts";
import { FormError } from "../../components/form-error.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { classLabel, errorRequirement, shareRules, type MemberClass } from "../../lib/coop.ts";
import { requireSession } from "../../lib/guard.ts";

export const Route = createFileRoute("/_app/coop/membership")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: MembershipPage,
});

function MembershipPage(): React.JSX.Element {
  const { me, config } = useBootstrap();
  const membership = useMyMembership(me);
  const settings = useLoad("settings", () => api().coop.settings());
  const [instructions, setInstructions] = React.useState<ShareInstructionsDto | null>(null);
  const [buying, setBuying] = React.useState(false);

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

  if (!me) return <Navigate to="/signin" replace />;
  return (
    <>
      {membership.failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <MembershipPanel
        view={membership.data}
        rules={shareRules(settings.data)}
        currency={config.currency}
        instructions={instructions}
        buying={buying}
        onBuy={buy}
        onExit={exit}
        onExitError={toastCoopError}
      />
    </>
  );
}
