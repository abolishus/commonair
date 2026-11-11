// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SettingsRow, SettingsSection } from "@commonair/ui/blocks/forms";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { toast } from "@commonair/ui/toast";
import { useRouter } from "@tanstack/react-router";
import * as React from "react";
import { applyLocale, tabLocale } from "../../i18n/client.ts";
import { activeLocale, t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { LanguageLabel, switchableLocales } from "./language-label.tsx";

/** The select's value for `users.locale` = null. */
export const AUTO = "auto";
type Status = "idle" | "saving" | "saved" | "error";

/**
 * A switch remounts the whole tree (`applyLocale`, or the root's `syncLocale` after a reload), so
 * the page the member sees afterwards is a new instance. The saving instance leaves its outcome
 * here for that one to show and announce in the new language. When no remount follows ("Automatic"
 * resolving to the language already shown) the saving page clears it; it also expires, so a lost
 * remount cannot announce a stale save on a later visit.
 */
let carried: { value: string; at: number } | null = null;
const CARRY_MS = 10_000;
const ANNOUNCE_DELAY_MS = 100;
const SETTLE_MS = 2_000;

function carriedValue(): string | null {
  return carried && Date.now() - carried.at < CARRY_MS ? carried.value : null;
}

/**
 * The locale the root will apply after reloading its loader (as `syncLocale` decides), or
 * undefined when its data does not say (then nothing will switch).
 */
function negotiated(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { locale, localeFromUser } = data as { locale?: unknown; localeFromUser?: unknown };
  if (typeof locale !== "string") return undefined;
  return (localeFromUser !== true && tabLocale()) || locale;
}

/**
 * Settings → Preferences, the Language section (batch 5 decision (e); a `SettingsSection` since
 * D7.1, the route brings the page header). The saved choice is
 * `Me.locale` (null: Automatic, so the cookie, the browser's languages and the instance default
 * decide), read with `me.get`; until it answers, `initial` (the root loader's locale when the
 * member's choice decided it, else null) stands in so the server render already shows it.
 * A choice saves at once; there is no unsaved state to lose when the tree remounts.
 */
export function LanguageSection({ initial }: { initial: string | null }): React.JSX.Element {
  const router = useRouter();
  const [value, setValue] = React.useState(() => carriedValue() ?? initial ?? AUTO);
  const [status, setStatus] = React.useState<Status>("idle");
  const busy = React.useRef(false);
  // A choice made before `me.get` answers wins over its (older) answer.
  const touched = React.useRef(false);
  const selectId = React.useId();
  const hintId = React.useId();

  // Announce the save that remounted this page. Set a moment after mount: a screen reader speaks
  // a change to a live region it has already seen, not one that arrives already filled.
  const [arrived] = React.useState(() => carriedValue() !== null);
  React.useEffect(() => {
    if (!arrived) return;
    carried = null;
    const id = window.setTimeout(() => setStatus("saved"), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [arrived]);

  React.useEffect(() => {
    let live = true;
    api()
      .me.get()
      .then(
        (me) => {
          if (live && !touched.current) setValue(me.locale ?? AUTO);
        },
        () => {
          // Keep the stand-in; saving still works and says so if it fails.
        },
      );
    return () => {
      live = false;
    };
  }, []);

  // Every path that ends without a remount settles here: the save is announced on this page, in
  // the language still shown, and the select is enabled again.
  const mounted = React.useRef(true);
  const fallback = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(fallback.current);
    };
  }, []);
  const settle = (): void => {
    window.clearTimeout(fallback.current);
    carried = null;
    busy.current = false;
    if (mounted.current) setStatus("saved");
  };
  // The remount normally replaces this page within a frame or two; if it never comes, do not
  // leave the select disabled.
  const awaitRemount = (): void => {
    window.clearTimeout(fallback.current);
    fallback.current = window.setTimeout(settle, SETTLE_MS);
  };

  const choose = async (next: string): Promise<void> => {
    if (next === value || busy.current) return;
    busy.current = true;
    touched.current = true;
    const previous = value;
    setValue(next);
    setStatus("saving");
    try {
      await api().me.update({ locale: next === AUTO ? null : next });
    } catch {
      busy.current = false;
      setValue(previous);
      setStatus("error");
      toast.error(t("localeSwitcher.saveFailed"));
      return;
    }
    // Stay "saving" (and the select disabled) through the switch: the remounted page announces
    // "Saved" once, in the new language, and a second choice cannot race this one.
    carried = { value: next, at: Date.now() };
    if (next === AUTO) {
      // The root loader negotiates again without a saved choice; the root then applies its answer.
      await router.invalidate();
      const want = negotiated(router.state.matches[0]?.loaderData);
      if (want === undefined || want === activeLocale()) settle();
      else awaitRemount();
      return;
    }
    try {
      await applyLocale(next);
      awaitRemount();
    } catch {
      // The catalog did not load: the choice is saved, so let the root sync from the server.
      await router.invalidate();
      settle();
    }
  };

  const autoLabel = t("preferences.language.auto");
  return (
    <SettingsSection
      data-testid="preferences-language"
      title={t("preferences.language.title")}
      description={<span id={hintId}>{t("preferences.language.description")}</span>}
    >
      <SettingsRow label={t("preferences.language.label")} controlId={selectId}>
        <div className="flex w-full flex-col gap-1 sm:w-80">
          <Select<string>
            value={value}
            disabled={status === "saving"}
            onValueChange={(v) => {
              if (typeof v === "string") void choose(v);
            }}
          >
            <SelectTrigger
              id={selectId}
              data-testid="locale-select"
              data-value={value}
              aria-describedby={hintId}
              className="w-full"
            >
              <SelectValue>{(v: string) => (v === AUTO ? autoLabel : <LanguageLabel tag={v} />)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO} data-testid="locale-option-auto">
                <span className="flex flex-col gap-0.5">
                  <span>{autoLabel}</span>
                  <span className="text-muted-foreground">{t("preferences.language.autoHint")}</span>
                </span>
              </SelectItem>
              {switchableLocales().map((tag) => (
                <SelectItem key={tag} value={tag} data-testid={`locale-option-${tag}`}>
                  <LanguageLabel tag={tag} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p
            aria-live="polite"
            data-testid="locale-save-status"
            data-state={status}
            className="min-h-5 text-sm text-muted-foreground"
          >
            {status === "saving"
              ? t("preferences.language.saving")
              : status === "saved"
                ? t("preferences.language.saved")
                : null}
          </p>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
