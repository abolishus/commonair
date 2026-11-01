// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Official rules": the instance's terms (whose giveaway section holds the official rules and the
 * "no purchase necessary" clause), opened in a dialog so the viewer never leaves the stream. The
 * document loads when the dialog opens; nothing is fetched for viewers who never ask.
 */
import { Skeleton } from "@commonair/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { ScrollArea } from "@commonair/ui/components/scroll-area";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api, type Api } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";

type RulesDoc = Awaited<ReturnType<Api["legal"]["get"]>>;
export type RulesClient = Pick<Api, "legal">;

export function GiveawayRulesLink({ client }: { client?: RulesClient }): React.JSX.Element {
  const [doc, setDoc] = React.useState<RulesDoc | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(() => {
    setFailed(false);
    (client ?? api()).legal
      .get({ kind: "terms" })
      .then(setDoc)
      .catch(() => setFailed(true));
  }, [client]);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && !doc) load();
      }}
    >
      <DialogTrigger
        data-testid="chat-giveaway-rules-link"
        className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("giveaways.card.rules")}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc?.title ?? t("giveaways.card.rules")}</DialogTitle>
          <DialogDescription>
            {doc
              ? doc.isDraft
                ? t("legal.versionDraft", { version: doc.version })
                : t("legal.version", { version: doc.version })
              : t("giveaways.rules.intro")}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <FormError>{t("giveaways.rules.failed")}</FormError>
        ) : doc ? (
          <ScrollArea className="max-h-96">
            <div className="pe-3 text-xs whitespace-pre-wrap">{doc.body}</div>
          </ScrollArea>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </DialogContent>
    </Dialog>
  );
}
