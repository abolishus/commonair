// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board ChatBot (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var cmds = [
      ['!schedule', 'Tue/Thu 19:00 UTC — full schedule on the channel page', 'Everyone', '30 s', '412', true],
      ['!kiln', 'Cone 6 electric, controller is a Bartlett Genesis', 'Everyone', '30 s', '188', true],
      ['!uptime', 'Live for ${uptime}', 'Everyone', '10 s', '902', true],
      ['!points', '${user}, you have ${points} glaze points', 'Everyone', '5 s', '1,610', true],
      ['!so', 'Go follow ${1} — they were last live in ${1.category}', 'Mods', '0 s', '57', true],
      ['!discord', 'Community server link (members only)', 'Subscribers', '60 s', '33', false]
    ].map(function (r) { return { k: r[0], r: r[1], who: r[2], cd: r[3], n: r[4], on: r[5] ? 'on' : '', lbl: r[5] ? 'Enabled' : 'Disabled' }; });
    var emotes = [
      { n: 'miraHype', g: 'H', acc: 'violet' }, { n: 'miraKiln', g: 'K', acc: 'orange' }, { n: 'miraCrack', g: 'C', acc: 'red' },
      { n: 'miraGlaze', g: 'G', acc: 'teal' }, { n: 'miraWave', g: 'W', acc: 'sky' }, { n: 'miraPot', g: 'P', acc: 'amber' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', cmds: cmds, emotes: emotes };
  }
}
