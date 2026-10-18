// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only notification API for apps: `toast.success/error/info/warning/promise`.
 * It wraps Sonner so call sites never import `sonner` (and we can swap it).
 * Mount `<Toaster theme={resolvedTheme} />` once at the app root.
 */
import type * as React from "react";
import { toast as sonner, type ExternalToast } from "sonner";

export { Toaster } from "./components/sonner.tsx";

export type ToastId = string | number;

export interface ToastOptions {
  description?: React.ReactNode;
  /** Reuse an id to update a toast in place instead of stacking a new one. */
  id?: ToastId;
  /** Milliseconds; `Infinity` keeps it until dismissed. */
  duration?: number;
  action?: { label: React.ReactNode; onClick: () => void };
}

export interface PromiseMessages<T> {
  loading: React.ReactNode;
  success: React.ReactNode | ((value: T) => React.ReactNode);
  error: React.ReactNode | ((error: unknown) => React.ReactNode);
}

function toExternal(options: ToastOptions | undefined): ExternalToast | undefined {
  if (!options) return undefined;
  const { action, ...rest } = options;
  return action ? { ...rest, action: { label: action.label, onClick: () => action.onClick() } } : rest;
}

export const toast = {
  success: (message: React.ReactNode, options?: ToastOptions): ToastId => sonner.success(message, toExternal(options)),
  error: (message: React.ReactNode, options?: ToastOptions): ToastId => sonner.error(message, toExternal(options)),
  info: (message: React.ReactNode, options?: ToastOptions): ToastId => sonner.info(message, toExternal(options)),
  warning: (message: React.ReactNode, options?: ToastOptions): ToastId => sonner.warning(message, toExternal(options)),
  message: (message: React.ReactNode, options?: ToastOptions): ToastId => sonner.message(message, toExternal(options)),
  /**
   * Shows a loading toast that turns into success or error when `promise` settles.
   * Returns the original promise so callers can keep awaiting it (rejections still propagate).
   */
  promise: <T,>(
    promise: Promise<T>,
    messages: PromiseMessages<T>,
    options?: Omit<ToastOptions, "description">,
  ): Promise<T> => {
    sonner.promise(promise, { ...toExternal(options), ...messages });
    return promise;
  },
  dismiss: (id?: ToastId): void => {
    sonner.dismiss(id);
  },
};
