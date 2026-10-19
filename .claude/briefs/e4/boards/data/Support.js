// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Support (all values are fixtures).

class Component extends DCLogic {
  constructor(props) { super(props); this.state = { tab: 'sub', tier: 1 }; }
  renderVals() {
    var self = this, tab = this.state.tab, tier = this.state.tier;
    var defs = [
      { name: 'Tier 1', price: '$4.99', perks: 'Sub badge, emotes, ad-free forever (there are no ads anyway)' },
      { name: 'Tier 2', price: '$9.99', perks: 'Everything in Tier 1, bonus emotes, supporter role in the Discord' },
      { name: 'Tier 3', price: '$24.99', perks: 'Everything in Tier 2, name in the credits, monthly patch file' }
    ];
    var tiers = defs.map(function (d, i) { return Object.assign({}, d, { on: tier === i + 1 ? 'on' : '', pick: function () { self.setState({ tier: i + 1 }); } }); });
    var cta = tab === 'sub' ? 'Subscribe for ' + defs[tier - 1].price + ' / month' : tab === 'gift' ? 'Gift 5 subs · $24.95' : 'Send $5.00 tip';
    return {
      themeClass: this.props.theme === 'light' ? 'light' : '',
      tiers: tiers, cta: cta,
      showSub: tab === 'sub', showGift: tab === 'gift', showTip: tab === 'tip',
      subSel: tab === 'sub' ? 'true' : 'false', giftSel: tab === 'gift' ? 'true' : 'false', tipSel: tab === 'tip' ? 'true' : 'false',
      toSub: function () { self.setState({ tab: 'sub' }); }, toGift: function () { self.setState({ tab: 'gift' }); }, toTip: function () { self.setState({ tab: 'tip' }); }
    };
  }
}
