// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { AccentButton, ChannelAvatar, IconButton, MoneyAmount, formatMoney } from "@commonair/ui";
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
import { Textarea } from "@commonair/ui/components/textarea";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { BreakdownBar, KeyValueList } from "@commonair/ui/blocks/data";
import { AmountField, ChoiceToggle, OptionGroup } from "@commonair/ui/blocks/forms";
import { ChannelHeader, ChatPanel, PlayerChrome } from "@commonair/ui/blocks/media";
import {
  channel,
  gift,
  giftPresets,
  instructions,
  reasons,
  recipients,
  split,
  tiers,
  tip as tipDefaults,
  tipPresetCents,
  type SupportTab,
} from "./fixtures/Support.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Channel/Support", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number): string => formatMoney(cents, "USD", "en-US");

/** Integer split of a total: the co-op's share rounds down, the creator gets the remainder. */
function splitCents(total: number): { creator: number; coop: number } {
  const coop = Math.floor((total * split.coopPercent) / 100);
  return { creator: total - coop, coop };
}

interface SupportBoardProps {
  /** The tiers the channel has set up; none disables sub and gift, as on a new channel. */
  hasTiers?: boolean;
  /** Show the manual adapter's result: the reference and the co-op's instructions. */
  step?: "form" | "instructions";
}

/** The dialog as it ships on the manual adapter: no card picker, no processing segment. */
function SupportForm({ hasTiers = true }: { hasTiers?: boolean }): React.JSX.Element {
  const [tab, setTab] = React.useState<SupportTab>(hasTiers ? "sub" : "tip");
  const [tier, setTier] = React.useState("1");
  const [recipient, setRecipient] = React.useState("random");
  const [giftCount, setGiftCount] = React.useState(gift.defaultCount);
  const [tipCents, setTipCents] = React.useState(tipDefaults.cents);
  const [message, setMessage] = React.useState("");
  const tierCents = tiers.find((option) => option.value === tier)?.cents ?? 0;
  const count = Number.parseInt(giftCount, 10);
  const giftValid = Number.isSafeInteger(count) && count >= 1 && count <= gift.maxCount;
  const total = tab === "sub" ? tierCents : tab === "gift" ? (giftValid ? count * tierCents : null) : tipCents;
  const parts = splitCents(total ?? 0);
  const cta =
    total === null
      ? "Check the details above"
      : tab === "sub"
        ? `Subscribe for ${usd(total)} / month`
        : tab === "gift"
          ? count === 1
            ? `Gift 1 sub for ${usd(total)}`
            : `Gift ${count} subs for ${usd(total)}`
          : `Send a ${usd(total)} tip`;
  const tierGroup = (
    <OptionGroup
      aria-label="Tier"
      value={tier}
      onValueChange={setTier}
      items={tiers.map((option) => ({
        value: option.value,
        title: option.title,
        description: option.perks,
        price: { cents: option.cents, currency: "USD" },
        trailing: <span className="shrink-0 text-muted-foreground">per month</span>,
      }))}
    />
  );
  return (
    <form className="flex min-w-0 flex-col gap-4" noValidate onSubmit={(event) => event.preventDefault()}>
      <PageTabs
        aria-label="Ways to support"
        variant="default"
        fullWidth
        value={tab}
        onValueChange={(next) => setTab(next as SupportTab)}
        afterList={
          hasTiers ? null : (
            <p id="support-reason" className="pt-2 text-muted-foreground">
              {reasons.noTiers}
            </p>
          )
        }
        items={[
          {
            id: "sub",
            label: "Subscribe",
            disabled: !hasTiers,
            "aria-describedby": hasTiers ? undefined : "support-reason",
            content: <div className="pt-2">{tierGroup}</div>,
          },
          {
            id: "gift",
            label: "Gift subs",
            disabled: !hasTiers,
            "aria-describedby": hasTiers ? undefined : "support-reason",
            content: (
              <div className="flex flex-col gap-4 pt-2">
                {tierGroup}
                <FieldGroup>
                  <ChoiceToggle
                    label="Recipient"
                    value={recipient}
                    onValueChange={setRecipient}
                    options={recipients}
                    wrap
                  />
                  {recipient === "random" ? (
                    <>
                      <ChoiceToggle
                        label="How many?"
                        value={giftCount}
                        onValueChange={setGiftCount}
                        options={giftPresets.map((preset) => ({ value: String(preset), label: preset }))}
                        wrap
                      />
                      <Field data-invalid={giftValid ? undefined : true}>
                        <FieldLabel htmlFor="support-gift-count">Number of subs</FieldLabel>
                        <Input
                          id="support-gift-count"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={gift.maxCount}
                          value={giftCount}
                          aria-invalid={giftValid ? undefined : true}
                          onChange={(event) => setGiftCount(event.currentTarget.value)}
                        />
                        <FieldDescription>
                          {giftValid
                            ? `Between 1 and ${gift.maxCount}.`
                            : `Choose between 1 and ${gift.maxCount} subs.`}
                        </FieldDescription>
                      </Field>
                      <FieldDescription>{gift.randomHint}</FieldDescription>
                    </>
                  ) : (
                    <Field>
                      <FieldLabel htmlFor="support-gift-to">Username</FieldLabel>
                      <Input id="support-gift-to" autoComplete="off" autoCapitalize="none" spellCheck={false} />
                      <FieldDescription>One sub goes to this viewer.</FieldDescription>
                    </Field>
                  )}
                </FieldGroup>
              </div>
            ),
          },
          {
            id: "tip",
            label: "Tip",
            content: (
              <div className="pt-2">
                <FieldGroup>
                  <AmountField
                    label="Tip amount"
                    currency="USD"
                    locale="en-US"
                    value={tipCents}
                    onValueChange={setTipCents}
                    presets={tipPresetCents.map((value) => ({ value, label: usd(value) }))}
                    min={tipDefaults.minCents}
                    max={tipDefaults.maxCents}
                    rangeError={`Tips are between ${usd(tipDefaults.minCents)} and ${usd(tipDefaults.maxCents)}.`}
                  />
                  <Field>
                    <FieldLabel htmlFor="support-message">Message (optional)</FieldLabel>
                    <Textarea
                      id="support-message"
                      maxLength={tipDefaults.messageMaxLength}
                      value={message}
                      onChange={(event) => setMessage(event.currentTarget.value)}
                    />
                    <FieldDescription>
                      {message.length} / {tipDefaults.messageMaxLength}
                    </FieldDescription>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox id="support-anonymous" />
                    <FieldLabel htmlFor="support-anonymous">Hide my name on this tip</FieldLabel>
                  </Field>
                </FieldGroup>
              </div>
            ),
          },
        ]}
      />
      <BreakdownBar
        label="Where your money goes"
        segments={[
          { id: "creator", label: "Creator", value: parts.creator, color: "--chart-1" },
          { id: "coop", label: "Co-op", value: parts.coop, color: "--chart-2" },
        ]}
        formatValue={usd}
        formatLabel={() => `${split.creatorPercent}% to the creator, ${split.coopPercent}% to the co-op`}
        legendLayout="inline"
      />
      <KeyValueList
        rows={[
          {
            term: "Total",
            value: total === null ? null : <MoneyAmount value={{ cents: total, currency: "USD" }} locale="en-US" />,
          },
        ]}
      />
      <DialogFooter className="sm:flex-col">
        <AccentButton type="submit" size="lg" className="w-full" disabled={total === null}>
          {cta}
        </AccentButton>
      </DialogFooter>
    </form>
  );
}

