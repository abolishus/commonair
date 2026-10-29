// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which studio a signed-in member gets on `/interact` and `/bot`: their own channel as owner, or
 * another channel (`?channel=`) where they are an editor (owner controls) or a moderator. The API
 * is the authority; this only hides what it would refuse.
 */
import { EmptyState, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { SquareLock02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { studioRole, type StudioRole } from "../../lib/interact-studio.ts";
import { useLoad } from "../money/use-load.ts";
import type { StudioApi } from "./shared.tsx";

export interface StudioMe {
  id: string;
  username: string;
  channelSlug: string | null;
}

/** The caller's own channel slug. */
export const ownChannel = (me: StudioMe): string => me.channelSlug ?? me.username;

/** `role: null`: no studio on this channel (the lookup was refused or listed no role for the caller). */
export async function resolveStudioRole(
  client: StudioApi,
  me: StudioMe,
  channel: string,
): Promise<{ role: StudioRole | null }> {
  if (channel === ownChannel(me)) return { role: "owner" };
  try {
    return { role: studioRole(me, channel, await client.channels.roles.list({ channel })) };
  } catch (err) {
    const code = errorCode(err);
    if (code === "FORBIDDEN" || code === "NOT_FOUND") return { role: null };
    throw err;
  }
}

export function StudioAccess({
  me,
  channel,
  client,
  home,
  loadError,
  children,
}: {
  me: StudioMe;
  channel: string;
  client: StudioApi;
  /** The page itself, for the "go to your own studio" link. */
  home: "/interact" | "/bot";
  /** The page's load error with its retry button. */
  loadError: (retry: () => void) => React.ReactNode;
  children: (role: StudioRole) => React.ReactNode;
}): React.ReactNode {
  const own = channel === ownChannel(me);
  const loaded = useLoad(`studio-role:${me.id}:${channel}`, () => resolveStudioRole(client, me, channel));
  if (own) return children("owner");
  if (loaded.data === null && loaded.failed) return loadError(loaded.reload);
  if (loaded.data === null)
    return (
      <SkeletonGroup label={t("interact.loading")}>
        <SkeletonText lines={6} />
      </SkeletonGroup>
    );
  if (loaded.data.role === null) return <NoStudioAccess channel={channel} home={home} />;
  return children(loaded.data.role);
}

/** Shown when the member has no role on the channel they asked for. */
export function NoStudioAccess({ channel, home }: { channel: string; home: "/interact" | "/bot" }): React.JSX.Element {
  return (
    <EmptyState
      icon={SquareLock02Icon}
      title={t("interact.noAccess", { channel })}
      description={t("interact.noAccessHint")}
      action={
        <Button nativeButton={false} render={<Link to={home} />}>
          {t("interact.ownStudio")}
        </Button>
      }
    />
  );
}
