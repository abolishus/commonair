// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { loadChannel } from "../server/channel.ts";

/** Channel summary for first render; the page then polls `channels.get` from the browser. */
export const getChannel = createServerFn({ method: "GET" })
  .validator((input: { channel: string }) => ({ channel: String(input.channel).toLowerCase() }))
  .handler(({ data }) => loadChannel(data.channel, getRequestHeader("cookie")));
