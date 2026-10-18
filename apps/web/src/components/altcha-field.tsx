// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bundled ALTCHA widget (MIT, self-hosted proof of work; nothing loads from a third party).
 * It fetches a challenge from the API and solves it in a worker as soon as it loads. The wrapper
 * mirrors the widget state in `data-state` so tests and the form can wait for `verified`.
 */
import * as React from "react";
import { locale } from "../i18n/index.ts";
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
    <div data-testid="signup-altcha" data-state={state} className="min-h-14">
      {ready &&
        // Created by tag name: the widget's JSX typings disagree between its entry points.
        React.createElement("altcha-widget" as string, {
          ref: widget,
          challenge: AUTH_ROUTES.altchaChallenge,
          auto: "onload",
          name: "altcha",
          language: locale,
          configuration: WIDGET_CONFIG,
        })}
    </div>
  );
}
