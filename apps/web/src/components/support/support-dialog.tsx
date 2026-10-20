// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AccentButton,
  ChannelAvatar,
  IconButton,
  MoneyAmount,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  formatMoney,
  useLocale,
} from "@commonair/ui";
import { BreakdownBar, KeyValueList } from "@commonair/ui/blocks/data";
import { AmountField, ChoiceToggle, OptionGroup } from "@commonair/ui/blocks/forms";
import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Button } from "@commonair/ui/components/button";
import { Checkbox } from "@commonair/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { Textarea } from "@commonair/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";
import { toast } from "@commonair/ui/toast";
import { Alert02Icon, Copy01Icon, FavouriteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import {
  SUBSCRIPTION_STATUS_VIEW,
  SUPPORT_TABS,
  checkoutErrorMessage,
  checkoutRequest,
  giftCount,
  giftError,
  giftPresets,
  initialTab,
  splitCents,
  splitPercents,
  supportText,
  supportTotal,
  tabAvailability,
  tipPresets,
  type CheckoutRequest,
  type CheckoutResult,
  type RecipientMode,
  type SupportDraft,
  type SupportInfo,
  type SupportTab,
  type TierNumber,
  type TipDraft,
} from "../../lib/support.ts";
import { safeHttpUrl } from "../../lib/url.ts";

/** The calls the dialog makes; tests pass a stub, the app the oRPC client. */
export interface SupportClient {
  support: (input: { channel: string }) => Promise<SupportInfo>;
  checkout: (request: CheckoutRequest) => Promise<CheckoutResult>;
}

export const apiSupportClient: SupportClient = {
  support: (input) => api().money.support(input),
  checkout: (request) =>
    request.kind === "tip" ? api().money.tip(request.input) : api().money.subscribe(request.input),
};

export interface SupportButtonProps {
  channel: string;
  channelName: string;
  signedIn: boolean;
  client?: SupportClient;
}

/**
 * The channel's Support call to action (`support-open`). Signed out it is a link to /signin;
 * signed in it opens the Support dialog, which loads `money.support` when it opens.
 */
export function SupportButton({
  channel,
  channelName,
  signedIn,
  client = apiSupportClient,
}: SupportButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  if (!signedIn)
    return (
      <AccentButton data-testid="support-open" size="sm" nativeButton={false} render={<Link to="/signin" />}>
        <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
        {t("support.open")}
      </AccentButton>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<AccentButton data-testid="support-open" size="sm" />}>
        <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
        {t("support.open")}
      </DialogTrigger>
      {open && (
        <SupportDialogContent
          channel={channel}
          channelName={channelName}
          client={client}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}

interface SupportDialogContentProps {
  channel: string;
  channelName: string;
  client: SupportClient;
  onClose: () => void;
}

/** Mounted while the dialog is open, so every open loads fresh tiers and subscription state. */
export function SupportDialogContent({
  channel,
  channelName,
  client,
  onClose,
}: SupportDialogContentProps): React.JSX.Element {
  const [info, setInfo] = React.useState<SupportInfo | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [result, setResult] = React.useState<Extract<CheckoutResult, { kind: "instructions" }> | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    client
      .support({ channel })
      .then((loaded) => {
        if (live) setInfo(loaded);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [channel, client, attempt]);

  return (
    // The dialog scrolls inside the viewport, so a Drawer is not needed at 320 px.
    <DialogContent
      data-testid="support-dialog"
      data-provider={info?.provider}
      className="max-h-svh overflow-y-auto sm:max-w-lg"
    >
      <DialogHeader className="flex-row items-start gap-3">
        <ChannelAvatar name={channelName} size="md" decorative />
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>{t("support.title", { name: channelName })}</DialogTitle>
          <DialogDescription>{t("support.description")}</DialogDescription>
        </div>
      </DialogHeader>
      {result ? (
        <SupportInstructions result={result} onDone={onClose} />
      ) : info ? (
        <SupportForm channel={channel} info={info} checkout={client.checkout} onInstructions={setResult} />
      ) : failed ? (
        <div className="flex flex-col gap-3">
          <SupportAlert>{t("support.loadFailed")}</SupportAlert>
          <div>
            <Button
              variant="outline"
              onClick={() => {
                setFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              {t("support.retry")}
            </Button>
          </div>
        </div>
      ) : (
        <SkeletonGroup label={t("support.loading")}>
          <SkeletonText lines={6} />
        </SkeletonGroup>
      )}
    </DialogContent>
  );
}

function SupportAlert({
  children,
  ...props
}: {
  children: React.ReactNode;
  "data-testid"?: string;
}): React.JSX.Element {
  return (
    <Alert variant="destructive" {...props}>
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export interface SupportFormProps {
  channel: string;
  info: SupportInfo;
  checkout: SupportClient["checkout"];
  onInstructions: (result: Extract<CheckoutResult, { kind: "instructions" }>) => void;
  /** Starting state (tests and stories); the dialog opens on the first open tab. */
  initial?: Partial<SupportDraft>;
}

/** The subscribe / gift / tip form. Totals, validation and the request come from lib/support.ts. */
export function SupportForm({ channel, info, checkout, onInstructions, initial }: SupportFormProps): React.JSX.Element {
  const { locale } = useLocale();
  const available = tabAvailability(info);
  const [draft, setDraft] = React.useState<SupportDraft>(() => ({
    tab: initial?.tab ?? initialTab(available),
    tier: initial?.tier ?? 1,
    gift: initial?.gift ?? { count: "1", mode: "random", to: "" },
    tip: initial?.tip ?? { cents: tipPresets(info.tip)[1] ?? info.tip.minCents, message: "", anonymous: false },
  }));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // `pending` only updates on the next render; a double click in one frame must not check out twice.
  const inFlight = React.useRef(false);
  const ids = React.useId();

  const money = (cents: number) => formatMoney(cents, info.currency, locale);
  const total = supportTotal(info, draft);
  const request = checkoutRequest(channel, info, draft, `/${channel}`);
  const parts = splitCents(total ?? 0, info.split);
  const percents = splitPercents(info.split);
  const held = info.viewer?.subscription ?? null;
  const update = (next: Partial<SupportDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setError(null);
  };
  // The amount field reports value and validity in one event: merge into the latest tip, not this render's.
  const updateTip = (next: Partial<TipDraft>) => {
    setDraft((d) => ({ ...d, tip: { ...d.tip, ...next } }));
    setError(null);
  };

  const submit = async () => {
    if (!request || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await checkout(request);
      if (result.kind === "instructions") onInstructions(result);
      else {
        const url = safeHttpUrl(result.url);
        if (url) {
          toast.info(t("support.redirecting"));
          window.location.assign(url);
        } else setError(t("support.error.generic"));
      }
    } catch (err) {
      setError(checkoutErrorMessage(err));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const tierItems = info.tiers.map((tier) => ({
    value: String(tier.tier),
    title: tier.name,
    description: tier.benefits || undefined,
    price: tier.price,
    trailing: <span className="shrink-0 text-muted-foreground">{t("support.perMonth")}</span>,
    controlProps: { "data-testid": "support-tier", "data-tier": tier.tier, "data-cents": tier.price.cents },
  }));
  const tierGroup = (
    <OptionGroup
      aria-label={t("support.tier")}
      value={String(draft.tier)}
      onValueChange={(value) => update({ tier: Number(value) as TierNumber })}
      items={tierItems}
    />
  );
  const giftProblem = giftError(draft.gift, info.gift.maxCount);
  const giftQuantity = giftCount(draft.gift, info.gift.maxCount);
  // Sub and gift often share a reason (no tiers yet): say it once, and point both tabs at it.
  const reasons = [...new Set(SUPPORT_TABS.flatMap((tab) => available[tab].reason ?? []))];
  const reasonId = (tab: SupportTab) => {
    const reason = available[tab].reason;
    return reason ? `${ids}-reason-${reasons.indexOf(reason)}` : undefined;
  };

  const cta = (() => {
    if (total === null) return t("support.submit.invalid");
    if (draft.tab === "sub") return t("support.submit.sub", { amount: money(total) });
    if (draft.tab === "gift")
      return giftQuantity === 1
        ? t("support.submit.giftOne", { amount: money(total) })
        : t("support.submit.gift", { count: giftQuantity ?? 0, amount: money(total) });
    return t("support.submit.tip", { amount: money(total) });
  })();

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      noValidate
      aria-busy={pending || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* Raw Tabs until PageTabs takes per-item `disabled` and test ids (head-agent follow-up). */}
      <Tabs value={draft.tab} onValueChange={(value) => update({ tab: value as SupportTab })}>
        <TabsList aria-label={t("support.tabs")} className="w-full">
          <TabsTrigger
            data-testid="support-tab-sub"
            value="sub"
            disabled={!available.sub.enabled}
            aria-describedby={
              [reasonId("sub"), held ? `${ids}-current` : undefined].filter(Boolean).join(" ") || undefined
            }
          >
            {t("support.tab.sub")}
          </TabsTrigger>
          <TabsTrigger
            data-testid="support-tab-gift"
            value="gift"
            disabled={!available.gift.enabled}
            aria-describedby={reasonId("gift")}
          >
            {t("support.tab.gift")}
          </TabsTrigger>
          <TabsTrigger
            data-testid="support-tab-tip"
            value="tip"
            disabled={!available.tip.enabled}
            aria-describedby={reasonId("tip")}
          >
            {t("support.tab.tip")}
          </TabsTrigger>
        </TabsList>
        {reasons.map((reason, index) => (
          <p key={reason} id={`${ids}-reason-${index}`} data-reason={reason} className="pt-2 text-muted-foreground">
            {supportText(reason)}
          </p>
        ))}
        {/* About the sub tab, but outside its panel: holding a subscription disables that tab. */}
        {held && (
          <div
            id={`${ids}-current`}
            data-testid="support-current"
            data-status={held.status}
            data-tier={held.tier}
            className="flex flex-wrap items-center gap-2 pt-2"
          >
            <StatusBadge tone={SUBSCRIPTION_STATUS_VIEW[held.status].tone}>
              {supportText(SUBSCRIPTION_STATUS_VIEW[held.status].key)}
            </StatusBadge>
            <span>{t("support.current", { tier: held.tier })}</span>
            {held.status === "incomplete" && (
              <span className="text-muted-foreground">{t("support.current.incomplete")}</span>
            )}
          </div>
        )}
        <TabsContent value="sub" className="pt-2">
          {tierGroup}
        </TabsContent>
        <TabsContent value="gift" className="flex flex-col gap-4 pt-2">
          {tierGroup}
          <FieldGroup>
            <Field>
              <FieldLabel id={`${ids}-recipient`}>{t("support.gift.recipient")}</FieldLabel>
              <ToggleGroup
                data-testid="support-gift-recipient"
                aria-labelledby={`${ids}-recipient`}
                variant="outline"
                multiple={false}
                value={[draft.gift.mode]}
                onValueChange={(values) => {
                  const mode = values.at(-1) as RecipientMode | undefined;
                  if (mode) update({ gift: { ...draft.gift, mode } });
                }}
                className="flex-wrap"
              >
                <ToggleGroupItem data-testid="support-gift-recipient-random" value="random">
                  {t("support.gift.random")}
                </ToggleGroupItem>
                <ToggleGroupItem data-testid="support-gift-recipient-viewer" value="viewer">
                  {t("support.gift.viewer")}
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            {draft.gift.mode === "random" ? (
              <>
                <ChoiceToggle
                  label={t("support.gift.count")}
                  value={draft.gift.count}
                  onValueChange={(count) => update({ gift: { ...draft.gift, count } })}
                  options={giftPresets(info.gift.maxCount).map((count) => ({
                    value: String(count),
                    label: count,
                  }))}
                />
                <Field data-invalid={giftProblem ? true : undefined}>
                  <FieldLabel htmlFor={`${ids}-count`}>{t("support.gift.countInput")}</FieldLabel>
                  <Input
                    id={`${ids}-count`}
                    data-testid="support-gift-count"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={info.gift.maxCount}
                    value={draft.gift.count}
                    aria-invalid={giftProblem ? true : undefined}
                    aria-describedby={`${ids}-count-hint`}
                    onChange={(event) => update({ gift: { ...draft.gift, count: event.currentTarget.value } })}
                  />
                  <FieldDescription id={`${ids}-count-hint`}>
                    {giftProblem
                      ? supportText(giftProblem, { max: info.gift.maxCount })
                      : t("support.gift.countHint", { max: info.gift.maxCount })}
                  </FieldDescription>
                </Field>
                <FieldDescription>{t("support.gift.randomHint")}</FieldDescription>
              </>
            ) : (
              <Field data-invalid={giftProblem && draft.gift.to ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-to`}>{t("support.gift.to")}</FieldLabel>
                <Input
                  id={`${ids}-to`}
                  data-testid="support-gift-to"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={26}
                  value={draft.gift.to}
                  aria-invalid={giftProblem && draft.gift.to ? true : undefined}
                  aria-describedby={`${ids}-to-hint`}
                  onChange={(event) => update({ gift: { ...draft.gift, to: event.currentTarget.value } })}
                />
                <FieldDescription id={`${ids}-to-hint`}>
                  {giftProblem && draft.gift.to ? supportText(giftProblem) : t("support.gift.toHint")}
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>
        </TabsContent>
        <TabsContent value="tip" className="pt-2">
          <FieldGroup>
            <AmountField
              label={t("support.tip.amount")}
              currency={info.currency}
              locale={locale}
              value={draft.tip.cents}
              onValueChange={(cents) => updateTip({ cents })}
              onValidityChange={(valid) => updateTip({ unparsed: !valid })}
              presets={tipPresets(info.tip).map((cents) => ({ value: cents, label: money(cents) }))}
              min={info.tip.minCents}
              max={info.tip.maxCents}
              rangeError={t("support.tip.invalidAmount", {
                min: money(info.tip.minCents),
                max: money(info.tip.maxCents),
              })}
              formatError={t("support.tip.unparsed", { example: money(info.tip.minCents) })}
              inputProps={{ "data-testid": "support-tip-amount" }}
            />
            <Field>
              <FieldLabel htmlFor={`${ids}-message`}>{t("support.tip.message")}</FieldLabel>
              <Textarea
                id={`${ids}-message`}
                data-testid="support-tip-message"
                maxLength={info.tip.messageMaxLength}
                value={draft.tip.message}
                aria-describedby={`${ids}-message-count`}
                onChange={(event) => update({ tip: { ...draft.tip, message: event.currentTarget.value } })}
              />
              <FieldDescription
                id={`${ids}-message-count`}
                aria-live={info.tip.messageMaxLength - draft.tip.message.length <= 20 ? "polite" : undefined}
              >
                {t("support.tip.count", { count: draft.tip.message.length, max: info.tip.messageMaxLength })}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id={`${ids}-anonymous`}
                data-testid="support-tip-anonymous"
                checked={draft.tip.anonymous}
                onCheckedChange={(checked) => update({ tip: { ...draft.tip, anonymous: checked === true } })}
              />
              <FieldLabel htmlFor={`${ids}-anonymous`}>{t("support.tip.anonymous")}</FieldLabel>
            </Field>
          </FieldGroup>
        </TabsContent>
      </Tabs>
      <BreakdownBar
        data-testid="support-split"
        data-streamer-share={info.split.streamerShare}
        data-coop-share={info.split.coopShare}
        label={t("support.split")}
        segments={[
          { id: "creator", label: t("support.split.creator"), value: parts.creator, color: "--chart-1" },
          { id: "coop", label: t("support.split.coop"), value: parts.coop, color: "--chart-2" },
        ]}
        formatValue={money}
        formatLabel={() => t("support.split.label", { creator: percents.creator, coop: percents.coop })}
        legendLayout="inline"
      />
      <KeyValueList
        rows={[
          {
            term: t("support.total"),
            value: (
              <span data-testid="support-total" data-cents={total ?? 0}>
                {total !== null && <MoneyAmount value={{ cents: total, currency: info.currency }} />}
              </span>
            ),
          },
        ]}
      />
      {error && <SupportAlert data-testid="support-error">{error}</SupportAlert>}
      <DialogFooter className="sm:flex-col">
        <AccentButton
          data-testid="support-submit"
          type="submit"
          size="lg"
          className="w-full"
          disabled={request === null || pending}
          aria-busy={pending || undefined}
        >
          {cta}
        </AccentButton>
      </DialogFooter>
    </form>
  );
}

export interface SupportInstructionsProps {
  result: Extract<CheckoutResult, { kind: "instructions" }>;
  onDone: () => void;
}

/** Manual adapter result: the reference to quote, the amount and the co-op's instructions. */
export function SupportInstructions({ result, onDone }: SupportInstructionsProps): React.JSX.Element {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.reference);
      toast.success(t("support.instructions.copied"));
    } catch {
      toast.error(t("support.instructions.copyFailed"));
    }
  };
  return (
    <section
      data-testid="support-instructions"
      data-payment-id={result.paymentId}
      aria-labelledby="support-instructions-title"
      className="flex min-w-0 flex-col gap-4"
    >
      <h3 id="support-instructions-title" className="text-sm font-semibold">
        {t("support.instructions.title")}
      </h3>
      <KeyValueList
        rows={[
          {
            term: t("support.instructions.reference"),
            value: (
              <span className="flex items-center gap-1">
                <span
                  data-testid="support-reference"
                  data-reference={result.reference}
                  className="font-semibold tabular-nums select-all"
                >
                  {result.reference}
                </span>
                <IconButton
                  icon={Copy01Icon}
                  label={t("support.instructions.copy")}
                  tooltip={t("support.instructions.copy")}
                  size="icon-sm"
                  onClick={() => void copy()}
                />
              </span>
            ),
          },
          {
            term: t("support.instructions.amount"),
            value: <MoneyAmount data-testid="support-amount" data-cents={result.amount.cents} value={result.amount} />,
          },
        ]}
      />
      <p className="break-words whitespace-pre-line">{result.instructions}</p>
      <p className="text-muted-foreground">{t("support.instructions.hint")}</p>
      <DialogFooter>
        <Button onClick={onDone}>{t("support.instructions.done")}</Button>
      </DialogFooter>
    </section>
  );
}
