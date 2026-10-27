// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { Bus } from "../src/bus.ts";
import { createMetrics } from "../src/metrics.ts";
import { Rooms } from "../src/rooms.ts";
import type { ChatSocket } from "../src/socket.ts";

/** A bus that only counts references per pub/sub channel. */
function fakeBus() {
  const refs = new Map<string, number>();
  const bus = {
    names: { chat: (id: string) => `chat:${id}`, control: (id: string) => `control:${id}` },
    acquire: async (name: string) => {
      refs.set(name, (refs.get(name) ?? 0) + 1);
    },
    release: async (name: string) => {
      const n = (refs.get(name) ?? 0) - 1;
      if (n > 0) refs.set(name, n);
      else refs.delete(name);
    },
  };
  return { bus: bus as unknown as Bus, refs };
}

const socket = () => ({ data: { closed: false } }) as unknown as ChatSocket;
const member = { canModerate: false, userId: null, modScope: false };
const channel = { id: "c1", slug: "room" };

function setup() {
  const { bus, refs } = fakeBus();
  const released: string[] = [];
  const rooms = new Rooms(
    bus,
    { onChat: () => undefined, onControl: () => undefined, onRelease: (id) => released.push(id) },
    { maxBufferedBytes: 1024, metrics: createMetrics() },
  );
  return { rooms, refs, released };
}

describe("Rooms release", () => {
  test("onRelease fires once, when the last local member leaves", async () => {
    const { rooms, refs, released } = setup();
    const [a, b] = [socket(), socket()];
    await rooms.join(a, channel, member);
    await rooms.join(b, channel, member);
    await rooms.part(a, channel.id);
    expect(released).toEqual([]);
    expect(refs.get("control:c1")).toBe(1);
    await rooms.part(b, channel.id);
    expect(released).toEqual(["c1"]);
    expect(refs.has("control:c1")).toBe(false);
    expect(rooms.get(channel.id)).toBeUndefined();
  });

  test("parting a socket that is not a member does not release the room", async () => {
    const { rooms, released } = setup();
    await rooms.join(socket(), channel, member);
    await rooms.part(socket(), channel.id);
    await rooms.part(socket(), "unknown");
    expect(released).toEqual([]);
  });

  test("a room joined again after its release releases again", async () => {
    const { rooms, released } = setup();
    const a = socket();
    await rooms.join(a, channel, member);
    await rooms.part(a, channel.id);
    await rooms.join(a, channel, member);
    await rooms.part(a, channel.id);
    expect(released).toEqual(["c1", "c1"]);
  });

  test("a failed subscription releases the room it created", async () => {
    const { bus } = fakeBus();
    const released: string[] = [];
    const failing = Object.assign(Object.create(bus) as Bus, {
      acquire: async () => {
        throw new Error("valkey down");
      },
      release: async () => undefined,
    });
    const rooms = new Rooms(
      failing,
      { onChat: () => undefined, onControl: () => undefined, onRelease: (id) => released.push(id) },
      { maxBufferedBytes: 1024, metrics: createMetrics() },
    );
    await expect(rooms.join(socket(), channel, member)).rejects.toThrow("valkey down");
    expect(released).toEqual(["c1"]);
    expect(rooms.size).toBe(0);
  });
});
