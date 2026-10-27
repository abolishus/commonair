// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { dmcaNoticeClient } from "../../components/dmca/client.ts";
import { DmcaNoticeForm } from "../../components/dmca/notice-form.tsx";
import { LegalDocumentLink, type LegalDoc } from "../../components/legal-document-link.tsx";
import { t } from "../../i18n/index.ts";

/** Public: the DMCA notice form (17 U.S.C. § 512(c)(3)(A); E7-dmca). No account needed. */
export const Route = createFileRoute("/_app/dmca")({ component: DmcaPage });

function DmcaPage(): React.JSX.Element {
  const [client] = React.useState(() => dmcaNoticeClient());
  const [policy, setPolicy] = React.useState<LegalDoc | null>(null);
  React.useEffect(() => {
    let live = true;
    client
      .policy()
      .then((doc) => {
        if (live) setPolicy(doc);
      })
      // The summary below still applies; only the link to the full text is missing.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);
  return (
    <PageContainer width="narrow" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("dmca.title")} description={t("dmca.intro")} />
      <AlertCallout
        tone="info"
        title={t("dmca.howTitle")}
        description={
          <div className="flex flex-col gap-2">
            <p>{t("dmca.how1")}</p>
            <p>{t("dmca.how2")}</p>
            <p>{t("dmca.how3")}</p>
            <p>{t("dmca.how4")}</p>
            {policy ? (
              <p>
                {t("dmca.policyLink")} <LegalDocumentLink doc={policy} />
              </p>
            ) : null}
          </div>
        }
      />
      <DmcaNoticeForm client={client} />
    </PageContainer>
  );
}
