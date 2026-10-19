// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board TrustSafety (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var reports = [
      ['High', 'badge-destructive', 'Harassment in chat', 'loudguy in rivertide', '14 m', '4', true],
      ['High', 'badge-destructive', 'Self-harm risk', 'stream · just chatting', '22 m', '2', false],
      ['Med', 'badge-warn', 'Unlabelled mature content', 'stream · art', '41 m', '6', false],
      ['Med', 'badge-warn', 'Spam / scam links', '14 accounts, same pattern', '1 h', '31', false],
      ['Low', 'badge-secondary', 'Impersonation', 'channel “rivert1de”', '3 h', '1', false],
      ['Low', 'badge-secondary', 'Misleading title', 'stream · hollow depths', '5 h', '1', false]
    ].map(function (r) { return { sev: r[0], cls: r[1], cat: r[2], target: r[3], age: r[4], n: r[5], sel: r[6] ? 'background: var(--muted)' : '' }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', reports: reports };
  }
}
