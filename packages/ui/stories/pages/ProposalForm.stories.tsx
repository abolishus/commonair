// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageContainer } from "@commonair/ui/layouts";
import { Breadcrumbs, PageHeader, Section } from "@commonair/ui/blocks/headers";
import { CharacterCountField, FormSection, SwitchField } from "@commonair/ui/blocks/forms";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { ProposalChangeEditor, type ProposalChangeDraft } from "@commonair/ui/blocks/coop";
import { breadcrumbs, draft, keyOptions, ordinaryChanges, protectedChanges } from "./fixtures/ProposalForm.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/ProposalForm", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const protectedKeys = new Set(keyOptions.filter((option) => option.protected).map((option) => option.value));

function validJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function ProposalFormPage({ initialChanges }: { initialChanges: ProposalChangeDraft[] }): React.JSX.Element {
  const [title, setTitle] = React.useState(draft.title);
  const [body, setBody] = React.useState(draft.body);
  const [affectsCreators, setAffectsCreators] = React.useState(draft.affectsCreators);
  const [changes, setChanges] = React.useState(initialChanges);
  const isProtected = changes.some((change) => protectedKeys.has(change.key));
  const rows = changes.map((change) =>
    change.key && change.value && !validJson(change.value) ? { ...change, error: "Not valid JSON" } : change,
  );
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="narrow" className="flex flex-col gap-6 py-6">
        <PageHeader
          breadcrumbs={<Breadcrumbs label="Breadcrumb" items={breadcrumbs} />}
          title="New proposal"
          description="Drafts are private until you open them for discussion."
        />
        <FormSection
          data-testid="proposal-form"
          title="Proposal"
          onSubmit={(event) => event.preventDefault()}
          actions={{
            saveLabel: "Save draft",
            cancelLabel: "Cancel",
            onCancel: () => undefined,
            saveProps: { "data-testid": "proposal-save" },
          }}
        >
          <CharacterCountField
            label="Title"
            maxLength={200}
            value={title}
            onValueChange={setTitle}
            inputProps={{ "data-testid": "proposal-title" }}
          />
          <CharacterCountField
            label="Proposal"
            hint="What changes, why, and what it costs."
            multiline
            maxLength={20000}
            value={body}
            onValueChange={setBody}
            textareaProps={{ "data-testid": "proposal-body", rows: 8 }}
          />
          <SwitchField
            label="Affects creators"
            description={
              isProtected
                ? "Always on for protected decisions: the creator council reviews it before voting."
                : "The creator council reviews it before voting."
            }
            checked={affectsCreators || isProtected}
            disabled={isProtected}
            onCheckedChange={setAffectsCreators}
            switchProps={{ "data-testid": "proposal-affects-creators" }}
          />
          <Section heading="Setting changes" headingLevel={3}>
            <ProposalChangeEditor
              rows={rows}
              keyOptions={keyOptions}
              labels={{
                key: "Setting",
                keyPlaceholder: "Choose a setting",
                value: "New value (JSON)",
                valueHint: "The whole new value of the setting, as JSON.",
                protected: "Protected setting",
                remove: "Remove change",
                add: "Add a change",
                empty: "No setting changes: an ordinary proposal can be a statement of intent.",
              }}
              kind={{
                kind: isProtected ? "protected" : "ordinary",
                label: isProtected ? "Protected decision" : "Ordinary decision",
                description: isProtected
                  ? "Needs two thirds of members and a majority of the streamer class, with a longer vote."
                  : "Needs a simple majority of members who vote.",
                props: { "data-testid": "proposal-kind" },
              }}
              rowProps={{ "data-testid": "proposal-change" }}
              keyTriggerProps={{ "data-testid": "proposal-change-key" }}
              valueProps={{ "data-testid": "proposal-change-value" }}
              removeProps={{ "data-testid": "proposal-change-remove" }}
              addProps={{ "data-testid": "proposal-change-add" }}
              onAdd={() =>
                setChanges((all) => [...all, { id: `c${all.length + 1}-${Date.now()}`, key: "", value: "" }])
              }
              onRemove={(id) => setChanges((all) => all.filter((change) => change.id !== id))}
              onRowChange={(id, patch) =>
                setChanges((all) => all.map((change) => (change.id === id ? { ...change, ...patch } : change)))
              }
            />
          </Section>
          {isProtected ? (
            <AlertCallout
              tone="warning"
              title="This is a protected decision"
              description="If the streamer class does not pass it, the database refuses the change whoever asks."
            />
          ) : null}
        </FormSection>
      </PageContainer>
    </ViewerPage>
  );
}

/** An ordinary proposal changing one setting. */
export const Default: Story = { render: () => <ProposalFormPage initialChanges={ordinaryChanges} /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** A protected key makes the whole proposal protected; one row still has no key. */
export const ProtectedDraft: Story = { render: () => <ProposalFormPage initialChanges={protectedChanges} /> };

/** No changes yet. */
export const NoChanges: Story = { render: () => <ProposalFormPage initialChanges={[]} /> };
