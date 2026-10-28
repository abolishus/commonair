// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The P2P indicator, first-run notice, dialog and settings section (ADR 0005 amendment 1,
 * decisions 3 and 4; test ids in docs/testing/p1-selectors.md). The disclosure ("Sharing with
 * other viewers shows them your IP address") always sits next to every switch that turns P2P on.
 */
import { IconButton, formatBytes, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@commonair/ui/components/dialog";
import { Label } from "@commonair/ui/components/label";
import { Switch } from "@commonair/ui/components/switch";
import { Cancel01Icon, PeerToPeer01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { LegalDocumentLink, type LegalDoc } from "../../components/legal-document-link.tsx";
import { t } from "../../i18n/index.ts";
import type { P2PStatus } from "../controller.ts";
import type { P2PDefault } from "./policy.ts";
import { setP2PPreference } from "./preference.ts";
import { p2pSwitchOn, useMounted, useOperatorP2PDefault, useP2PPrefs } from "./use-p2p.ts";

/** The switch's state on this device; `false` until mounted (the server cannot know). */
function useSwitchOn(operatorDefault: P2PDefault): boolean {
  const prefs = useP2PPrefs();
  const mounted = useMounted();
  return mounted && p2pSwitchOn(prefs, operatorDefault);
}

function indicatorLabel(status: P2PStatus, locale: string): string {
  if (status.state === "off") return t("p2p.indicator.off");
  if (status.state === "on") return t("p2p.indicator.on");
  const bytes = formatBytes(status.uploadedBytes, locale);
  return status.peers === 1
    ? t("p2p.indicator.sharingOne", { bytes })
    : t("p2p.indicator.sharing", { peers: status.peers, bytes });
}

/** Player control: P2P state at a glance (peers, bytes shared), opens the dialog. */
export function P2PIndicator({ status, onOpen }: { status: P2PStatus; onOpen: () => void }): React.JSX.Element {
  const { locale } = useLocale();
  const label = indicatorLabel(status, locale);
  return (
    <IconButton
      data-testid="player-p2p"
      data-p2p={status.state}
      label={label}
      icon={PeerToPeer01Icon}
      onClick={onOpen}
      className={status.state === "off" ? "text-overlay-foreground opacity-70" : "text-overlay-foreground"}
    />
  );
}

/**
 * First-run notice (operator default `on`, no choice yet): one line with the disclosure and the
 * off switch. `onShown` fires once it is on screen; P2P waits for that.
 */
export function P2PNotice({
  onShown,
  onDismiss,
  onTurnOff,
}: {
  onShown: () => void;
  onDismiss: () => void;
  onTurnOff: () => void;
}): React.JSX.Element {
  const shown = React.useRef(onShown);
  React.useEffect(() => {
    shown.current();
  }, []);
  return (
    <aside
      data-testid="player-p2p-notice"
      aria-label={t("p2p.dialog.title")}
      className="absolute inset-x-2 top-10 z-30 flex flex-wrap items-center gap-2 rounded-md bg-overlay/90 px-2 py-1 text-xs text-overlay-foreground"
    >
      <p className="min-w-0 flex-1">
        {t("p2p.notice.text")} {t("p2p.disclosure")}
      </p>
      <Button size="sm" variant="secondary" onClick={onTurnOff}>
        {t("p2p.notice.turnOff")}
      </Button>
      <IconButton
        label={t("p2p.notice.dismiss")}
        icon={Cancel01Icon}
        size="icon-sm"
        className="text-overlay-foreground"
        onClick={onDismiss}
      />
    </aside>
  );
}

/** The instance's privacy policy, read in a dialog; loaded when needed, nothing if there is none. */
function PrivacyPolicyLink({ load }: { load?: () => Promise<LegalDoc | null> }): React.JSX.Element | null {
  const [doc, setDoc] = React.useState<LegalDoc | null>(null);
  React.useEffect(() => {
    if (!load) return;
    let live = true;
    load()
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [load]);
  if (!doc) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t("p2p.dialog.privacyPolicy")} <LegalDocumentLink doc={doc} />
    </p>
  );
}

/** The switch with the disclosure right next to it (dialog and settings share it). */
function P2PSwitchRow({
  testId,
  checked,
  onCheckedChange,
}: {
  testId: "player-p2p-toggle" | "privacy-p2p-toggle";
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
}): React.JSX.Element {
  const id = React.useId();
  const hint = `${id}-hint`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{t("p2p.dialog.switch")}</Label>
        <p id={hint} className="text-xs text-muted-foreground">
          {t("p2p.disclosure")}
        </p>
      </div>
      {testId === "player-p2p-toggle" ? (
        <Switch
          id={id}
          data-testid="player-p2p-toggle"
          aria-describedby={hint}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      ) : (
        <Switch
          id={id}
          data-testid="privacy-p2p-toggle"
          aria-describedby={hint}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      )}
    </div>
  );
}

export interface P2PDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: P2PStatus;
  /** Loads the privacy policy document (the player passes the API's). */
  loadPrivacyPolicy?: () => Promise<LegalDoc | null>;
}

