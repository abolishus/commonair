// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Word-filter regex validator: a whitelist grammar plus an ambiguity budget, so the patterns
 * chat compiles with a backtracking `RegExp` cannot blow up (ReDoS).
 *
 * Grammar: literals, escaped metacharacters, character classes, `.`, `\d\w\s` (and negations),
 * `\p{…}`, `\b\B^$`, non-capturing/capturing groups and `|`. Quantifiers `? * + {m} {m,} {m,n}`
 * (lazy allowed) apply to one atom or to a group that contains no quantifier itself.
 * Refused: backreferences, lookaround, named groups, nested quantifiers, repeated groups with an
 * alternation (at any depth) whose alternatives can start with the same character, bounded
 * repeats above MAX_BOUNDED_REPEAT, and patterns that can match the empty string.
 *
 * Cost model: the estimated backtracking steps per start position, which must stay under
 * MAX_COST. Variable-length elements of one sequence whose characters overlap (with only
 * overlapping or optional elements between them) form an ambiguity chain: they can split the same
 * text in many ways, so their repeat choices multiply. An unbounded repeat (`*`, `+`, `{m,}`) scans
 * to the end of the message and backtracks over it, so it costs O(n) per start position (counted
 * as UNBOUNDED_COST, half the longest message). A chain may hold one unbounded repeat, whose
 * O(n) scan multiplies with the choices of everything else in the chain: `.*.{0,20}!` is
 * O(n·21) per start and refused, `\w+a?!` (O(n·2)) and `[^\s]+\.(?:ru|xyz)` (the group is
 * decided by its first character) are fine. Steps over repeated groups and non-ASCII classes are
 * slower, so a chain containing one is weighted SLOW_STEP times (once per chain; in an unbounded
 * chain only when the scan itself is slow). Chains separated
 * by a required element the earlier chain cannot match consume disjoint stretches of the input,
 * so bounded chains add up and the unbounded scans together cover the message at most once.
 * Alternatives (top level and inside groups) add up unless their fixed prefixes tell them apart,
 * in which case only one of them gets past its first characters at any start position.
 *
 * Pure module with no dependencies, shared by the API (validation on save) and chat (compile).
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_BOUNDED_REPEAT = 20;
/** Longest chat message (`CHAT_LIMITS.maxBodyLength`); the cost model is sized for it. */
export const MAX_INPUT_LENGTH = 500;
/**
 * Cost of one unbounded repeat per start position: it scans to the end of the message and
 * backtracks over it, on average half the message over all start positions.
 */
const UNBOUNDED_COST = MAX_INPUT_LENGTH / 2;
/**
 * Largest estimated backtracking steps per start position. Over a 500-character message this
 * keeps the worst accepted pattern around 1-3 ms (see the benchmark test).
 */
export const MAX_COST = 1024;
/**
 * Backtracking into a repeated group, or over a class that can match non-ASCII characters under
 * `u`, is several times slower per step than over an ASCII class (measured on JavaScriptCore).
 */
const SLOW_STEP = 4;

/** Characters an element may consume: exact for ASCII, a single "some non-ASCII" bit otherwise. */
interface CharSet {
  ascii: boolean[];
  nonAscii: boolean;
}

type Node = { kind: "atom"; set: CharSet } | { kind: "assert" } | { kind: "group"; alts: Elem[][] };

interface Elem {
  node: Node;
  min: number;
  max: number;
  quantified: boolean;
}

class Refusal extends Error {}

const emptySet = (): CharSet => ({ ascii: Array<boolean>(128).fill(false), nonAscii: false });
const fullSet = (): CharSet => ({ ascii: Array<boolean>(128).fill(true), nonAscii: true });

/**
 * Under `iu`, two non-ASCII code points case-fold onto ASCII letters: KELVIN SIGN (U+212A) is `k`
 * and LATIN SMALL LETTER LONG S (U+017F) is `s`. Without this, `s+ſ+s+ſ+x` looks like disjoint
 * repeats and backtracks for seconds.
 */
