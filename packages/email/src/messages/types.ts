// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmailCatalog } from "./en.ts";

/** A translation may be incomplete; missing strings fall back to English. */
export type PartialCatalog = { [K in keyof EmailCatalog]?: Partial<EmailCatalog[K]> };

/** Catalogs by BCP 47 tag, e.g. `{ de: deCatalog, "pt-BR": ptBrCatalog }`. */
export type Catalogs = Record<string, PartialCatalog>;
