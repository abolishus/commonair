// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Analytics (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var bars = [];
    for (var i = 0; i < 30; i++) { var off = (i % 7 === 2 || i % 7 === 5); bars.push({ h: off ? 3 : Math.min(98, 48 + i * 1.4 + ((i * 17) % 13)) }); }
    var sources = [
      { k: 'Following feed', p: 41, c: 'var(--chart-1)' }, { k: 'Directory & spotlight', p: 27, c: 'var(--chart-2)' },
      { k: 'Raids & hosts', p: 14, c: 'var(--chart-4)' }, { k: 'Search', p: 9, c: 'var(--chart-3)' }, { k: 'External links & embeds', p: 9, c: 'var(--chart-5)' }
    ];
    var streams = [
      { d: 'Oct 17', t: 'Glaze tests: copper reds, round 4', len: '3:12', avg: '341', peak: '468', f: '+37', m: '1,804' },
      { d: 'Oct 15', t: 'Throwing big bowls, viewer challenges', len: '2:48', avg: '322', peak: '512', f: '+52', m: '2,130' },
      { d: 'Oct 12', t: 'Kiln unloading — the moment of truth', len: '1:55', avg: '398', peak: '612', f: '+118', m: '3,402' },
      { d: 'Oct 10', t: 'Trimming and Q&A', len: '2:30', avg: '254', peak: '310', f: '+21', m: '1,066' },
      { d: 'Oct 8', t: 'Glaze tests: copper reds, round 3', len: '3:05', avg: '271', peak: '355', f: '+30', m: '1,511' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', bars: bars, sources: sources, streams: streams };
  }
}
