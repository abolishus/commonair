// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live metadata under the title (F9, F12): the category as a link into the directory, tags as
 * links, uptime from the broadcast's `startedAt`, Share (copies the canonical URL, confirms with a
 * toast), "Just started" for a low verified count, and the phone and tablet overflow menu that
 * holds Share and Report below `lg` (overhaul D4.1).
 * Category and tag URLs come from `lib/category-route.ts` (D1-web's), never written here.
 */
import { IconButton, RelativeTime, StatusBadge } from "@commonair/ui";
import { Dialog, DialogContent } from "@commonair/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { toast } from "@commonair/ui/toast";
import { Clock01Icon, Flag01Icon, MoreHorizontalIcon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { categoryLink, tagLink as tagRoute } from "../../lib/category-route.ts";
import { AuthGateDialog } from "../auth-gate/auth-gate-prompt.tsx";
import { reportClient, type ReportClient, type ReportSubject } from "../safety/client.ts";
import { ReportForm } from "../safety/report-dialog.tsx";

/** The category, linking to its directory page. */
export function CategoryLink({ category }: { category: { slug: string; name: string } }): React.JSX.Element {
  return (
    <Link
      data-testid="channel-meta-category"
      data-slug={category.slug}
      {...categoryLink(category.slug)}
      className="min-w-0 truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {category.name}
    </Link>
  );
}

/** The element a tag `Badge` renders as (`ChannelHeader`'s `tagLink`): a link to the directory filtered by it. */
export function tagLink(tag: string): React.ReactElement {
  return <Link data-testid="channel-meta-tag" data-tag={tag} {...tagRoute(tag)} aria-label={tag} />;
}

/**
 * How long the broadcast has been live, as a clock (0:59, 1:00:00, 48:00:00), with the start time
 * in its tooltip. The server render and hydration use `now` (the request time) so they match; it
 * ticks after (`<RelativeTime mode="elapsed">`).
 * It is not a live region: a screen reader reads it when it reaches it, not every second.
 */
export function Uptime({ startedAt, now }: { startedAt: string; now: number }): React.JSX.Element {
  return (
    <span data-testid="channel-meta-uptime" className="inline-flex items-center gap-1 tabular-nums">
      <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden className="size-3.5" />
      <span className="sr-only">{t("channel.meta.uptimeLabel")} </span>
      <RelativeTime mode="elapsed" date={startedAt} now={now} />
    </span>
  );
}

/** Beside `<LiveBadge>` while the verified count is below `JUST_STARTED_BELOW` (the count is not shown). */
export function JustStartedBadge(): React.JSX.Element {
  return (
    <StatusBadge data-testid="channel-just-started" tone="neutral">
      {t("channel.meta.justStarted")}
    </StatusBadge>
  );
}

export interface Clipboard {
  writeText(text: string): Promise<void>;
}

const browserClipboard = (): Clipboard | null =>
  typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null;

/** Copies `url` and confirms with a toast (or says it could not). */
export async function shareUrl(url: string, clipboard: Clipboard | null): Promise<void> {
  try {
    if (!clipboard) throw new Error("no clipboard");
    await clipboard.writeText(url);
    toast.success(t("channel.meta.shareCopied"));
  } catch {
    toast.error(t("channel.meta.shareFailed"));
  }
}

/** Copies the channel's canonical URL and confirms with a toast (or says it could not). */
export function ShareButton({
  url,
  clipboard = browserClipboard(),
}: {
  url: string;
  clipboard?: Clipboard | null;
}): React.JSX.Element {
  const share = () => shareUrl(url, clipboard);
  return (
    <IconButton
      data-testid="channel-share"
      data-url={url}
      variant="outline"
      size="icon-sm"
      icon={Share08Icon}
      label={t("channel.meta.share")}
      onClick={() => void share()}
    />
  );
}

/**
 * Below `lg` (the page passes `lg:hidden`): the "More" menu that holds Share (when `shareUrl` is
 * given) and Report, so the compact row keeps its room for Follow and Support. Signed out, Report
 * opens the sign-in prompt, as the desktop button does.
 */
export function ChannelOverflowMenu({
  signedIn,
  subjectType,
  subjectId,
  client,
  className,
  shareUrl: url,
  clipboard = browserClipboard(),
}: {
  signedIn: boolean;
  subjectType: ReportSubject;
  subjectId: string;
  client?: ReportClient;
  className?: string;
  /** The channel's canonical URL: adds Share to the menu. */
  shareUrl?: string;
  clipboard?: Clipboard | null;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [reports] = React.useState(() => client ?? reportClient());
  // The menu item that opened the dialog is gone once it closes; focus goes back to "More".
  const trigger = React.useRef<HTMLButtonElement>(null);
  const content = (
    <>
      <HugeiconsIcon icon={Flag01Icon} strokeWidth={2} aria-hidden />
      {t("safety.report.open")}
    </>
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              ref={trigger}
              data-testid="channel-overflow"
              variant="outline"
              size="icon-sm"
              icon={MoreHorizontalIcon}
              label={t("channel.meta.more")}
              className={className}
            />
          }
        />
        <DropdownMenuContent align="end">
          {url === undefined ? null : (
            <DropdownMenuItem
              data-testid="channel-overflow-share"
              data-url={url}
              onClick={() => void shareUrl(url, clipboard)}
            >
              <HugeiconsIcon icon={Share08Icon} strokeWidth={2} aria-hidden />
              {t("channel.meta.share")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid="channel-overflow-report" onClick={() => setOpen(true)}>
            {content}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Signed out, Report opens the sign-in prompt (`intent=report`) as a dialog: the menu item
          it would anchor to is gone once the menu closes. */}
      {signedIn ? null : <AuthGateDialog intent="report" open={open} onOpenChange={setOpen} finalFocus={trigger} />}
      {signedIn ? (
        <Dialog open={open} onOpenChange={setOpen}>
          {open && (
            <DialogContent
              data-testid="report-dialog"
              data-subject-type={subjectType}
              data-subject-id={subjectId}
              finalFocus={trigger}
              className="max-h-svh overflow-y-auto sm:max-w-lg"
            >
              <ReportForm
                onSubmit={async (reason, details) => {
                  await reports.report({ subjectType, subjectId, reason, details });
                  setOpen(false);
                }}
              />
            </DialogContent>
          )}
        </Dialog>
      ) : null}
    </>
  );
}
