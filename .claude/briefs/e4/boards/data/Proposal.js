// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: CC-BY-SA-4.0
// Sample data from mockup board Proposal (all values are fixtures).

class Component extends DCLogic {
  constructor(props) { super(props); this.state = { vote: 'no' }; }
  renderVals() {
    var self = this, v = this.state.vote;
    var choices = [['yes', 'Yes'], ['no', 'No'], ['abstain', 'Abstain']].map(function (c) {
      return { label: c[1], on: v === c[0] ? 'on' : '', pick: function () { self.setState({ vote: c[0] }); } };
    });
    var comments = [
      { n: 'Lumen Kitchen', i: 'L', acc: 'green', cls: 'Streamer', ago: '2 days ago', h: 96, t: 'Six points is most of my grocery money from this. I would support a tiered version where bigger channels give more.' },
      { n: 'ohmslaw', i: 'O', acc: 'blue', cls: 'Viewer', ago: '2 days ago', h: 61, t: 'The outage in August cost everyone. A second region is worth it, and the automatic revert is a good safeguard.' },
      { n: 'treasury-wg', i: 'T', acc: 'zinc', cls: 'Worker', ago: '1 day ago', h: 44, t: 'Monthly reports of the ring-fenced account will be on the Transparency page, line by line.' }
    ];
    return { themeClass: this.props.theme === 'light' ? 'light' : '', choices: choices, comments: comments, voteNote: 'Voting as streamer member' };
  }
}
