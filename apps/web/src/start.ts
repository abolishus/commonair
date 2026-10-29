// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * TanStack Start instance: request middleware for every request the Start handler serves.
 * Declaring an instance replaces Start's default middleware list, so the CSRF check on server
 * functions that Start adds by default is listed here explicitly.
 */
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { withRequestLocale } from "./i18n/server.ts";
import { localeDeps } from "./server/bootstrap.ts";

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

/** Negotiate the visitor's locale once and render the whole request in it (ADR 0029). */
const locale = createMiddleware({ type: "request" }).server(({ request, handlerType, next }) =>
  withRequestLocale(request, handlerType, localeDeps(), () => next()),
);

export const startInstance = createStart(() => ({ requestMiddleware: [csrf, locale] }));
