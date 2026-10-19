// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Search (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var channels = [
      { name: 'Tinwhistle', i: 'T', acc: 'sky', live: true, member: true, sub: 'Live: Late-night synth jam — requests open', f: '1.2K' },
      { name: 'voltagecontrol', i: 'V', acc: 'lime', live: true, member: false, sub: 'Live: Modular patch from scratch', f: '3.4K' },
      { name: 'synthesist_ana', i: 'S', acc: 'pink', live: false, member: true, sub: 'Last live 2 days ago · Music', f: '806' },
      { name: 'synthkid', i: 'S', acc: 'orange', live: false, member: false, sub: 'Last live 3 weeks ago · Software & Game Dev', f: '74' }
    ].map(function (c) { c.ring = c.live ? 'av-live' : ''; return c; });
    var videos = [
      { title: 'Building a 4-voice poly from kits, part 2', name: 'voltagecontrol', i: 'V', acc: 'lime', kind: 'Past broadcast', len: '3:12:40', ago: '2 days ago', views: '1.8K' },
      { title: 'That bass patch everyone asked about', name: 'Tinwhistle', i: 'T', acc: 'sky', kind: 'Clip', len: '0:42', ago: '5 days ago', views: '6.1K' },
      { title: 'Synth basics for total beginners', name: 'synthesist_ana', i: 'S', acc: 'pink', kind: 'Highlight', len: '24:08', ago: '1 week ago', views: '2.3K' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', channels: channels, videos: videos };
  }
}
