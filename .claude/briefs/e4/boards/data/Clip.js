// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Clip (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var frames = [];
    for (var i = 0; i < 18; i++) frames.push({ mix: 12 + ((i * 7) % 24) });
    var more = [
      { t: 'Capacitor goes pop, chat goes wild', len: '0:19', views: '12K', ago: '3 days ago' },
      { t: 'How to read a schematic in 60 seconds', len: '0:58', views: '4.4K', ago: '1 week ago' },
      { t: 'The world’s slowest desolder', len: '0:33', views: '2.1K', ago: '2 weeks ago' },
      { t: 'VU meters dancing for the first time', len: '0:25', views: '1.7K', ago: '3 weeks ago' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', frames: frames, more: more };
  }
}
