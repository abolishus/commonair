// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import { SelectField } from "../../src/blocks/forms/index.ts";

const latencies = [
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low latency" },
  { value: "ultra", label: "Ultra-low", disabled: true },
];

describe("SelectField", () => {
  test("the label names the trigger and the trigger shows the selected option", () => {
    render(<SelectField label="Latency" options={latencies} value="low" onValueChange={() => undefined} />);
    const trigger = screen.getByRole("combobox", { name: "Latency" });
    expect(trigger.textContent).toContain("Low latency");
  });

  test("description and error describe the trigger; an error marks it invalid", () => {
    render(
      <SelectField
        id="setup-latency"
        label="Latency"
        options={latencies}
        defaultValue="normal"
        description="Lower latency costs viewers more buffering."
        error="Pick a latency"
        data-testid="latency-field"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Latency" });
    expect(trigger.id).toBe("setup-latency");
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (trigger.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toEqual(["setup-latency-description", "setup-latency-error"]);
    expect(document.getElementById("setup-latency-description")?.textContent).toBe(
      "Lower latency costs viewers more buffering.",
    );
    expect(document.getElementById("setup-latency-error")?.textContent).toBe("Pick a latency");
    expect(screen.getByTestId("latency-field").getAttribute("data-invalid")).toBe("true");
  });

  test("no description or error leaves the trigger undescribed and valid", () => {
    render(<SelectField label="Latency" options={latencies} defaultValue="normal" />);
    const trigger = screen.getByRole("combobox", { name: "Latency" });
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
    expect(trigger.hasAttribute("aria-invalid")).toBe(false);
  });

  test("uncontrolled: picking an option updates the trigger and reports the value", async () => {
    const change = vi.fn<(value: string) => void>();
    render(<SelectField label="Latency" options={latencies} defaultValue="normal" onValueChange={change} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Latency" }));
    await user.click(await screen.findByRole("option", { name: "Low latency" }));
    expect(change).toHaveBeenCalledWith("low");
    expect(screen.getByRole("combobox", { name: "Latency" }).textContent).toContain("Low latency");
  });

  test("controlled: the value only changes when the parent changes it", async () => {
    function Controlled(): React.JSX.Element {
      const [value, setValue] = React.useState("normal");
      return (
        <>
          <SelectField label="Latency" options={latencies} value={value} onValueChange={setValue} />
          <output>{value}</output>
        </>
      );
    }
    render(<Controlled />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Latency" }));
    await user.click(await screen.findByRole("option", { name: "Low latency" }));
    expect(screen.getByRole("status").textContent).toBe("low");
  });

  test("disabled disables the trigger and marks the field", () => {
    render(<SelectField label="Latency" options={latencies} defaultValue="normal" disabled data-testid="field" />);
    expect(screen.getByRole("combobox", { name: "Latency" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("field").getAttribute("data-disabled")).toBe("true");
  });

  test("forwards orientation to Field", () => {
    render(
      <SelectField
        label="Pay with"
        options={latencies}
        defaultValue="normal"
        orientation="horizontal"
        data-testid="f"
      />,
    );
    expect(screen.getByTestId("f").getAttribute("data-orientation")).toBe("horizontal");
  });

  test("server-renders and hydrates without warnings", async () => {
    const node = <SelectField label="Latency" options={latencies} defaultValue="low" description="Hint" error="Bad" />;
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
