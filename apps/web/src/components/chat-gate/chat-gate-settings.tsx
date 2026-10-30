// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Studio `/chat` (docs/testing/w1-selectors.md "Watch gate"): the verified-watch gate and the surge
 * guard for one channel, saved together through `chat.updateSettings`. Each control shows only
 * while the instance runs its feature (`instance.info` `features`); otherwise an empty state says
 * the instance has not enabled it.
 */
import { EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { ButtonGroup } from "@commonair/ui/components/button-group";
import { FieldSeparator } from "@commonair/ui/components/field";
import { toast } from "@commonair/ui/toast";
import { Shield01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { StudioLoadError, StudioSection, TextField, ToggleField } from "../interact-studio/shared.tsx";
import { useLoad } from "../money/use-load.ts";
import { chatGateFeatures, type ChatGateClient } from "./features.ts";
import {
  chatGateDraft,
  chatGateInput,
  type ChatGateDraft,
  type ChatGateErrors,
  type ChatGateFeatures,
  GATE_PRESETS,
} from "./form.ts";

interface Loaded {
  features: ChatGateFeatures;
  settings: ChannelChatSettings;
}

export function ChatGateStudio({ channel, client }: { channel: string; client?: ChatGateClient }): React.JSX.Element {
  const c = React.useMemo(() => client ?? api(), [client]);
  const loaded = useLoad<Loaded>(channel, async () => {
    const [features, settings] = await Promise.all([chatGateFeatures(c), c.chat.settings({ channel })]);
    return { features, settings };
  });
  if (loaded.failed)
    return (
      <StudioLoadError
        data-testid="chat-gate-load-error"
        message={t("chatGate.loadFailed")}
        retry={
          <Button type="button" variant="outline" size="sm" data-testid="chat-gate-retry" onClick={loaded.reload}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  if (!loaded.data)
    return (
      <SkeletonGroup>
        <SkeletonText lines={6} />
      </SkeletonGroup>
    );
  const { features, settings } = loaded.data;
  if (!features.watchGate && !features.surgeGuard)
    return (
      <EmptyState
        data-testid="chat-gate-off"
        icon={Shield01Icon}
        title={t("chatGate.offTitle")}
        description={t("chatGate.offDescription")}
        headingLevel={2}
      />
    );
  return <ChatGateForm channel={channel} client={c} features={features} initial={settings} />;
}

function ChatGateForm({
  channel,
  client,
  features,
  initial,
}: {
  channel: string;
  client: ChatGateClient;
  features: ChatGateFeatures;
  initial: ChannelChatSettings;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<ChatGateDraft>(() => chatGateDraft(initial));
  const [errors, setErrors] = React.useState<ChatGateErrors>({});
  const [pending, setPending] = React.useState(false);
  const set = <K extends keyof ChatGateDraft>(key: K, value: ChatGateDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const presetLabel: Record<(typeof GATE_PRESETS)[number], string> = {
    0: t("chatGate.gate.preset0"),
    60: t("chatGate.gate.preset60"),
    300: t("chatGate.gate.preset300"),
    900: t("chatGate.gate.preset900"),
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const checked = chatGateInput(draft, features);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const next = await client.chat.updateSettings({ channel, ...checked.input });
      setDraft(chatGateDraft(next));
      toast.success(t("chatGate.saved"));
    } catch (err) {
      toastActionError(err, t("chatGate.saveFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="chat-gate-settings"
      noValidate
      onSubmit={(e) => void submit(e)}
      aria-label={t("chatGate.pageTitle")}
      className="flex flex-col gap-6"
    >
      {features.watchGate ? (
        <StudioSection icon={Shield01Icon} title={t("chatGate.gate.title")} description={t("chatGate.gate.intro")}>
          <TextField
            label={t("chatGate.gate.seconds")}
            value={draft.seconds}
            onChange={(v) => set("seconds", v)}
            data-testid="chat-gate-seconds"
            numeric
            error={errors.seconds ? t("chatGate.error.seconds") : undefined}
            description={t("chatGate.gate.secondsHint")}
          />
          <ButtonGroup aria-label={t("chatGate.gate.presets")}>
            {GATE_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={draft.seconds.trim() === String(p) ? "secondary" : "outline"}
                aria-pressed={draft.seconds.trim() === String(p)}
                data-testid={`chat-gate-seconds-${p}`}
                onClick={() => set("seconds", String(p))}
              >
                {presetLabel[p]}
              </Button>
            ))}
          </ButtonGroup>
          <ToggleField
            label={t("chatGate.gate.exemptSubs")}
            description={t("chatGate.gate.exemptSubsHint")}
            checked={draft.exemptSubs}
            onChange={(v) => set("exemptSubs", v)}
            data-testid="chat-gate-exempt-subs"
          />
          <p className="text-sm text-muted-foreground">{t("chatGate.gate.who")}</p>
        </StudioSection>
      ) : (
        <EmptyState
          data-testid="chat-gate-gate-off"
          icon={Shield01Icon}
          title={t("chatGate.gate.offTitle")}
          description={t("chatGate.gate.offDescription")}
          headingLevel={2}
        />
      )}
      {features.surgeGuard ? (
        <StudioSection
          icon={UserMultiple02Icon}
          title={t("chatGate.surge.title")}
          description={t("chatGate.surge.intro")}
        >
          <ToggleField
            label={t("chatGate.surge.enabled")}
            description={t("chatGate.surge.enabledHint")}
            checked={draft.surgeEnabled}
            onChange={(v) => set("surgeEnabled", v)}
            data-testid="surge-guard-enabled"
          />
          <FieldSeparator />
          <TextField
            label={t("chatGate.surge.ratio")}
            value={draft.ratio}
            onChange={(v) => set("ratio", v)}
            data-testid="surge-guard-ratio"
            numeric
            error={errors.ratio ? t("chatGate.error.ratio") : undefined}
            description={t("chatGate.surge.ratioHint")}
          />
          <TextField
            label={t("chatGate.surge.cooldown")}
            value={draft.cooldown}
            onChange={(v) => set("cooldown", v)}
            data-testid="surge-guard-cooldown"
            numeric
            error={errors.cooldown ? t("chatGate.error.cooldown") : undefined}
            description={t("chatGate.surge.cooldownHint")}
          />
        </StudioSection>
      ) : (
        <EmptyState
          data-testid="chat-gate-surge-off"
          icon={UserMultiple02Icon}
          title={t("chatGate.surge.offTitle")}
          description={t("chatGate.surge.offDescription")}
          headingLevel={2}
        />
      )}
      <div>
        <Button type="submit" data-testid="chat-gate-save" disabled={pending}>
          {t("chatGate.save")}
        </Button>
      </div>
    </form>
  );
}
