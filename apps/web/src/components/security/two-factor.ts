// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Two-step sign-in helpers (D7.2): the set-up stepper's steps, the manual key, codes and their file. */
import { t } from "../../i18n/index.ts";

/** The set-up dialog's steps, in order; two-step sign-in is on only after `code`. */
export const SETUP_STEPS = ["password", "scan", "code", "codes"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export function nextStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.min(SETUP_STEPS.indexOf(step) + 1, SETUP_STEPS.length - 1)] ?? "codes";
}

/**
 * Back from a step: the code step returns to the QR code; nothing goes back past it (the secret
 * exists from `scan` on) or out of the backup codes (two-step sign-in is already on there).
 */
export function previousStep(step: SetupStep): SetupStep | null {
  return step === "code" ? "scan" : null;
}

/** 1-based position, for "Step 2 of 4". */
export const stepNumber = (step: SetupStep) => SETUP_STEPS.indexOf(step) + 1;

/** The base32 secret in an `otpauth://` URI, for typing in by hand ("" when there is none). */
export function totpSecret(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/** The key in groups of four, as authenticator apps accept it typed with spaces. */
export function groupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(" ");
}

/** What a person typed as a 6-digit code: digits only (spaces and dashes from copying dropped). */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

export const isTotpCode = (code: string): boolean => /^\d{6}$/.test(code);

/** A backup code as typed (better-auth's are letters, digits and a dash): trimmed, case kept. */
export function normalizeBackupCode(input: string): string {
  return input.trim().replace(/\s+/g, "");
}

/** The downloaded `.txt`: a heading, one code per line and the reminder. */
export function backupCodesFile(codes: readonly string[], instance: string, username: string): string {
  return [
    t("d7Security.setup.fileHeading", { instance, username }),
    "",
    ...codes,
    "",
    t("d7Security.setup.fileHint"),
    "",
  ].join("\n");
}

/** Save `text` as `name` from the browser, with no network request. */
export function downloadText(name: string, text: string, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  doc.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
