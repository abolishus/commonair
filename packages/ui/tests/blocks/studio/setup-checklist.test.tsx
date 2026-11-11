// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-dashboard: the `SetupChecklist` block (done, current and to-do steps, the current step's
 * inline detail, done steps keeping their action) and CopyField's Reveal and `onCopied`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { CopyField } from "../../../src/blocks/forms/index.ts";
import { SetupChecklist, type SetupChecklistStep } from "../../../src/blocks/studio/index.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const labels = { done: "Done", current: "Current step", todo: "To do", optional: "(optional)", progress: "Setup" };
const steps: SetupChecklistStep[] = [
  { id: "a", title: "Set up your channel", state: "done", summary: "Picture added", action: <button>Edit</button> },
  {
    id: "b",
    title: "Copy your stream key",
    state: "current",
    hint: "Paste it into OBS",
    estimate: "About 2 min",
    action: <button>Create stream key</button>,
    detail: <p>Server URL here</p>,
  },
  { id: "c", title: "Do a rehearsal", state: "todo", optional: true, hint: "Go live privately", detail: <p>hidden</p> },
];

describe("SetupChecklist", () => {
  test("renders each step with its state, number or tick, and the progress", () => {
    render(
      <SetupChecklist
        title="Ready to go live"
        progressText="1 of 3 steps done"
        done={1}
        total={3}
        steps={steps}
        labels={labels}
      />,
    );
    const section = screen.getByRole("region", { name: "Ready to go live" });
    expect(within(section).getByText("1 of 3 steps done")).toBeTruthy();
    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "current", "todo"]);
    expect(items[1]?.getAttribute("aria-current")).toBe("step");
    expect(items[0]?.getAttribute("aria-current")).toBeNull();
    // The state is in words too, never colour alone.
    expect(items[0]?.textContent).toContain("Done: Set up your channel");
    expect(items[1]?.textContent).toContain("Current step: Copy your stream key");
    expect(items[2]?.textContent).toContain("(optional)");
    expect(items[2]?.textContent).toContain("3");
    expect(screen.getByRole("progressbar", { name: "Setup" }).getAttribute("aria-valuenow")).toBe("33");
  });

  test("only the current step shows its detail and estimate; done steps show their summary and keep their action", () => {
    render(<SetupChecklist title="T" progressText="p" done={1} total={3} steps={steps} labels={labels} />);
    expect(screen.getByText("Server URL here")).toBeTruthy();
    expect(screen.queryByText("hidden")).toBeNull();
    expect(screen.getByText("About 2 min")).toBeTruthy();
    expect(screen.getByText("Picture added")).toBeTruthy();
    expect(screen.queryByText("Paste it into OBS")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  test("an empty list is 0 %, and a footer renders", () => {
    render(
      <SetupChecklist
        title="T"
        progressText="p"
        done={0}
        total={0}
        steps={[]}
        labels={labels}
        footer="Support is on"
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("Support is on")).toBeTruthy();
  });
});

describe("CopyField Reveal", () => {
  test("masks a secret until Reveal, copies the real value either way and calls onCopied", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onCopied = vi.fn<() => void>();
    render(
      <CopyField
        label="Stream key"
        value="live_abc123"
        copiedLabel="Copied"
        copyLabel="Copy"
        copyFailedLabel="Failed"
        secret
        showLabel="Reveal"
        hideLabel="Hide"
        onCopied={onCopied}
        data-value-testid="key"
      />,
    );
    const input = screen.getByTestId("key") as HTMLInputElement;
    expect(input.value).not.toContain("abc");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("live_abc123"));
    expect(onCopied).toHaveBeenCalledTimes(1);
    const reveal = screen.getByRole("button", { name: "Reveal" });
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(reveal.getAttribute("aria-controls")).toBe(input.id);
    fireEvent.click(reveal);
    expect(input.value).toBe("live_abc123");
    expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("a failed copy does not call onCopied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn<(value: string) => Promise<void>>().mockRejectedValue(new Error("no")) },
    });
    const onCopied = vi.fn<() => void>();
    render(
      <CopyField label="L" value="v" copiedLabel="C" copyLabel="Copy" copyFailedLabel="Failed" onCopied={onCopied} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getAllByText("Failed").length).toBeGreaterThan(0));
    expect(onCopied).not.toHaveBeenCalled();
  });
});
