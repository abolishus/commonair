// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Content (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var vids = [
      ['Glaze tests: copper reds, round 4', 'Oct 17', 'Makers & Crafting', '3:12:04', 'Public', '412', 'in 60 days', true],
      ['Throwing big bowls, viewer challenges', 'Oct 15', 'Makers & Crafting', '2:48:51', 'Public', '1,208', 'in 58 days', true],
      ['Kiln unloading — the moment of truth', 'Oct 12', 'Makers & Crafting', '1:55:10', 'Highlight', '4,981', 'never', false],
      ['Trimming and Q&A', 'Oct 10', 'Makers & Crafting', '2:30:22', 'Subscribers', '366', 'in 53 days', false],
      ['Glaze tests: copper reds, round 3', 'Oct 8', 'Makers & Crafting', '3:05:39', 'Public', '702', 'in 51 days', false],
      ['Studio tour + music (muted segments)', 'Oct 5', 'Just Chatting', '1:12:48', 'Muted 0:12', '230', 'in 48 days', false],
      ['Glaze chemistry for beginners', 'Oct 3', 'Makers & Crafting', '0:48:15', 'Private', '0', 'in 46 days', false]
    ].map(function (r) {
      var cls = r[4] === 'Public' ? 'badge-ok' : r[4] === 'Highlight' ? 'badge-accent' : r[4].indexOf('Muted') === 0 ? 'badge-warn' : 'badge-secondary';
      return { t: r[0], d: r[1], cat: r[2], len: r[3], vis: r[4], vcls: cls, views: r[5], exp: r[6], selected: r[7], sel: r[7] ? 'on' : '' };
    });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', vids: vids };
  }
}
