// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CouncilPage } from "../../components/coop/council.tsx";
import { FormError } from "../../components/form-error.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";

/** Public: the creator council, how it was seated, board seats and elections (read-only). */
export const Route = createFileRoute("/_app/coop/council")({ component: CouncilRoute });

function CouncilRoute(): React.JSX.Element {
  const council = useLoad("council", () => api().coop.council());
  const board = useLoad("board", () => api().coop.board());
  const elections = useLoad("elections", () => api().coop.elections.list());
  const failed = council.failed || board.failed || elections.failed;
  return (
    <>
      {failed && <FormError>{t("coop.loadFailed")}</FormError>}
      <CouncilPage
        council={council.data}
        board={board.data ?? (board.failed ? [] : null)}
        elections={elections.data ?? (elections.failed ? [] : null)}
      />
    </>
  );
}
