// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `panelPaste`, exhaustively: HTML removal (scripts, attributes, entities), links, splitting, caps, empty input, unicode. */
import { describe, expect, test } from "vite-plus/test";
import { decodeEntities, isHttpUrl, PANEL_LIMITS, panelPaste, panelPasteDetails, stripHtml } from "../src/index.ts";

const one = (text: string) => {
  const p = panelPaste(text);
  expect(p).toHaveLength(1);
  return p[0]!;
};
const allText = (text: string) =>
  panelPaste(text)
    .map((p) => `${p.title}\n${p.body}\n${p.linkUrl ?? ""}`)
    .join("\n");

describe("empty input", () => {
  test.each(["", "   ", "\n\n\n", "<p></p>", "<script>alert(1)</script>", "&nbsp;", "<!-- only a comment -->"])(
    "%j gives no panels",
    (text) => {
      expect(panelPaste(text)).toEqual([]);
      expect(panelPasteDetails(text)).toMatchObject({ dropped: 0 });
    },
  );
});

describe("HTML removal", () => {
  test("script and style elements go with their contents", () => {
    const p = one("# About\nHello<script>alert('x')</script> world<style>p{color:red}</style>!");
    expect(p).toEqual({ title: "About", body: "Hello world!", imageKey: null, linkUrl: null });
  });

  test("case, spacing and attributes on script tags do not help", () => {
    const text = allText(
      '# A\nx<SCRIPT type="text/javascript">evil()</SCRIPT >y<  script>more()</script>z<iframe src="https://e.test">f</iframe>w',
    );
    expect(text).not.toMatch(/evil|more\(\)|iframe|script/i);
    expect(text).toContain("xyzw");
  });

  test("an unclosed script drops the rest of the text", () => {
    const text = allText("# A\nkeep<script>alert(1)");
    expect(text).toContain("keep");
    expect(text).not.toContain("alert");
  });

  test("every tag and attribute is removed, block tags become line breaks", () => {
    const p = one(
      '# Rules\n<p class="x" onclick="steal()">Be <b>kind</b>.</p><p>No <i style="x">spam</i><br/>Thanks</p>',
    );
    expect(p.body).toBe("Be kind.\nNo spam\nThanks");
    expect(p.body).not.toMatch(/onclick|class=|style=|steal/);
  });

  test("an image tag leaves nothing, not even its attributes", () => {
    expect(allText('# A\n<img src="https://x.test/a.png" onerror="alert(1)">text')).not.toMatch(
      /img|onerror|alert|x\.test/,
    );
  });

  test("entities are decoded, and encoded markup is stripped too", () => {
    expect(one("# A\nFish &amp; chips &lt;3 &quot;yum&quot; &#39;ok&#39; &#x1F600; &#128512;").body).toBe(
      "Fish & chips 3 \"yum\" 'ok' 😀 😀",
    );
    const enc = allText("# A\n&lt;script&gt;alert(1)&lt;/script&gt;after &lt;b onclick=x&gt;bold&lt;/b&gt;");
    expect(enc).not.toMatch(/script|alert|onclick|<|>/);
    expect(enc).toContain("after");
    expect(enc).toContain("bold");
    // Doubly encoded markup does not survive either.
    expect(allText("# A\n&amp;lt;script&amp;gt;x()&amp;lt;/script&amp;gt;ok")).not.toMatch(/script|<|>/);
  });

  test("entities that decode to controls or surrogates are dropped; unknown ones stay as text", () => {
    expect(decodeEntities("a&#0;b&#x7f;c&#xD800;d&#1114112;e")).toBe("abcde");
    expect(decodeEntities("&bogus; &AMP;")).toBe("&bogus; &");
  });

  test("comments vanish and stray brackets never form a tag", () => {
    expect(one("# A\nx<!-- hidden <b>y</b> -->z").body).toBe("xz");
    expect(stripHtml("1 < 2 and 3 > 2")).toBe("1  2 and 3  2");
  });
});

describe("links", () => {
  test("an <a href> to http(s) becomes a markdown link; other schemes keep their text", () => {
    expect(one('# A\nSee <a href="https://shop.example/x?a=1&amp;b=2" target="_blank">my shop</a>.').body).toBe(
      "See [my shop](https://shop.example/x?a=1&b=2).",
    );
    expect(one("# A\n<a href='javascript:alert(1)'>click</a> <a href=data:text/html,x>d</a>").body).toBe("click d");
  });

  test("markdown links survive only as http(s)", () => {
    const p = one("# A\n[ok](http://a.example) [bad](javascript:alert(1)) [ftp](ftp://x.example/f)");
    expect(p.body).toBe("[ok](http://a.example) bad ftp");
  });

  test("a line holding only a URL becomes the panel's link, once", () => {
    const p = one("# Discord\nCome hang out\nhttps://discord.example/invite\nhttps://second.example");
    expect(p.linkUrl).toBe("https://discord.example/invite");
    expect(p.body).toBe("Come hang out\nhttps://second.example");
    expect(one("# A\njavascript:alert(1)").linkUrl).toBeNull();
    expect(one("# A\nhttps://user:pw@x.example/").linkUrl).toBeNull();
  });

  test("isHttpUrl", () => {
    expect(isHttpUrl("https://a.example/b")).toBe(true);
    expect(isHttpUrl("HTTP://A.EXAMPLE")).toBe(true);
    expect(isHttpUrl("//a.example")).toBe(false);
    expect(isHttpUrl("https://")).toBe(false);
    expect(isHttpUrl("mailto:a@b.example")).toBe(false);
  });
});

