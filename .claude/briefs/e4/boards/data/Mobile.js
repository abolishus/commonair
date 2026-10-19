// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Mobile (all values are fixtures).

class Component extends DCLogic {
  renderVals() {
    return { themeClass: this.props.theme === 'light' ? 'light' : '' };
  }
}
