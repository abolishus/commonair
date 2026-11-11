// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `Channel.ownerCoop` (overhaul D4.7, trust marks): whether the channel's owner is a co-op
 * member now (an active `memberships` row of any class) and whether they hold a seat on the
 * current council (`council_members` of the term `currentCouncilTerm` picks: the newest computed
 * term that covers now). Both are public facts (seats are listed on `/coop/council`).
 *
 * One round trip of two indexed EXISTS probes, so `toChannelDto` stays cheap.
 */
import { sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";

const { memberships, councilTerms, councilMembers } = schema;

export interface OwnerCoop {
  member: boolean;
  council: boolean;
}

export async function ownerCoop(deps: Pick<Deps, "db">, ownerId: string): Promise<OwnerCoop> {
  const rows = await deps.db.execute<{ member: boolean; council: boolean }>(sql`
    select
      exists (
        select 1 from ${memberships}
        where ${memberships.userId} = ${ownerId}::uuid and ${memberships.status} = 'active'
      ) as member,
      exists (
        select 1 from ${councilMembers}
        where ${councilMembers.userId} = ${ownerId}::uuid
          and ${councilMembers.termId} = (
            select ${councilTerms.id} from ${councilTerms}
            where ${councilTerms.startsAt} <= clock_timestamp() and ${councilTerms.endsAt} > clock_timestamp()
            order by ${councilTerms.computedAt} desc, ${councilTerms.id} desc
            limit 1
          )
      ) as council
  `);
  const row = rows[0];
  return { member: row?.member === true, council: row?.council === true };
}
