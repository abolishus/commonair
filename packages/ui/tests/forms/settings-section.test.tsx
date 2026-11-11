// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { DangerZone, SettingsRow, SettingsSection } from "../../src/blocks/forms/index.ts";

describe("SettingsSection, SettingsRow, DangerZone", () => {
  it("labels the section by its title and the control by its row label", () => {
    render(
      <SettingsSection title="Profile" description="Channels see this name.">
        <SettingsRow label="Display name" hint="Up to 40 characters" controlId="dn">
          <input id="dn" />
        </SettingsRow>
        <SettingsRow label="Username">@aurora</SettingsRow>
      </SettingsSection>,
    );
    expect(screen.getByRole("region", { name: "Profile" })).toBeTruthy();
    expect(screen.getByLabelText("Display name").tagName).toBe("INPUT");
    expect(screen.getByText("Channels see this name.")).toBeTruthy();
    expect(screen.getByText("@aurora")).toBeTruthy();
  });

  it("marks the danger zone without a fill", () => {
    const { container } = render(
      <DangerZone title="Delete your account">
        <SettingsRow label="Delete" />
      </DangerZone>,
    );
    const zone = container.querySelector('[data-slot="danger-zone"]');
    expect(zone).not.toBeNull();
    expect(zone?.className).toContain("ring-destructive");
    expect(zone?.className).not.toContain("bg-destructive");
  });
});
