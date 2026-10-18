// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sample payloads for test events, synthesized from the catalog schema so they
 * always validate and never drift when the catalog changes. Condition values of
 * the subscription are copied in, so a test event matches the subscription.
 */
import { EVENTS, type EventType } from "@commonair/contracts/events";
import type { z } from "zod";

type AnySchema = z.core.$ZodType;
interface Def {
  type: string;
  shape?: Record<string, AnySchema>;
  innerType?: AnySchema;
  element?: AnySchema;
  values?: unknown[];
  entries?: Record<string, unknown>;
}
const defOf = (s: AnySchema) => s._zod.def as unknown as Def;

const SAMPLE_ID = "00000000-0000-7000-8000-000000000000";

function sampleString(key: string): string {
  if (key === "id" || key.endsWith("_id")) return SAMPLE_ID;
  if (key.endsWith("_at")) return new Date(0).toISOString();
  if (key.endsWith("_login")) return "testuser";
  if (key.endsWith("_name")) return "TestUser";
  if (key === "currency") return "usd";
  if (key === "color") return "#9147ff";
  if (key === "language") return "en";
  return "test";
}

function sampleValue(schema: AnySchema, key: string): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(def.shape ?? {})) out[k] = sampleValue(v, k);
      return out;
    }
    case "string":
      return sampleString(key);
    case "number":
    case "int":
      return key === "decimal_places" ? 2 : 1;
    case "boolean":
      return false;
    case "literal":
      return def.values?.[0];
    case "enum":
      return Object.values(def.entries ?? {})[0];
    case "nullable":
    case "optional":
    case "default":
      return def.innerType ? sampleValue(def.innerType, key) : null;
    case "array":
      return def.element ? [sampleValue(def.element, key)] : [];
    default:
      return null;
  }
}

export function samplePayload(type: EventType, condition: Record<string, string>): Record<string, unknown> {
  const schema = EVENTS[type].payload;
  const base = sampleValue(schema, "") as Record<string, unknown>;
  for (const [k, v] of Object.entries(condition)) if (Object.hasOwn(base, k)) base[k] = v;
  // Parse so a sample that would not validate fails loudly here, not at the receiver.
  return schema.parse(base) as Record<string, unknown>;
}
