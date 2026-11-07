// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The not-found and error states (F13): a title, a sentence that explains, and a way forward.
 * Every one has a primary "Browse live channels" action (`empty-state-action`), or the caller's
 * own (for example "Back to <channel>" for a missing VOD). Errors never show a message or a stack:
 * the visitor gets the same calm page whatever broke.
 */
import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { AppShell, PageContainer } from "@commonair/ui/layouts";
import { Alert02Icon, FileNotFoundIcon, Tv01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Link, useRouter } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import { BROWSE_LIVE_ROUTE } from "../lib/browse-route.ts";
import { PageLoadError, isBusyPageError } from "../lib/page-load-error.tsx";
import { AppFooter, AppHeader } from "./site-chrome.tsx";

/** "Browse live channels": the primary way out of a dead end (`empty-state-action`). */
export function BrowseLiveButton(): React.JSX.Element {
  return (
    <Button data-testid="empty-state-action" nativeButton={false} render={<Link to={BROWSE_LIVE_ROUTE} />}>
      {t("polish.browseLive")}
    </Button>
  );
}

export interface NotFoundStateProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: IconSvgElement;
  /** Replaces "Browse live channels" (e.g. "Back to <channel>"); give it `data-testid="empty-state-action"`. */
  action?: React.ReactNode;
  /** Shown after the primary action. */
  secondaryAction?: React.ReactNode;
  "data-testid"?: string;
}

/** A page, channel or item that does not exist (or that the visitor may not see). */
export function NotFoundState({
  title = t("polish.notFound.title"),
  description = t("polish.notFound.description"),
  icon = FileNotFoundIcon,
  action = <BrowseLiveButton />,
  secondaryAction,
  "data-testid": testId = "not-found-state",
}: NotFoundStateProps): React.JSX.Element {
  return (
    <PageContainer width="narrow" className="py-16">
      <EmptyState
        data-testid={testId}
        icon={icon}
        title={title}
        description={description}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {action}
            {secondaryAction}
          </div>
        }
      />
    </PageContainer>
  );
}

/** An unknown channel: for `$channel.tsx`'s `notFoundComponent` (D2-channel adopts it). */
export function ChannelNotFoundState(): React.JSX.Element {
  return (
    <NotFoundState
      data-testid="channel-not-found"
      icon={Tv01Icon}
      title={t("channel.notFound")}
      description={t("polish.channelNotFound.description")}
    />
  );
}

export interface ErrorStateProps {
  /** The error the boundary caught: only used to tell a busy API from anything else. */
  error?: unknown;
  /** The error boundary's `reset`; "Try again" reloads the route's data, then resets. */
  reset?: () => void;
}

/**
 * An error boundary's page: never the error's message or stack. A busy or unreachable API (a
 * guard's `SessionUnavailableError`, a loader's 429 or 503) gets `PageLoadError` instead, which
 * retries by itself (F1, F2).
 */
export function ErrorState({ error, reset }: ErrorStateProps): React.JSX.Element {
  if (isBusyPageError(error)) return <PageLoadError error={error} reset={reset} />;
  return <GenericErrorState reset={reset} />;
}

function GenericErrorState({ reset }: { reset?: () => void }): React.JSX.Element {
  const router = useRouter();
  return (
    <NotFoundState
      data-testid="error-state"
      icon={Alert02Icon}
      title={t("polish.error.title")}
      description={t("polish.error.description")}
      secondaryAction={
        <Button
          variant="outline"
          data-testid="error-state-retry"
          onClick={() => {
            void router.invalidate().finally(() => reset?.());
          }}
        >
          {t("polish.error.retry")}
        </Button>
      }
    />
  );
}

/**
 * A layout route's not-found or error page. When the router renders it in place of the layout (the
 * layout's own guard or loader failed, or its error boundary caught), it brings the public site
 * chrome; inside the layout's outlet it is the bare state.
 */
export function ShellFallback({ wrap, children }: { wrap: boolean; children: React.ReactNode }): React.JSX.Element {
  if (!wrap) return <>{children}</>;
  return (
    <AppShell header={<AppHeader />} footer={<AppFooter />} skipLabel={t("nav.skipToContent")}>
      {children}
    </AppShell>
  );
}
