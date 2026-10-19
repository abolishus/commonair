// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Browse (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var cats = [
      ['Just Chatting', 'JC', 'zinc', '18.2K', '412', 'IRL'], ['Music', 'M', 'indigo', '6.4K', '188', 'Creative'],
      ['Hollow Depths', 'HD', 'amber', '5.9K', '96', 'Competitive'], ['Art', 'A', 'pink', '3.1K', '143', 'Creative'],
      ['Science & Technology', 'ST', 'teal', '2.8K', '61', 'Educational'], ['Speedrunning', 'SR', 'lime', '2.2K', '74', 'Competitive'],
      ['Food & Drink', 'FD', 'green', '1.5K', '39', 'IRL'], ['Meadowlight', 'ML', 'lime', '1.4K', '52', 'Cozy'],
      ['Software & Game Dev', 'SD', 'sky', '1.2K', '58', 'Educational'], ['Retro', 'R', 'orange', '1.1K', '47', 'Nostalgia'],
      ['Tabletop RPGs', 'TT', 'violet', '980', '22', 'Creative'], ['Chess', 'C', 'zinc', '910', '31', 'Competitive'],
      ['Fitness & Health', 'FH', 'red', '640', '19', 'IRL'], ['Makers & Crafting', 'MC', 'amber', '590', '27', 'Creative'],
      ['Starfall Tactics', 'SF', 'blue', '530', '18', 'Strategy'], ['Co-op', 'CO', 'zinc', '204', '3', 'Governance'],
      ['Travel & Outdoors', 'TO', 'teal', '188', '9', 'IRL'], ['Podcasts', 'P', 'indigo', '160', '12', 'Talk']
    ].map(function (r) { return { name: r[0], g: r[1], acc: r[2], v: r[3], ch: r[4], tag: r[5] }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', cats: cats };
  }
}
