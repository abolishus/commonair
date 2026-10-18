// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Button } from "../src/components/button.tsx";
import { ConfirmDialog, LocaleProvider } from "../src/index.ts";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve: () => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn<() => void>();
  render(
    <ConfirmDialog
      trigger={<Button>Delete clip</Button>}
      title="Delete this clip?"
      description="It is removed for everyone. This cannot be undone."
      confirmLabel="Delete"
      variant="destructive"
      icon={Delete02Icon}
      {...props}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

describe("ConfirmDialog", () => {
  test("buttons carry the stable e2e test ids", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Delete clip" }));
    await screen.findByRole("alertdialog");
    expect(screen.getByTestId("confirm-dialog-confirm").textContent).toContain("Delete");
    expect(screen.getByTestId("confirm-dialog-cancel").textContent).toContain("Cancel");
  });

  test("keyboard flow: open with Enter, focus starts on Cancel, Tab to confirm, Enter confirms", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete clip" }));
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("alertdialog", { name: "Delete this clip?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    await user.keyboard("{Enter}");

    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("Escape and Cancel close without confirming", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete clip" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Delete clip" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("async confirm keeps the dialog open and busy until it resolves; Escape cannot orphan it", async () => {
    const user = userEvent.setup();
    const task = deferred();
    const onConfirm = vi.fn<() => Promise<void>>(() => task.promise);
    renderDialog({ onConfirm });

    await user.click(screen.getByRole("button", { name: "Delete clip" }));
    const confirm = await screen.findByRole("button", { name: "Delete" });
    await user.click(confirm);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();

    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true").toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    task.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a failed confirm stays open, re-enables the buttons and reports the error", async () => {
    const user = userEvent.setup();
    const onError = vi.fn<(error: unknown) => void>();
    const failure = new Error("network down");
    renderDialog({ onConfirm: () => Promise.reject(failure), onError });

    await user.click(screen.getByRole("button", { name: "Delete clip" }));
    const confirm = await screen.findByRole("button", { name: "Delete" });
    await user.click(confirm);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await waitFor(() => expect(confirm.getAttribute("aria-busy")).toBeNull());
  });

  test("controlled mode reports open changes and uses catalog labels by default", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    function Controlled() {
      const [open, setOpen] = React.useState(true);
      return (
        <LocaleProvider locale="fr" messages={{ cancel: "Annuler", confirm: "Confirmer" }}>
          <ConfirmDialog
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            title="Quitter ?"
            onConfirm={() => {}}
          />
        </LocaleProvider>
      );
    }
    render(<Controlled />);
    expect(await screen.findByRole("button", { name: "Confirmer" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