/**
 * What P2P does, the disclosure, and the switch. Off persists `off` and the player stops the
 * loader at once; on persists `on` and applies from the next playback start (never a silent
 * restart of this session).
 */
export function P2PDialog({ open, onOpenChange, status, loadPrivacyPolicy }: P2PDialogProps): React.JSX.Element {
  const operatorDefault = useOperatorP2PDefault();
  const checked = useSwitchOn(operatorDefault);
  const { locale } = useLocale();
  const running = status.state !== "off";
  const note = checked
    ? running
      ? status.peers === 1
        ? t("p2p.dialog.activeOne", {
            sent: formatBytes(status.uploadedBytes, locale),
            received: formatBytes(status.receivedBytes, locale),
          })
        : t("p2p.dialog.active", {
            peers: status.peers,
            sent: formatBytes(status.uploadedBytes, locale),
            received: formatBytes(status.receivedBytes, locale),
          })
      : t("p2p.dialog.nextStart")
    : running
      ? null
      : status.available
        ? t("p2p.dialog.stopped")
        : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="player-p2p-dialog" data-p2p={status.state} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("p2p.dialog.title")}</DialogTitle>
          <DialogDescription>{t("p2p.dialog.what")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p>{operatorDefault === "on" ? t("p2p.dialog.defaultOn") : t("p2p.dialog.default")}</p>
          <p>{t("p2p.dialog.gated")}</p>
          <P2PSwitchRow
            testId="player-p2p-toggle"
            checked={checked}
            onCheckedChange={(on) => setP2PPreference(on ? "on" : "off")}
          />
          <p className="text-xs text-muted-foreground">{t("p2p.dialog.perDevice")}</p>
          {note && (
            <output data-testid="player-p2p-dialog-note" className="block text-xs">
              {note}
            </output>
          )}
          {open && <PrivacyPolicyLink load={loadPrivacyPolicy} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** `/settings/privacy`: the same switch and disclosure, per device. */
export function P2PSettingsSection(): React.JSX.Element {
  const operatorDefault = useOperatorP2PDefault();
  const checked = useSwitchOn(operatorDefault);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t("p2p.settings.title")}</CardTitle>
        <CardDescription>{t("p2p.settings.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>{operatorDefault === "on" ? t("p2p.dialog.defaultOn") : t("p2p.dialog.default")}</p>
        <P2PSwitchRow
          testId="privacy-p2p-toggle"
          checked={checked}
          onCheckedChange={(on) => setP2PPreference(on ? "on" : "off")}
        />
        <p className="text-xs text-muted-foreground">{t("p2p.settings.perDevice")}</p>
        <p className="text-xs text-muted-foreground">{t("p2p.settings.nextStart")}</p>
      </CardContent>
    </Card>
  );
}
