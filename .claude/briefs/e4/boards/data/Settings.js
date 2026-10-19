// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Settings (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    var keys = ['zinc', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'indigo', 'violet', 'pink'];
    var accents = keys.map(function (k) { var on = k === 'violet'; return { k: k, on: on ? 'true' : 'false', ring: on ? 'box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--foreground)' : '' }; });
    return { themeClass: this.props.theme === 'light' ? 'light' : '', accents: accents };
  }
}
