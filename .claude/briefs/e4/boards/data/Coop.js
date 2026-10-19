// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Coop (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var props = [
      { n: 47, t: 'Lower the creator share of subscriptions from 71% to 65%', prot: true, status: 'Voting', scls: 'badge-info', sum: 'Fund a second origin region by moving 6 points of every subscription to infrastructure for 12 months.', ends: 'Closes in 3 days', turnout: '38%', turnoutW: 38, comments: 214, voted: true },
      { n: 48, t: 'Add a small-channel seat to the creator council', prot: false, status: 'Voting', scls: 'badge-info', sum: 'Reserve one more council seat for channels averaging under 50 verified viewers.', ends: 'Closes in 6 days', turnout: '21%', turnoutW: 21, comments: 88, voted: false },
      { n: 49, t: 'Adopt a clearer mature-content labelling policy', prot: false, status: 'Council review', scls: 'badge-warn', sum: 'Replaces the single mature flag with three labels and an 18+ gate for the strongest.', ends: 'Voting opens Oct 25', turnout: '—', turnoutW: 0, comments: 41, voted: false }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', props: props };
  }
}
