// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The digest's preference re-check (ADR 0028 decision 4) and the job's registration. */
import { NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { describe, expect, test } from "vite-plus/test";
import { job } from "../src/jobs/notify-email-digest.ts";
import { emailEnabledFor } from "../src/notify/email/digest.ts";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";

describe("emailEnabledFor", () => {
  test("no rows: the built-in default (go-live email is opt-in, so off)", () => {
    expect(emailEnabledFor([], A)).toBe(false);
  });
  test("the member's default applies to a channel without an override", () => {
    expect(emailEnabledFor([{ channelId: null, enabled: true }], A)).toBe(true);
    expect(emailEnabledFor([{ channelId: null, enabled: false }], A)).toBe(false);
  });
  test("a channel override wins over the default, both ways", () => {
    expect(
      emailEnabledFor(
        [
          { channelId: null, enabled: true },
          { channelId: A, enabled: false },
        ],
        A,
      ),
    ).toBe(false);
    expect(
      emailEnabledFor(
        [
          { channelId: null, enabled: false },
          { channelId: A, enabled: true },
        ],
        A,
      ),
    ).toBe(true);
  });
  test("another channel's override does not apply", () => {
    expect(emailEnabledFor([{ channelId: B, enabled: true }], A)).toBe(false);
    expect(
      emailEnabledFor(
        [
          { channelId: null, enabled: true },
          { channelId: B, enabled: false },
        ],
        A,
      ),
    ).toBe(true);
  });
});

test("the sweep is scheduled on the email queue every emailDigestSweepMs, without retries", () => {
  expect(job.queue).toBe(QUEUES.email);
  expect(job.name).toBe(NOTIFY_JOBS.emailDigest);
  expect(job.schedule).toEqual({ every: NOTIFY_RULES.emailDigestSweepMs });
  expect(job.attempts).toBe(1);
});
