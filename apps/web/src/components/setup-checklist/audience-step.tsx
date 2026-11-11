// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Bring your audience" (ux-journeys J2-a): the channel link and a follow link (a move link: one
 * tap follows, and each follow through it is counted), both with Copy. Copying either, or "I've
 * shared it", marks the step (`stream.setupMark`), the one step nothing else records.
 */
import { CopyField } from "@commonair/ui/blocks/forms";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { channelUrl } from "../channel/channel-data.ts";
import type { SetupClient } from "./client.ts";

export interface AudienceStepProps {
  channel: string;
  publicUrl: string;
  client: Pick<SetupClient, "mark" | "followLinkConversions" | "createFollowLink">;
  /** The make-a-link button is the screen's one filled CTA while this step is current. */
  primary: boolean;
  /** After the mark is saved (the checklist reloads). */
  onMarked: () => void;
}

export function AudienceStep({ channel, publicUrl, client, primary, onMarked }: AudienceStepProps): React.JSX.Element {
  const [followUrl, setFollowUrl] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [marking, setMarking] = React.useState(false);
  const [conversions, setConversions] = React.useState<number | null>(null);
  const marked = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    client.followLinkConversions(channel).then(
      (n) => {
        if (live) setConversions(n);
      },
      // The count is a nicety; without it the step still works.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [channel, client]);

  // A copy marks the step quietly and leaves it open, so a follow link shown once stays on screen;
  // "I've shared it" marks it and lets the checklist move on.
  const mark = async (explicit: boolean) => {
    if (marked.current && !explicit) return;
    marked.current = true;
    if (explicit) setMarking(true);
    try {
      await client.mark(channel, "bring_your_audience");
      if (explicit) onMarked();
    } catch {
      marked.current = false;
      if (explicit) toast.error(t("d5Dashboard.audience.markFailed"));
    } finally {
      setMarking(false);
    }
  };

  const create = async () => {
    trackUi("studio.checklist", "create", "bring_your_audience");
    setCreating(true);
    try {
      setFollowUrl((await client.createFollowLink(channel)).url);
    } catch {
      toast.error(t("d5Dashboard.audience.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const copyProps = {
    copyLabel: t("d5Dashboard.audience.copy"),
    copiedLabel: t("d5Dashboard.audience.copied"),
    copyFailedLabel: t("d5Dashboard.audience.copyFailed"),
    onCopied: () => void mark(false),
  };
  return (
    <div data-testid="setup-audience" className="flex min-w-0 flex-col gap-4">
      <CopyField
        label={t("d5Dashboard.audience.channelLink")}
        value={channelUrl(publicUrl, channel)}
        data-testid="setup-audience-channel"
        data-value-testid="setup-audience-channel-url"
        data-copy-testid="setup-audience-channel-copy"
        {...copyProps}
      />
      {followUrl ? (
        <CopyField
          label={t("d5Dashboard.audience.followLink")}
          value={followUrl}
          hint={t("d5Dashboard.audience.followOnce")}
          data-testid="setup-audience-follow"
          data-value-testid="setup-audience-follow-url"
          data-copy-testid="setup-audience-follow-copy"
          {...copyProps}
        />
      ) : null}
      {conversions !== null ? (
        <p data-testid="setup-audience-conversions" className="text-xs text-muted-foreground">
          {t("d5Dashboard.audience.follows", { count: conversions })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {followUrl ? null : (
          <Button
            data-testid="setup-audience-create"
            variant={primary ? "brand" : "outline"}
            data-filled-cta={primary ? "" : undefined}
            disabled={creating}
            aria-busy={creating || undefined}
            onClick={() => void create()}
          >
            {t("d5Dashboard.audience.createFollow")}
          </Button>
        )}
        <Button
          data-testid="setup-audience-done"
          variant="outline"
          disabled={marking}
          aria-busy={marking || undefined}
          onClick={() => {
            trackUi("studio.checklist", "confirm", "bring_your_audience");
            void mark(true);
          }}
        >
          {t("d5Dashboard.audience.markDone")}
        </Button>
      </div>
    </div>
  );
}
