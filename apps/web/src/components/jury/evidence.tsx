// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameTile } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import * as React from "react";
import { t } from "../../i18n/index.ts";

const REDUCED_TRANSPARENCY = "(prefers-reduced-transparency: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(REDUCED_TRANSPARENCY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** The viewer asked for less transparency: a blurred image behind a see-through veil is not shown at all. */
export function useReducedTransparency(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED_TRANSPARENCY).matches,
    () => false,
  );
}

/**
 * One kept image (ADR 0038 §5): blurred and grayscale until the juror reveals it, behind its
 * content warning. Under `prefers-reduced-transparency` the blurred image is not drawn at all: an
 * opaque panel with the warning and the reveal button stands in. Reduced motion is the tile's own.
 * State only, so it is blurred again on the next visit.
 */
export function EvidenceMedia({ src, index }: { src: string; index: number }): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false);
  const reduced = useReducedTransparency();
  const reveal = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="jury-evidence-reveal"
      onClick={() => setRevealed(true)}
    >
      {t("jury.evidence.reveal")}
    </Button>
  );
  const hideImage = reduced && !revealed;
  return (
    <FrameTile
      data-testid="jury-evidence-media"
      data-revealed={revealed ? "true" : "false"}
      src={hideImage ? null : src}
      alt={t("jury.evidence.alt", { n: index + 1 })}
      revealed={revealed}
      onReveal={() => setRevealed(true)}
      revealLabel={t("jury.evidence.reveal")}
      notice={t("jury.evidence.warning")}
      revealButtonProps={{ "data-testid": "jury-evidence-reveal" }}
      placeholder={
        hideImage ? (
          <div className="flex flex-col items-center gap-3 p-4 text-center text-sm">
            <p className="text-muted-foreground">{t("jury.evidence.warning")}</p>
            {reveal}
          </div>
        ) : undefined
      }
    />
  );
}
