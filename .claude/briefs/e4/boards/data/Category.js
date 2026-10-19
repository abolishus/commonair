// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Category (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var live = [
      ['Friday house set from the balcony', 'DJ Halcyon', 'D', 'indigo', '1.1K', 'Popular', ['DJ', 'House'], false],
      ['Late-night synth jam — requests open', 'Tinwhistle', 'T', 'sky', '23', 'Spotlight', ['Synth'], false],
      ['Writing a song in one stream, start to master', 'Wren & Ash', 'W', 'amber', '312', 'Popular', ['Production'], false],
      ['Classical guitar practice, études 1–6', 'nylonstring', 'N', 'orange', '17', 'New streamer', ['Classical'], false],
      ['Listening party: new album, first spin', 'basementradio', 'B', 'red', '640', 'Popular', ['Talk'], true],
      ['Lo-fi beats while I tidy the studio', 'cassette.wav', 'C', 'violet', '58', 'Spotlight', ['Lo-fi'], false],
      ['Drum covers, chat picks the song', 'Rimshot Rosa', 'R', 'pink', '204', 'Popular', ['Drums', 'Requests'], false],
      ['Choir rehearsal livestream', 'Northgate Singers', 'N', 'teal', '41', 'New streamer', ['Vocal'], false],
      ['Modular patch from scratch', 'voltagecontrol', 'V', 'lime', '96', 'Spotlight', ['Modular'], false],
      ['Folk session from the pub back room', 'Harrow & Hound', 'H', 'green', '133', 'Popular', ['Folk'], false],
      ['Piano requests until midnight', 'ivorykeys', 'I', 'blue', '275', 'Popular', ['Piano'], false],
      ['Beat battle practice', 'loopsmith', 'L', 'zinc', '12', 'New streamer', ['Hip-hop'], false]
    ].map(function (r) { return { title: r[0], name: r[1], i: r[2], acc: r[3], v: r[4], reason: r[5], tags: r[6], mature: r[7] }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', live: live };
  }
}
