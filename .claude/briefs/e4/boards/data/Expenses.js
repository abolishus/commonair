// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Expenses (all values are fixtures).

class Component extends DCLogic {
  constructor(props) { super(props); this.state = { basis: 'month' }; }
  renderVals() {
    var self = this, unit = this.state.basis === 'unit';
    var VH = 3950; // thousand verified viewer-hours in the last 30 days
    var rows = [
      ['Bare-metal servers (EU)', 'origin, API, chat, Postgres', 'flat, per server', '6 servers', '$306.67', 1840, '0%', 'var(--chart-1)'],
      ['Bare-metal servers (US)', 'edge cache, chat replica', 'flat, per server', '4 servers', '$290.00', 1160, '0%', 'var(--chart-1)'],
      ['GPU transcoding nodes', 'adaptive renditions (NVENC)', 'per hour used', '2,710 h', '$0.30', 813, '+6%', 'var(--chart-1)'],
      ['Cloud burst compute', 'overflow transcoding', 'per hour used', '412 h', '$0.74', 305, '−22%', 'var(--chart-1)'],
      ['Transit bandwidth', 'video egress not served by relays', 'per TB over commit', '512 TB', '$2.80', 1434, '−11%', 'var(--chart-5)'],
      ['Object storage', 'VODs, clips, thumbnails, backups', 'per TB-month', '96 TB', '$6.00', 576, '+4%', 'var(--chart-5)'],
      ['Backup storage (offsite)', 'WAL archives, nightly dumps', 'per TB-month', '18 TB', '$5.00', 90, '+2%', 'var(--chart-5)'],
      ['Transactional email', 'verification, go-live, statements', 'per 1,000 emails', '214K', '$0.65', 139, '+9%', 'var(--chart-5)'],
      ['DNS, domains & TLS', 'name service, certificates', 'flat', '—', '—', 24, '0%', 'var(--muted-foreground)'],
      ['Status page host', 'separate infra for status', 'flat', '1 server', '$12.00', 12, '0%', 'var(--muted-foreground)']
    ];
    var svcs = rows.map(function (r) {
      var cost = unit ? '$' + (r[5] / VH).toFixed(3) : '$' + r[5].toLocaleString('en-US');
      return { n: r[0], runs: r[1], basis: r[2], use: r[3], unit: r[4], cost: cost, delta: r[6], dcls: r[6].charAt(0) === '+' ? 'delta-down' : r[6].charAt(0) === '−' ? 'delta-up' : 'muted', c: r[7] };
    });
    var vh = [
      ['Video egress (origin + edge)', '$0.0029', 48], ['Transcoding', '$0.0016', 26], ['Storage (VOD, clips)', '$0.0007', 11],
      ['Chat & API', '$0.0005', 8], ['Trust & safety review', '$0.0004', 7]
    ].map(function (r) { return { k: r[0], v: r[1], w: r[2] }; });
    var inv = [
      ['Oct 15', 'Transit bandwidth · September overage', '$1,612.40', 'treasurer + infra lead'],
      ['Oct 10', 'GPU transcoding nodes · September', '$768.20', 'treasurer'],
      ['Oct 3', 'Trust & safety contractor A · September', '$480.00', 'treasurer + T&S lead'],
      ['Oct 1', 'Bare-metal servers (EU) · October', '$1,840.00', 'treasurer'],
      ['Oct 1', 'Bare-metal servers (US) · October', '$1,160.00', 'treasurer'],
      ['Sep 30', 'Accounting firm · Q3 bookkeeping', '$1,350.00', 'treasurer + council chair']
    ].map(function (r) { return { d: r[0], s: r[1], a: r[2], by: r[3] }; });
    return {
      themeClass: this.props.theme === 'light' ? 'light' : '', svcs: svcs, vh: vh, inv: inv,
      costHead: unit ? 'Cost / 1K viewer-h' : 'Cost / month',
      bMonth: unit ? 'false' : 'true', bUnit: unit ? 'true' : 'false',
      toMonth: function () { self.setState({ basis: 'month' }); }, toUnit: function () { self.setState({ basis: 'unit' }); }
    };
  }
}
