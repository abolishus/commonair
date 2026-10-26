// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one way the web uploads a channel file: presigned PUT into the unpublished incoming
 * prefix, then `channels.commitUpload`, which scans images and publishes them. Only the key
 * commit returns may be used. Every rejection is reported the same way (`rejected`), so the UI
 * cannot tell a hash-list match from any other refusal, and neither can the uploader.
 */
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_TYPES,
  type UploadContentType,
  type UploadPurpose,
} from "@commonair/contracts/shapes";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";

export type { UploadContentType, UploadPurpose };

export interface UploadClient {
  uploadUrl(input: {
    channel: string;
    purpose: UploadPurpose;
    contentType: UploadContentType;
    sizeBytes: number;
  }): Promise<{ uploadUrl: string; key: string; headers: Record<string, string> }>;
  /** The presigned PUT, with the headers the signature covers. */
  put(url: string, file: Blob, headers: Record<string, string>): Promise<{ ok: boolean }>;
  commit(input: { channel: string; key: string }): Promise<{ key: string; url: string }>;
}

export const uploadClient = (): UploadClient => ({
  uploadUrl: (input) => api().channels.uploadUrl(input),
  put: (url, file, headers) => fetch(url, { method: "PUT", body: file, headers }),
  commit: (input) => api().channels.commitUpload(input),
});

export type UploadResult = { ok: true; key: string; url: string } | { ok: false; reason: "rejected" | "failed" };

/** True for the generic upload rejection (`UNPROCESSABLE_CONTENT`, `upload_rejected`). */
export function isUploadRejected(err: unknown): boolean {
  return errorCode(err) === "UNPROCESSABLE_CONTENT";
}

/** The file types a purpose accepts, for `<input accept>`. */
export function uploadAccept(purpose: UploadPurpose): string {
  return UPLOAD_TYPES[purpose].join(",");
}

export type UploadFileCheck =
  | { ok: true; contentType: UploadContentType }
  | { ok: false; reason: "type" | "size" | "empty" };

/** The contract's limits, checked before asking for a presigned URL the API would refuse. */
export function checkUploadFile(purpose: UploadPurpose, file: Blob): UploadFileCheck {
  const contentType = UPLOAD_TYPES[purpose].find((type) => type === file.type);
  if (!contentType) return { ok: false, reason: "type" };
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, reason: "size" };
  return { ok: true, contentType };
}

export async function uploadChannelFile(
  client: UploadClient,
  input: { channel: string; purpose: UploadPurpose; file: Blob; contentType: UploadContentType },
): Promise<UploadResult> {
  try {
    const target = await client.uploadUrl({
      channel: input.channel,
      purpose: input.purpose,
      contentType: input.contentType,
      sizeBytes: input.file.size,
    });
    const put = await client.put(target.uploadUrl, input.file, target.headers);
    if (!put.ok) return { ok: false, reason: "failed" };
    const committed = await client.commit({ channel: input.channel, key: target.key });
    return { ok: true, key: committed.key, url: committed.url };
  } catch (err) {
    return { ok: false, reason: isUploadRejected(err) ? "rejected" : "failed" };
  }
}

/** What to tell the uploader: one message for every rejection, another for transport failures. */
export function uploadFailureMessage(reason: "rejected" | "failed"): string {
  return reason === "rejected" ? t("safety.upload.rejected") : t("safety.upload.failed");
}
