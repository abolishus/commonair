// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import multiInstance, { CLAIMS } from "../scenarios/multi-instance.ts";
import {
  MULTI_SERVICES,
  chatUrlOn,
  containerOf,
  missingReplicas,
  parseReplicaContainers,
  replicaUrls,
  valkeyUrl,
} from "../src/multi/replicas.ts";

describe("parseReplicaContainers", () => {
  const ps = [
    "commonair_api_1\trunning",
    "commonair_api-2_1\trunning",
    "commonair_chat_1\trunning",
    "commonair_chat-2_1\texited",
    "commonair-worker-1\trunning",
    "commonair-worker-2-1\trunning",
    "commonair_origin_1\trunning",
    "commonair_media_1\trunning",
    "commonair_postgres_1\trunning",
    "othersite_api-2_1\trunning",
    "",
  ].join("\n");

  test("finds the originals and replicas under either separator, ignoring other services and projects", () => {
    expect(parseReplicaContainers(ps, "commonair")).toEqual([
      { service: "api", name: "commonair_api_1", running: true },
      { service: "api-2", name: "commonair_api-2_1", running: true },
      { service: "chat", name: "commonair_chat_1", running: true },
      { service: "chat-2", name: "commonair_chat-2_1", running: false },
      { service: "worker", name: "commonair-worker-1", running: true },
      { service: "worker-2", name: "commonair-worker-2-1", running: true },
      { service: "origin", name: "commonair_origin_1", running: true },
    ]);
  });

  test("a stopped or absent replica is missing", () => {
    expect(missingReplicas(parseReplicaContainers(ps, "commonair"))).toEqual(["chat-2", "origin-2"]);
  });

  test("nothing running: every replica is missing", () => {
    expect(missingReplicas([])).toEqual(["api-2", "chat-2", "origin-2", "worker-2"]);
  });

  test("containerOf picks the first container of a service", () => {
    const cs = parseReplicaContainers("commonair_chat-2_2\trunning\ncommonair_chat-2_1\trunning", "commonair");
    expect(containerOf(cs, "chat-2")?.name).toBe("commonair_chat-2_1");
    expect(containerOf(cs, "api-2")).toBeNull();
  });

  test("MULTI_SERVICES lists each original next to its replica", () => {
    expect(MULTI_SERVICES).toEqual(["api", "api-2", "chat", "chat-2", "origin", "origin-2", "worker", "worker-2"]);
  });
});

describe("replicaUrls", () => {
  test("defaults follow the override's host ports", () => {
    const u = replicaUrls({});
    expect(u).toEqual({
      api2: "http://localhost:3101",
      chat2: "ws://localhost:3102",
      chat2Health: "http://localhost:3102/healthz",
      worker2Health: "http://localhost:3105/healthz",
      origin2: "http://localhost:3103",
      valkey: "redis://localhost:6379",
    });
  });

  test("moved ports (the repo .env) and explicit URLs", () => {
    const u = replicaUrls({ API_2_PORT: "4101", CHAT_2_PORT: "4102", HARNESS_ORIGIN_2_URL: "http://h:9/" });
    expect(u.api2).toBe("http://localhost:4101");
    expect(u.chat2).toBe("ws://localhost:4102");
    expect(u.chat2Health).toBe("http://localhost:4102/healthz");
    expect(u.origin2).toBe("http://h:9");
  });

  test("a wss replica gets an https health URL", () => {
    expect(replicaUrls({ HARNESS_CHAT_2_URL: "wss://chat2.example.test" }).chat2Health).toBe(
      "https://chat2.example.test/healthz",
    );
  });
});

describe("valkeyUrl", () => {
  test("the repo .env's URL, with VALKEY_PASSWORD added when it carries none", () => {
    expect(valkeyUrl({ VALKEY_URL: "redis://localhost:6379", VALKEY_PASSWORD: "abc" })).toBe(
      "redis://:abc@localhost:6379",
    );
    expect(valkeyUrl({ VALKEY_URL: "redis://:xyz@localhost:6379", VALKEY_PASSWORD: "abc" })).toBe(
      "redis://:xyz@localhost:6379",
    );
  });

  test("HARNESS_VALKEY_URL wins and is taken as is", () => {
    expect(valkeyUrl({ HARNESS_VALKEY_URL: "redis://v:1", VALKEY_URL: "redis://x:2", VALKEY_PASSWORD: "p" })).toBe(
      "redis://v:1",
    );
  });
});

describe("chatUrlOn", () => {
  test("keeps the API's path and token, swaps scheme, host and port", () => {
    expect(chatUrlOn("ws://localhost:3102", "ws://localhost:3002/ws?token=abc")).toBe(
      "ws://localhost:3102/ws?token=abc",
    );
    expect(chatUrlOn("wss://c2.example.test", "ws://localhost:3002/ws")).toBe("wss://c2.example.test/ws");
  });
});

describe("scenario", () => {
  test("is part of full, needs podman, fits the default timeout", () => {
    expect(multiInstance.name).toBe("multi-instance");
    expect(multiInstance.inFull).toBe(true);
    expect(multiInstance.needs).toContain("podman");
    expect(multiInstance.timeoutMs).toBeLessThanOrEqual(10 * 60_000);
  });

  test("one step per claim in the brief's table", () => {
    expect(CLAIMS).toHaveLength(9);
    expect(new Set(CLAIMS).size).toBe(CLAIMS.length);
  });
});
