// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Outlet, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { Footer } from "../components/footer.tsx";
import { Header } from "../components/header.tsx";

/** Site chrome (header + footer) for every page except embeds. */
export const Route = createFileRoute("/_app")({ component: AppLayout });

function AppLayout(): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