describe("splitting", () => {
  test("blank-line-separated headings start panels; plain blocks join the panel above", () => {
    const panels = panelPaste(
      "# About me\nI garden in pixels.\n\nSecond paragraph.\n\n## Schedule\nTue and Thu\n\n**Rules**\nBe kind",
    );
    expect(panels.map((p) => [p.title, p.body])).toEqual([
      ["About me", "I garden in pixels.\n\nSecond paragraph."],
      ["Schedule", "Tue and Thu"],
      ["Rules", "Be kind"],
    ]);
  });

  test("text before the first heading is its own untitled panel", () => {
    expect(panelPaste("Intro text\n\n# Next\nbody").map((p) => p.title)).toEqual(["", "Next"]);
  });

  test("with no heading, every block is a panel titled by a short first line", () => {
    const panels = panelPaste(
      `Donate\nTips keep the lights on\n\nJust one long line with no title at all\n\n${"T".repeat(61)}\nbody`,
    );
    expect(panels.map((p) => [p.title, p.body])).toEqual([
      ["Donate", "Tips keep the lights on"],
      ["", "Just one long line with no title at all"],
      ["", `${"T".repeat(61)}\nbody`],
    ]);
  });

  test("CRLF, tabs, trailing spaces and runs of blank lines are normalized", () => {
    const panels = panelPaste("# A\r\nline one   \r\n\r\n\r\n\r\n# B\r\n\tline two");
    expect(panels.map((p) => [p.title, p.body])).toEqual([
      ["A", "line one"],
      ["B", "line two"],
    ]);
  });

  test("a heading alone still makes a panel; trailing #s are removed", () => {
    expect(panelPaste("## Just a title ##")).toEqual([
      { title: "Just a title", body: "", imageKey: null, linkUrl: null },
    ]);
  });
});

describe("caps", () => {
  test("at most 20 panels; the rest are reported as dropped", () => {
    const text = Array.from({ length: 25 }, (_, i) => `# P${i}\nbody ${i}`).join("\n\n");
    const r = panelPasteDetails(text);
    expect(r.panels).toHaveLength(PANEL_LIMITS.maxPanels);
    expect(r.dropped).toBe(5);
    expect(r.panels.at(-1)?.title).toBe("P19");
  });

  test("titles at 60 and bodies at 5000, reported as truncated", () => {
    const r = panelPasteDetails(`# ${"t".repeat(80)}\n${"b".repeat(6000)}`);
    expect(r.panels[0]?.title).toHaveLength(60);
    expect(r.panels[0]?.body).toHaveLength(5000);
    expect(r.truncated).toBe(true);
    expect(panelPasteDetails("# ok\nfine").truncated).toBe(false);
  });

  test("a huge paste is cut before parsing", () => {
    const r = panelPasteDetails(`# A\n${"x".repeat(PANEL_LIMITS.maxInput + 10)}`);
    expect(r.truncated).toBe(true);
    expect(r.panels[0]?.body.length).toBeLessThanOrEqual(5000);
  });

  test("a link longer than the cap is not taken as the panel link", () => {
    const long = `https://a.example/${"x".repeat(2100)}`;
    expect(one(`# A\n${long}`).linkUrl).toBeNull();
  });
});

describe("unicode", () => {
  test("emoji, CJK, RTL and combining marks pass through; NFC normalized", () => {
    const p = one("# Über 🌱 庭\nمرحبا — café 👩‍🌾");
    expect(p.title).toBe("Über 🌱 庭");
    expect(p.body).toBe("مرحبا — café 👩‍🌾");
  });

  test("caps never split a surrogate pair", () => {
    const p = one(`# ${"a".repeat(59)}😀\nbody`);
    expect(p.title).toBe("a".repeat(59));
    const q = one(`# t\n${"b".repeat(4999)}😀`);
    expect(q.body).toBe("b".repeat(4999));
  });

  test("control characters are removed", () => {
    expect(one("# A\nx\u0000y\u0007z\u001b").body).toBe("xyz");
  });
});