const FOLDS_TO_ASCII: readonly [number, number][] = [
  [0x212a, 0x6b], // K → k
  [0x017f, 0x73], // ſ → s
];

function addCode(set: CharSet, cp: number) {
  addRange(set, cp, cp);
}

/** The two folding code points are recorded as their ASCII letter: under `iu` they are the same. */
function addRange(set: CharSet, lo: number, hi: number) {
  for (let c = lo; c <= Math.min(hi, 127); c++) set.ascii[c] = true;
  let folded = 0;
  for (const [from, to] of FOLDS_TO_ASCII)
    if (lo <= from && from <= hi) {
      set.ascii[to] = true;
      folded++;
    }
  const nonAsciiCount = hi < 128 ? 0 : hi - Math.max(lo, 128) + 1;
  if (nonAsciiCount > folded) set.nonAscii = true;
}

function union(a: CharSet, b: CharSet): CharSet {
  return { ascii: a.ascii.map((v, i) => v || (b.ascii[i] ?? false)), nonAscii: a.nonAscii || b.nonAscii };
}

/** Filters are compiled case-insensitively: fold ASCII letters both ways. */
function fold(set: CharSet): CharSet {
  const out = { ascii: [...set.ascii], nonAscii: set.nonAscii };
  for (let c = 65; c <= 90; c++) {
    if (set.ascii[c] || set.ascii[c + 32]) out.ascii[c] = out.ascii[c + 32] = true;
  }
  return out;
}

function negate(set: CharSet): CharSet {
  return { ascii: set.ascii.map((v) => !v), nonAscii: true };
}

/** Conservative: any two sets that both admit non-ASCII characters are treated as overlapping. */
function overlaps(a: CharSet, b: CharSet): boolean {
  if (a.nonAscii && b.nonAscii) return true;
  return a.ascii.some((v, i) => v && (b.ascii[i] ?? false));
}

function classEscape(letter: string): CharSet | null {
  const set = emptySet();
  switch (letter.toLowerCase()) {
    case "d":
      addRange(set, 48, 57);
      break;
    case "w":
      addRange(set, 48, 57);
      addRange(set, 65, 90);
      addRange(set, 97, 122);
      addCode(set, 95);
      break;
    case "s":
      for (const c of [9, 10, 11, 12, 13, 32]) addCode(set, c);
      set.nonAscii = true;
      break;
    default:
      return null;
  }
  return letter === letter.toUpperCase() ? negate(set) : set;
}

