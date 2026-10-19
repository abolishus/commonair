// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CodeBlock } from "@commonair/ui/blocks/forms";
import { Field, FieldDescription, FieldTitle } from "@commonair/ui/components/field";
import type * as React from "react";
import { t } from "../i18n/index.ts";

/**
 * Dashboard values OBS needs verbatim. `CodeBlock` keeps the e1 contract: the test id is on the
 * wrapper whose text content is exactly the value, next to a copy `IconButton` with a tooltip.
 */
export function IngestServerUrl({ value }: { value: string }): React.JSX.Element {
  return (
    <Field>
      <FieldTitle>{t("dashboard.serverUrl")}</FieldTitle>
      <CodeBlock
        value={value}
        label={t("dashboard.copyServerUrl")}
        copiedLabel={t("dashboard.serverUrlCopied")}
        copyFailedLabel={t("dashboard.copyFailed")}
        data-testid="stream-server-url"
      />
    </Field>
  );
}

/** The full key, rendered only right after `stream.rotateKey` (the API shows it once). */
export function NewStreamKey({ value }: { value: string }): React.JSX.Element {
  return (
    <Field aria-live="polite">
      <FieldTitle>{t("dashboard.newKey")}</FieldTitle>
      <CodeBlock
        value={value}
        label={t("dashboard.copyKey")}
        copiedLabel={t("dashboard.keyCopied")}
        copyFailedLabel={t("dashboard.copyFailed")}
        data-testid="stream-key"
        data-copy-testid="stream-key-copy"
      />
      <FieldDescription>{t("dashboard.newKeyOnce")}</FieldDescription>
    </Field>
  );
}
