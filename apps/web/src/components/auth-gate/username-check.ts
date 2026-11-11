// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Is this name free?" on sign-up (`users.usernameAvailable`, rate-limited on the API's auth
 * bucket). Asked when the field is left, never per keystroke. A failure says nothing: the sign-up
 * itself still checks.
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
  const run = React.useCallback(
    (raw: string) => {
      const username = raw.trim().toLowerCase();
      latest.current = username;
      if (username === "") {
        setCheck({ state: "idle" });
        return;
      }
      if (!FORMAT.test(username)) {
        setCheck({ state: "unavailable", username, reason: "invalid" });
        return;
      }
      setCheck({ state: "checking", username });
      checker(username)
        .then((res) => {
          if (latest.current !== username) return;
          setCheck(
            res.available
              ? { state: "free", username }
              : { state: "unavailable", username, reason: res.reason ?? "taken" },
          );
        })
        .catch(() => {
          if (latest.current === username) setCheck({ state: "idle" });
        });
    },
    [checker],
  );
  const reset = React.useCallback(() => {
    latest.current = "";
    setCheck({ state: "idle" });
  }, []);
  return { check, run, reset };
}