const SYNTAX = "^$\\.*+?()[]{}|/";
const CONTROL: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13, "0": 0 };

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  fail(reason: string): never {
    throw new Refusal(reason);
  }

  parsePattern(): Elem[][] {
    const alts = this.parseAlts();
    if (this.i < this.src.length) this.fail("unbalanced parentheses");
    return alts;
  }

  parseAlts(): Elem[][] {
    const alts = [this.parseSeq()];
    while (this.peek() === "|") {
      this.i++;
      alts.push(this.parseSeq());
    }
    return alts;
  }

  parseSeq(): Elem[] {
    const seq: Elem[] = [];
    while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      const elem = this.parseQuantified();
      // A plain group with one alternative is just a run of elements: splice it in, so the
      // ambiguity analysis sees its contents next to their neighbours.
      if (!elem.quantified && elem.node.kind === "group" && elem.node.alts.length === 1)
        seq.push(...(elem.node.alts[0] ?? []));
      else seq.push(elem);
    }
    return seq;
  }

  parseQuantified(): Elem {
    const node = this.parseAtom();
    const q = this.parseQuantifier();
    if (!q) return { node, min: 1, max: 1, quantified: false };
    if (node.kind === "assert") this.fail("anchors and word boundaries cannot be repeated");
    if (this.parseQuantifier()) this.fail("a quantifier cannot follow another quantifier");
    if (node.kind === "group") {
      // An optional group may hold quantifiers (`(?:https?://)?`); a repeated one may not.
      if (q.max > 1 && node.alts.some((seq) => containsQuantifier(seq)))
        this.fail("nested quantifiers are not allowed");
      if (node.alts.some((seq) => seq.every((e) => e.node.kind === "assert")))
        this.fail("a repeated group cannot have an empty alternative");
      if (branchesOverlap(node.alts) || (q.max > 1 && !nestedAltsDisjoint(node.alts)))
        this.fail("alternatives in a repeated group must start with different characters");
    }
    return { node, min: q.min, max: q.max, quantified: true };
  }

  parseQuantifier(): { min: number; max: number } | null {
    const c = this.peek();
    let q: { min: number; max: number } | null = null;
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    if (q) this.i++;
    else if (c === "{") {
      const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(this.src.slice(this.i));
      if (!m) this.fail("braces must be escaped unless they form a repeat count");
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (max < min) this.fail("repeat counts are out of order");
      if (min > MAX_BOUNDED_REPEAT || (Number.isFinite(max) && max > MAX_BOUNDED_REPEAT))
        this.fail(`repeat counts above ${MAX_BOUNDED_REPEAT} are not allowed`);
      q = { min, max };
      this.i += m[0].length;
    }
    if (q && this.peek() === "?") this.i++; // lazy: same shape
    return q;
  }

  parseAtom(): Node {
    const c = this.peek();
    switch (c) {
      case "^":
      case "$":
        this.i++;
        return { kind: "assert" };
      case ".": {
        this.i++;
        const set = fullSet();
        set.ascii[10] = set.ascii[13] = false;
        return { kind: "atom", set };
      }
      case "[":
        return { kind: "atom", set: this.parseClass() };
      case "(":
        return this.parseGroup();
      case "\\":
        return this.parseEscape();
      case "*":
      case "+":
      case "?":
      case "{":
        return this.fail("a quantifier needs something to repeat");
      case "}":
      case "]":
        return this.fail(`"${c}" must be escaped`);
      default: {
        const cp = this.src.codePointAt(this.i) ?? 0;
        this.i += cp > 0xffff ? 2 : 1;
        const set = emptySet();
        addCode(set, cp);
        return { kind: "atom", set: fold(set) };
      }
    }
  }

  parseGroup(): Node {
    this.i++;
    if (this.peek() === "?") {
      if (this.peek(1) === ":") this.i += 2;
      else if (this.peek(1) === "=" || this.peek(1) === "!" || (this.peek(1) === "<" && /[=!]/.test(this.peek(2))))
        this.fail("lookaround is not allowed");
      else this.fail("only plain (…) and (?:…) groups are allowed");
    }
    const alts = this.parseAlts();
    if (this.peek() !== ")") this.fail("unbalanced parentheses");
    this.i++;
    return { kind: "group", alts };
  }

  parseEscape(): Node {
    const next = this.peek(1);
    if (next === "b" || next === "B") {
      this.i += 2;
      return { kind: "assert" };
    }
    if (/[1-9]/.test(next) || next === "k") this.fail("backreferences are not allowed");
    return { kind: "atom", set: this.parseCharEscape(false) };
  }

  /** An escape that stands for characters (inside or outside a class), with `\` at `this.i`. */
  parseCharEscape(inClass: boolean): CharSet {
    const next = this.peek(1);
    const cls = classEscape(next);
    if (cls) {
      this.i += 2;
      return cls;
    }
    if (next === "p" || next === "P") {
      const m = /^\\[pP]\{[A-Za-z_=]{1,40}\}/.exec(this.src.slice(this.i));
      if (!m) this.fail("invalid Unicode property escape");
      this.i += m[0].length;
      return fullSet();
    }
    const set = emptySet();
    addCode(set, this.parseCodeEscape(inClass));
    return fold(set);
  }

  /** A single-character escape; returns its code point. */
  parseCodeEscape(inClass: boolean): number {
    const next = this.peek(1);
    if (next === "0" && /[0-9]/.test(this.peek(2))) this.fail("octal escapes are not allowed");
    const control = CONTROL[next];
    if (control !== undefined) {
      this.i += 2;
      return control;
    }
    if (SYNTAX.includes(next) || (inClass && next === "-")) {
      this.i += 2;
      return next.codePointAt(0) ?? 0;
    }
    const rest = this.src.slice(this.i);
    const hex =
      /^\\x([0-9a-fA-F]{2})/.exec(rest) ?? /^\\u([0-9a-fA-F]{4})/.exec(rest) ?? /^\\u\{([0-9a-fA-F]{1,6})\}/.exec(rest);
    if (hex?.[1]) {
      const cp = Number.parseInt(hex[1], 16);
      if (cp > 0x10ffff) this.fail("invalid code point escape");
      this.i += hex[0].length;
      return cp;
    }
    if (inClass && next === "b") this.fail("\\b inside a character class is not allowed");
    return this.fail(next ? `unsupported escape "\\${next}"` : "pattern ends with a backslash");
  }

  parseClass(): CharSet {
    this.i++; // [
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.i++;
    }
    if (this.peek() === "]") this.fail("empty character classes are not allowed");
    let set = emptySet();
    while (this.peek() !== "]") {
      if (this.i >= this.src.length) this.fail("unterminated character class");
      const lo = this.classChar();
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== "") {
        this.i++;
        const hi = this.classChar();
        if (typeof lo !== "number" || typeof hi !== "number") this.fail("invalid range in character class");
        if (hi < lo) this.fail("character class range is out of order");
        addRange(set, lo, hi);
      } else if (typeof lo === "number") addCode(set, lo);
      else set = union(set, lo);
    }
    this.i++; // ]
    set = fold(set);
    return negated ? negate(set) : set;
  }

  /** One class member: a code point, or a set for class escapes like `\d`. */
  classChar(): number | CharSet {
    const c = this.peek();
    if (c === "\\") {
      const next = this.peek(1);
      if (classEscape(next) || next === "p" || next === "P") return this.parseCharEscape(true);
      return this.parseCodeEscape(true);
    }
    if (c === "[") this.fail(`"[" must be escaped inside a character class`);
    const cp = this.src.codePointAt(this.i) ?? 0;
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }
}

