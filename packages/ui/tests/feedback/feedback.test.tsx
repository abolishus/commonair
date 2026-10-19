// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import type * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Alert01Icon } from "@hugeicons/core-free-icons";
import { describe, expect, test, vi } from "vite-plus/test";
import { AlertCallout, IncidentCard, QueueItemCard, alertCalloutVariants } from "../../src/blocks/feedback/index.ts";

describe("AlertCallout", () => {
  test("static notes are role=note; live callouts are role=alert", () => {
    const { rerender } = render(<AlertCallout description="Past broadcasts are kept 60 days." />);
    expect(screen.getByRole("note").textContent).toContain("Past broadcasts are kept 60 days.");
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<AlertCallout live tone="danger" title="Payment failed" />);
    expect(screen.getByRole("alert").textContent).toContain("Payment failed");
  });

  test.each(["neutral", "info", "warning", "danger"] as const)(
    "tone %s sets data-tone and its token classes",
    (tone) => {
      render(<AlertCallout tone={tone} title="Title" description="Body" data-testid="callout" />);
      const callout = screen.getByTestId("callout");
      expect(callout.getAttribute("data-tone")).toBe(tone);
      const classes = alertCalloutVariants({ tone }).split(" ").filter(Boolean);
      for (const name of classes) expect(callout.className).toContain(name);
    },
  );

  test("tones use only status tokens already checked AA on card (no new token pairs)", () => {
    const used = (["info", "warning", "danger"] as const).flatMap((tone) =>
      alertCalloutVariants({ tone })
        .split(" ")
        .map((name) => name.replace(/^(?:text|border)-/, "")),
    );
    expect(new Set(used)).toEqual(new Set(["info", "warning", "destructive"]));
  });

  test("renders title, description, action, a default icon per tone, and hides the icon with null", () => {
    const go = vi.fn<() => void>();
    const { container, rerender } = render(
      <AlertCallout
        tone="warning"
        title="Your old key showed up in a public paste."
        description="We revoked it automatically."
        action={
          <button type="button" onClick={go}>
            What the leak scanner checks
          </button>
        }
      />,
    );
    const note = screen.getByRole("note");
    expect(within(note).getByText("Your old key showed up in a public paste.")).toBeTruthy();
    expect(note.querySelector("p")?.textContent).toBe("We revoked it automatically.");
    fireEvent.click(within(note).getByRole("button", { name: "What the leak scanner checks" }));
    expect(go).toHaveBeenCalledOnce();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    rerender(<AlertCallout icon={null} description="No icon" />);
    expect(container.querySelector("svg")).toBeNull();
    rerender(<AlertCallout icon={Alert01Icon} description={<span>Node body</span>} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("Node body").tagName).toBe("SPAN");
  });
});

describe("QueueItemCard", () => {
  test("shows kind, reason, time and content, and runs actions in order with the trailing one last", () => {
    const approve = vi.fn<() => void>();
    const escalate = vi.fn<() => void>();
    render(
      <QueueItemCard
        kind="Held by filter"
        reason="Link from a new account"
        time="12 s ago"
        data-testid="queue-item"
        actions={[
          { id: "approve", label: "Allow", variant: "default", onAction: approve },
          { id: "ban", label: "Ban", variant: "destructive", buttonProps: { "data-testid": "ban" } },
        ]}
        trailingAction={{ id: "escalate", label: "Escalate to platform", variant: "ghost", onAction: escalate }}
      >
        <p>cheap followers at [link]</p>
      </QueueItemCard>,
    );
    const card = screen.getByTestId("queue-item");
    expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe("Held by filterLink from a new account");
    expect(within(card).getByText("12 s ago")).toBeTruthy();
    expect(within(card).getByText("cheap followers at [link]")).toBeTruthy();
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Allow", "Ban", "Escalate to platform"]);
    expect(buttons[2]?.className).toContain("ms-auto");
    expect(screen.getByTestId("ban")).toBe(buttons[1]);
    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(buttons[2] as HTMLElement);
    expect(approve).toHaveBeenCalledOnce();
    expect(escalate).toHaveBeenCalledOnce();
  });

  test("renders no action row without actions and honours the heading level", () => {
    render(
      <QueueItemCard kind="Reported" reason="Spam" time="now" headingLevel={2}>
        body
      </QueueItemCard>,
    );
    expect(screen.getByRole("heading", { level: 2 })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("IncidentCard", () => {
  test("lists updates as a timeline and links the postmortem after the note", () => {
    const { rerender } = render(
      <IncidentCard
        status="Monitoring"
        title="Chat delivery delays in EU"
        date="Oct 18"
        updates={[
          { id: "u2", status: "Identified", time: "18:54 UTC", text: "Fan-out lag." },
          { id: "u1", status: "Investigating", time: "18:41 UTC", text: "Reports of delays." },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("Chat delivery delays in EU");
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    rerender(
      <IncidentCard
        status="Resolved"
        tone="success"
        title="Origin outage"
        date="Aug 22"
        note="Storage quota exhausted."
        link={{ label: "Postmortem", href: "#postmortem" }}
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("link", { name: "Postmortem" }).getAttribute("href")).toBe("#postmortem");
    expect(screen.getByText(/Storage quota exhausted/)).toBeTruthy();
  });

  test("a router render element replaces the plain link", () => {
    render(
      <IncidentCard
        status="Resolved"
        title="Outage"
        date="Aug 22"
        link={{
          label: "Postmortem",
          render: (
            <a href="/status/postmortem/1" data-router="">
              Postmortem
            </a>
          ),
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Postmortem" });
    expect(link.getAttribute("data-router")).toBe("");
    expect(link.getAttribute("href")).toBe("/status/postmortem/1");
  });
});

const cases: [string, React.ReactElement][] = [
  [
    "AlertCallout",
    <AlertCallout key="a" tone="warning" title="Title" description="Body" action={<a href="#x">x</a>} />,
  ],
  [
    "QueueItemCard",
    <QueueItemCard key="q" kind="Held" reason="Link" time="now" actions={[{ id: "a", label: "Allow" }]}>
      body
    </QueueItemCard>,
  ],
  [
    "IncidentCard",
    <IncidentCard
      key="i"
      status="Monitoring"
      title="Delays"
      date="Oct 18"
      updates={[{ id: "u", status: "Identified", time: "18:54", text: "Lag" }]}
    />,
  ],
];

describe("feedback blocks SSR and hydration", () => {
  test.each(cases)("%s hydrates without warnings", async (_name, node) => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(node);
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, node, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
