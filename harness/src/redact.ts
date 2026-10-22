// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Credentials that can ride in a URL's query (overlay tokens, presigned S3 links). Error text from
 * fetch or Playwright often quotes the URL, and step/run errors go into the report.
 */
const SECRET_PARAMS =
  /([?&](?:token|access_token|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"'<>)]*/gi;

/** Replace credential query values in free text with `REDACTED`. */
export function redactUrlSecrets(text: string): string {
  return text.replace(SECRET_PARAMS, "$1REDACTED");
}

/** The message of an error, with URL credentials redacted (for reports and logs). */
export function errorMessage(err: unknown): string {
  return redactUrlSecrets(err instanceof Error ? err.message : String(err));
}
