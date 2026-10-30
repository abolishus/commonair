// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 2 (N1-email): the go-live email digest and its one-click unsubscribe. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "email",
  owner: "N1-email",
  needs: [1],
  run: notMerged("N1-email"),
};
