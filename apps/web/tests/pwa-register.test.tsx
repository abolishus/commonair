// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Service worker registration, the update prompt and the pages that never register. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { UpdatePrompt } from "../src/components/pwa/pwa-root.tsx";
import {
  SKIP_WAITING,
  type WaitingWorker,
  type WorkerContainer,
  type WorkerRegistration,
  applyUpdate,
  pwaExcludedPath,
  registerServiceWorker,
} from "../src/pwa/register.ts";

afterEach(() => cleanup());

class FakeWorker implements WaitingWorker {
  state = "installing";
  messages: unknown[] = [];
  private listeners: (() => void)[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  addEventListener(_type: "statechange", listener: () => void) {
    this.listeners.push(listener);
  }
  become(state: string) {
    this.state = state;
    for (const l of this.listeners) l();
  }
}

class FakeRegistration implements WorkerRegistration {
  waiting: WaitingWorker | null = null;
  installing: WaitingWorker | null = null;
  private listeners: (() => void)[] = [];
  addEventListener(_type: "updatefound", listener: () => void) {
    this.listeners.push(listener);
  }
  found(worker: FakeWorker) {
    this.installing = worker;
    for (const l of this.listeners) l();
  }
}

function container(controller: unknown, registration = new FakeRegistration()) {
  const changes: (() => void)[] = [];
  const c: WorkerContainer & { calls: unknown[][]; changes: (() => void)[] } = {
    controller,
    calls: [],
    changes,
    register: (url, options) => {
      c.calls.push([url, options]);
      return Promise.resolve(registration);
    },
    addEventListener: (_type, listener) => {
      changes.push(listener);
    },
  };
  return c;
}

describe("registerServiceWorker", () => {
  it("registers /sw.js for the whole origin", async () => {
    const c = container(null);
    await registerServiceWorker(c, () => undefined);
    expect(c.calls).toEqual([["/sw.js", { scope: "/" }]]);
  });

  it("does not offer an update on the very first install", async () => {
    const reg = new FakeRegistration();
    const onUpdate = vi.fn<(worker: WaitingWorker) => void>();
    await registerServiceWorker(container(null, reg), onUpdate);
    const w = new FakeWorker();
    reg.found(w);
    w.become("installed");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("offers a new build's worker once it is installed and waiting", async () => {
    const reg = new FakeRegistration();
    const onUpdate = vi.fn<(worker: WaitingWorker) => void>();
    await registerServiceWorker(container({}, reg), onUpdate);
    const w = new FakeWorker();
    reg.found(w);
    expect(onUpdate).not.toHaveBeenCalled();
    w.become("installed");
    expect(onUpdate).toHaveBeenCalledWith(w);
  });

  it("offers a worker already waiting when the page loads", async () => {
    const reg = new FakeRegistration();
    const w = new FakeWorker();
    reg.waiting = w;
    const onUpdate = vi.fn<(worker: WaitingWorker) => void>();
    await registerServiceWorker(container({}, reg), onUpdate);
    expect(onUpdate).toHaveBeenCalledWith(w);
  });

  it("reloads only after the new worker took control", () => {
    const c = container({});
    const w = new FakeWorker();
    const reload = vi.fn<() => void>();
    applyUpdate(c, w, reload);
    expect(w.messages).toEqual([SKIP_WAITING]);
    expect(reload).not.toHaveBeenCalled();
    for (const l of c.changes) l();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("pwaExcludedPath", () => {
  it.each([
    ["/overlay/chat", true],
    ["/overlay/alerts", true],
    ["/embed/somebody", true],
    ["/", false],
    ["/somebody", false],
    ["/settings/notifications", false],
    ["/overlayer", false],
  ])("%s → %s", (path, excluded) => {
    expect(pwaExcludedPath(path)).toBe(excluded);
  });
});

describe("UpdatePrompt", () => {
  it("offers a reload and a dismissal, and does nothing on its own", () => {
    const onReload = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    render(<UpdatePrompt onReload={onReload} onDismiss={onDismiss} />);
    expect(screen.getByTestId("pwa-update-prompt").getAttribute("aria-live")).toBe("polite");
    expect(onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pwa-update-reload"));
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Later"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
