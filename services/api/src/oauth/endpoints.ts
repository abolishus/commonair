// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The machine OAuth endpoints (ADR 0027 §1-2): `POST /api/oauth2/token`, `/api/oauth2/revoke` and
 * `/api/oauth2/device`, raw form-encoded handlers per RFC 6749, 7009 and 8628 (not oRPC: clients
 * send `application/x-www-form-urlencoded` and expect RFC error bodies). `http.ts` calls this for
 * exactly those three paths, with cookies stripped for foreign origins and CORS added.
 *
 * Logs carry ids and enums only (app id, grant, error code): never a token, code, secret,
 * redirect URI or state.
 */
import {
  DEVICE_CODE_GRANT,
  DeviceAuthorizationRequest,
  OAUTH_GRANT_TYPES,
  OAUTH_PATHS,
  RevokeRequest,
  TokenRequest,
  parseScope,
} from "@commonair/contracts/oauth";
import type { Deps } from "../deps.ts";
import type { RequestInfo } from "../lib/orpc.ts";
import { rateLimitKey } from "../lib/ratelimit.ts";
import { authenticateClient } from "./clients.ts";
import { deviceCodeGrant, startDeviceAuthorization } from "./device.ts";
import { clientCredentials, NO_STORE, OAuthError, oauthErrorResponse, readParams } from "./protocol.ts";
import { authorizationCodeGrant, clientCredentialsGrant, refreshGrant, revokePresentedToken } from "./tokens.ts";

type Endpoint = "token" | "revoke" | "device";

const ENDPOINTS: Record<string, Endpoint> = {
  [OAUTH_PATHS.token]: "token",
  [OAUTH_PATHS.revoke]: "revoke",
  [OAUTH_PATHS.device]: "device",
};

/** The `auth` bucket per client address, as the sign-in routes use it. */
async function limitByIp(deps: Deps, info: RequestInfo): Promise<void> {
  const nowMs = deps.now().getTime();
  const rl = await deps.rateLimitStore.hit(
    rateLimitKey("auth", `ip:${info.rateLimitHash}`),
    deps.rateLimits.auth,
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (!rl.allowed)
    throw new OAuthError("temporarily_unavailable", "Too many requests", {
      status: 429,
      retryAfterSeconds: rl.retryAfterSeconds,
    });
}

const ok = (body: unknown) => Response.json(body, { status: 200, headers: NO_STORE });

async function token(deps: Deps, req: Request, info: RequestInfo, params: Record<string, string>): Promise<Response> {
  const grantType = params.grant_type;
  if (grantType === undefined) throw new OAuthError("invalid_request", "grant_type is required");
  if (!(OAUTH_GRANT_TYPES as readonly string[]).includes(grantType))
    throw new OAuthError("unsupported_grant_type", "Unsupported grant_type");
  // Device polling has its own throttle (RFC 8628 §3.5, `slow_down`).
  if (grantType !== DEVICE_CODE_GRANT) await limitByIp(deps, info);

  const creds = clientCredentials(req.headers, params);
  const app = await authenticateClient(deps, creds);
  if (grantType === "client_credentials") {
    if (!app.confidential)
      throw new OAuthError("unauthorized_client", "Public clients cannot use the client_credentials grant");
    if (params.scope !== undefined) throw new OAuthError("invalid_scope", "App access tokens carry no scopes");
  }
  const parsed = TokenRequest.safeParse({
    ...params,
    client_id: creds.clientId,
    client_secret: creds.secret ?? undefined,
  });
  if (!parsed.success) throw new OAuthError("invalid_request", "Missing or malformed parameters for this grant");
  const r = parsed.data;
  switch (r.grant_type) {
    case "authorization_code":
      return ok(await authorizationCodeGrant(deps, app, r));
    case "refresh_token":
      return ok(await refreshGrant(deps, app, r.refresh_token));
    case "client_credentials":
      return ok(await clientCredentialsGrant(deps, app));
    case DEVICE_CODE_GRANT:
      return ok(await deviceCodeGrant(deps, app, r.device_code));
  }
}

async function revoke(deps: Deps, req: Request, info: RequestInfo, params: Record<string, string>): Promise<Response> {
  await limitByIp(deps, info);
  const creds = clientCredentials(req.headers, params);
  const parsed = RevokeRequest.safeParse({
    ...params,
    client_id: creds.clientId,
    client_secret: creds.secret ?? undefined,
  });
  if (!parsed.success) throw new OAuthError("invalid_request", "token is required");
  const app = await authenticateClient(deps, creds);
  await revokePresentedToken(deps, app, parsed.data.token, parsed.data.token_type_hint);
  // RFC 7009 §2.2: 200 whether or not the token existed.
  return new Response(null, { status: 200, headers: NO_STORE });
}

async function device(deps: Deps, req: Request, info: RequestInfo, params: Record<string, string>): Promise<Response> {
  await limitByIp(deps, info);
  const creds = clientCredentials(req.headers, params);
  const parsed = DeviceAuthorizationRequest.safeParse({ ...params, client_id: creds.clientId });
  if (!parsed.success) throw new OAuthError("invalid_request", "Malformed parameters");
  const app = await authenticateClient(deps, creds);
  const scope = parseScope(parsed.data.scope);
  if (!scope.ok) throw new OAuthError("invalid_scope", "Unknown scope requested");
  if (scope.scopes.length === 0) throw new OAuthError("invalid_scope", "At least one scope is required");
  return ok(await startDeviceAuthorization(deps, app, scope.scopes));
}

export async function oauthEndpoint(deps: Deps, req: Request, info: RequestInfo): Promise<Response> {
  const endpoint = ENDPOINTS[new URL(req.url).pathname];
  try {
    if (!endpoint) throw new OAuthError("invalid_request", "Unknown endpoint", { status: 404 });
    if (req.method !== "POST") {
      const res = oauthErrorResponse(new OAuthError("invalid_request", "Use POST", { status: 405 }));
      res.headers.set("allow", "POST");
      return res;
    }
    const params = await readParams(req);
    if (endpoint === "token") return await token(deps, req, info, params);
    if (endpoint === "revoke") return await revoke(deps, req, info, params);
    return await device(deps, req, info, params);
  } catch (err) {
    if (err instanceof OAuthError) {
      // Polling answers are the normal course of the device flow, not worth a log line each.
      if (err.code !== "authorization_pending" && err.code !== "slow_down")
        deps.logger.info("oauth request refused", { endpoint, error: err.code, status: err.status });
      return oauthErrorResponse(err);
    }
    deps.logger.error("oauth endpoint failed", { endpoint, err });
    return Response.json(
      { error: "temporarily_unavailable", error_description: "Internal error" },
      { status: 500, headers: NO_STORE },
    );
  }
}
