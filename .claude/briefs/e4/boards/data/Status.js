// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Status (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    function days(bad, warn, today) {
      var out = [];
      for (var i = 0; i < 90; i++) {
        var c = 'var(--chart-2)';
        if (bad.indexOf(i) >= 0) c = 'var(--destructive)'; else if (warn.indexOf(i) >= 0) c = 'var(--chart-3)';
        if (i === 89 && today) c = today;
        out.push({ c: c });
      }
      return out;
    }
    var comps = [
      { n: 'Website & API', d: 'Pages, sign-in, REST', up: '99.97%', state: 'Operational', cls: 'badge-ok', days: days([], [31], null) },
      { n: 'Ingest', d: 'RTMP, WHIP, SRT', up: '99.95%', state: 'Operational', cls: 'badge-ok', days: days([31], [], null) },
      { n: 'Video delivery', d: 'Origin + edge', up: '99.92%', state: 'Operational', cls: 'badge-ok', days: days([31], [32], null) },
      { n: 'Community relays', d: '142 online', up: '—', state: 'Operational', cls: 'badge-ok', days: days([], [], null) },
      { n: 'Chat', d: 'WebSocket + IRC gateway', up: '99.88%', state: 'Degraded', cls: 'badge-warn', days: days([], [12, 58], 'var(--chart-3)') },
      { n: 'Payments', d: 'Subscriptions, tips, payouts', up: '100%', state: 'Operational', cls: 'badge-ok', days: days([], [], null) },
      { n: 'Webhooks & events', d: 'Developer deliveries', up: '99.90%', state: 'Operational', cls: 'badge-ok', days: days([], [44], null) },
      { n: 'Email', d: 'Verification, notifications', up: '99.99%', state: 'Operational', cls: 'badge-ok', days: days([], [], null) }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', comps: comps };
  }
}
