-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- The counts a restore drill compares (ADR 0032 §4, after restore-owner.sql's procedure). Run it
-- as the owner against the source and against the restored copy; the two outputs must be equal,
-- and on each the `ledger.balance` values are 0 and `follows.count_mismatch` is 0:
--
--   rows.<schema>.<table>       row count of every table
--   ledger.balance.<currency>   sum of ledger entries in that currency (double entry: 0)
--   follows.count_mismatch      channels whose follower_count differs from their counted follows
--
-- Read-only: one SELECT, no functions created.

SELECT 'rows.' || n.nspname || '.' || c.relname AS check_name,
       (xpath('/row/n/text()',
              query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')
       ))[1]::text::bigint AS value
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle')
UNION ALL
SELECT 'ledger.balance.' || currency, sum(amount_cents)::bigint
FROM public.ledger_entries GROUP BY currency
UNION ALL
SELECT 'follows.count_mismatch', count(*)
FROM public.channels ch
WHERE ch.follower_count <> (
  SELECT count(*) FROM public.follows f WHERE f.channel_id = ch.id AND f.excluded_at IS NULL
)
ORDER BY 1;
