// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Settings the N1 units read: the cached go-live governance setting and web push (ADR 0028). */
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  clearGoLiveSettingCache,
  DEFAULT_GO_LIVE_SETTING,
  GO_LIVE_SETTING_TTL_MS,
  goLiveSetting,
  webPushSettings,
} from "../src/notify/settings.ts";

/** A db whose `select().from().where()` answers the queued rows, counting reads. */
function fakeDb(answers: unknown[][]) {
  const db = {
    reads: 0,
    select: () => ({
      from: () => ({
        where: async () => {
          db.reads++;
          return answers.shift() ?? [];
        },
      }),
    }),
  };
  return db;
}
const logger = () => {
  const errors: { msg: string; fields: unknown }[] = [];
  return { errors, error: (msg: string, fields?: unknown) => void errors.push({ msg, fields }) };
};

describe("goLiveSetting", () => {
  afterEach(clearGoLiveSettingCache);

  test("the default is the seeded value", () => {
    expect(DEFAULT_GO_LIVE_SETTING).toEqual(
      DEFAULT_GOVERNANCE_SETTINGS.find((s) => s.key === "notifications.goLive")?.value,
    );
    expect(DEFAULT_GO_LIVE_SETTING).toEqual({ cooldownHours: 4, emailDigestMinutes: 5 });
  });

  test("reads the stored value and caches it per process for 30 s", async () => {
    const db = fakeDb([
      [{ value: { cooldownHours: 2, emailDigestMinutes: 0 } }],
      [{ value: { cooldownHours: 6, emailDigestMinutes: 1 } }],
    ]);
    const log = logger();
    const at = 1_000_000;
    expect(await goLiveSetting(db as never, log, at)).toEqual({ cooldownHours: 2, emailDigestMinutes: 0 });
    expect(await goLiveSetting(db as never, log, at + GO_LIVE_SETTING_TTL_MS - 1)).toEqual({
      cooldownHours: 2,
      emailDigestMinutes: 0,
    });
    expect(db.reads).toBe(1);
    expect(await goLiveSetting(db as never, log, at + GO_LIVE_SETTING_TTL_MS)).toEqual({
      cooldownHours: 6,
      emailDigestMinutes: 1,
    });
    expect(db.reads).toBe(2);
    expect(log.errors).toEqual([]);
  });

  test.each([
    ["missing", []],
    ["invalid", [{ value: { cooldownHours: 0, emailDigestMinutes: 5 } }]],
  ])("a %s value falls back to the default, logged", async (_, rows) => {
    const log = logger();
    expect(await goLiveSetting(fakeDb([rows]) as never, log, 1)).toEqual(DEFAULT_GO_LIVE_SETTING);
    expect(log.errors).toHaveLength(1);
  });
});

describe("webPushSettings", () => {
  const site = { contacts: { general: "ops@instance.test" } } as never;
  test("undefined while push is off", () => {
    expect(
      webPushSettings({ WEB_PUSH_ENABLED: false, WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: false }, site),
    ).toBeUndefined();
  });

  test("on: the pair, the instance's contact as the VAPID subject, the insecure switch", () => {
    expect(
      webPushSettings(
        {
          WEB_PUSH_ENABLED: true,
          VAPID_PUBLIC_KEY: "pub",
          VAPID_PRIVATE_KEY: "priv",
          WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: true,
        },
        site,
      ),
    ).toEqual({ publicKey: "pub", privateKeyPkcs8: "priv", subject: "mailto:ops@instance.test", allowInsecure: true });
  });

  test("on without a key throws", () => {
    expect(() =>
      webPushSettings(
        { WEB_PUSH_ENABLED: true, VAPID_PUBLIC_KEY: "pub", WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: false },
        site,
      ),
    ).toThrow(/VAPID/);
  });
});
