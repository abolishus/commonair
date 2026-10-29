// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `Me.locale` and `me.update({ locale })` (ADR 0029): null means "not chosen". */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

type MeBody = { locale: string | null };

describe("me locale", () => {
  test("a new account has no chosen language", async () => {
    const s = await signUpAndSignIn(api);
    const me = await s.client.call<MeBody>("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.locale).toBeNull();
  });

  test("a member sets and clears their language", async () => {
    const s = await signUpAndSignIn(api);
    const set = await s.client.call<MeBody>("PATCH", "/api/me", { locale: "es" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.locale).toBe("es");
    expect((await s.client.call<MeBody>("GET", "/api/me")).body.locale).toBe("es");

    const cleared = await s.client.call<MeBody>("PATCH", "/api/me", { locale: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.locale).toBeNull();

    // Omitting the field leaves the choice alone.
    await s.client.call("PATCH", "/api/me", { locale: "pt-BR" });
    const other = await s.client.call<MeBody>("PATCH", "/api/me", { shareEmailWithFollowedChannels: false });
    expect(other.body.locale).toBe("pt-BR");
  });

  test("the pseudo-locale is a valid tag; malformed tags are refused", async () => {
    const s = await signUpAndSignIn(api);
    const xa = await s.client.call<MeBody>("PATCH", "/api/me", { locale: "en-XA" });
    expect(xa.status).toBe(200);
    expect(xa.body.locale).toBe("en-XA");
    for (const bad of ["english", "EN", "en_US"]) {
      const res = await s.client.call("PATCH", "/api/me", { locale: bad });
      expect(res.status, bad).toBe(400);
    }
    expect((await s.client.call<MeBody>("GET", "/api/me")).body.locale).toBe("en-XA");
  });
});
