// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Raids on `/interact`, owner and editors only (docs/testing/e8-selectors.md "Raids"): the target
 * form (the live check is the API's), the countdown with cancel, the last raid and its cooldown,
 * and who may raid this channel (saved on change).
 */
import { RelativeTime, StatusBadge, ViewerCount } from "@commonair/ui";
import { SelectField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Rocket01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { fillNode } from "../../lib/fill.tsx";
import {
  isRaidPolicy,
  raidCancelReasonLabel,
  raidCooldownUntil,
  raidErrorCode,
  raidErrorMessage,
  raidPolicyLabel,
  raidStatusLabel,
  raidTarget,
  type RaidDto,
  type RaidErrorCode,
  type RaidPolicy,
  type RaidStateDto,
} from "../../lib/interact-studio.ts";
import { POLL_REFRESH_MS } from "./poll-panel.tsx";
import { StudioSection, TextField, useLiveState, useNow, usePolling, type StudioApi } from "./shared.tsx";

export function RaidPanel({
  channel,
  initial,
  client,
  refreshMs = POLL_REFRESH_MS,
}: {
  channel: string;
  initial: RaidStateDto;
  client: StudioApi;
  refreshMs?: number;
}): React.JSX.Element {
  const [state, setState, refreshState] = useLiveState(initial);
  const raids = client.interact.raids;
  const pending = state.raid?.status === "pending" ? state.raid : null;
  usePolling(pending !== null, refreshMs, () => refreshState(() => raids.current({ channel })));
  const now = useNow(state.cooldownEndsAt !== null);
  const cooldownUntil = raidCooldownUntil(state, now);
  const last = state.raid !== null && state.raid.status !== "pending" ? state.raid : null;

  return (
    <StudioSection icon={Rocket01Icon} title={t("interact.raid.title")} description={t("interact.raid.intro")}>
      {pending ? (
        <RaidPending
          raid={pending}
          onCancel={async () => {
            await raids.cancel({ channel });
            setState(await raids.current({ channel }));
            toast.success(t("interact.raid.canceled"));
          }}
        />
      ) : (
        <RaidForm
          onStart={async (to) => {
            await raids.start({ channel, to });
            setState(await raids.current({ channel }));
          }}
        />
      )}
      {last ? <RaidLast raid={last} cooldownUntil={cooldownUntil} /> : null}
      <RaidPolicyField
        policy={state.policy}
        onChange={async (policy) => {
          setState(await raids.setPolicy({ channel, policy }));
          toast.success(t("interact.raid.policySaved"));
        }}
      />
    </StudioSection>
  );
}

function RaidForm({ onStart }: { onStart: (to: string) => Promise<void> }): React.JSX.Element {
  const [target, setTarget] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | undefined>();
  const [refusal, setRefusal] = React.useState<RaidErrorCode | null>(null);
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const to = raidTarget(target);
    if (to === null) {
      setFieldError(t("interact.raid.error.target"));
      return;
    }
    setFieldError(undefined);
    setRefusal(null);
    setPending(true);
    try {
      await onStart(to);
      setTarget("");
    } catch (err) {
      const code = raidErrorCode(err);
      if (code === "raid_failed") toastActionError(err, raidErrorMessage(code));
      setRefusal(code);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="raid-form"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4"
      aria-label={t("interact.raid.formLabel")}
    >
      <TextField
        label={t("interact.raid.target")}
        value={target}
        onChange={setTarget}
        data-testid="raid-target"
        error={fieldError}
        description={t("interact.raid.targetHint")}
      />
      {refusal ? (
        <p data-testid="raid-error" data-code={refusal} role="alert" className="text-sm text-destructive">
          {raidErrorMessage(refusal)}
        </p>
      ) : null}
      <Button type="submit" data-testid="raid-start" disabled={pending} className="self-start">
        {t("interact.raid.start")}
      </Button>
    </form>
  );
}

function RaidPending({ raid, onCancel }: { raid: RaidDto; onCancel: () => Promise<void> }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  return (
    <div
      data-testid="raid-pending"
      data-raid-id={raid.id}
      data-to={raid.to}
      data-execute-at={raid.executeAt}
      className="flex flex-col gap-3"
      aria-live="polite"
    >
      <p className="text-sm">
        {fillNode(
          t("interact.raid.countdown", { channel: raid.toDisplayName }),
          "time",
          <RelativeTime date={raid.executeAt} />,
        )}
      </p>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        data-testid="raid-cancel"
        disabled={pending}
        onClick={() => {
          setPending(true);
          onCancel()
            .catch((err: unknown) => toastActionError(err, t("interact.raid.cancelFailed")))
            .finally(() => setPending(false));
        }}
      >
        {t("interact.raid.cancel")}
      </Button>
    </div>
  );
}

function RaidLast({ raid, cooldownUntil }: { raid: RaidDto; cooldownUntil: string | null }): React.JSX.Element {
  return (
    <div
      data-testid="raid-last"
      data-raid-id={raid.id}
      data-status={raid.status}
      data-viewers={raid.viewerCount}
      data-cancel-reason={raid.cancelReason ?? ""}
      className="flex flex-col gap-2 border-t pt-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t("interact.raid.last")}</h3>
        <StatusBadge tone={raid.status === "completed" ? "success" : "neutral"}>
          {raidStatusLabel(raid.status)}
        </StatusBadge>
      </div>
      <p className="text-sm break-words">
        {fillNode(
          t("interact.raid.lastTo", { channel: raid.toDisplayName }),
          "time",
          <RelativeTime date={raid.executeAt} />,
        )}
      </p>
      {raid.status === "completed" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {t("interact.raid.viewersLabel")} <ViewerCount count={raid.viewerCount} />
        </p>
      ) : null}
      {raid.cancelReason ? (
        <p className="text-sm text-muted-foreground">{raidCancelReasonLabel(raid.cancelReason)}</p>
      ) : null}
      {cooldownUntil ? (
        <p data-testid="raid-cooldown" data-until={cooldownUntil} className="text-sm text-muted-foreground">
          {fillNode(t("interact.raid.cooldown"), "time", <RelativeTime date={cooldownUntil} />)}
        </p>
      ) : null}
    </div>
  );
}

function RaidPolicyField({
  policy,
  onChange,
}: {
  policy: RaidPolicy;
  onChange: (policy: RaidPolicy) => Promise<void>;
}): React.JSX.Element {
  const [saving, setSaving] = React.useState(false);
  return (
    <SelectField
      label={t("interact.raid.policy")}
      description={t("interact.raid.policyHint")}
      value={policy}
      disabled={saving}
      triggerProps={{ "data-testid": "raid-policy" }}
      options={[
        { value: "anyone", label: raidPolicyLabel("anyone"), "data-testid": "raid-policy-anyone" },
        { value: "followed", label: raidPolicyLabel("followed"), "data-testid": "raid-policy-followed" },
        { value: "off", label: raidPolicyLabel("off"), "data-testid": "raid-policy-off" },
      ]}
      onValueChange={(value) => {
        if (!isRaidPolicy(value) || value === policy) return;
        setSaving(true);
        onChange(value)
          .catch((err: unknown) => toastActionError(err, t("interact.raid.policyFailed")))
          .finally(() => setSaving(false));
      }}
    />
  );
}
