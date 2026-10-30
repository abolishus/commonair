// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { useBootstrap } from "../lib/bootstrap.ts";
import { safeHttpUrl } from "../lib/url.ts";
import { DiscordWebhookPanel } from "./discord-webhook/panel.tsx";
import { discordDocsUrl, discordWebhookClient } from "./discord-webhook/shared.ts";

/** The studio dashboard's Discord webhook section (ADR 0028 decision 5): optional, set per channel. */
export function DiscordWebhookSection({ channel }: { channel: string }): React.JSX.Element {
  const { instance } = useBootstrap();
  const client = React.useMemo(() => discordWebhookClient(channel), [channel]);
  const docsUrl = safeHttpUrl(discordDocsUrl(safeHttpUrl(instance.sourceUrl)));
  return <DiscordWebhookPanel client={client} docsUrl={docsUrl} />;
}
