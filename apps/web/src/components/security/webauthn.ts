// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Passkeys with the browser's own WebAuthn (`navigator.credentials`), no remote script: the API's
 * options JSON (base64url fields) to the browser's `ArrayBuffer`s and the credential back to JSON,
 * as `@simplewebauthn/server` (inside better-auth's passkey plugin) reads it.
 */
import * as React from "react";
import { AUTH_ROUTES, authRequest } from "../../lib/auth.ts";

const noSubscribe = () => () => {};

/**
 * `passkeysSupported()` for a component: false in the server render and at hydration (so the
 * markup matches), the browser's answer after.
 */
export function usePasskeysSupported(): boolean {
  return React.useSyncExternalStore(
    noSubscribe,
    () => passkeysSupported(),
    () => false,
  );
}

/** Passkeys work here: WebAuthn exists and the page is a secure context. */
export function passkeysSupported(win: (Window & typeof globalThis) | undefined = globalThis.window): boolean {
  return (
    win !== undefined &&
    win.isSecureContext === true &&
    typeof win.PublicKeyCredential === "function" &&
    typeof win.navigator?.credentials?.create === "function" &&
    typeof win.navigator?.credentials?.get === "function"
  );
}

export function fromBase64Url(value: string): ArrayBuffer {
  const b64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function toBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface CredentialDescriptorJson {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
}

export interface CreationOptionsJson {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: CredentialDescriptorJson[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

export interface RequestOptionsJson {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: CredentialDescriptorJson[];
  userVerification?: UserVerificationRequirement;
}

const descriptor = (d: CredentialDescriptorJson): PublicKeyCredentialDescriptor => ({
  ...d,
  id: fromBase64Url(d.id),
});

export function creationOptions(json: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  const { excludeCredentials, ...rest } = json;
  return {
    ...rest,
    challenge: fromBase64Url(json.challenge),
    user: { ...json.user, id: fromBase64Url(json.user.id) },
    ...(excludeCredentials ? { excludeCredentials: excludeCredentials.map(descriptor) } : {}),
  };
}

export function requestOptions(json: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  const { allowCredentials, ...rest } = json;
  return {
    ...rest,
    challenge: fromBase64Url(json.challenge),
    ...(allowCredentials ? { allowCredentials: allowCredentials.map(descriptor) } : {}),
  };
}

/** The new credential as `RegistrationResponseJSON`. */
export function registrationJson(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toBase64Url(r.clientDataJSON),
      attestationObject: toBase64Url(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}

/** The assertion as `AuthenticationResponseJSON`. */
export function authenticationJson(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toBase64Url(r.clientDataJSON),
      authenticatorData: toBase64Url(r.authenticatorData),
      signature: toBase64Url(r.signature),
      ...(r.userHandle ? { userHandle: toBase64Url(r.userHandle) } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}

/** The person dismissed the browser's prompt (or it timed out): not an error to report. */
export const isCancelled = (err: unknown): boolean =>
  err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");

/** Create a passkey on this device and save it to the account. */
export async function registerPasskey(creds: CredentialsContainer = navigator.credentials): Promise<void> {
  const json = await authRequest<CreationOptionsJson>("GET", AUTH_ROUTES.passkeyRegisterOptions);
  if (!json) throw new Error("no registration options");
  const cred = (await creds.create({ publicKey: creationOptions(json) })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("cancelled", "NotAllowedError");
  await authRequest("POST", AUTH_ROUTES.passkeyVerifyRegistration, { response: registrationJson(cred) });
}

/** Sign in with a passkey (sets the session cookie). */
export async function signInWithPasskey(creds: CredentialsContainer = navigator.credentials): Promise<void> {
  const json = await authRequest<RequestOptionsJson>("GET", AUTH_ROUTES.passkeyAuthenticateOptions);
  if (!json) throw new Error("no authentication options");
  const cred = (await creds.get({ publicKey: requestOptions(json) })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("cancelled", "NotAllowedError");
  await authRequest("POST", AUTH_ROUTES.passkeyVerifyAuthentication, { response: authenticationJson(cred) });
}
