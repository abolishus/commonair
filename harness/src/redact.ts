// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Credentials that can ride in a URL's query (overlay tokens, presigned S3 links, OAuth codes and
 * tokens) or in free text (prefixed OAuth secrets). Error text from
 * fetch or Playwright often quotes the URL, and step/run errors go into the report.
 */
const SECRET_PARAMS =
  /([?&](?:token|access_token|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|code|refresh_token|device_code|client_secret|resume)=)[^&\s"'<>)]*/gi;

/**
 * OAuth secrets by their prefixes (docs/testing/e9-selectors.md "Rules"): access `ca_`, refresh
 * `car_`, client secret `cas_`, authorization code `cac_`, device code `cad_`, EventSub resume
 * `ces_`; the bodies are lowercase hex (`randomTokenSecret`).
 */
const PREFIXED_SECRETS = /\bc(?:a|ar|as|ac|ad|es)_[a-z0-9]{20,}\b/g;

/** Replace credential query values and prefixed OAuth secrets in free text with `REDACTED`. */
export function redactUrlSecrets(text: string): string {
  return text.replace(SECRET_PARAMS, "$1REDACTED").replace(PREFIXED_SECRETS, "REDACTED");
}

/** The message of an error, with URL credentials redacted (for reports and logs). */
export function errorMessage(err: unknown): string {
  return redactUrlSecrets(err instanceof Error ? err.message : String(err));
}
