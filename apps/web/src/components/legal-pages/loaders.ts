// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public legal pages' first render, server-side, so the document is in the HTML (readable
 * without scripts). `legal.get` is public; no cookie is forwarded.
 */
import { createServerFn } from "@tanstack/react-start";
import { serverApi } from "../../lib/api.ts";
import { loadFailureKind } from "../../lib/load-failure.ts";
import { loadWebEnv } from "../../server/env.ts";
import { loaderFailed, loaderOk, type LoaderResult } from "../discovery/loaders.ts";
import type { LegalDoc } from "../legal-document-link.tsx";
import { PUBLIC_LEGAL_KINDS, type PublicLegalKind } from "./kinds.ts";

/** The current document of `kind`; null when none is published on this instance. */
export const getLegalDocument = createServerFn({ method: "GET" })
  .validator((input: { kind: PublicLegalKind }): { kind: PublicLegalKind } => {
    if (!PUBLIC_LEGAL_KINDS.includes(input.kind)) throw new Error("not a public legal document");
    return { kind: input.kind };
  })
  .handler(async ({ data }): Promise<LoaderResult<LegalDoc | null>> => {
    try {
      const doc = await serverApi(loadWebEnv().API_INTERNAL_URL).legal.get({ kind: data.kind });
      return loaderOk({
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        version: doc.version,
        body: doc.body,
        isDraft: doc.isDraft,
        requiresAcceptance: doc.requiresAcceptance,
      });
    } catch (err) {
      if (loadFailureKind(err) === "notFound") return loaderOk(null);
      return loaderFailed(err);
    }
  });
