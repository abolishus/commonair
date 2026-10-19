// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { DashboardShell } from "./dashboard-shell.tsx";
import type { NavGroup } from "./nav.tsx";
export interface AdminShellProps {
  header: React.ReactNode;
  groups: NavGroup[];
  sidebarLabel: string;
  children: React.ReactNode;
}
export function AdminShell(props: AdminShellProps): React.JSX.Element {
  return <DashboardShell {...props} />;
}
