// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Which media a preference type offers (`PREFERENCE_MEDIA`): the only ones `set` accepts. */
import { PREFERENCE_MEDIA, type NotifyMedium, type PreferenceType } from "@commonair/contracts/enums";

export const mediumOffered = (type: PreferenceType, medium: NotifyMedium): boolean =>
  PREFERENCE_MEDIA[type].includes(medium);
