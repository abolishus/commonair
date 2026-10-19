// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Developer (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var dl = [
      ['19:04:12', 'channel.tip', '200', '84 ms', '1'], ['19:02:55', 'channel.subscribe', '200', '91 ms', '1'],
      ['18:58:30', 'stream.online', '503', '30 s', '3'], ['18:58:00', 'stream.online', '503', '30 s', '2'],
      ['18:57:30', 'stream.online', 'timeout', '30 s', '1'], ['18:51:47', 'channel.follow', '200', '77 ms', '1']
    ].map(function (r) { return { t: r[0], e: r[1], code: r[2], cls: r[2] === '200' ? 'badge-ok' : 'badge-destructive', ms: r[3], n: r[4] }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', dl: dl };
  }
}
