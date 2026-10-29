// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { t } from "../i18n/index.ts";
import type { Api } from "../lib/api.ts";

type LegalDocument = Awaited<ReturnType<Api["legal"]["current"]>>[number];

export type LegalDoc = Pick<
  LegalDocument,
  "id" | "kind" | "title" | "version" | "body" | "isDraft" | "requiresAcceptance"
>;

/**
 * Split the current documents into those a user accepts (sign-up, re-acceptance) and those that
 * are only linked for reading (`cookies`, and `dmca_policy` unless an instance requires it).
 */
export function splitByAcceptance<D extends Pick<LegalDoc, "requiresAcceptance">>(
  docs: readonly D[],
): { required: D[]; optional: D[] } {
  return {
    required: docs.filter((d) => d.requiresAcceptance),
    optional: docs.filter((d) => !d.requiresAcceptance),
  };
}

/** A legal document's title that opens its full text in a dialog (no navigation away from the form). */
export function LegalDocumentLink({ doc }: { doc: LegalDoc }): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger
        data-legal-kind={doc.kind}
        className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {doc.title}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc.title}</DialogTitle>
          <DialogDescription>
            {doc.isDraft
              ? t("legal.versionDraft", { version: doc.version })
              : t("legal.version", { version: doc.version })}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-96">
          <div className="pe-3 text-xs whitespace-pre-wrap">{doc.body}</div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** Documents as a parenthesised, comma-separated list of links. */
export function LegalDocumentList({ docs }: { docs: readonly LegalDoc[] }): React.JSX.Element {
  return (
    <>
      {t("common.openParen")}
      {docs.map((d, i) => (
        <React.Fragment key={d.id}>
          {i > 0 && t("common.listSeparator")}
          <LegalDocumentLink doc={d} />
        </React.Fragment>
      ))}
      {t("common.closeParen")}
    </>
  );
}
