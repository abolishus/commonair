// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../src/components/button.tsx";
import { toast } from "../src/toast.tsx";
import { LONG_TITLE } from "./fixtures.ts";

function ToastDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => toast.success("Settings saved", { description: "Your changes are live." })}>
        Success
      </Button>
      <Button variant="destructive" onClick={() => toast.error("Could not save")}>
        Error
      </Button>
      <Button variant="outline" onClick={() => toast.info("Raid incoming in 10 seconds")}>
        Info
      </Button>
      <Button variant="outline" onClick={() => toast.warning("Your stream key was used from a new location")}>
        Warning
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          void toast
            .promise(new Promise<number>((resolve) => setTimeout(() => resolve(3), 1500)), {
              loading: "Uploading clips…",
              success: (n) => `Uploaded ${n} clips`,
              error: "Upload failed",
            })
            .catch(() => {})
        }
      >
        Promise
      </Button>
      <Button
        variant="ghost"
        onClick={() => toast.message(LONG_TITLE, { action: { label: "Undo", onClick: () => toast.dismiss() } })}
      >
        Long text with action
      </Button>
    </div>
  );
}

const meta = { title: "Primitives/toast", component: ToastDemo } satisfies Meta<typeof ToastDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
