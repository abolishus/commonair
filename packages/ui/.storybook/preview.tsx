// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Decorator, Preview } from "@storybook/react-vite";
import * as React from "react";
import "../src/styles/globals.css";
import { TooltipProvider } from "../src/components/tooltip.tsx";
import { LocaleProvider } from "../src/lib/locale.tsx";
import { applyTheme, isTheme, useResolvedTheme } from "../src/primitives/theme-toggle.tsx";
import { Toaster } from "../src/toast.tsx";

/** Applies the toolbar's theme and direction to <html>, exactly as the app does. */
const withShell: Decorator = (Story, context) => {
  const theme = isTheme(context.globals.theme) ? context.globals.theme : "dark";
  const dir = context.globals.dir === "rtl" ? "rtl" : "ltr";
  const locale = typeof context.globals.locale === "string" ? context.globals.locale : "en";
  React.useLayoutEffect(() => {
    applyTheme(theme);
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
  }, [theme, dir, locale]);
  const resolved = useResolvedTheme(theme);
  return (
    <LocaleProvider locale={locale}>
      <TooltipProvider>
        <div className="min-h-full bg-background p-4 font-sans text-foreground">
          <Story />
        </div>
        <Toaster theme={resolved} />
      </TooltipProvider>
    </LocaleProvider>
  );
};

const preview: Preview = {
  decorators: [withShell],
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
          { value: "system", title: "System" },
        ],
        dynamicTitle: true,
      },
    },
    dir: {
      description: "Text direction",
      toolbar: {
        title: "Direction",
        icon: "transfer",
        items: [
          { value: "ltr", title: "LTR" },
          { value: "rtl", title: "RTL" },
        ],
        dynamicTitle: true,
      },
    },
    locale: {
      description: "Formatting locale",
      toolbar: {
        title: "Locale",
        icon: "globe",
        items: ["en", "de", "fr", "ar", "ja"].map((value) => ({ value, title: value })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "dark", dir: "ltr", locale: "en" },
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    a11y: { test: "todo" },
    backgrounds: { disable: true },
    viewport: {
      options: {
        mobile320: { name: "Mobile 320", styles: { width: "320px", height: "640px" }, type: "mobile" },
        mobile390: { name: "Mobile 390", styles: { width: "390px", height: "844px" }, type: "mobile" },
        tablet: { name: "Tablet", styles: { width: "768px", height: "1024px" }, type: "tablet" },
      },
    },
  },
};

export default preview;