function containsQuantifier(seq: Elem[]): boolean {
  return seq.some((e) => e.quantified || (e.node.kind === "group" && e.node.alts.some(containsQuantifier)));
}

function charsOf(node: Node): CharSet {
  if (node.kind === "atom") return node.set;
  if (node.kind === "assert") return emptySet();
  let set = emptySet();
  for (const seq of node.alts) for (const e of seq) set = union(set, charsOf(e.node));
  return set;
}

/** Characters a sequence can start with (null when it can only match empty). */
function firstSet(seq: Elem[]): CharSet | null {
  let set: CharSet | null = null;
  for (const e of seq) {
    if (e.node.kind === "assert") continue;
    const first = e.node.kind === "atom" ? e.node.set : groupFirst(e.node.alts);
    if (first) set = set ? union(set, first) : first;
    if (e.min > 0 && minLength([e]) > 0) return set;
  }
  return set;
}

function groupFirst(alts: Elem[][]): CharSet | null {
  let set: CharSet | null = null;
  for (const seq of alts) {
    const f = firstSet(seq);
    if (f) set = set ? union(set, f) : f;
  }
  return set;
}

function minLength(seq: Elem[]): number {
  let n = 0;
  for (const e of seq) {
    const inner = e.node.kind === "atom" ? 1 : e.node.kind === "assert" ? 0 : Math.min(...e.node.alts.map(minLength));
    n += inner * e.min;
  }
  return n;
}

function maxLength(seq: Elem[]): number {
  let n = 0;
  for (const e of seq) {
    const inner = e.node.kind === "atom" ? 1 : e.node.kind === "assert" ? 0 : Math.max(...e.node.alts.map(maxLength));
    n += inner * e.max;
  }
  return n;
}

interface Info {
  set: CharSet;
  min: number;
  variable: boolean;
  cost: number;
  unbounded: number;
  /** Its repeat choices step over a group or a class that can match non-ASCII (slow steps). */
  slow: boolean;
}

interface Cost {
  cost: number;
  unbounded: number;
}

