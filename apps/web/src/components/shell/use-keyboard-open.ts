// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/** Input types that bring up no on-screen keyboard. */
const NO_KEYBOARD = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether focusing `element` brings up the on-screen keyboard on a touch device. */
export function opensKeyboard(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement)
    return !NO_KEYBOARD.has(element.type) && !element.readOnly && !element.disabled;
  return false;
}

/**
 * Whether the on-screen keyboard is (most likely) open: a text field has focus. Browsers expose
 * no keyboard event that works everywhere (`navigator.virtualKeyboard` is Chromium-only and opt-in),
 * and the visual viewport also shrinks on pinch zoom, so focus is the signal. A fixed bottom bar
 * hides while it is true, so it never rides up over the keyboard or covers the field.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const sync = () => setOpen(opensKeyboard(document.activeElement));
    // `focusout` fires before focus lands elsewhere: read the new element on the next task.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, 0);
    };
    sync();
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", later);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return open;
}
