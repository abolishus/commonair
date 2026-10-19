// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Revenue (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var tx = [
      ['Oct 17', 'Tip', 'badge-ok', 'Fernsby', '$5.00', '−$0.75', '$4.25'],
      ['Oct 17', 'Gift ×5', 'badge-accent', 'paperlantern', '$24.95', '−$7.25', '$17.70'],
      ['Oct 17', 'Sub T2', 'badge-accent', 'ohmslaw', '$9.99', '−$2.90', '$7.09'],
      ['Oct 16', 'Refund', 'badge-warn', 'tapehead99', '−$4.99', '+$1.45', '−$3.54'],
      ['Oct 15', 'Chargeback', 'badge-destructive', 'payment dispute #8812', '−$9.99', '+$2.90', '−$7.09'],
      ['Oct 15', 'Sub T1', 'badge-accent', 'quietfox', '$4.99', '−$1.45', '$3.54'],
      ['Oct 1', 'Payout', 'badge-secondary', 'Bank ••••6021', '—', '—', '−$1,102.33']
    ].map(function (r) { return { d: r[0], k: r[1], cls: r[2], who: r[3], g: r[4], f: r[5], n: r[6] }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', tx: tx };
  }
}