function elemInfo(e: Elem): Info {
  const set = charsOf(e.node);
  const min = minLength([e]);
  const max = maxLength([e]);
  if (e.quantified) {
    // Repeated groups hold no quantifier and every alternation in them is decided by its first
    // character, so the only choice is how many times the repeat runs. An optional group adds
    // its own contents' choices.
    const span = Number.isFinite(e.max) ? e.max - e.min + 1 : UNBOUNDED_COST;
    const inner: Cost =
      e.node.kind === "group" && e.max <= 1
        ? altsCost(e.node.alts, e.node.alts.map(analyzeSeq))
        : { cost: 1, unbounded: 0 };
    return {
      set,
      min,
      variable: min !== max,
      cost: span * inner.cost,
      unbounded: (Number.isFinite(e.max) ? 0 : 1) + inner.unbounded,
      slow: span > 1 && (e.node.kind === "group" || set.nonAscii),
    };
  }
  if (e.node.kind === "group") {
    const { cost, unbounded } = altsCost(e.node.alts, e.node.alts.map(analyzeSeq));
    return { set, min, variable: min !== max, cost, unbounded, slow: false };
  }
  return { set, min, variable: false, cost: 1, unbounded: 0, slow: false };
}

/**
 * Alternatives whose fixed prefixes tell them apart are decided within a few characters, so only
 * one of them runs on: the worst one dominates. Otherwise every alternative is tried in turn.
 */
function altsCost(alts: Elem[][], parts: Cost[]): Cost {
  const costs = parts.map((p) => p.cost);
  const cost = prefixesDistinct(alts) ? Math.max(1, ...costs) : costs.reduce((s, c) => s + c, 0);
  const unbounded = Math.max(0, ...parts.map((p) => p.unbounded));
  if (cost > MAX_COST) throw new Refusal(TOO_COSTLY);
  return { cost, unbounded };
}

/**
 * Inside a repeated group every alternation, at every depth, must be decided by its first
 * character: `(?:(?:a|\w))+` would otherwise match each iteration in two ways (exponential).
 */
function nestedAltsDisjoint(alts: Elem[][]): boolean {
  for (const seq of alts)
    for (const e of seq) {
      if (e.node.kind !== "group") continue;
      if (e.node.alts.length > 1 && branchesOverlap(e.node.alts)) return false;
      if (!nestedAltsDisjoint(e.node.alts)) return false;
    }
  return true;
}

/** Repeated groups: alternatives must differ in their very first character. */
function branchesOverlap(alts: Elem[][]): boolean {
  const firsts = alts.map((seq) => firstSet(seq) ?? fullSet());
  for (let a = 0; a < firsts.length; a++)
    for (let b = a + 1; b < firsts.length; b++) {
      const fa = firsts[a];
      const fb = firsts[b];
      if (fa && fb && overlaps(fa, fb)) return true;
    }
  return false;
}

/**
 * The characters each position of a sequence's fixed prefix can hold: leading single characters,
 * then the first set of whatever follows (if that cannot be empty).
 */
function prefixSets(seq: Elem[]): CharSet[] {
  const out: CharSet[] = [];
  let i = 0;
  for (; i < seq.length; i++) {
    const e = seq[i];
    if (!e) break;
    if (e.node.kind === "assert") continue;
    if (e.node.kind !== "atom" || e.min !== 1 || e.max !== 1) break;
    out.push(e.node.set);
  }
  const rest = seq.slice(i);
  if (rest.length > 0 && minLength(rest) > 0) {
    const first = firstSet(rest);
    if (first) out.push(first);
  }
  return out;
}

/** True when every pair of alternatives has a position in their prefixes with disjoint characters. */
function prefixesDistinct(alts: Elem[][]): boolean {
  const prefixes = alts.map(prefixSets);
  for (let a = 0; a < prefixes.length; a++)
    for (let b = a + 1; b < prefixes.length; b++) {
      const pa = prefixes[a] ?? [];
      const pb = prefixes[b] ?? [];
      let distinct = false;
      for (let k = 0; k < Math.min(pa.length, pb.length) && !distinct; k++) {
        const x = pa[k];
        const y = pb[k];
        if (x && y && !overlaps(x, y)) distinct = true;
      }
      if (!distinct) return false;
    }
  return true;
}

