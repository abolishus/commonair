// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Command and timer templates (ADR 0026 decision 6): variable substitution only. No expressions,
 * no conditionals, no fetching. Unknown variables render literally and a substituted value is
 * never expanded again, so a viewer's name or argument cannot inject a variable.
 */
import { CHAT_LIMITS } from "@commonair/contracts";

/** The values a template may use; a missing one renders its variable literally. */
export interface TemplateVars {
  /** The caller's display name. */
  user?: string;
  /** The first argument without a leading `@`, else the caller. */
  touser?: string;
  /** The command's use count after this use. */
  count?: number;
  channel?: string;
  /** Since the live broadcast started, or "offline". */
  uptime?: string;
  /** The caller's balance. */
  points?: number;
  pointsName?: string;
  /** `${var:name}` values (`bot_variables`). */
  variables?: ReadonlyMap<string, string>;
}

/** The built-in variable names, for the docs and the `needs` check. */
export const TEMPLATE_VARIABLES = ["user", "touser", "count", "channel", "uptime", "points", "pointsName"] as const;
type BuiltinName = (typeof TEMPLATE_VARIABLES)[number];
const BUILTINS: ReadonlySet<string> = new Set(TEMPLATE_VARIABLES);

/** A well-formed variable reference: a built-in name or `var:<name>` (the API's variable-name rule). */
const NAME = /^(?:[A-Za-z]{1,20}|var:[a-z0-9_]{1,30})$/;

/** Longest `${…}` the scanner looks for; anything longer is literal text. */
const MAX_REF = 40;

function lookup(name: string, vars: TemplateVars): string | undefined {
  if (name.startsWith("var:")) return vars.variables?.get(name.slice(4));
  if (!BUILTINS.has(name)) return undefined;
  const v = vars[name as BuiltinName];
  return v === undefined ? undefined : String(v);
}

/** Cut to at most `max` UTF-16 units without leaving half a surrogate pair. */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * Substitute variables in one left-to-right pass over the template. A `${` whose reference is not
 * well-formed (e.g. `${var:${user}}`) is copied as text and scanning resumes right after it.
 */
export function renderTemplate(template: string, vars: TemplateVars, max: number = CHAT_LIMITS.maxBodyLength): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("${", i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf("}", open + 2);
    const name = close === -1 || close - open > MAX_REF ? null : template.slice(open + 2, close);
    if (name === null || !NAME.test(name)) {
      out += "${";
      i = open + 2;
      continue;
    }
    const value = lookup(name, vars);
    out += value ?? template.slice(open, close + 1);
    i = close + 1;
    // Stop early: the output is cut anyway, and a long template must not build a huge string.
    if (out.length > max) break;
  }
  return cutText(out, max);
}

/** Which costly variables a template uses, so the engine only queries what it needs. */
export function templateNeeds(template: string): { points: boolean; uptime: boolean; variables: boolean } {
  return {
    points: template.includes("${points}"),
    uptime: template.includes("${uptime}"),
    variables: template.includes("${var:"),
  };
}

/** "2h 5m", "4m", "30s": coarse, for chat. */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}
