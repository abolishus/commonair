// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `instance.info` `features.watchGate` / `features.surgeGuard`, read once per page load. */
import * as React from "react";
import { api, type Api } from "../../lib/api.ts";
import type { ChatGateFeatures } from "./form.ts";

export type ChatGateClient = Pick<Api, "instance" | "chat">;

const cache = new WeakMap<object, Promise<ChatGateFeatures>>();

/** One read per client; a failure is not cached, so a later mount asks again. */
export function chatGateFeatures(client: ChatGateClient): Promise<ChatGateFeatures> {
  const hit = cache.get(client);
  if (hit) return hit;
  // Any failure, synchronous ones included (a partial client in tests), is a rejection.
  const p = Promise.resolve()
    .then(() => client.instance.info())
    .then((i) => ({ watchGate: i.features.watchGate, surgeGuard: i.features.surgeGuard }));
  cache.set(client, p);
  p.catch(() => cache.delete(client));
  return p;
}

/**
 * The features, or null while loading and after a failed read (callers then render nothing). The
 * browser client is made in the effect, never during a server render.
 */
export function useChatGateFeatures(client?: ChatGateClient): ChatGateFeatures | null {
  const [features, setFeatures] = React.useState<ChatGateFeatures | null>(null);
  React.useEffect(() => {
    let live = true;
    chatGateFeatures(client ?? api()).then(
      (f) => {
        if (live) setFeatures(f);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  return features;
}
