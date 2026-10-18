// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * License policy. Only OSI-approved licenses are allowed for dependencies.
 * Judgment calls (data-only packages, missing metadata) are listed explicitly in
 * EXCEPTIONS, each with a reason, and recorded in docs/decisions/0002-license-policy.md.
 */

export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "MPL-2.0",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "OFL-1.1",
  "Unlicense",
  "BlueOak-1.0.0",
  "Zlib",
  "Python-2.0",
  "BSL-1.0", // Boost Software License (OSI-approved). NOT the Business Source License (BUSL).
  "PostgreSQL",
]);

/** Deprecated SPDX ids still common in package.json files, mapped to current ids. */
const ALIASES: Record<string, string> = {
  "LGPL-2.0": "LGPL-2.0-only",
  "LGPL-2.0+": "LGPL-2.0-or-later",
  "LGPL-2.1": "LGPL-2.1-only",
  "LGPL-2.1+": "LGPL-2.1-or-later",
  "LGPL-3.0": "LGPL-3.0-only",
  "LGPL-3.0+": "LGPL-3.0-or-later",
  "GPL-2.0": "GPL-2.0-only",
  "GPL-2.0+": "GPL-2.0-or-later",
  "GPL-3.0": "GPL-3.0-only",
  "GPL-3.0+": "GPL-3.0-or-later",
  "AGPL-3.0": "AGPL-3.0-only",
  "Apache 2.0": "Apache-2.0",
  Apache2: "Apache-2.0",
  "MIT/X11": "MIT",
  OFL: "OFL-1.1",
  "MPL 2.0": "MPL-2.0",
  "SIL OFL 1.1": "OFL-1.1",
};

/** Explicitly refused even if someone adds them to ALLOWED by mistake. */
export const DENIED = [/^BUSL/i, /^SSPL/i, /^Elastic/i, /^RSAL/i, /Commons[- ]Clause/i, /^CC-BY-NC/i, /^Polyform/i];

/** SPDX license exceptions accepted after WITH (each only grants additional permissions). */
export const ALLOWED_EXCEPTIONS = new Set([
  "Classpath-exception-2.0",
  "LLVM-exception",
  "GCC-exception-3.1",
  "GCC-exception-2.0",
  "Autoconf-exception-3.0",
  "Bison-exception-2.2",
  "Font-exception-2.0",
  "OpenSSL-exception",
  "Swift-exception",
]);

/**
 * Per-package exceptions for non-code data under non-OSI licenses. Each pins the exact license
 * string the package declares, so a relicense to anything else fails the check.
 */
export const EXCEPTIONS: Record<string, { license: string; reason: string }> = {
  "caniuse-lite": { license: "CC-BY-4.0", reason: "Browser-support data table, not code; build-time only. ADR 0002." },
  "spdx-license-ids": {
    license: "CC0-1.0",
    reason: "List of SPDX identifiers (data); public-domain dedication. ADR 0002.",
  },
  "spdx-exceptions": { license: "CC-BY-3.0", reason: "List of SPDX exception identifiers (data). ADR 0002." },
};

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Evaluate an SPDX expression: OR needs one allowed side, AND needs both, WITH keeps the base license. */
export function evaluate(expression: string): Verdict {
  const tokens = expression.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  function primary(): boolean {
    const t = tokens[pos++];
    if (t === undefined) throw new Error("unexpected end of license expression");
    if (t === "(") {
      const v = or();
      if (tokens[pos++] !== ")") throw new Error("unbalanced parentheses");
      return v;
    }
    let id = ALIASES[t] ?? t;
    id = id.replace(/\+$/, "-or-later");
    if (peek()?.toUpperCase() === "WITH") {
      const exception = tokens[pos + 1];
      pos += 2;
      if (!exception || !ALLOWED_EXCEPTIONS.has(exception)) return false;
    }
    if (DENIED.some((r) => r.test(id))) return false;
    return ALLOWED.has(id);
  }
  function and(): boolean {
    let v = primary();
    while (peek()?.toUpperCase() === "AND") {
      pos++;
      v = primary() && v;
    }
    return v;
  }
  function or(): boolean {
    let v = and();
    while (peek()?.toUpperCase() === "OR") {
      pos++;
      v = and() || v;
    }
    return v;
  }

  try {
    // A few legacy packages ship a bare human-readable name; normalize whole-string aliases first.
    const whole = ALIASES[expression.trim()];
    if (whole) return ALLOWED.has(whole) ? { ok: true } : { ok: false, reason: `not allowed: ${whole}` };
    const v = or();
    if (pos !== tokens.length) throw new Error(`unexpected token "${tokens[pos]}"`);
    return v ? { ok: true } : { ok: false, reason: `not on the allowlist: ${expression}` };
  } catch (e) {
    return { ok: false, reason: `unparseable license "${expression}": ${(e as Error).message}` };
  }
}

/** Normalize the many historical shapes of package.json license metadata to one SPDX expression. */
export function licenseOf(pkg: { license?: unknown; licenses?: unknown }): string | undefined {
  const { license, licenses } = pkg;
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && "type" in license && typeof license.type === "string")
    return license.type;
  if (Array.isArray(licenses)) {
    const ids = licenses
      .map((l: unknown) => (typeof l === "string" ? l : (l as { type?: string })?.type))
      .filter((s): s is string => typeof s === "string");
    if (ids.length > 0) return ids.length === 1 ? ids[0] : `(${ids.join(" OR ")})`;
  }
  return undefined;
}
