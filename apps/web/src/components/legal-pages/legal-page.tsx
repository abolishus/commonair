// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { File01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { RouteSectionLoadError } from "../../lib/section-load-error.tsx";
import type { LoaderResult } from "../discovery/loaders.ts";
import type { LegalDoc } from "../legal-document-link.tsx";
import { LEGAL_PATH, PUBLIC_LEGAL_KINDS, type PublicLegalKind } from "./kinds.ts";
import { parseMarkdown, tableOfContents, type Block, type Inline } from "./markdown.ts";

export const LEGAL_TITLE: Record<PublicLegalKind, MessageKey> = {
  terms: "d2Pages.legal.terms",
  privacy: "d2Pages.legal.privacy",
  guidelines: "d2Pages.legal.guidelines",
};

const LINK =
  "underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function renderInline(nodes: readonly Inline[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return <React.Fragment key={i}>{node.text}</React.Fragment>;
      case "strong":
        return (
          <strong key={i} className="font-semibold text-foreground">
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code key={i} className="bg-muted px-1 font-mono text-sm">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a key={i} href={node.href} rel="noreferrer" className={`break-words ${LINK}`}>
            {node.text}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: readonly Block[]): React.ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.kind) {
      case "heading":
        return block.level === 2 ? (
          <h2 key={i} id={block.id} className="mt-8 scroll-mt-20 text-lg font-semibold text-foreground first:mt-0">
            {block.text}
          </h2>
        ) : (
          <h3 key={i} id={block.id} className="mt-6 scroll-mt-20 text-base font-semibold text-foreground">
            {block.text}
          </h3>
        );
      case "paragraph":
        return (
          <p key={i} className="mt-3 first:mt-0">
            {renderInline(block.inline)}
          </p>
        );
      case "list": {
        const items = block.items.map((item, j) => (
          <li key={j} className="ps-1">
            {renderInline(item)}
          </li>
        ));
        return block.ordered ? (
          <ol key={i} className="mt-3 flex first:mt-0 list-decimal flex-col gap-2 ps-6">
            {items}
          </ol>
        ) : (
          <ul key={i} className="mt-3 flex first:mt-0 list-disc flex-col gap-2 ps-6">
            {items}
          </ul>
        );
      }
      case "quote":
        return (
          <blockquote key={i} className="mt-3 border-s-2 border-warning bg-surface-sunken px-4 py-3 first:mt-0">
            {renderBlocks(block.blocks)}
          </blockquote>
        );
    }
  });
}

/** A legal document body as headings, paragraphs and lists (never raw HTML). */
export function LegalBody({ body }: { body: string }): React.JSX.Element {
  const blocks = React.useMemo(() => parseMarkdown(body), [body]);
  return (
    <div data-testid="legal-body" className="min-w-0 text-base leading-relaxed text-muted-foreground">
      {renderBlocks(blocks)}
    </div>
  );
}

/**
 * The page's `doc` from the loader's answer: the document, null when none is published, undefined
 * when the API did not answer (the page shows Retry).
 */
export function legalDocOf(result: LoaderResult<LegalDoc | null> | undefined): LegalDoc | null | undefined {
  return result?.status === "ok" ? result.data : undefined;
}

export interface LegalPageProps {
  kind: PublicLegalKind;
  /** The current document; null when none is published; undefined when the load failed. */
  doc: LegalDoc | null | undefined;
}

/** `/terms`, `/privacy`, `/guidelines`: the current document with a table of contents. */
export function LegalPage({ kind, doc }: LegalPageProps): React.JSX.Element {
  const title = doc?.title ?? t(LEGAL_TITLE[kind]);
  const toc = React.useMemo(() => (doc ? tableOfContents(parseMarkdown(doc.body)) : []), [doc]);
  const others = PUBLIC_LEGAL_KINDS.filter((k) => k !== kind);
  return (
    <PageContainer data-testid="legal-page" data-kind={kind} width="default" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={title}
        description={
          doc
            ? doc.isDraft
              ? t("legal.versionDraft", { version: doc.version })
              : t("legal.version", { version: doc.version })
            : undefined
        }
      />
      {doc === undefined ? (
        <RouteSectionLoadError section={title} alone headingLevel={2} data-testid="legal-error" />
      ) : doc === null ? (
        <EmptyState
          data-testid="legal-missing"
          icon={File01Icon}
          headingLevel={2}
          title={t("d2Pages.legal.missing.title")}
          description={t("d2Pages.legal.missing.body")}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-8 lg:flex-row-reverse lg:items-start">
          {toc.length > 0 && (
            <nav
              aria-label={t("d2Pages.legal.toc")}
              data-testid="legal-toc"
              className="min-w-0 bg-surface-sunken p-4 ring-1 ring-border lg:sticky lg:top-20 lg:w-64 lg:shrink-0"
            >
              <p className="mb-2 font-semibold">{t("d2Pages.legal.toc")}</p>
              <ol className="flex flex-col gap-1.5 text-sm">
                {toc.map((entry) => (
                  <li key={entry.id} className={entry.level === 3 ? "ps-3" : undefined}>
                    <a href={`#${entry.id}`} className={`text-muted-foreground ${LINK}`}>
                      {entry.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <article aria-label={title} className="min-w-0 max-w-prose flex-1">
            <LegalBody body={doc.body} />
          </article>
        </div>
      )}
      <nav aria-label={t("d2Pages.legal.other")} className="border-t border-border pt-4">
        <p className="mb-2 text-sm font-semibold">{t("d2Pages.legal.other")}</p>
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {others.map((k) => (
            <li key={k}>
              <Link to={LEGAL_PATH[k]} data-testid="legal-other" className={LINK}>
                {t(LEGAL_TITLE[k])}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </PageContainer>
  );
}
