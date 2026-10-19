// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle01Icon, FingerPrintIcon, Mail01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@commonair/ui/components/item";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { DateOfBirthField, PasswordField } from "@commonair/ui/blocks/forms";
import { benefits, form, tabs } from "./fixtures/SignIn.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Viewer/SignIn", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function SignInPage(): React.JSX.Element {
  const [username, setUsername] = React.useState(form.username);
  const [password, setPassword] = React.useState(form.password);
  const [birthDate, setBirthDate] = React.useState<string | undefined>(undefined);
  const [agreed, setAgreed] = React.useState(false);
  return (
    <ViewerPage>
      <PageContainer className="py-6">
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex max-w-md flex-col gap-6">
              <PageTabs variant="default" items={tabs} />
              <PageHeader
                size="compact"
                title="Create your account"
                description="Watch, chat, follow and stream. Members can join the co-op later."
              />
              <form onSubmit={(event) => event.preventDefault()}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="signup-username">Username</FieldLabel>
                    <Input
                      id="signup-username"
                      autoComplete="username"
                      value={username}
                      onChange={(event) => setUsername(event.currentTarget.value)}
                    />
                    <FieldDescription>{form.usernameHint}</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="signup-email">Email</FieldLabel>
                    <Input id="signup-email" type="email" autoComplete="email" placeholder={form.emailPlaceholder} />
                  </Field>
                  <PasswordField
                    label="Password"
                    value={password}
                    onValueChange={setPassword}
                    showLabel="Show password"
                    hideLabel="Hide password"
                    strength={form.strength}
                    description={form.passwordHint}
                  />
                  <Field>
                    <DateOfBirthField
                      label="Date of birth"
                      value={birthDate}
                      onValueChange={setBirthDate}
                      monthLabel="Month"
                      dayLabel="Day"
                      yearLabel="Year"
                      invalidDateMessage="That date does not exist."
                      years={form.years}
                    />
                    <FieldDescription>{form.dobHint}</FieldDescription>
                  </Field>
                  <Item variant="outline" size="sm">
                    <ItemMedia variant="icon">
                      <HugeiconsIcon icon={CheckmarkCircle01Icon} aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Verified — no tracking, proof-of-work only</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <StatusBadge tone="neutral">ALTCHA</StatusBadge>
                    </ItemActions>
                  </Item>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="signup-terms"
                      checked={agreed}
                      onCheckedChange={(checked) => setAgreed(checked === true)}
                    />
                    <FieldLabel htmlFor="signup-terms">
                      <span>
                        I agree to the <a href="#terms">Terms of Service</a> (v3) and have read the{" "}
                        <a href="#privacy">Privacy Policy</a>.
                      </span>
                    </FieldLabel>
                  </Field>
                  <Button type="submit" size="lg" className="w-full">
                    Create account
                  </Button>
                </FieldGroup>
              </form>
              <FieldSeparator>or</FieldSeparator>
              <div className="flex flex-col gap-2">
                <Button variant="outline" size="lg" className="w-full">
                  <HugeiconsIcon icon={FingerPrintIcon} aria-hidden="true" />
                  Continue with a passkey
                </Button>
                <Button variant="outline" size="lg" className="w-full">
                  <HugeiconsIcon icon={Mail01Icon} aria-hidden="true" />
                  Email me a sign-in link
                </Button>
                <Button variant="ghost" size="lg" className="w-full">
                  Other providers this instance enabled
                </Button>
              </div>
            </div>
          }
          aside={
            <Card>
              <CardHeader>
                <CardTitle>What you get</CardTitle>
                <CardDescription>Same account for viewing and streaming.</CardDescription>
              </CardHeader>
              <CardContent>
                <ItemGroup>
                  {benefits.map((benefit) => (
                    <Item key={benefit} size="xs">
                      <ItemMedia variant="icon">
                        <HugeiconsIcon icon={Tick01Icon} aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{benefit}</ItemTitle>
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              </CardContent>
            </Card>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <SignInPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