const TOO_COSTLY =
  "too many overlapping optional, repeated or alternative parts: merge them (a?a?a? → a{0,3}, foo.*|bar.* → (?:foo|bar).*) or use a bounded repeat like .{0,20}";

/** Group a sequence's variable-length elements into ambiguity chains and check each chain. */
function analyzeSeq(seq: Elem[]): Cost {
  const infos = seq.filter((e) => e.node.kind !== "assert").map(elemInfo);
  const parent = infos.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] ?? i;
    return i;
  };
  for (let a = 0; a < infos.length; a++) {
    const x = infos[a];
    if (!x?.variable) continue;
    for (let b = a + 1; b < infos.length; b++) {
      const y = infos[b];
      if (!y) break;
      if (y.variable && overlaps(x.set, y.set)) parent[find(b)] = find(a);
      // X can only run past Y into later elements if it can consume what Y matches.
      if (y.min > 0 && !overlaps(x.set, y.set)) break;
    }
  }
  // Ambiguous fixed-length alternations re-run everything after them for each alternative, so
  // they multiply. Within a chain the repeat choices multiply.
  interface Chain {
    cost: number;
    unbounded: number;
    slow: boolean;
    unboundedSlow: boolean;
  }
  const chains = new Map<number, Chain>();
  let fixedProduct = 1;
  infos.forEach((info, i) => {
    if (!info.variable) {
      fixedProduct *= info.cost;
      return;
    }
    const root = find(i);
    const chain = chains.get(root) ?? { cost: 1, unbounded: 0, slow: false, unboundedSlow: false };
    chain.cost *= info.cost;
    chain.unbounded += info.unbounded;
    chain.slow ||= info.slow;
    if (info.unbounded > 0) chain.unboundedSlow ||= info.slow;
    chains.set(root, chain);
  });
  // Chains are separated by characters only one side can take, so they consume disjoint
  // stretches of the input: bounded chains add up, and the unbounded scans together cover the
  // message at most once (the costliest one dominates). Slow steps weigh a chain once: in an
  // unbounded chain the scan dominates, so only a slow scan counts.
  let bounded = 0;
  let scan = 0;
  let unbounded = 0;
  for (const chain of chains.values()) {
    if (chain.unbounded > 1)
      throw new Refusal(
        "two unbounded repeats can match the same text: merge them (l+l+ → l{2,}) or bound one (.{0,20} instead of .*)",
      );
    if (chain.unbounded === 1) {
      const cost = chain.cost * (chain.unboundedSlow ? SLOW_STEP : 1);
      if (cost > MAX_COST)
        throw new Refusal(
          "an unbounded repeat is followed by optional or repeated parts that can match the same characters, so every position it backs off to is tried several ways: put a required character it cannot match between them, or bound it (.{0,20} instead of .*)",
        );
      scan = Math.max(scan, cost);
      unbounded = 1;
    } else bounded += chain.cost * (chain.slow ? SLOW_STEP : 1);
  }
  const cost = fixedProduct * Math.max(1, bounded + scan);
  if (cost > MAX_COST) throw new Refusal(TOO_COSTLY);
  return { cost, unbounded };
}

/**
 * Why a word-filter regex is refused, or null when it is safe to compile with flags `giu`.
 * Reasons are plain English suitable for an API error message.
 */
export function unsafeFilterRegexReason(pattern: string): string | null {
  if (pattern.length === 0) return "pattern is empty";
  if (pattern.length > MAX_PATTERN_LENGTH) return `patterns are limited to ${MAX_PATTERN_LENGTH} characters`;
  try {
    const alts = new Parser(pattern).parsePattern();
    if (Math.min(...alts.map(minLength)) === 0) return "pattern must not match empty text";
    altsCost(alts, alts.map(analyzeSeq));
  } catch (err) {
    if (err instanceof Refusal) return err.message;
    throw err;
  }
  try {
    new RegExp(pattern, "giu");
  } catch {
    return "invalid regular expression";
  }
  return null;
}
