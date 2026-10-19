// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { StreamGrid } from "@commonair/ui/blocks/media";
import { AlertCircleIcon, LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import type { DirectorySection, DirectorySectionId } from "../lib/directory-sections.ts";

function sectionTitle(id: DirectorySectionId): string {
  switch (id) {
    case "spotlight":
      return t("directory.section.spotlight");
    case "new":
      return t("directory.section.new");
    case "live":
      return t("directory.section.live");
    case "following":
      return t("directory.section.following");
  }
}

/** The directory on `/`: one `StreamGrid` per non-empty section; `sections` is null when loading failed. */
export function Directory({ sections }: { sections: DirectorySection[] | null }): React.JSX.Element {
  return (
    <div data-testid="directory" className="flex flex-col gap-8">
      {sections === null ? (
        <EmptyState icon={AlertCircleIcon} title={t("directory.loadFailed")} />
      ) : sections.length === 0 ? (
        <EmptyState
          data-testid="directory-empty"
          icon={LiveStreaming02Icon}
          title={t("directory.empty")}
          description={t("directory.emptyHint")}
        />
      ) : (
        sections.map((section) => (
          <Section
            key={section.id}
            data-testid="directory-section"
            data-section={section.id}
            heading={sectionTitle(section.id)}
          >
            <StreamGrid
              streams={section.cards}
              hrefFor={(card) => `/${card.channel.slug}`}
              renderLink={(card) => <Link to="/$channel" params={{ channel: card.channel.slug }} />}
              cardProps={(card) => ({
                "data-testid": "stream-card",
                "data-channel": card.channel.slug,
                showReason: section.id !== "following",
              })}
            />
          </Section>
        ))
      )}
    </div>
  );
}
