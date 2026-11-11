// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed-in viewer's own account facts the chat composer's gate needs (J3-d): whether their
 * email is verified and when the account was made. One `me.get` per chat mount, and only once the
 * channel has a gate that uses them, so a member who verified in another tab is not held back by
 * an old answer after a reload or a channel change.
 */
import * as React from "react";
import { api } from "../../lib/api.ts";

export interface AccountFacts {
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AccountFactsClient {
  me: () => Promise<AccountFacts>;
}

export const apiAccountFactsClient = (): AccountFactsClient => ({ me: () => api().me.get() });

/** The facts once `enabled` (null until then, while loading, and after a failed read). */
export function useAccountFacts(enabled: boolean, client?: AccountFactsClient): AccountFacts | null {
  const [facts, setFacts] = React.useState<AccountFacts | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Inside `then`, so a client that cannot be made rejects instead of throwing in the effect.
    Promise.resolve()
      .then(() => (client ?? apiAccountFactsClient()).me())
      .then(
        (me) => {
          if (live) setFacts({ email: me.email, emailVerified: me.emailVerified, createdAt: me.createdAt });
        },
        // Nothing to say then: the server still says why when they send.
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [enabled, client]);
  return enabled ? facts : null;
}
