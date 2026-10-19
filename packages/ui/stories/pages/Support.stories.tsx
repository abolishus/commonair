// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, PiggyBankIcon } from "@hugeicons/core-free-icons";
import { AccentButton, ChannelAvatar, MoneyAmount, formatMoney } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
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
import { Textarea } from "@commonair/ui/components/textarea";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { BreakdownBar, KeyValueList } from "@commonair/ui/blocks/data";
import { AmountField, ChoiceToggle, OptionGroup } from "@commonair/ui/blocks/forms";
import { ChannelHeader, ChatPanel, PlayerChrome } from "@commonair/ui/blocks/media";
import {
  channel,
  gift,
  giftCounts,
  paymentMethods,
  recipients,
  smallPrint,
  split,
  tiers,
  tip as tipDefaults,
  tipPresetCents,
  type SupportTab,
} from "./fixtures/Support.ts";
import { SelectField } from "./select-field.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Channel/Support", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number): string => formatMoney(cents, "USD", "en-US");

function SupportPage(): React.JSX.Element {
  const [tab, setTab] = React.useState<SupportTab>("sub");
  const [tier, setTier] = React.useState("1");
  const [giftCount, setGiftCount] = React.useState(gift.defaultCount);
  const [customCount, setCustomCount] = React.useState(gift.customDefault);
  const [recipient, setRecipient] = React.useState("random");
  const [tipCents, setTipCents] = React.useState(tipDefaults.cents);
  const [method, setMethod] = React.useState("card");
  const chosen = tiers.find((option) => option.value === tier) ?? tiers[0];
  const giftQuantity = giftCount === "Custom" ? customCount : Number(giftCount);
  const giftValid = Number.isSafeInteger(giftQuantity) && giftQuantity >= 1 && giftQuantity <= gift.customMax;
  const giftCents = giftValid ? giftQuantity * gift.tierCents : 0;
  const cta =
    tab === "sub"
      ? `Subscribe for ${usd(chosen?.cents ?? 0)} / month`
      : tab === "gift"
        ? giftValid
          ? `Gift ${giftQuantity} ${giftQuantity === 1 ? "sub" : "subs"} · ${usd(giftCents)}`
          : "Choose how many subs to gift"
        : `Send ${usd(tipCents)} tip`;
  return (
    <div data-accent={channel.accent}>
      <ViewerPage footer={false}>
        <PageContainer width="wide" className="py-4">
          <SplitLayout
            asideWidth="lg"
            main={
              <div className="flex flex-col gap-4">
                <PlayerChrome
                  variant="live"
                  stage={<ChannelAvatar name={channel.name} accent={channel.accent} size="xl" decorative />}
                >
                  {null}
                </PlayerChrome>
                <ChannelHeader name={channel.name} accent={channel.accent} live variant="compact" />
              </div>
            }
            aside={
              <ChatPanel title="Stream chat" logLabel="Chat messages" newMessagesLabel="New messages">
                {null}
              </ChatPanel>
            }
          />
        </PageContainer>
      </ViewerPage>
      <Dialog defaultOpen>
        <DialogTrigger render={<AccentButton accent={channel.accent} className="sr-only focus:not-sr-only" />}>
          Support {channel.name}
        </DialogTrigger>
        <DialogContent className="max-h-svh overflow-y-auto sm:max-w-lg" data-accent={channel.accent}>
          <DialogHeader className="flex-row items-start gap-3">
            <ChannelAvatar name={channel.name} accent={channel.accent} size="md" decorative />
            <div className="flex flex-col gap-1">
              <DialogTitle>Support {channel.name}</DialogTitle>
              <DialogDescription>Every option pays the creator directly through the co-op.</DialogDescription>
            </div>
          </DialogHeader>
          <PageTabs
            variant="default"
            value={tab}
            onValueChange={(next) => setTab(next as SupportTab)}
            items={[
              {
                id: "sub",
                label: "Subscribe",
                content: (
                  <OptionGroup
                    aria-label="Tier"
                    value={tier}
                    onValueChange={setTier}
                    className="flex flex-col gap-2"
                    items={tiers.map((option) => ({
                      value: option.value,
                      title: option.title,
                      description: option.perks,
                      trailing: (
                        <span className="shrink-0 tabular-nums">
                          <MoneyAmount value={{ cents: option.cents, currency: "USD" }} locale="en-US" /> / month
                        </span>
                      ),
                    }))}
                  />
                ),
              },
              {
                id: "gift",
                label: "Gift subs",
                content: (
                  <FieldGroup>
                    <ChoiceToggle
                      label="How many?"
                      options={giftCounts}
                      value={giftCount}
                      onValueChange={setGiftCount}
                    />
                    {giftCount === "Custom" ? (
                      <Field>
                        <FieldLabel htmlFor="support-gift-count">Number of subs</FieldLabel>
                        <Input
                          id="support-gift-count"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={gift.customMax}
                          value={Number.isNaN(customCount) ? "" : customCount}
                          onChange={(event) => setCustomCount(Number.parseInt(event.currentTarget.value, 10))}
                          aria-invalid={!giftValid || undefined}
                        />
                        <FieldDescription>Between 1 and {gift.customMax}.</FieldDescription>
                      </Field>
                    ) : null}
                    <SelectField
                      id="support-recipient"
                      label="Recipient"
                      value={recipient}
                      options={recipients}
                      onValueChange={setRecipient}
                    />
                    <KeyValueList
                      rows={[
                        {
                          term: giftValid ? `${giftQuantity} × ${gift.tier}` : gift.tier,
                          value: giftValid ? (
                            <MoneyAmount value={{ cents: giftCents, currency: "USD" }} locale="en-US" />
                          ) : (
                            "—"
                          ),
                        },
                      ]}
                    />
                  </FieldGroup>
                ),
              },
              {
                id: "tip",
                label: "Tip",
                content: (
                  <FieldGroup>
                    <AmountField
                      label="Custom amount"
                      currency="USD"
                      value={tipCents}
                      onValueChange={setTipCents}
                      presets={tipPresetCents.map((value) => ({ value, label: usd(value) }))}
                      min={100}
                      rangeError="Tips start at $1.00."
                    />
                    <Field>
                      <FieldLabel htmlFor="support-message">Message (shown on stream)</FieldLabel>
                      <Textarea id="support-message" placeholder="Say something nice" />
                      <FieldDescription>
                        Messages go through the channel’s chat filters before the alert plays.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                ),
              },
            ]}
          />
          <Collapsible defaultOpen className="flex flex-col gap-3">
            <CollapsibleTrigger render={<Button variant="outline" className="w-full justify-between" />}>
              <span className="flex items-center gap-2">
                <HugeiconsIcon icon={PiggyBankIcon} aria-hidden="true" />
                Where your money goes
              </span>
              <span className="flex items-center gap-2">
                per {usd(500)}
                <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden="true" />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3">
              <BreakdownBar
                label="Where your money goes"
                segments={split}
                formatValue={usd}
                formatLabel={(segments, shares) =>
                  segments.map((segment, index) => `${segment.label} ${shares[index] ?? 0}%`).join(", ")
                }
              />
              <a href="#transparency">Split set by member vote, proposal #41</a>
            </CollapsibleContent>
          </Collapsible>
          <DialogFooter className="flex-col gap-3 sm:flex-col">
            <SelectField
              id="support-method"
              label="Pay with"
              orientation="horizontal"
              value={method}
              options={paymentMethods}
              onValueChange={setMethod}
            />
            <AccentButton accent={channel.accent} size="lg" className="w-full" disabled={tab === "gift" && !giftValid}>
              {cta}
            </AccentButton>
            <p>{smallPrint}</p>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Default: Story = { render: () => <SupportPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
