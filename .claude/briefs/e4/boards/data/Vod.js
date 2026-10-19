// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Vod (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var rows = [
      ['1:10:02', 'nightcap', 'c10', 'ratio 3.5 sounds like a church bell'], ['1:10:15', 'ohmslaw', 'c8', 'the inharmonics!!'],
      ['1:10:41', 'synthesist_ana', 'c11', 'exactly, non-integer ratios = clangorous'], ['1:11:03', 'Fernsby', 'c11', 'saving this VOD forever'],
      ['1:11:20', 'tapehead99', 'c9', 'what is the feedback knob doing'], ['1:11:28', 'voltagecontrol', 'c4', 'op4 feeding into itself, gets saw-ish'],
      ['1:11:50', 'quietfox', 'c2', 'my ears are happy'], ['1:12:05', 'kettlebell_kai', 'c3', 'can you share the patch file?'],
      ['1:12:19', 'synthesist_ana', 'c11', 'it’s in the description after stream'], ['1:12:33', 'nightcap', 'c10', 'ty!'],
      ['1:12:38', 'ohmslaw', 'c8', 'add a slow LFO on the index'], ['1:12:40', 'Fernsby', 'c11', 'ooooh']
    ];
    var msgs = rows.map(function (r) { return { ts: r[0], n: r[1], c: r[2], t: r[3] }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', msgs: msgs };
  }
}
