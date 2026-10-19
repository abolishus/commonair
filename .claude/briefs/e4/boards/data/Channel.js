// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Channel (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var MOD = { c: 'bdg-mod', t: 'M', l: 'Moderator' }, SUB = { c: 'bdg-sub', t: 'S', l: 'Subscriber' }, MEM = { c: 'bdg-mem', t: 'C', l: 'Co-op member' }, HOST = { c: 'bdg-host', t: 'B', l: 'Broadcaster' };
    function m(n, c, t, b) { return { n: n, c: c, t: t, b: b || [], sep: ': ', cls: '' }; }
    var msgs = [
      m('ohmslaw', 'c8', 'that pinch roller is GLAZED', [SUB]),
      m('kettlebell_kai', 'c3', 'isopropyl and a scotch pad, gently'),
      m('rivertide', 'c6', 'yeah going to try rubber rejuvenator first', [HOST]),
      m('Fernsby', 'c11', 'first time here, this is so calming', [MEM]),
      { n: '', c: '', t: 'Fernsby followed the channel', b: [], sep: '', cls: 'sys' },
      m('nightcap', 'c10', 'azimuth screw is the one on the left of the head right?'),
      m('voltagecontrol', 'c4', 'left one yes, mark it before you touch it', [MOD, SUB]),
      { n: 'paperlantern', c: 'c11', t: ' gifted 5 subs to the community!', b: [SUB], sep: '', cls: 'hl' },
      m('ohmslaw', 'c8', 'W', [SUB]),
      m('quietfox', 'c2', 'what solder are you using?'),
      m('rivertide', 'c6', 'SAC305 for this, leaded for the old boards', [HOST]),
      m('tapehead99', 'c9', 'my dad had this exact deck'),
      m('kettlebell_kai', 'c3', 'the VU meters on that thing are gorgeous'),
      m('Fernsby', 'c11', 'is there a VOD of the earlier part?', [MEM])
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', msgs: msgs };
  }
}
