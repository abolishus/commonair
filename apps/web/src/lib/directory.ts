// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { loadDirectory } from "../server/directory.ts";

/** Front-page directory, server-rendered and refetched on every navigation to `/`. */
export const getDirectory = createServerFn({ method: "GET" }).handler(() => loadDirectory(getRequestHeader("cookie")));
