// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board StreamManager (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var br = [];
    for (var i = 0; i < 40; i++) br.push({ h: 72 + ((i * 13) % 20) });
    var feed = [
      { kind: 'Tip', cls: 'badge-ok', who: 'Fernsby', what: 'tipped $5.00 — “that glaze!!”', ago: '12 s ago' },
      { kind: 'Gift', cls: 'badge-accent', who: 'paperlantern', what: 'gifted 5 Tier 1 subs', ago: '2 min ago' },
      { kind: 'Raid', cls: 'badge-info', who: 'Lumen Kitchen', what: 'raided with 34 viewers', ago: '6 min ago' },
      { kind: 'Sub', cls: 'badge-accent', who: 'ohmslaw', what: 'subscribed at Tier 2 · 8 months', ago: '9 min ago' },
      { kind: 'Follow', cls: 'badge-secondary', who: 'tapehead99', what: 'followed', ago: '11 min ago' },
      { kind: 'Follow', cls: 'badge-secondary', who: 'quietfox', what: 'followed', ago: '14 min ago' },
      { kind: 'Points', cls: 'badge-outline', who: 'nightcap', what: 'redeemed “Pick the next glaze”', ago: '18 min ago' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', br: br, feed: feed };
  }
}
