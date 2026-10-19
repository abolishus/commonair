// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Finances (all values are fixtures).

class Component extends DCLogic {
  constructor(props) { super(props); this.state = { period: 'month' }; }
  renderVals() {
    var self = this, p = this.state.period;
    var sets = {
      month: [['Platform income', '$21,100', 'Oct 1–17', 'muted'], ['Operating expenses', '$14,380', 'Oct 1–17', 'muted'], ['Net surplus', '+$6,720', '+$1,140 vs same days in Sep', 'delta-up'], ['Reserve', '$101,300', '4.2 months of runway', 'muted'], ['Cost per viewer-hour', '$0.0061', '−9% since relays', 'delta-up'], ['Cost per streamed hour', '$0.42', 'transcode + ingest', 'muted']],
      quarter: [['Platform income', '$103,040', 'Q3 2026', 'muted'], ['Operating expenses', '$71,400', 'Q3 2026', 'muted'], ['Net surplus', '+$31,640', '+18% vs Q2', 'delta-up'], ['Reserve', '$94,100', 'at Sep 30', 'muted'], ['Cost per viewer-hour', '$0.0067', 'Q3 average', 'muted'], ['Cost per streamed hour', '$0.44', 'Q3 average', 'muted']],
      year: [['Platform income', '$298,600', 'Nov 2025 – Oct 2026', 'muted'], ['Operating expenses', '$251,900', 'Nov 2025 – Oct 2026', 'muted'], ['Net surplus', '+$46,700', 'first surplus year', 'delta-up'], ['Reserve', '$101,300', 'from $54,600', 'delta-up'], ['Cost per viewer-hour', '$0.0081', '12-month average', 'muted'], ['Cost per streamed hour', '$0.51', '12-month average', 'muted']]
    };
    var kpis = sets[p].map(function (r) { return { k: r[0], v: r[1], d: r[2], dcls: r[3] }; });
    var inc = [14, 16, 17, 19, 21, 23, 25, 26, 28, 30, 31, 33], exp = [17, 18, 18, 19, 19, 20, 21, 21, 22, 23, 24, 24];
    var labels = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
    var months = labels.map(function (l, i) { return { l: l, i: Math.round(inc[i] / 36 * 100), e: Math.round(exp[i] / 36 * 100) }; });
    var opex = [
      ['Compute & servers', '−$4,120', '4.9%', '6 services', 'var(--chart-1)'], ['Bandwidth & storage', '−$2,240', '2.7%', '4 services', 'var(--chart-1)'],
      ['Worker-member wages', '−$5,800', '6.9%', '4.5 FTE', 'var(--chart-4)'], ['Trust & safety contractors', '−$910', '1.1%', '2 contracts', 'var(--chart-4)'],
      ['Legal, accounting & insurance', '−$760', '0.9%', '3 firms', 'var(--chart-3)'], ['Upstream FOSS donations', '−$350', '0.4%', '9 projects', 'var(--chart-2)'],
      ['Everything else', '−$200', '0.2%', '5 lines', 'var(--muted-foreground)']
    ].map(function (r) { return { k: r[0], v: r[1], p: r[2], n: r[3], c: r[4] }; });
    var budget = [
      ['Infrastructure', '$61.2K', '$80K', 77, 'var(--chart-1)', 'On track (83% of year elapsed)', 'muted'],
      ['Wages', '$58.0K', '$72K', 81, 'var(--chart-4)', 'On track', 'muted'],
      ['Trust & safety', '$11.6K', '$12K', 97, 'var(--chart-3)', 'Over pace — council approved +$2K on Sep 9', 'delta-down'],
      ['Legal & accounting', '$7.1K', '$10K', 71, 'var(--chart-3)', 'Annual audit still to come', 'muted'],
      ['FOSS donations', '$3.5K', '$4.2K', 83, 'var(--chart-2)', 'On track', 'muted']
    ].map(function (r) { return { k: r[0], a: r[1], t: r[2], w: r[3], c: r[4], note: r[5], ncls: r[6] }; });
    var label = { month: 'October 1–17, 2026', quarter: 'Q3 2026 (figures below shown for October to date)', year: 'Last 12 months (figures below shown for October to date)' }[p];
    return {
      themeClass: this.props.theme === 'light' ? 'light' : '', kpis: kpis, months: months, opex: opex, budget: budget, periodLabel: label,
      pMonth: p === 'month' ? 'true' : 'false', pQuarter: p === 'quarter' ? 'true' : 'false', pYear: p === 'year' ? 'true' : 'false',
      toMonth: function () { self.setState({ period: 'month' }); }, toQuarter: function () { self.setState({ period: 'quarter' }); }, toYear: function () { self.setState({ period: 'year' }); }
    };
  }
}
