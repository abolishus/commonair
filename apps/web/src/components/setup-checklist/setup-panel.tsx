// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What an encoder needs, inline in the checklist: the server URL, the stream key (created here,
 * shown once, masked until Reveal; Copy copies it either way), and the `EncoderGuide`. Shown in the
 * key step, and again in the encoder step, where the key just created stays visible.
 */
import { SkeletonText } from "@commonair/ui";
import { CopyField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { RetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { EncoderGuide, type Ingest } from "./encoder-guide.tsx";

export interface SetupPanelProps {
  /** `stream.ingest`; null data reads as still loading. */
  ingest: RetryingLoad<Ingest | null>;
  /** The key `stream.rotateKey` just returned; null until one is created on this page. */
  newKey: string | null;
  /** Offer "Create stream key" (no active key yet). */
  canCreate: boolean;
  creating: boolean;
  onCreate: () => void;
  /** The create button is the screen's one filled CTA while the key step is current. */
  primary: boolean;
  loadObsConfig: () => Promise<{ filename: string; json: string }>;
  download?: (filename: string, json: string) => void;
}

export function SetupPanel({
  ingest,
  newKey,
  canCreate,
  creating,
  onCreate,
  primary,
  loadObsConfig,
  download,
}: SetupPanelProps): React.JSX.Element {
  if (!ingest.data) {
    return ingest.state === "failed" ? (
      <SectionLoadError
        section={t("d5Dashboard.guide.section")}
        load={ingest}
        headingLevel={4}
        data-testid="setup-panel-error"
        retryTestId="setup-panel-retry"
      />
    ) : (
      <div aria-busy="true" aria-label={t("d5Dashboard.guide.loading")}>
        <SkeletonText lines={3} />
      </div>
    );
  }
  return (
    <div data-testid="setup-panel" className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <CopyField
          label={t("d5Dashboard.key.serverUrl")}
          value={ingest.data.rtmpUrl}
          copyLabel={t("d5Dashboard.key.copy")}
          copiedLabel={t("d5Dashboard.key.copied")}
          copyFailedLabel={t("d5Dashboard.key.copyFailed")}
          data-testid="setup-server-url"
          data-value-testid="setup-server-url-value"
          data-copy-testid="setup-server-url-copy"
        />
        {newKey ? (
          <CopyField
            label={t("d5Dashboard.key.label")}
            value={newKey}
            secret
            showLabel={t("d5Dashboard.key.reveal")}
            hideLabel={t("d5Dashboard.key.hide")}
            copyLabel={t("d5Dashboard.key.copy")}
            copiedLabel={t("d5Dashboard.key.copied")}
            copyFailedLabel={t("d5Dashboard.key.copyFailed")}
            hint={t("d5Dashboard.key.once")}
            data-testid="setup-stream-key"
            data-value-testid="setup-stream-key-value"
            data-copy-testid="setup-stream-key-copy"
            data-reveal-testid="setup-stream-key-reveal"
          />
        ) : canCreate ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t("d5Dashboard.key.label")}</span>
            <div>
              <Button
                data-testid="setup-create-key"
                variant={primary ? "brand" : "outline"}
                data-filled-cta={primary ? "" : undefined}
                disabled={creating}
                aria-busy={creating || undefined}
                onClick={onCreate}
              >
                <HugeiconsIcon icon={Key01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                {t("d5Dashboard.step.stream_key.create")}
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">{t("d5Dashboard.key.once")}</span>
          </div>
        ) : null}
      </div>
      <EncoderGuide ingest={ingest.data} loadObsConfig={loadObsConfig} download={download} />
    </div>
  );
}
