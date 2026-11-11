// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `/settings/account` calls (D7.2). The picture reuses the channel avatar upload: every
 * account owns a channel (`ensureChannel` at sign-up), so the file goes through
 * `channels.uploadUrl` (purpose `avatar`) and the scanning commit, and the committed key becomes
 * the profile image through better-auth's `update-user`, which accepts only the member's own
 * committed channel avatar uploads (services/api/src/auth/index.ts `ownAvatarKey`).
 */
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import type { Me } from "@commonair/contracts/dto";
import { api } from "../../lib/api.ts";
import { AuthRequestError, resendVerificationEmail } from "../../lib/auth.ts";
import { uploadClient, type UploadClient } from "../safety/upload.ts";

/** better-auth's profile update, mounted by services/api. */
export const UPDATE_USER_PATH = AUTH_ROUTES.updateUser;

export type MeUpdate = {
  displayName?: string;
  shareEmailWithFollowedChannels?: boolean;
  matureConfirmed?: false;
};

export interface AccountClient {
  me(): Promise<Me>;
  update(input: MeUpdate): Promise<Me>;
  resendVerification(email: string): Promise<void>;
  /** The profile picture: a committed avatar key, or null to remove it. */
  setImage(key: string | null): Promise<void>;
  upload: UploadClient;
}

async function setImage(key: string | null): Promise<void> {
  const res = await fetch(UPDATE_USER_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: key }),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  throw new AuthRequestError(
    res.status,
    typeof data?.code === "string" ? data.code : null,
    typeof data?.message === "string" ? data.message : `HTTP ${res.status}`,
  );
}

export const accountClient = (): AccountClient => ({
  me: () => Promise.resolve().then(() => api().me.get()),
  update: (input) => Promise.resolve().then(() => api().me.update(input)),
  // The link lands back here, so the badge reads Verified on return.
  resendVerification: (email) => resendVerificationEmail(email, "/settings/account"),
  setImage,
  upload: uploadClient(),
});
