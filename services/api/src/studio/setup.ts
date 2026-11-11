// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's "Ready to go live" checklist (overhaul wave 3, D5.1; creator-studio.md P1). Every
 * step but the `STREAM_SETUP_MARKABLE` ones is derived from rows other features already write, so
 * a step is done when the server state says so, never because a button was clicked:
 *
 * - `channel_profile`: the channel has a description, a theme avatar, or the owner a profile image;
 * - `stream_info`: the channel's title and category are both set;
 * - `stream_key`: an unrevoked stream key exists;
 * - `encoder_connected`: a `broadcasts` row exists, of either kind. The MediaMTX ready hook
 *   (`media/hooks.ts` `mediaReady`) inserts one the moment an encoder's publish is accepted, live
 *   or rehearsal, so this covers "connected now" (an open row) and "connected ever" (an ended one);
 * - `rehearsal` (optional): a `kind = 'rehearsal'` broadcast exists;
 * - `first_live`: a `kind = 'live'` broadcast exists;
 * - `import_twitch`: null unless the owner signed up with `intent=import`; then a finished
 *   (`done`) Twitch import, and null again while the instance has the import switched off and none
 *   finished (a step nobody can complete must not block `complete`);
 * - `bring_your_audience`: a `channel_setup_steps` row (`stream.setupMark`).
 *
 * One round trip: every check is a scalar subquery of a single select.
 */
import { and, eq, sql } from "drizzle-orm";
import { STREAM_SETUP_STEPS, type StreamSetupMarkable, type StreamSetupStep } from "@commonair/contracts/enums";
import type { StreamSetupState } from "@commonair/contracts/dto";
import { type Database, schema } from "@commonair/db";

const { broadcasts, channelSetupSteps, channels, portabilityImports, streamKeys, users } = schema;

/** Steps the checklist shows but `complete` does not wait for. */
export const OPTIONAL_SETUP_STEPS: ReadonlySet<StreamSetupStep> = new Set(["rehearsal"]);

export interface SetupFacts {
  profile: boolean;
  streamInfo: boolean;
  streamKey: boolean;
  anyBroadcast: boolean;
  rehearsal: boolean;
  live: boolean;
  signupIntent: StreamSetupState["signupIntent"];
  twitchImportDone: boolean;
  audienceMarked: boolean;
}

/** The step list from the facts; pure, so the rules are unit-tested without a database. */
export function setupStateFromFacts(facts: SetupFacts, twitchImportAvailable: boolean): StreamSetupState {
  const importStep =
    facts.signupIntent !== "import" ? null : facts.twitchImportDone ? true : twitchImportAvailable ? false : null;
  const done: Record<StreamSetupStep, boolean | null> = {
    channel_profile: facts.profile,
    stream_info: facts.streamInfo,
    stream_key: facts.streamKey,
    encoder_connected: facts.anyBroadcast,
    rehearsal: facts.rehearsal,
    first_live: facts.live,
    import_twitch: importStep,
    bring_your_audience: facts.audienceMarked,
  };
  const steps = STREAM_SETUP_STEPS.map((step) => ({
    step,
    done: done[step],
    optional: OPTIONAL_SETUP_STEPS.has(step),
  }));
  return {
    steps,
    signupIntent: facts.signupIntent,
    complete: steps.every((s) => s.optional || s.done !== false),
  };
}

const exists = (q: ReturnType<typeof sql>) => sql<boolean>`exists (${q})`.mapWith(Boolean);

/** Reads every fact for one channel in one query. */
export async function readSetupFacts(db: Database, channelId: string): Promise<SetupFacts> {
  const [row] = await db
    .select({
      profile: sql<boolean>`(
        ${channels.description} <> ''
        or coalesce(${channels.theme}->>'avatarKey', '') <> ''
        or coalesce(${users.image}, '') <> ''
      )`.mapWith(Boolean),
      streamInfo: sql<boolean>`(${channels.title} <> '' and ${channels.categoryId} is not null)`.mapWith(Boolean),
      streamKey: exists(
        sql`select 1 from ${streamKeys} where ${streamKeys.channelId} = ${channels.id} and ${streamKeys.revokedAt} is null`,
      ),
      anyBroadcast: exists(sql`select 1 from ${broadcasts} where ${broadcasts.channelId} = ${channels.id}`),
      rehearsal: exists(
        sql`select 1 from ${broadcasts} where ${broadcasts.channelId} = ${channels.id} and ${broadcasts.kind} = 'rehearsal'`,
      ),
      live: exists(
        sql`select 1 from ${broadcasts} where ${broadcasts.channelId} = ${channels.id} and ${broadcasts.kind} = 'live'`,
      ),
      signupIntent: users.signupIntent,
      twitchImportDone: exists(
        sql`select 1 from ${portabilityImports} where ${portabilityImports.channelId} = ${channels.id}
            and ${portabilityImports.source} = 'twitch' and ${portabilityImports.status} = 'done'`,
      ),
      audienceMarked: exists(
        sql`select 1 from ${channelSetupSteps} where ${channelSetupSteps.channelId} = ${channels.id}
            and ${channelSetupSteps.step} = 'bring_your_audience'`,
      ),
    })
    .from(channels)
    .innerJoin(users, eq(users.id, channels.ownerId))
    .where(eq(channels.id, channelId));
  if (!row) throw new Error("setup facts: channel not found");
  return row;
}

export async function readSetupState(
  db: Database,
  channelId: string,
  twitchImportAvailable: boolean,
): Promise<StreamSetupState> {
  return setupStateFromFacts(await readSetupFacts(db, channelId), twitchImportAvailable);
}

/**
 * Marks an owner-marked step done; a repeat keeps the first mark's time. Nothing outside the
 * checklist reads these rows, so there is no outbox event (the funnel counts the click itself
 * through `metrics.ui`).
 */
export async function markSetupStep(db: Database, channelId: string, step: StreamSetupMarkable): Promise<void> {
  await db.insert(channelSetupSteps).values({ channelId, step }).onConflictDoNothing();
}

/** For tests: whether a mark exists. */
export async function setupStepMarked(db: Database, channelId: string, step: StreamSetupMarkable): Promise<boolean> {
  const rows = await db
    .select({ step: channelSetupSteps.step })
    .from(channelSetupSteps)
    .where(and(eq(channelSetupSteps.channelId, channelId), eq(channelSetupSteps.step, step)));
  return rows.length > 0;
}
