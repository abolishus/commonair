// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Template building blocks: the per-render context (instance identity,
 * locale, messages, formatters) and the shared layout and components. Every
 * visible string comes from the message catalog; components never carry text.
 */
import { sourceLink, type InstanceSite } from "@commonair/config";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  interpolate,
  interpolateNodes,
  type DateInput,
} from "./format.ts";
import type { EmailCatalog, LayoutMessages } from "./messages/en.ts";
import { DARK_MODE_CSS, styles } from "./theme.ts";

export type Contact = keyof InstanceSite["contacts"];

export interface EmailContext<M> {
  site: InstanceSite;
  locale: string;
  messages: M;
  layout: LayoutMessages;
  /** Message with `{placeholders}` filled by nodes; `{instance}` is always available. */
  t(message: string, vars?: Record<string, ReactNode>): ReactNode;
  /** Message with `{placeholders}` filled by strings (subjects, previews). */
  text(message: string, vars?: Record<string, string | number>): string;
  dateTime(value: DateInput): string;
  date(value: DateInput): string;
  money(amountMinor: number, currency: string): string;
  percent(ratio: number): string;
  /** A `mailto:` link to one of the instance's contact addresses. */
  contact(kind: Contact): ReactNode;
}

/** Keys of `D` whose values are strings: the only fields that may be declared as links. */
export type StringKeys<D> = { [K in keyof D]-?: D[K] extends string ? K : never }[keyof D] & string;

export interface TemplateDefinition<D, M> {
  /**
   * The data fields that are URLs. Only these are rendered as links, and each must be an
   * http(s) URL on the instance's own origin (validated and normalised before rendering).
   * Everything else is free text and is only ever rendered as escaped text.
   */
  links: readonly StringKeys<D>[];
  subject(ctx: EmailContext<M>, data: D): string;
  preview?(ctx: EmailContext<M>, data: D): string;
  body(ctx: EmailContext<M>, data: D): ReactNode;
  /** Opt-out URL for mail recipients may unsubscribe from (sets List-Unsubscribe). */
  unsubscribeUrl?(data: D): string;
}

export type TemplateId = Exclude<keyof EmailCatalog, "layout">;

export function defineTemplate<K extends TemplateId, D>(
  _id: K,
  def: TemplateDefinition<D, EmailCatalog[K]>,
): TemplateDefinition<D, EmailCatalog[K]> {
  return def;
}

export function createContext<M>(
  site: InstanceSite,
  locale: string,
  layout: LayoutMessages,
  messages: M,
): EmailContext<M> {
  const instance = site.name;
  return {
    site,
    locale,
    messages,
    layout,
    t: (message, vars = {}) => interpolateNodes(message, { instance, ...vars }),
    text: (message, vars = {}) => interpolate(message, { instance, ...vars }),
    dateTime: (value) => formatDateTime(value, locale),
    date: (value) => formatDate(value, locale),
    money: (amount, currency) => formatMoney(amount, currency, locale),
    percent: (ratio) => formatPercent(ratio, locale),
    contact: (kind) => (
      <Link className="ca-link" href={`mailto:${site.contacts[kind]}`} style={styles.link}>
        {site.contacts[kind]}
      </Link>
    ),
  };
}

/* ------------------------------------------------------------------------- */

export function H1({ children }: { children: ReactNode }) {
  return (
    <Heading as="h1" className="ca-text" style={styles.heading}>
      {children}
    </Heading>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <Text className="ca-text" style={styles.text}>
      {children}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return (
    <Text className="ca-muted" style={styles.muted}>
      {children}
    </Text>
  );
}

/** A visually emphasised paragraph for warnings (border, not colour alone). */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <Section className="ca-notice" style={styles.notice}>
      <Text className="ca-text" style={{ ...styles.text, margin: 0 }}>
        {children}
      </Text>
    </Section>
  );
}

/** Label/value pairs as a definition list (screen readers announce the pairing). */
export function Facts({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl style={{ margin: "0 0 16px" }}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="ca-muted" style={styles.factLabel}>
            {label}
          </dt>
          <dd className="ca-text" style={{ ...styles.factValue, marginLeft: 0 }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Primary call to action plus a copyable fallback link (HTML only; the text part shows the URL anyway). */
export function Action({ ctx, href, label }: { ctx: EmailContext<unknown>; href: string; label: string }) {
  return (
    <Section style={{ margin: "8px 0 24px" }}>
      <Button className="ca-button" href={href} style={styles.button}>
        {label}
      </Button>
      <Text className="ca-muted" data-skip-in-text={true} style={{ ...styles.muted, margin: "16px 0 0" }}>
        {ctx.t(ctx.layout.buttonFallback, {
          url: (
            <Link className="ca-link" href={href} style={{ ...styles.link, wordBreak: "break-all" }}>
              {href}
            </Link>
          ),
        })}
      </Text>
    </Section>
  );
}

export function Layout({
  ctx,
  subject,
  preview,
  unsubscribeUrl,
  children,
}: {
  ctx: EmailContext<unknown>;
  subject: string;
  preview: string;
  unsubscribeUrl?: string | undefined;
  children: ReactNode;
}) {
  const { site, layout } = ctx;
  return (
    <Html lang={ctx.locale} dir={layout.dir === "rtl" ? "rtl" : "ltr"}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{subject}</title>
        <style>{DARK_MODE_CSS}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body className="ca-body" style={styles.body}>
        <Container className="ca-surface" style={styles.container}>
          <Text className="ca-muted" style={styles.brand}>
            <Link className="ca-link" href={site.publicUrl} style={{ ...styles.link, textDecoration: "none" }}>
              {site.name}
            </Link>
          </Text>
          {children}
          <Hr style={styles.hr} />
          <Text className="ca-muted" style={styles.footer}>
            {ctx.t(layout.reason)}
          </Text>
          <Text className="ca-muted" style={styles.footer}>
            {ctx.t(layout.contact, { contact: ctx.contact("general") })}
          </Text>
          <Text className="ca-muted" style={styles.footer}>
            {ctx.t(layout.source, {
              sourceLink: (
                <Link className="ca-link" href={sourceLink(site)} style={styles.link}>
                  {layout.sourceLinkLabel}
                </Link>
              ),
            })}
          </Text>
          {unsubscribeUrl ? (
            <Text className="ca-muted" style={styles.footer}>
              <Link className="ca-link" href={unsubscribeUrl} style={styles.link}>
                {layout.unsubscribe}
              </Link>
            </Text>
          ) : null}
        </Container>
      </Body>
    </Html>
  );
}
