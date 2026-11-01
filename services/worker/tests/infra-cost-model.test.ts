// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `INFRA_COST_MODEL` prices every delivery source and nothing else (config cannot import contracts). */
import { COST_MODEL_SOURCES } from "@commonair/config";
import { DELIVERY_SOURCES } from "@commonair/contracts/enums";
import { expect, test } from "vite-plus/test";

test("the cost model's sources are the delivery sources", () => {
  expect([...COST_MODEL_SOURCES].sort()).toEqual([...DELIVERY_SOURCES].sort());
});
