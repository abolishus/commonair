// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 1 (E9-apps; docs/testing/e9-selectors.md "Scenarios"), over the API:
 * the developer registers a confidential app (redirect `http://127.0.0.1:<receiver>/cb`) and a
 * public app, updates the confidential app's description, rotates its secret, and checks the old
 * secret now fails at the token endpoint with `invalid_client` (a client-credentials request is
 * the cheapest probe). Both apps go into `E9Run.state` for the later steps. Ids and outcomes only
 * in the report: never a secret.
 */
import { OAUTH_PATHS, OAuthErrorResponse } from "@commonair/contracts/oauth";
import type { HarnessEnv } from "../env.ts";
import type { FetchLike } from "../api/cookies.ts";
import { type E9App, type E9Run, type E9Step, machineFetch } from "./run.ts";

/** The client-credentials form the token endpoint takes (`client_secret_post`). */
export function clientCredentialsForm(clientId: string, clientSecret: string): URLSearchParams {
  return new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
}

/** The OAuth error code of a token endpoint answer, or null when it is not an RFC 6749 error. */
export function oauthErrorCode(body: unknown): string | null {
  const r = OAuthErrorResponse.safeParse(body);
  return r.success ? r.data.error : null;
}

/** POST a client-credentials request; the status and error code only (a success body holds a token). */
export async function probeClientCredentials(
  env: Pick<HarnessEnv, "HARNESS_API_URL">,
  clientId: string,
  clientSecret: string,
  send: FetchLike = (request) => fetch(request),
): Promise<{ status: number; error: string | null }> {
  const res = await send(
    new Request(new URL(OAUTH_PATHS.token, env.HARNESS_API_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: clientCredentialsForm(clientId, clientSecret),
    }),
  );
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, error: res.ok ? null : oauthErrorCode(body) };
}

/** What the report may show of an app: never its secret. */
export const appSummary = (app: E9App) => ({
  id: app.id,
  clientId: app.clientId,
  confidential: app.clientSecret !== null,
  redirectUri: app.redirectUri,
});

async function runStep(run: E9Run): Promise<void> {
  const { ctx, state } = run;
  const dev = run.actors.developer.api.client.developer.apps;
  const redirectUri = state.receiver.callbackUrl;

  const confidential = await ctx.step("developer registers a confidential app", async () => {
    const r = await dev.create({
      name: `Harness confidential ${ctx.runId}`.slice(0, 50),
      description: "developer-platform step 1",
      redirectUris: [redirectUri],
      confidential: true,
    });
    ctx.assert("confidential app has a secret, shown once", r.app.confidential && r.secret !== null, {
      id: r.app.id,
      confidential: r.app.confidential,
      secret: r.secret === null ? "none" : "issued",
    });
    ctx.assert("its secret names its client id", r.secret?.clientId === r.app.clientId);
    ctx.assert("client id is 30 lowercase alphanumerics", /^[a-z0-9]{30}$/.test(r.app.clientId), r.app.clientId);
    return r;
  });

  const publicApp = await ctx.step("developer registers a public app", async () => {
    const r = await dev.create({
      name: `Harness public ${ctx.runId}`.slice(0, 50),
      description: "developer-platform step 1 (device flow)",
      redirectUris: [redirectUri],
      confidential: false,
    });
    ctx.assert("public app has no secret", !r.app.confidential && r.secret === null, {
      id: r.app.id,
      confidential: r.app.confidential,
    });
    return r.app;
  });

  await ctx.step("developer updates the description", async () => {
    const description = `updated ${ctx.runId}`.slice(0, 500);
    const updated = await dev.update({ id: confidential.app.id, description });
    ctx.assert("description changed", updated.description === description, { id: updated.id });
    ctx.assert("redirect URIs unchanged", updated.redirectUris.join(" ") === redirectUri, updated.redirectUris);
    const listed = (await dev.list()).find((a) => a.id === confidential.app.id);
    ctx.assert("the list shows the update", listed?.description === description, { found: listed !== undefined });
  });

  const oldSecret = confidential.secret?.clientSecret ?? "";
  const rotated = await ctx.step("developer rotates the secret", async () => {
    const r = await dev.rotateSecret({ id: confidential.app.id });
    ctx.assert(
      "a new secret for the same client",
      r.clientId === confidential.app.clientId && r.clientSecret !== oldSecret,
    );
    const listed = (await dev.list()).find((a) => a.id === confidential.app.id);
    ctx.assert("secretRotatedAt is set", typeof listed?.secretRotatedAt === "string", {
      at: listed?.secretRotatedAt ?? null,
    });
    return r;
  });

  await ctx.step("the old secret fails at the token endpoint (invalid_client)", async () => {
    const probe = await probeClientCredentials(
      run.env,
      confidential.app.clientId,
      oldSecret,
      machineFetch(run.platform),
    );
    ctx.assert(
      "old secret refused with 401 invalid_client",
      probe.status === 401 && probe.error === "invalid_client",
      probe,
    );
  });

  state.confidentialApp = {
    id: confidential.app.id,
    clientId: confidential.app.clientId,
    clientSecret: rotated.clientSecret,
    redirectUri,
  };
  state.publicApp = { id: publicApp.id, clientId: publicApp.clientId, clientSecret: null, redirectUri };
  ctx.data("apps", { confidential: appSummary(state.confidentialApp), public: appSummary(state.publicApp) });
}

export const step: E9Step = {
  name: "apps",
  owner: "E9-apps",
  ready: true,
  needs: [],
  run: runStep,
};
