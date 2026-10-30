// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `vods.chat` / `clips.chat` (ADR 0012 amendment 1 decision 5): chat replay. HTTP 501 until W1-spine implements them. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const vodChat = os.vods.chat.handler(notImplemented);
export const clipChat = os.clips.chat.handler(notImplemented);
