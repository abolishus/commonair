// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Button } from "../src/components/button.tsx";
import { ConfirmDialog } from "../src/index.ts";
import { toast } from "../src/toast.tsx";
import { LONG_TITLE } from "./fixtures.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const meta = {
  title: "Primitives/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    trigger: <Button variant="destructive">Delete clip</Button>,
    title: "Delete this clip?",
    description: "It is removed for everyone who shared it. This cannot be undone.",
    confirmLabel: "Delete clip",
    variant: "destructive",
    icon: Delete02Icon,
    onConfirm: () => wait(1200),
  },
} satisfies Meta<typeof ConfirmDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Async confirm: buttons disable and the dialog stays until the promise resolves. */
export const Destructive: Story = {};
export const OpenByDefault: Story = { args: { defaultOpen: true } };
export const Neutral: Story = {
  args: {
    trigger: <Button>Publish</Button>,
    title: "Publish the schedule?",
    description: "Followers will be notified.",
    confirmLabel: "Publish",
    variant: "default",
    icon: undefined,
  },
};
/** The action fails: the dialog stays open and the error is reported (here as a toast). */
export const ErrorState: Story = {
  args: {
    onConfirm: async () => {
      await wait(800);
      throw new Error("network");
    },
    onError: () => toast.error("Could not delete the clip. Try again."),
  },
};
export const LongText: Story = {
  args: { defaultOpen: true, title: LONG_TITLE, description: `${LONG_TITLE}. ${LONG_TITLE}.` },
};
export const Light: Story = { args: { defaultOpen: true }, globals: { theme: "light" } };
export const Mobile320: Story = { args: { defaultOpen: true }, globals: { viewport: { value: "mobile320" } } };
export const RightToLeft: Story = {
  args: { defaultOpen: true, title: "حذف هذا المقطع؟", description: "لا يمكن التراجع عن ذلك." },
  globals: { dir: "rtl" },
};
