<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/payments

Payment-provider adapters behind one interface (`src/adapter.ts`): `manual` (the default, no vendor)
and the optional `stripe` (test mode only). Adapters talk to the provider; callers own ledger
postings, subscription state, events and audit rows. `manualReference()` mints the `CA-XXXXXXXX`
references payers quote to the treasurer.
