// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bundled ALTCHA widget (MIT, self-hosted proof of work; nothing loads from a third party).
 * It fetches a challenge from the API and solves it in a worker as soon as it loads. The wrapper
 * mirrors the widget state in `data-state` so tests and the form can wait for `verified`.
 */
import * as React from "react";
import { activeLocale, baseLanguage } from "../i18n/index.ts";
import { AUTH_ROUTES } from "../lib/auth.ts";

export type AltchaState = "loading" | "unverified" | "verifying" | "verified" | "expired" | "error" | "code";

interface AltchaElement extends HTMLElement {
  reset?: (state?: string) => void;
  verify?: () => Promise<unknown>;
}

export interface AltchaFieldHandle {
  /** Payloads are single use: get a fresh one after a failed submit. */
  renew(): void;
}

export interface AltchaFieldProps {
  onChange: (payload: string | null) => void;
  ref?: React.Ref<AltchaFieldHandle>;
}

const WIDGET_CONFIG = JSON.stringify({ hideFooter: true, hideLogo: true });

/**
 * The widget's theme hooks, on design tokens (F17): it sits borderless and transparent inside a
 * container styled like the form's inputs, and "Verified" uses the primary colour instead of the
 * widget's own green, in both themes. `styles.css` sets the base palette on `altcha-widget`; these
 * are set on the element itself (they win over that rule) once it exists.
 */
export const ALTCHA_TOKENS: Readonly<Record<string, string>> = {
  "--altcha-border-width": "0",
  "--altcha-border-radius": "0",
  "--altcha-color-base": "transparent",
  "--altcha-color-base-content": "var(--foreground)",
  "--altcha-color-success": "var(--primary)",
  "--altcha-color-success-content": "var(--primary-foreground)",
  "--altcha-color-error": "var(--destructive)",
  "--altcha-color-error-content": "var(--primary-foreground)",
  "--altcha-checkbox-border-color": "var(--input)",
  "--altcha-checkbox-border-width": "1px",
  "--altcha-checkbox-border-radius": "0",
  "--altcha-checkbox-outline-color": "var(--ring)",
  "--altcha-shadow": "none",
  "--altcha-padding": "0",
  "--altcha-max-width": "100%",
};

/** Applies `ALTCHA_TOKENS` to the widget element. */
export function applyAltchaTokens(el: HTMLElement): void {
  for (const [name, value] of Object.entries(ALTCHA_TOKENS)) el.style.setProperty(name, value);
}

export function AltchaField({ onChange, ref }: AltchaFieldProps): React.JSX.Element {
  const widget = React.useRef<AltchaElement>(null);
  const [state, setState] = React.useState<AltchaState>("loading");
  const [ready, setReady] = React.useState(false);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  React.useEffect(() => {
    let cancelled = false;
    // Custom elements only exist in the browser; register the widget after hydration.
    void import("altcha").then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const el = widget.current;
    if (!ready || !el) return;
    applyAltchaTokens(el);
    const onState = (ev: Event) => {
      const detail = (ev as CustomEvent<{ state: AltchaState; payload?: string }>).detail;
      setState(detail.state);
      onChangeRef.current(detail.state === "verified" && detail.payload ? detail.payload : null);
      // A challenge expires after a few minutes on an idle form: solve a fresh one.
      if (detail.state === "expired") {
        el.reset?.();
        void el.verify?.();
      }
    };
    el.addEventListener("statechange", onState);
    return () => el.removeEventListener("statechange", onState);
  }, [ready]);

  React.useImperativeHandle(ref, () => ({
    renew() {
      const el = widget.current;
      onChangeRef.current(null);
      el?.reset?.();
      void el?.verify?.();
    },
  }));

  return (
    // Styled like the form's inputs (`Input`): the same border, fill and focus ring in both themes.
    <div
      data-testid="signup-altcha"
      data-state={state}
      className="min-h-14 border border-input bg-transparent px-2.5 py-2 text-xs text-foreground transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring dark:bg-input/30"
    >
      {ready &&
        // Created by tag name: the widget's JSX typings disagree between its entry points.
        React.createElement("altcha-widget" as string, {
          ref: widget,
          challenge: AUTH_ROUTES.altchaChallenge,
          auto: "onload",
          name: "altcha",
          language: baseLanguage(activeLocale()),
          configuration: WIDGET_CONFIG,
        })}
    </div>
  );
}
