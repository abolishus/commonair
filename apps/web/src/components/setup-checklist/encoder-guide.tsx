// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `EncoderGuide` (creator-studio.md P1): numbered steps per encoder, OBS first, tool names only (no
 * logos); the WHIP URL; the recommended settings from `stream.ingest`; and the OBS profile from
 * `stream.obsConfig`, downloaded as a file without leaving the page.
 */
import { formatNumber, useLocale } from "@commonair/ui";
import { CopyField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { toast } from "@commonair/ui/toast";
import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IngestInfo } from "@commonair/contracts/dto";
import * as React from "react";
import type { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { GUIDE_TAB_KEYS } from "./keys.ts";
import { resolutionLabel } from "./model.ts";

export type Ingest = z.infer<typeof IngestInfo>;

const TABS = ["obs", "streamlabs", "larix", "whip"] as const;
type GuideTab = (typeof TABS)[number];

const STEPS: Record<Exclude<GuideTab, "whip">, readonly MessageKey[]> = {
  obs: ["d5Dashboard.guide.obs.1", "d5Dashboard.guide.obs.2", "d5Dashboard.guide.obs.3"],
  streamlabs: ["d5Dashboard.guide.streamlabs.1", "d5Dashboard.guide.streamlabs.2"],
  larix: ["d5Dashboard.guide.larix.1", "d5Dashboard.guide.larix.2"],
};

/** Hands the browser the OBS service file (JSON, no byte-order mark: OBS parses it strictly). */
export function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface EncoderGuideProps {
  ingest: Ingest;
  /** `stream.obsConfig`. */
  loadObsConfig: () => Promise<{ filename: string; json: string }>;
  /** For tests. */
  download?: (filename: string, json: string) => void;
}

export function EncoderGuide({ ingest, loadObsConfig, download = downloadJson }: EncoderGuideProps): React.JSX.Element {
  const { locale } = useLocale();
  const [busy, setBusy] = React.useState(false);
  const rec = ingest.recommended;
  const fetchProfile = async () => {
    setBusy(true);
    try {
      const file = await loadObsConfig();
      download(file.filename, file.json);
    } catch {
      toast.error(t("d5Dashboard.guide.downloadFailed"));
    } finally {
      setBusy(false);
    }
  };
  const rows: { id: string; term: string; value: string }[] = [
    { id: "video", term: t("d5Dashboard.guide.rec.video"), value: rec.videoCodec },
    {
      id: "resolution",
      term: t("d5Dashboard.guide.rec.resolution"),
      value: t("d5Dashboard.guide.rec.resolutionValue", {
        resolution: resolutionLabel(rec.resolution),
        fps: formatNumber(rec.fps, locale),
      }),
    },
    {
      id: "bitrate",
      term: t("d5Dashboard.guide.rec.bitrate"),
      value: t("d5Dashboard.guide.rec.bitrateValue", {
        kbps: formatNumber(rec.bitrateKbps, locale),
        rateControl: rec.rateControl,
      }),
    },
    {
      id: "keyframe",
      term: t("d5Dashboard.guide.rec.keyframe"),
      value: t("d5Dashboard.guide.rec.keyframeValue", { seconds: formatNumber(rec.keyframeIntervalSeconds, locale) }),
    },
    {
      id: "audio",
      term: t("d5Dashboard.guide.rec.audio"),
      value: t("d5Dashboard.guide.rec.audioValue", {
        codec: rec.audioCodec,
        kbps: formatNumber(rec.audioBitrateKbps, locale),
      }),
    },
  ];
  return (
    <div data-testid="encoder-guide" className="flex min-w-0 flex-col gap-4">
      <Tabs defaultValue="obs">
        <TabsList aria-label={t("d5Dashboard.guide.label")} className="flex-wrap">
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} data-testid={`encoder-guide-tab-${tab}`}>
              {t(GUIDE_TAB_KEYS[tab])}
            </TabsTrigger>
          ))}
        </TabsList>
        {(["obs", "streamlabs", "larix"] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="pt-3">
            <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm">
              {STEPS[tab].map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ol>
            {tab === "obs" ? (
              <Button
                data-testid="encoder-guide-obs-profile"
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void fetchProfile()}
              >
                <HugeiconsIcon icon={Download01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                {t("d5Dashboard.guide.download")}
              </Button>
            ) : null}
          </TabsContent>
        ))}
        <TabsContent value="whip" className="pt-3">
          <CopyField
            label={t("d5Dashboard.guide.whip.url")}
            value={ingest.whipUrl}
            copyLabel={t("d5Dashboard.key.copy")}
            copiedLabel={t("d5Dashboard.key.copied")}
            copyFailedLabel={t("d5Dashboard.key.copyFailed")}
            hint={t("d5Dashboard.guide.whip.hint")}
            data-testid="encoder-guide-whip"
            data-value-testid="encoder-guide-whip-url"
          />
        </TabsContent>
      </Tabs>
      <div>
        <h4 className="mb-2 text-sm font-medium">{t("d5Dashboard.guide.recommended")}</h4>
        <dl data-testid="encoder-guide-recommended" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {rows.map((row) => (
            <div key={row.id} className="min-w-0" data-rec={row.id}>
              <dt className="text-xs text-muted-foreground">{row.term}</dt>
              <dd className="text-sm font-medium tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("d5Dashboard.guide.slowUpload", {
            upload: formatNumber(8, locale),
            kbps60: formatNumber(4500, locale),
            kbps30: formatNumber(3000, locale),
          })}
        </p>
      </div>
    </div>
  );
}
