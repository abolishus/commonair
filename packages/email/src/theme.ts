// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Email styling. Mail clients ignore CSS variables and most stylesheets, so
 * colours are inline literals here (the web app's token rule does not apply).
 * Light values are inline; `DARK_MODE_CSS` overrides them for clients that
 * honour `prefers-color-scheme`. Contrast is WCAG AA or better in both.
 */
import type { CSSProperties } from "react";

/** System font stack: no remote or embedded fonts in email. */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';

export const COLORS = {
  background: "#f4f4f5",
  surface: "#ffffff",
  text: "#18181b",
  muted: "#52525b",
  border: "#d4d4d8",
  accent: "#1d4ed8",
  accentText: "#ffffff",
  warningBorder: "#b45309",
} as const;

export const DARK_MODE_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .ca-body { background-color: #09090b !important; }
  .ca-surface { background-color: #18181b !important; border-color: #3f3f46 !important; }
  .ca-text { color: #fafafa !important; }
  .ca-muted { color: #d4d4d8 !important; }
  .ca-link { color: #93c5fd !important; }
  .ca-button { background-color: #93c5fd !important; color: #09090b !important; }
  .ca-notice { border-color: #f59e0b !important; }
}
`;

export const styles = {
  body: { backgroundColor: COLORS.background, fontFamily: FONT_STACK, margin: 0, padding: "24px 0" },
  container: {
    backgroundColor: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "8px",
    margin: "0 auto",
    maxWidth: "560px",
    padding: "32px 28px",
  },
  brand: { color: COLORS.muted, fontSize: "14px", fontWeight: 600, letterSpacing: "0.02em", margin: "0 0 24px" },
  heading: { color: COLORS.text, fontSize: "24px", fontWeight: 700, lineHeight: "32px", margin: "0 0 16px" },
  text: { color: COLORS.text, fontSize: "16px", lineHeight: "26px", margin: "0 0 16px" },
  muted: { color: COLORS.muted, fontSize: "14px", lineHeight: "22px", margin: "0 0 12px" },
  link: { color: COLORS.accent, textDecoration: "underline" },
  button: {
    backgroundColor: COLORS.accent,
    borderRadius: "6px",
    color: COLORS.accentText,
    display: "inline-block",
    fontSize: "16px",
    fontWeight: 600,
    padding: "12px 20px",
    textDecoration: "none",
  },
  notice: {
    borderLeft: `4px solid ${COLORS.warningBorder}`,
    margin: "0 0 16px",
    padding: "4px 0 4px 16px",
  },
  factLabel: { color: COLORS.muted, fontSize: "14px", lineHeight: "22px", margin: 0 },
  factValue: { color: COLORS.text, fontSize: "16px", fontWeight: 600, lineHeight: "24px", margin: "0 0 12px" },
  hr: { borderColor: COLORS.border, margin: "24px 0" },
  footer: { color: COLORS.muted, fontSize: "13px", lineHeight: "20px", margin: "0 0 8px" },
} satisfies Record<string, CSSProperties>;