/** Manual adapter result: the CA-… reference to quote, the amount and the co-op's instructions. */
function SupportInstructions(): React.JSX.Element {
  return (
    <section aria-labelledby="support-instructions-title" className="flex min-w-0 flex-col gap-4">
      <h3 id="support-instructions-title" className="text-sm font-semibold">
        Pay to complete
      </h3>
      <KeyValueList
        rows={[
          {
            term: "Payment reference",
            value: (
              <span className="flex items-center gap-1">
                <span className="font-semibold tabular-nums select-all">{instructions.reference}</span>
                <IconButton icon={Copy01Icon} label="Copy reference" tooltip="Copy reference" size="icon-sm" />
              </span>
            ),
          },
          {
            term: "Amount",
            value: <MoneyAmount value={instructions.amount} locale="en-US" />,
          },
        ]}
      />
      <p className="break-words whitespace-pre-line">{instructions.text}</p>
      <p className="text-muted-foreground">{instructions.hint}</p>
      <DialogFooter>
        <Button>Done</Button>
      </DialogFooter>
    </section>
  );
}

function SupportPage({ hasTiers = true, step = "form" }: SupportBoardProps): React.JSX.Element {
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
        {/* The dialog portals out of the page, so it carries the channel accent itself. */}
        <DialogContent className="max-h-svh overflow-y-auto sm:max-w-lg" data-accent={channel.accent}>
          <DialogHeader className="flex-row items-start gap-3">
            <ChannelAvatar name={channel.name} accent={channel.accent} size="md" decorative />
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle>Support {channel.name}</DialogTitle>
              <DialogDescription>Every option pays the creator directly through the co-op.</DialogDescription>
            </div>
          </DialogHeader>
          {step === "instructions" ? <SupportInstructions /> : <SupportForm hasTiers={hasTiers} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Default: Story = { render: () => <SupportPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
/** After checkout on the manual adapter: the reference panel replaces the form. */
export const Instructions: Story = { render: () => <SupportPage step="instructions" /> };
export const InstructionsMobile320: Story = { ...Instructions, ...mobile320 };
/** A channel without tiers: sub and gift are disabled, the reason describes them, the dialog opens on Tip. */
export const NoTiers: Story = { render: () => <SupportPage hasTiers={false} /> };
