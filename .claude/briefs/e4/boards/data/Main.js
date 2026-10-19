// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Main (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var followed = [
      { name: 'rivertide', i: 'R', acc: 'teal', cat: 'Science & Technology', v: '2.4K' },
      { name: 'Okonkwo Plays', i: 'O', acc: 'amber', cat: 'Hollow Depths', v: '318' },
      { name: 'paperlantern', i: 'P', acc: 'pink', cat: 'Art', v: '87' },
      { name: 'DJ Halcyon', i: 'D', acc: 'indigo', cat: 'Music', v: '1.1K' },
      { name: 'grumblebee', i: 'G', acc: 'lime', cat: 'Speedrunning', v: '42' }
    ];
    var spot = [
      { name: 'Tinwhistle', i: 'T', acc: 'sky', cat: 'Music', v: '23' },
      { name: 'quietfox', i: 'Q', acc: 'orange', cat: 'Just Chatting', v: '11' },
      { name: 'Lumen Kitchen', i: 'L', acc: 'green', cat: 'Food & Drink', v: '36' }
    ];
    var newLive = [
      { title: 'First stream ever! Learning pixel art from zero', name: 'mothwing', i: 'M', acc: 'violet', cat: 'Art', v: '14', reason: 'New streamer', tags: ['Beginner', 'English'] },
      { title: 'Cozy farm sim, building the second greenhouse', name: 'harrowfield', i: 'H', acc: 'lime', cat: 'Meadowlight', v: '29', reason: 'New streamer', tags: ['Cozy'] },
      { title: 'Late-night synth jam — requests open', name: 'Tinwhistle', i: 'T', acc: 'sky', cat: 'Music', v: '23', reason: 'Spotlight', tags: ['Synth', 'Requests'] },
      { title: 'Translating old manga panels live', name: 'kanjikat', i: 'K', acc: 'red', cat: 'Just Chatting', v: '58', reason: 'New streamer', tags: ['Japanese', 'Language'] }
    ];
    var cats = [
      { name: 'Just Chatting', g: 'JC', acc: 'zinc', v: '18.2K' },
      { name: 'Music', g: 'M', acc: 'indigo', v: '6.4K' },
      { name: 'Hollow Depths', g: 'HD', acc: 'amber', v: '5.9K' },
      { name: 'Art', g: 'A', acc: 'pink', v: '3.1K' },
      { name: 'Science & Technology', g: 'ST', acc: 'teal', v: '2.8K' },
      { name: 'Speedrunning', g: 'SR', acc: 'lime', v: '2.2K' },
      { name: 'Food & Drink', g: 'FD', acc: 'green', v: '1.5K' }
    ];
    var live = [
      { title: 'Ranked grind to Diamond — chat picks my loadout', name: 'Okonkwo Plays', i: 'O', acc: 'amber', cat: 'Hollow Depths', v: '318', reason: 'Popular', tags: ['Competitive', 'English'] },
      { title: 'Friday house set from the balcony', name: 'DJ Halcyon', i: 'D', acc: 'indigo', cat: 'Music', v: '1.1K', reason: 'Popular', tags: ['DJ', 'House'] },
      { title: 'Watercolor landscapes, slow and quiet', name: 'paperlantern', i: 'P', acc: 'pink', cat: 'Art', v: '87', reason: 'Spotlight', tags: ['Relaxing'] },
      { title: 'Any% WR attempts, reset counter on screen', name: 'grumblebee', i: 'G', acc: 'lime', cat: 'Speedrunning', v: '42', reason: 'Spotlight', tags: ['Any%'] },
      { title: 'Sourdough, round two: the starter survived', name: 'Lumen Kitchen', i: 'L', acc: 'green', cat: 'Food & Drink', v: '36', reason: 'Spotlight', tags: ['Baking'] },
      { title: 'Q&A about moving abroad, ask me anything', name: 'quietfox', i: 'Q', acc: 'orange', cat: 'Just Chatting', v: '11', reason: 'New streamer', tags: ['IRL'] },
      { title: 'Co-op council open session: patronage formula', name: 'commonair', i: 'C', acc: 'zinc', cat: 'Co-op', v: '204', reason: 'Popular', tags: ['Governance'] },
      { title: 'Rebuilding a 1970s tape deck', name: 'rivertide', i: 'R', acc: 'teal', cat: 'Science & Technology', v: '2.4K', reason: 'Popular', tags: ['Repair'] }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', followed: followed, spot: spot, newLive: newLive, cats: cats, live: live };
  }
}
