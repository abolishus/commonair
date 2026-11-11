// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * /settings/security (D7.2, account-admin.md P3): email and password, two-step sign-in, passkeys,
 * sessions (`#sessions`) and a note on email sign-in links, as SettingsSections. No brand fill on
 * this page: every action is outline, ghost or destructive.
 */
import { SkeletonText } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { SettingsSection } from "@commonair/ui/blocks/forms";
import { Mail01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { AccountSection } from "./account-section.tsx";
import { PasskeysSection } from "./passkeys-section.tsx";
import { SessionsSection } from "./sessions-section.tsx";
import { TwoFactorSection } from "./two-factor-section.tsx";

/** What the page needs from `me.get` (the bootstrap's session user has no email or 2FA flag). */
export interface SecurityAccount {
  email: string;
  username: string;
  twoFactorEnabled: boolean;
}

export interface SecurityPageProps {
  /** Tests pass the account; the app loads it with `me.get`. */
  loadAccount?: () => Promise<SecurityAccount>;
}

const loadMe = async (): Promise<SecurityAccount> => {
  const me = await api().me.get();
  return { email: me.email, username: me.username, twoFactorEnabled: me.twoFactorEnabled };
};

export function SecurityPage({ loadAccount = loadMe }: SecurityPageProps): React.JSX.Element {
  const account = useRetryingLoad("security:me", loadAccount);
  React.useEffect(() => trackUi("settings.security", "view"), []);
  const data = account.data;
  // A link to `#sessions` (the new-sign-in mail) lands before the list renders: scroll once it is there.
  React.useEffect(() => {
    if (data && window.location.hash === "#sessions") document.getElementById("sessions")?.scrollIntoView();
  }, [data]);
  const title = t("d7Security.title");
  return (
    <div data-testid="security-page" className="flex min-w-0 flex-col gap-6">
      <PageHeader title={title} description={t("d7Security.intro")} />
      {account.state === "loading" && <SkeletonText lines={4} />}
      {account.state === "failed" && <SectionLoadError section={title} load={account} alone />}
      {data && (
        <>
          <AccountSection email={data.email} />
          <TwoFactorSection initiallyEnabled={data.twoFactorEnabled} username={data.username} />
          <PasskeysSection />
          <SessionsSection />
          <SettingsSection title={t("d7Security.emailLink.title")} data-testid="security-email-link">
            <div className="px-4 py-4 sm:px-6">
              <AlertCallout tone="info" icon={Mail01Icon} description={t("d7Security.emailLink.body")} />
            </div>
          </SettingsSection>
        </>
      )}
    </div>
  );
}
