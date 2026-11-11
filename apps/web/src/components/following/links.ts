// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where signed-out follow prompts send people (D2.1 intents). Plain links until the sign-up page
 * reads `?intent` (d2-gate); then the AuthGatePrompt takes over on `/following`.
 */
export const SIGNUP_FOLLOW_HREF = "/signup?intent=follow";
/** From `/following` itself: back there after sign-up. */
export const SIGNUP_FOLLOWING_HREF = "/signup?intent=follow&redirect=%2Ffollowing";
