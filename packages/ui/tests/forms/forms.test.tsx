// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { toast } from "../../src/toast.tsx";
import {
  ActionRow,
  AccentPicker,
  AmountField,
  CharacterCountField,
  ChoiceToggle,
  CodeBlock,
  CommentComposer,
  CopyField,
  DateOfBirthField,
  FormSection,
  OptionGroup,
  PasswordField,
  SwitchField,
  SwitchMatrix,
  TagsField,
} from "../../src/blocks/forms/index.ts";
import { ACCENTS } from "@commonair/contracts/shapes";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

afterEach(() => vi.restoreAllMocks());

describe("forms blocks", () => {
  test("FormSection submits with its associated title", () => {
    const submit = vi.fn<(event: React.FormEvent<HTMLFormElement>) => void>((event) => event.preventDefault());
    render(
      <FormSection title="Profile" onSubmit={submit} actions={{ saveLabel: "Save" }}>
        <SwitchField label="Public" />
      </FormSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("form", { name: "Profile" })).toBeTruthy();
  });

  test("SwitchField forwards test ids to its root and switch", () => {
    render(<SwitchField label="Email" data-testid="email-field" switchProps={{ "data-testid": "email-switch" }} />);
    expect(screen.getByTestId("email-field")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Email" })).toBeTruthy();
  });

  test("OptionGroup supports arrow-key selection", async () => {
    const change = vi.fn<(value: string) => void>();
    render(
      <OptionGroup
        aria-label="Tier"
        items={[
          { value: "basic", title: "Basic" },
          { value: "plus", title: "Plus" },
        ]}
        defaultValue="basic"
        onValueChange={change}
      />,
    );
    const radio = screen.getByRole("radio", { name: /Basic/ });
    radio.focus();
    await userEvent.setup().keyboard("{ArrowRight}");
    await waitFor(() => expect(change).toHaveBeenCalledWith("plus"));
  });

  test("CopyField copies and reports success; secrets can be revealed", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const success = vi.spyOn(toast, "success");
    render(
      <CopyField
        label="Token"
        value="secret-key"
        copiedLabel="Copied"
        copyLabel="Copy"
        copyFailedLabel="Copy failed"
        secret
        showLabel="Show"
        hideLabel="Hide"
        data-value-testid="secret-value"
        data-copy-testid="secret-copy"
      />,
    );
    expect((screen.getByTestId("secret-value") as HTMLInputElement).value).not.toContain("secret-key");
    expect(screen.getByTestId("secret-copy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect((screen.getByTestId("secret-value") as HTMLInputElement).value).toBe("secret-key");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("secret-key"));
    expect(success).toHaveBeenCalledWith("Copied");
  });

  test("copy failures are surfaced", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn<(value: string) => Promise<void>>().mockRejectedValue(new Error("blocked")) },
    });
    const failure = vi.spyOn(toast, "error");
    render(<CodeBlock value="hello" label="Copy code" copiedLabel="Copied" copyFailedLabel="Copy failed" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(failure).toHaveBeenCalledWith("Copy failed"));
  });

  test("CopyField gates destructive actions behind ConfirmDialog", async () => {
    const action = vi.fn<() => void>();
    render(
      <CopyField
        label="Key"
        value="x"
        copiedLabel="Copied"
        copyLabel="Copy"
        copyFailedLabel="Error"
        actions={[{ label: "Rotate", destructive: true, onAction: action }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  test("CharacterCountField enforces maxLength and announces near-limit counts", () => {
    render(<CharacterCountField label="Title" defaultValue="A" maxLength={3} data-testid="title-field" />);
    const input = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(input.maxLength).toBe(3);
    fireEvent.change(input, { target: { value: "ABC" } });
    expect(input.value).toBe("ABC");
    expect(screen.getByText("3 / 3").getAttribute("aria-live")).toBe("polite");
  });

  test("AmountField parses integer minor units using currency precision and locale", () => {
    const usd = vi.fn<(value: number) => void>();
    const jpy = vi.fn<(value: number) => void>();
    const kwd = vi.fn<(value: number) => void>();
    const { rerender } = render(
      <AmountField
        label="USD"
        currency="USD"
        locale="en-US"
        value={0}
        onValueChange={usd}
        rangeError="Invalid amount"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "USD" }), { target: { value: "12.34" } });
    expect(usd).toHaveBeenCalledWith(1234);
    rerender(
      <AmountField
        label="JPY"
        currency="JPY"
        locale="en-US"
        value={0}
        onValueChange={jpy}
        rangeError="Invalid amount"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "JPY" }), { target: { value: "120" } });
    expect(jpy).toHaveBeenCalledWith(120);
    rerender(
      <AmountField
        label="KWD"
        currency="KWD"
        locale="de-DE"
        value={0}
        onValueChange={kwd}
        rangeError="Invalid amount"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "KWD" }), { target: { value: "1,234" } });
    expect(kwd).toHaveBeenCalledWith(1234);
  });

  test("AmountField rejects negative and out-of-range values", () => {
    const change = vi.fn<(value: number) => void>();
    const { rerender } = render(
      <AmountField
        label="Tip"
        currency="USD"
        value={500}
        onValueChange={change}
        min={100}
        max={1000}
        rangeError="Amount is outside the allowed range."
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Tip" }), { target: { value: "-5" } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Tip" }), { target: { value: "20" } });
    rerender(
      <AmountField
        label="Tip"
        currency="USD"
        value={2000}
        onValueChange={change}
        min={100}
        max={1000}
        rangeError="Amount is outside the allowed range."
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("outside the allowed range");
  });

  test("ChoiceToggle changes among options and SwitchMatrix labels every cell", () => {
    const change = vi.fn<(value: string) => void>();
    render(
      <>
        <ChoiceToggle
          label="Protocol"
          options={[
            { value: "hls", label: "HLS" },
            { value: "rtmp", label: "RTMP" },
          ]}
          onValueChange={change}
        />
        <SwitchMatrix
          label="Notifications"
          columns={[{ id: "email", label: "Email" }]}
          rows={[{ id: "live", label: "When live", values: { email: false } }]}
          onValueChange={() => undefined}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "RTMP" }));
    expect(change).toHaveBeenCalledWith("rtmp");
    expect(screen.getByRole("switch", { name: "When live Email" })).toBeTruthy();
  });

  test("TagsField adds and removes tags with keyboard controls and enforces max", async () => {
    render(<TagsField label="Tags" defaultValues={["retro"]} max={2} />);
    const input = screen.getByRole("combobox", { name: "Tags" });
    fireEvent.change(input, { target: { value: "speedrun" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("speedrun")).toBeTruthy();
    fireEvent.change(input, { target: { value: "extra" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByText("extra")).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Backspace" });
    await waitFor(() => expect(screen.queryByText("speedrun")).toBeNull());
  });

  test("AccentPicker exposes all contract accent names", () => {
    render(
      <AccentPicker
        label="Accent"
        labels={
          Object.fromEntries(ACCENTS.map((accent) => [accent, accent])) as Record<(typeof ACCENTS)[number], string>
        }
      />,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(ACCENTS.length);
  });

  test("DateOfBirthField formats localized month names and reports invalid calendar dates", async () => {
    render(
      <DateOfBirthField
        label="Birth date"
        locale="fr-FR"
        monthLabel="Month"
        dayLabel="Day"
        yearLabel="Year"
        invalidDateMessage="Invalid date"
        value="2020-02-30"
        years={[2020]}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Invalid date");
    fireEvent.click(screen.getByRole("combobox", { name: "Month" }));
    expect(await screen.findByText("février")).toBeTruthy();
  });

  test("PasswordField toggles visibility and CommentComposer submits its text", () => {
    const submit = vi.fn<(value: string) => void>();
    render(
      <>
        <PasswordField label="Password" showLabel="Show password" hideLabel="Hide password" defaultValue="abc" />
        <CommentComposer label="Comment" submitLabel="Post" defaultValue="Hello" onSubmit={submit} />
      </>,
    );
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    expect(submit).toHaveBeenCalledWith("Hello");
  });

  test("ActionRow renders status and actions", () => {
    const action = vi.fn<() => void>();
    render(
      <ActionRow
        title="Password"
        status={{ label: "Active", tone: "success" }}
        actions={[{ label: "Manage", onAction: action }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Active")).toBeTruthy();
  });
});

describe("forms SSR and hydration", () => {
  test("all 15 blocks server-render and hydrate without warnings", async () => {
    const recoverableError = vi.fn<(error: unknown) => void>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixtures: React.ReactElement[] = [
      <FormSection key="1" title="Settings">
        <SwitchField label="Alerts" />
      </FormSection>,
      <SwitchField key="2" label="Alerts" />,
      <OptionGroup key="3" aria-label="Tier" items={[{ value: "one", title: "One" }]} />,
      <CopyField key="4" label="Token" value="abc" copiedLabel="Copied" copyLabel="Copy" copyFailedLabel="Failed" />,
      <CodeBlock key="5" value="code" label="Copy" copiedLabel="Copied" copyFailedLabel="Failed" />,
      <CharacterCountField key="6" label="Title" maxLength={20} />,
      <AmountField
        key="7"
        label="Amount"
        currency="USD"
        value={100}
        onValueChange={() => undefined}
        rangeError="Invalid amount"
      />,
      <ChoiceToggle key="8" label="Mode" options={[{ value: "a", label: "A" }]} />,
      <TagsField key="9" label="Tags" />,
      <AccentPicker
        key="10"
        label="Accent"
        labels={
          Object.fromEntries(ACCENTS.map((accent) => [accent, accent])) as Record<(typeof ACCENTS)[number], string>
        }
      />,
      <ActionRow key="11" title="Sign in" />,
      <PasswordField key="12" label="Password" showLabel="Show" hideLabel="Hide" />,
      <DateOfBirthField
        key="13"
        label="DOB"
        monthLabel="Month"
        dayLabel="Day"
        yearLabel="Year"
        invalidDateMessage="Invalid"
        years={[2000]}
      />,
      <SwitchMatrix
        key="14"
        label="Alerts"
        columns={[{ id: "email", label: "Email" }]}
        rows={[{ id: "a", label: "Live", values: {} }]}
        onValueChange={() => undefined}
      />,
      <CommentComposer key="15" label="Note" submitLabel="Post" onSubmit={() => undefined} />,
    ];
    for (const fixture of fixtures) {
      const container = document.createElement("div");
      container.innerHTML = renderToString(fixture);
      const root = hydrateRoot(container, fixture, { onRecoverableError: recoverableError });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        root.unmount();
      });
    }
    expect(recoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
