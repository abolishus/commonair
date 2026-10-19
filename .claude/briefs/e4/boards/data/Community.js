// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Community (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var queue = [
      { kind: 'Held by filter', cls: 'badge-warn', reason: 'Link from a new account', ago: '12 s ago', who: 'spamcannon_77', c: 'c2', text: 'cheap followers at [link]', primary: 'Allow', secondary: 'Deny' },
      { kind: 'User report', cls: 'badge-destructive', reason: 'Harassment · reported by 3 viewers', ago: '2 min ago', who: 'loudguy', c: 'c1', text: '[message hidden until reviewed]', primary: 'Show message', secondary: 'Dismiss report' },
      { kind: 'Held by filter', cls: 'badge-warn', reason: 'Blocked term list', ago: '4 min ago', who: 'gremlin_420', c: 'c7', text: '[1 blocked term]', primary: 'Allow', secondary: 'Deny' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', queue: queue };
  }
}
