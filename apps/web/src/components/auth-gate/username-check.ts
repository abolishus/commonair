// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Is this name free?" on sign-up (`users.usernameAvailable`, rate-limited on the API's auth
 * bucket). Asked when the field is left, never per keystroke, and never twice for the same name:
 * the lookup shares the per-IP auth budget with the sign-up POST, so re-asking on every blur (or
 * after the `?username` prefill) could starve the submit. A failure says nothing and is not kept,
 * so leaving the field again retries; the sign-up itself still checks.
 */
import { USERNAME_UNAVAILABLE_REASONS } from "@commonair/contracts/enums";
import * as React from "react";
import { api } from "../../lib/api.ts";

export type UsernameReason = (typeof USERNAME_UNAVAILABLE_REASONS)[number];
export type UsernameCheck =
  | { state: "idle" }
  | { state: "checking"; username: string }
  | { state: "free"; username: string }
  | { state: "unavailable"; username: string; reason: UsernameReason };

export type UsernameChecker = (
  username: string,
) => Promise<{ username: string; available: boolean; reason: UsernameReason | null }>;

const apiChecker: UsernameChecker = (username) => api().users.usernameAvailable({ username });

/** Local format check first, so an obviously bad name never costs a request. */
const FORMAT = /^[a-z0-9_]{3,25}$/;

export function useUsernameCheck(checker: UsernameChecker = apiChecker): {
  check: UsernameCheck;
  run: (raw: string) => void;
  reset: () => void;
} {
  const [check, setCheck] = React.useState<UsernameCheck>({ state: "idle" });
  const latest = React.useRef("");
  // Names asked on this page: their answer, or null while the lookup is in flight. Small (one
  // entry per distinct name left in the field), and the sign-up re-checks anyway.
  const asked = React.useRef(new Map<string, UsernameCheck | null>());
  const run = React.useCallback(
    (raw: string) => {
      const username = raw.trim().toLowerCase();
      latest.current = username;
      const known = asked.current.get(username);
      if (known !== undefined) {
        setCheck(known ?? { state: "checking", username });
        return;
      }
      if (username === "") {
        setCheck({ state: "idle" });
        return;
      }
      if (!FORMAT.test(username)) {
        setCheck({ state: "unavailable", username, reason: "invalid" });
        return;
      }
      setCheck({ state: "checking", username });
      const cache = asked.current;
      cache.set(username, null);
      checker(username)
        .then((res) => {
          const result: UsernameCheck = res.available
            ? { state: "free", username }
            : { state: "unavailable", username, reason: res.reason ?? "taken" };
          cache.set(username, result);
          if (latest.current === username) setCheck(result);
        })
        .catch(() => {
          cache.delete(username);
          if (latest.current === username) setCheck({ state: "idle" });
        });
    },
    [checker],
  );
  const reset = React.useCallback(() => {
    latest.current = "";
    asked.current = new Map();
    setCheck({ state: "idle" });
  }, []);
  return { check, run, reset };
}
