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
import type * as React from "react";
import { t } from "../i18n/index.ts";

export interface LegalDoc {
  id: string;
  title: string;
  version: string;
  body: string;
  isDraft: boolean;
}

/** A legal document's title that opens its full text in a dialog (no navigation away from the form). */
export function LegalDocumentLink({ doc }: { doc: LegalDoc }): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {doc.title}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc.title}</DialogTitle>
          <DialogDescription>
            {t("legal.version", { version: doc.version })}
            {doc.isDraft ? ` · ${t("legal.draft")}` : ""}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="pr-3 text-xs whitespace-pre-wrap">{doc.body}</div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
