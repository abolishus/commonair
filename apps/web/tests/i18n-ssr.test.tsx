// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The request store must hold across a streaming render's suspensions and never leak between
 * concurrent requests: two server renders in different locales, interleaved, each entirely in
 * its own locale.
 */
import * as React from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { activeLocale, t } from "../src/i18n/index.ts";
import { negotiateRequest, requestLocale, runWithRequestLocale } from "../src/i18n/server.ts";

const deps = { fetchMe: () => Promise.reject(new Error("signed out")), instanceDefault: "en" };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Late({ wait }: { wait: Promise<void> }): React.JSX.Element {
  React.use(wait);
  return (
    <p data-locale={activeLocale()}>
      {t("nav.signIn")} · {t("follow.count", { count: 3 })}
    </p>
  );
}

function Page({ waits }: { waits: Promise<void>[] }): React.JSX.Element {
  return (
    <main>
      <h1>{t("app.title")}</h1>
      {waits.map((wait, i) => (
        <React.Suspense key={i} fallback={<span>…</span>}>
          <Late wait={wait} />
        </React.Suspense>
      ))}
    </main>
  );
}

async function render(cookie: string | undefined, delays: number[]): Promise<string> {
  const headers = new Headers({ accept: "text/html" });
  if (cookie) headers.set("cookie", cookie);
  const store = await negotiateRequest(new Request("http://web.test/", { headers }), { document: true, deps });
  // As in production: the stream leaves the store (the middleware returns the Response) and the
  // HTTP server pulls the body outside it, so suspended work must keep the request's context.
  const stream = await runWithRequestLocale(store, () =>
    renderToReadableStream(<Page waits={delays.map((ms) => delay(ms))} />),
  );
  expect(requestLocale()).toBeUndefined();
  let html = "";
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += value;
    await delay(1);
  }
  // React separates adjacent text nodes with empty comments.
  return html.replaceAll("<!-- -->", "");
}

describe("server rendering per request", () => {
  it("renders two interleaved requests each in its own locale", async () => {
    const [pseudo, english] = await Promise.all([
      render("commonair-locale=en-XA", [15, 40, 5]),
      render(undefined, [5, 30, 20]),
    ]);
    expect(english).toContain("Live streaming, owned by the people who make it");
    expect(english.match(/Sign in · 3 followers/g)).toHaveLength(3);
    expect(english).not.toMatch(/[À-ɏḀ-ỿ]/);
    expect(english).not.toContain('data-locale="en-XA"');

    expect(pseudo).not.toContain("Sign in");
    expect(pseudo).not.toContain("Live streaming");
    expect(pseudo.match(/\[Šîĝñ îñ~+\] · \[3 ƒöļļöŵéŕš~+\]/g)).toHaveLength(3);
    expect(pseudo).not.toContain('data-locale="en"');
  });

  it("is English again outside any request", async () => {
    await render("commonair-locale=en-XA", [1]);
    expect(requestLocale()).toBeUndefined();
    expect(activeLocale()).toBe("en");
    expect(t("nav.signIn")).toBe("Sign in");
  });
});
