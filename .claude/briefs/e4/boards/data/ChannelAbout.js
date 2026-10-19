// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board ChannelAbout (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var vods = [
      { title: 'Patch from zero: FM bells on a 4-op', len: '2:58:12', ago: '2 days ago', views: '1.1K' },
      { title: 'Listener tracks review #14', len: '1:47:30', ago: '5 days ago', views: '640' },
      { title: 'Patch from zero: West-coast plucks', len: '3:05:44', ago: '1 week ago', views: '1.4K' }
    ];
    var clips = [
      { title: 'The accidental drone that ate the stream', len: '0:38', by: 'ohmslaw', views: '6.1K' },
      { title: 'Explaining wavefolding with a slinky', len: '1:02', by: 'nightcap', views: '3.3K' },
      { title: 'Chat finally gets the filter joke', len: '0:21', by: 'Fernsby', views: '980' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', vods: vods, clips: clips };
  }
}
