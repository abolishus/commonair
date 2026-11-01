// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The panel paste-in helper on `/import` (ADR 0031 decision 6 as replaced at acceptance): Twitch
 * has no panels endpoint, so the streamer pastes their panels' text; `panelPaste` (from
 * `@commonair/twitch`, the same code everywhere) turns it into panels live, and saving replaces the
 * channel's panels through `channels.setPanels`, behind a confirmation. Images are not pasted: they
 * are added as any panel image is.
 */
import { ConfirmDialog } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Textarea } from "@commonair/ui/components/textarea";
import { toast } from "@commonair/ui/toast";
import { PANEL_LIMITS, panelPasteDetails, type PastedPanel } from "@commonair/twitch";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";

export interface PanelsPasteViewProps {
  text: string;
  saving: boolean;
  onText: (text: string) => void;
  onSave: (panels: PastedPanel[]) => Promise<void>;
}

export function PanelsPasteView(props: PanelsPasteViewProps): React.JSX.Element {
  const inputId = React.useId();
  const hintId = React.useId();
  const parsed = React.useMemo(() => panelPasteDetails(props.text), [props.text]);
  const count = parsed.panels.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("twitchImport.panels.title")}</CardTitle>
        <CardDescription>{t("twitchImport.panels.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={inputId}>{t("twitchImport.panels.label")}</FieldLabel>
          <Textarea
            id={inputId}
            data-testid="import-panels-paste"
            rows={8}
            value={props.text}
            aria-describedby={hintId}
            onChange={(e) => props.onText(e.currentTarget.value)}
          />
          <FieldDescription id={hintId}>{t("twitchImport.panels.hint")}</FieldDescription>
        </Field>
        <section
          data-testid="import-panels-preview"
          data-count={count}
          className="flex min-w-0 flex-col gap-3"
          aria-label={t("twitchImport.panels.previewLabel")}
          aria-live="polite"
        >
          <p className="text-sm text-muted-foreground">{t("twitchImport.panels.count", { count })}</p>
          {(parsed.dropped > 0 || parsed.truncated) && (
            <AlertCallout
              tone="warning"
              description={t("twitchImport.panels.capped", { max: PANEL_LIMITS.maxPanels, dropped: parsed.dropped })}
            />
          )}
          {count > 0 && (
            <ol className="flex min-w-0 flex-col gap-3">
              {parsed.panels.map((p, i) => (
                <li
                  // Panels have no identity until saved; the position is it.
                  key={i}
                  className="flex min-w-0 flex-col gap-1 rounded-md border p-3"
                >
                  <span className="min-w-0 break-words text-sm font-medium">
                    {p.title || t("twitchImport.panels.untitled")}
                  </span>
                  {p.body && <span className="min-w-0 whitespace-pre-line break-words text-sm">{p.body}</span>}
                  {p.linkUrl && (
                    <span className="min-w-0 break-all text-xs text-muted-foreground">
                      {t("twitchImport.panels.link", { url: p.linkUrl })}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
        <div>
          <ConfirmDialog
            trigger={
              <Button
                data-testid="import-panels-save"
                disabled={count === 0 || props.saving}
                aria-busy={props.saving || undefined}
              >
                {t("twitchImport.panels.save")}
              </Button>
            }
            title={t("twitchImport.panels.confirmTitle")}
            description={t("twitchImport.panels.confirmBody", { count })}
            confirmLabel={t("twitchImport.panels.save")}
            contentProps={{ "data-testid": "import-panels-confirm" }}
            onConfirm={() => props.onSave(parsed.panels)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export interface PanelsClient {
  save: (input: { channel: string; panels: PastedPanel[] }) => Promise<unknown>;
}

export const panelsClient = (): PanelsClient => ({
  save: (input) => api().channels.setPanels(input),
});

export function PanelsPaste({ channel, client: given }: { channel: string; client?: PanelsClient }): React.JSX.Element {
  const client = React.useMemo(() => given ?? panelsClient(), [given]);
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  return (
    <PanelsPasteView
      text={text}
      saving={saving}
      onText={setText}
      onSave={async (panels) => {
        setSaving(true);
        try {
          await client.save({ channel, panels });
          toast.success(t("twitchImport.panels.saved"));
          setText("");
        } catch (err) {
          toastActionError(err, t("twitchImport.panels.saveFailed"));
        } finally {
          setSaving(false);
        }
      }}
    />
  );
}
