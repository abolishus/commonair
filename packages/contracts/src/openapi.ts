// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract } from "./api/router.ts";

/** Generate the public OpenAPI 3.1 document from the contract. */
export async function generateOpenApi(opts: { title: string; version: string; serverUrl: string; sourceUrl: string }) {
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
  return generator.generate(contract, {
    info: {
      title: `${opts.title} API`,
      version: opts.version,
      description:
        "The public API. Authenticate with a session cookie (first-party) or `Authorization: Bearer <token>` (apps and bots). Events: see the EventSub-compatible webhook and WebSocket transports.",
      license: { name: "AGPL-3.0-or-later", identifier: "AGPL-3.0-or-later" },
    },
    servers: [{ url: opts.serverUrl }],
    externalDocs: { url: opts.sourceUrl, description: "Source code" },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "OAuth access token" },
        session: { type: "apiKey", in: "cookie", name: "session_token" },
      },
    },
  });
}
