// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { parseBusMessage } from "../src/multi/valkey.ts";

const event = {
  id: "0192f0a0-0000-7000-8000-000000000001",
  type: "channel.update",
  version: "1",
  channelId: "0192f0a0-0000-7000-8000-000000000002",
  payload: { title: "multi:abc:once:1" },
  occurredAt: "2026-10-26T12:00:00.000Z",
};

describe("parseBusMessage (BusEvent contract)", () => {
  test("a relayed event passes as is", () => {
    expect(parseBusMessage(JSON.stringify(event))).toEqual(event);
  });

  test("a null channel is allowed", () => {
    expect(parseBusMessage(JSON.stringify({ ...event, channelId: null }))?.channelId).toBeNull();
  });

  test.each([
    ["not JSON", "{nope"],
    ["missing version", JSON.stringify({ ...event, version: undefined })],
    ["missing occurredAt", JSON.stringify({ ...event, occurredAt: undefined })],
    ["unknown type", JSON.stringify({ ...event, type: "made.up" })],
    ["payload not an object", JSON.stringify({ ...event, payload: "x" })],
    ["a bare value", "42"],
  ])("%s is rejected", (_, message) => {
    expect(parseBusMessage(message)).toBeNull();
  });
});
