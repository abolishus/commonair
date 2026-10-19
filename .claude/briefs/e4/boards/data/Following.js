// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Following (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var live = [
      { title: 'Rebuilding a 1970s tape deck', name: 'rivertide', i: 'R', acc: 'teal', cat: 'Science & Technology', v: '2.4K', up: '3:41:09' },
      { title: 'Friday house set from the balcony', name: 'DJ Halcyon', i: 'D', acc: 'indigo', cat: 'Music', v: '1.1K', up: '1:12:55' },
      { title: 'Ranked grind to Diamond — chat picks my loadout', name: 'Okonkwo Plays', i: 'O', acc: 'amber', cat: 'Hollow Depths', v: '318', up: '5:02:17' },
      { title: 'Watercolor landscapes, slow and quiet', name: 'paperlantern', i: 'P', acc: 'pink', cat: 'Art', v: '87', up: '0:48:30' },
      { title: 'Any% WR attempts, reset counter on screen', name: 'grumblebee', i: 'G', acc: 'lime', cat: 'Speedrunning', v: '42', up: '2:20:03' }
    ];
    var offline = [
      { name: 'synthesist_ana', i: 'S', acc: 'pink', last: 'Live 2 days ago · Music', next: 'Tomorrow 19:00' },
      { name: 'Wren & Ash', i: 'W', acc: 'amber', last: 'Live 4 days ago · Music', next: 'Sat 20:00' },
      { name: 'boardgame.bureau', i: 'B', acc: 'violet', last: 'Live 1 week ago · Tabletop RPGs', next: 'Sun 18:00' },
      { name: 'Lumen Kitchen', i: 'L', acc: 'green', last: 'Live yesterday · Food & Drink', next: 'Not scheduled' },
      { name: 'kanjikat', i: 'K', acc: 'red', last: 'Live 3 days ago · Just Chatting', next: 'Mon 12:00' },
      { name: 'stackframe', i: 'S', acc: 'sky', last: 'Live 2 weeks ago · Software & Game Dev', next: 'Not scheduled' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', live: live, offline: offline };
  }
}
