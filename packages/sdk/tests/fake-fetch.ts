// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/** A scripted `fetch` for the OAuth endpoints: records each request and answers from a queue. */
export interface Recorded {
  url: string;
  method: string;
  contentType: string | null;
  form: Record<string, string>;
}

export type Answer = { status?: number; json?: unknown; text?: string } | ((r: Recorded) => Answer);

export function fakeFetch(answers: Answer[]) {
  const requests: Recorded[] = [];
  const queue = [...answers];
  const fetch = async (request: Request): Promise<Response> => {
    const body = await request.text();
    const rec: Recorded = {
      url: request.url,
      method: request.method,
      contentType: request.headers.get("content-type"),
      form: Object.fromEntries(new URLSearchParams(body)),
    };
    requests.push(rec);
    let a = queue.shift();
    if (a === undefined) throw new Error(`fake fetch: no answer left for ${rec.url}`);
    while (typeof a === "function") a = a(rec);
    const text = a.text ?? (a.json === undefined ? "" : JSON.stringify(a.json));
    return new Response(text, { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, requests, remaining: () => queue.length };
}

export const tokenJson = (n: number, extra: Record<string, unknown> = {}) => ({
  access_token: `at_${n}`,
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: `rt_${n}`,
  scope: "chat:read chat:edit",
  ...extra,
});

export const oauthError = (error: string, status = 400) => ({ status, json: { error, error_description: error } });
