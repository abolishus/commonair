// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Field, FieldContent, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { type PushEnv, type PushState, browserPushEnv, readPushState, turnPushOff, turnPushOn } from "./push-client.ts";

/**
 * The browser push switch on the notification settings page (N1-inbox mounts it). `data-state`
 * is the push state (docs/testing/n1-selectors.md); with push off on the instance it renders
 * nothing. Permission is only asked when the member turns it on.
 */
export function PushToggle({ env }: { env?: PushEnv } = {}): React.JSX.Element | null {
  const id = React.useId();
  const [state, setState] = React.useState<PushState>("busy");
  const [pushEnv] = React.useState(() => env ?? browserPushEnv());

  // A failed status read (offline, signed out meanwhile) shows nothing rather than a dead switch.
  const read = React.useCallback(() => readPushState(pushEnv).catch((): PushState => "unavailable"), [pushEnv]);
  const refresh = async () => setState(await read());

  React.useEffect(() => {
    let live = true;
    const load = async () => {
      const next = await read();
      if (live) setState(next);
    };
    void load();
    return () => {
      live = false;
    };
  }, [read]);

  const change = async (on: boolean) => {
    setState("busy");
    try {
      const next = on ? await turnPushOn(pushEnv) : await turnPushOff(pushEnv);
      setState(next);
      if (next === "on") toast.success(t("push.toast.on"));
      else if (next === "off" && !on) toast.success(t("push.toast.off"));
    } catch {
      toast.error(on ? t("push.error.on") : t("push.error.off"));
      await refresh();
    }
  };

  if (state === "unavailable") return null;
  return (
    <Field orientation="horizontal" data-disabled={state === "unsupported" || state === "denied" || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{t("push.toggle.label")}</FieldLabel>
        <FieldDescription>{t("push.toggle.description")}</FieldDescription>
        <FieldDescription>{t("push.vendorNote")}</FieldDescription>
        {state === "unsupported" ? (
          <FieldDescription data-testid="push-unsupported">{t("push.unsupported")}</FieldDescription>
        ) : null}
        {state === "denied" ? (
          <FieldDescription data-testid="push-denied-help">{t("push.deniedHelp")}</FieldDescription>
        ) : null}
      </FieldContent>
      <Switch
        id={id}
        data-testid="push-toggle"
        data-state={state}
        checked={state === "on"}
        disabled={state !== "on" && state !== "off"}
        aria-busy={state === "busy" || undefined}
        onCheckedChange={(on) => void change(on)}
      />
    </Field>
  );
}
