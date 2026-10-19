// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * People in the E2 social scenario (docs/testing/e2-selectors.md): follow, chat, see moderation.
 * Each `SocialActor` is one signed-in user, driven either through the real web app (`WebActor`,
 * the milestone's definition of done) or straight through the API and chat socket (`ApiActor`,
 * `--set via=api`, which isolates backend failures from web ones). Scenario code is written once
 * against the interface.
 */
import type { Page } from "playwright";
import type { ApiClient } from "./api/client.ts";
import type { ChatClient } from "./chat-client.ts";
import { TimeoutError, waitFor } from "./wait.ts";
import { DIRECTORY_SECTIONS, type DirectorySection, ROUTES, TEST_IDS as T, tid } from "./web/selectors.ts";
import { byTestId } from "./web/session.ts";

/** Timeout the moderation menu applies (e2-selectors: `chat-mod-timeout` = 600 s). */
export const TIMEOUT_SECONDS = 600;

/** Sections where a just-started stream may show up (anything but `following`). */
export const DISCOVERY_SECTIONS: readonly DirectorySection[] = ["live", "spotlight", "new"];

export interface FollowState {
  following: boolean;
  count: number;
}

/** The directory as the API returns it (`directory.home`), reduced to slugs. */
export interface DirectoryHome {
  spotlight: readonly { channel: { slug: string } }[];
  newAndLive: readonly { channel: { slug: string } }[];
  live: readonly { channel: { slug: string } }[];
  following: readonly { channel: { slug: string } }[];
}

/** Web `data-section` values for the API's section keys. */
const SECTION_KEYS: Record<DirectorySection, keyof DirectoryHome> = {
  spotlight: "spotlight",
  new: "newAndLive",
  live: "live",
  following: "following",
};

/** The sections (in web naming) whose cards include `slug`. */
export function sectionsWith(home: DirectoryHome, slug: string): DirectorySection[] {
  return DIRECTORY_SECTIONS.filter((s) => home[SECTION_KEYS[s]].some((c) => c.channel.slug === slug));
}

/**
 * A CLEARCHAT `ban-duration` is computed from the ban's expiry at send time (rounded up), so it
 * can be a little under the requested length but never over it.
 */
export function timeoutDurationOk(seconds: number | null, expected = TIMEOUT_SECONDS, slackSeconds = 15): boolean {
  return seconds !== null && seconds <= expected && seconds >= expected - slackSeconds;
}

/** A ban row that is a timeout still in force. */
export function isActiveTimeout(ban: { expiresAt: string | null }, now = Date.now()): boolean {
  return ban.expiresAt !== null && Date.parse(ban.expiresAt) > now;
}

export interface WaitBudget {
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * Time left until `deadline` (ms epoch), capped at `capMs`, never below 1 ms, so inner waits of a
 * polling loop cannot run past the loop's overall bound.
 */
export function remainingMs(deadline: number, capMs = Number.POSITIVE_INFINITY, now = Date.now()): number {
  return Math.max(1, Math.min(capMs, deadline - now));
}

export interface SocialActor {
  readonly who: string;
  readonly username: string;
  /** Open the channel page / join its chat and wait until chat is usable. */
  openChannel(channel: string, b: WaitBudget): Promise<void>;
  /** Find the channel in a discovery section of the directory and open it from there. */
  discover(channel: string, b: WaitBudget): Promise<DirectorySection>;
  /** Wait until the channel is in the viewer's `following` section. */
  waitFollowingSection(channel: string, b: WaitBudget): Promise<void>;
  followState(b: WaitBudget): Promise<FollowState>;
  /** Toggle follow and wait until both the state and the count have moved. */
  toggleFollow(b: WaitBudget): Promise<FollowState>;
  /** True when a follow control is offered (false on your own channel). */
  hasFollowControl(): Promise<boolean>;
  send(text: string, b: WaitBudget): Promise<void>;
  /** Wait for a message by `author` containing `text`; returns its id (empty when not exposed). */
  waitMessage(author: string, text: string, b: WaitBudget): Promise<string>;
  /** Wait for a message to be shown as removed by moderation. */
  waitDeleted(messageId: string, author: string, text: string, b: WaitBudget): Promise<void>;
  waitNotice(code: string, b: WaitBudget): Promise<void>;
  /** Number of moderation controls offered on messages (0 for non-moderators). */
  moderationControls(): Promise<number>;
  /** Moderator action: time out the author of a message for TIMEOUT_SECONDS. */
  timeoutAuthor(author: string, text: string, b: WaitBudget): Promise<void>;
  /** Release what the actor holds (chat sockets). Browser sessions are closed by the scenario. */
  close(): void;
}

// ---------------------------------------------------------------- web

export class WebActor implements SocialActor {
  private current: Page | null = null;

  constructor(
    readonly who: string,
    readonly username: string,
    private readonly open: (path: string) => Promise<Page>,
  ) {}

  private get page(): Page {
    if (!this.current) throw new Error(`${this.who}: no page open`);
    return this.current;
  }

  async openChannel(channel: string, b: WaitBudget): Promise<void> {
    this.current = await this.open(ROUTES.channel(channel));
    await byTestId(this.current, T.chat, { state: "open" }).waitFor({ timeout: b.timeoutMs });
  }

  async discover(channel: string, b: WaitBudget): Promise<DirectorySection> {
    const page = await this.open(ROUTES.directory);
    this.current = page;
    // Ranking runs on an interval: reload until the card shows up in a discovery section.
    const deadline = Date.now() + b.timeoutMs;
    const section = await waitFor(
      `stream-card[data-channel=${channel}] in a ${DISCOVERY_SECTIONS.join("/")} section of /`,
      async () => {
        for (const s of DISCOVERY_SECTIONS) {
          if (await page.locator(cardIn(s, channel)).count()) return s;
        }
        await page.waitForTimeout(remainingMs(deadline, 1_000));
        await page.reload({ waitUntil: "domcontentloaded", timeout: remainingMs(deadline) });
        await byTestId(page, T.directory).waitFor({ timeout: remainingMs(deadline, 10_000) });
        return null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 0, signal: b.signal },
    );
    const card = page.locator(cardIn(section, channel)).first();
    const link = card.locator(`a[href$="${ROUTES.channel(channel)}"]`);
    await ((await link.count()) ? link.first() : card).click({ timeout: 10_000 });
    await page.waitForURL((u) => u.pathname === ROUTES.channel(channel), { timeout: 20_000 });
    await byTestId(page, T.chat, { state: "open" }).waitFor({ timeout: 20_000 });
    return section;
  }

  async waitFollowingSection(channel: string, b: WaitBudget): Promise<void> {
    const page = await this.open(ROUTES.directory);
    const deadline = Date.now() + b.timeoutMs;
    await waitFor(
      `stream-card[data-channel=${channel}] in directory-section[data-section=following]`,
      async () => {
        if (await page.locator(cardIn("following", channel)).count()) return true;
        await page.waitForTimeout(remainingMs(deadline, 1_000));
        await page.reload({ waitUntil: "domcontentloaded", timeout: remainingMs(deadline) });
        return null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 0, signal: b.signal },
    );
    // Back to the channel so later chat steps keep working.
    await this.openChannel(channel, { ...b, timeoutMs: 20_000 });
  }

  async followState(b: WaitBudget): Promise<FollowState> {
    const button = byTestId(this.page, T.followButton);
    await button.waitFor({ timeout: b.timeoutMs });
    const following = await button.getAttribute("data-following", { timeout: b.timeoutMs });
    const count = await byTestId(this.page, T.followerCount).getAttribute("data-count", { timeout: b.timeoutMs });
    return { following: following === "true", count: Number(count) };
  }

  async toggleFollow(b: WaitBudget): Promise<FollowState> {
    const before = await this.followState(b);
    const button = byTestId(this.page, T.followButton);
    await button.click({ timeout: b.timeoutMs });
    const want = before.following ? before.count - 1 : before.count + 1;
    let last = before;
    try {
      return await waitFor(
        `follow-button data-following=${!before.following} and follower-count ${want}`,
        async () => {
          if (await button.isDisabled()) return null;
          last = await this.followState(b);
          return last.following !== before.following && last.count === want ? last : null;
        },
        { timeoutMs: b.timeoutMs, intervalMs: 100, signal: b.signal },
      );
    } catch (err) {
      throw new Error(`${(err as Error).message}; last seen ${JSON.stringify(last)}`, { cause: err });
    }
  }

  async hasFollowControl(): Promise<boolean> {
    return (await byTestId(this.page, T.followButton).count()) > 0;
  }

  async send(text: string, b: WaitBudget): Promise<void> {
    await byTestId(this.page, T.chatInput).fill(text, { timeout: b.timeoutMs });
    await byTestId(this.page, T.chatSend).click({ timeout: b.timeoutMs });
  }

  private row(author: string, text: string) {
    return byTestId(this.page, T.chatMessage, { author }).filter({ hasText: text }).first();
  }

  async waitMessage(author: string, text: string, b: WaitBudget): Promise<string> {
    const row = this.row(author, text);
    await row.waitFor({ timeout: b.timeoutMs });
    return (await row.getAttribute("data-id", { timeout: 1_000 })) ?? "";
  }

  async waitDeleted(messageId: string, author: string, _text: string, b: WaitBudget): Promise<void> {
    // The row stays but its text is replaced, so select by id when the page exposes it.
    const target = messageId
      ? this.page.locator(tid(T.chatMessage, { id: messageId, deleted: "true" }))
      : byTestId(this.page, T.chatMessage, { author, deleted: "true" });
    await target.first().waitFor({ timeout: b.timeoutMs });
  }

  async waitNotice(code: string, b: WaitBudget): Promise<void> {
    await byTestId(this.page, T.chatNotice, { code }).first().waitFor({ timeout: b.timeoutMs });
  }

  async moderationControls(): Promise<number> {
    return byTestId(this.page, T.chatMessageActions).count();
  }

  async timeoutAuthor(author: string, text: string, b: WaitBudget): Promise<void> {
    const row = this.row(author, text);
    await row.waitFor({ timeout: b.timeoutMs });
    await row.hover({ timeout: b.timeoutMs });
    await row.locator(tid(T.chatMessageActions)).first().click({ timeout: b.timeoutMs });
    await byTestId(this.page, T.chatModTimeout).first().click({ timeout: b.timeoutMs });
  }

  close(): void {}
}

function cardIn(section: DirectorySection, channel: string): string {
  return `${tid(T.directorySection, { section })} ${tid(T.streamCard, { channel })}`;
}

// ---------------------------------------------------------------- API

export class ApiActor implements SocialActor {
  private chat: ChatClient | null = null;
  private channel = "";

  constructor(
    readonly who: string,
    readonly username: string,
    private readonly userId: string,
    private readonly api: ApiClient,
    private readonly connect: () => Promise<ChatClient>,
  ) {}

  private get socket(): ChatClient {
    if (!this.chat) throw new Error(`${this.who}: chat not joined`);
    return this.chat;
  }

  async openChannel(channel: string): Promise<void> {
    this.channel = channel;
    if (this.chat?.isOpen) return;
    this.chat = await this.connect();
    await this.chat.join(channel);
  }

  async discover(channel: string, b: WaitBudget): Promise<DirectorySection> {
    const section = await waitFor(
      `${channel} in a ${DISCOVERY_SECTIONS.join("/")} section of directory.home`,
      async () => {
        const found = sectionsWith(await this.api.directory.home({}), channel);
        return DISCOVERY_SECTIONS.find((s) => found.includes(s)) ?? null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
    await this.openChannel(channel);
    return section;
  }

  async waitFollowingSection(channel: string, b: WaitBudget): Promise<void> {
    await waitFor(
      `${channel} in directory.home following`,
      async () => sectionsWith(await this.api.directory.home({}), channel).includes("following") || null,
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
  }

  async followState(): Promise<FollowState> {
    const c = await this.api.channels.get({ channel: this.channel });
    return { following: c.viewer?.following === true, count: c.followerCount };
  }

  async toggleFollow(): Promise<FollowState> {
    const before = await this.followState();
    const r = before.following
      ? await this.api.channels.unfollow({ channel: this.channel })
      : await this.api.channels.follow({ channel: this.channel });
    return { following: r.following, count: r.followerCount };
  }

  async hasFollowControl(): Promise<boolean> {
    // `viewer` is set for every signed-in caller, the owner included; the web hides the button
    // on your own channel, so compare with the owner.
    const c = await this.api.channels.get({ channel: this.channel });
    return c.viewer !== null && c.viewer !== undefined && c.owner.id !== this.userId;
  }

  async send(text: string): Promise<void> {
    // A rejected send (id null) is answered by a notice; callers assert on what they expect.
    await this.socket.send(this.channel, text);
  }

  async waitMessage(author: string, text: string, b: WaitBudget): Promise<string> {
    const f = await this.socket.waitFor(
      "message",
      (m) => m.message.user.username === author && m.message.body.includes(text),
      b.timeoutMs,
    );
    return f.message.id;
  }

  async waitDeleted(messageId: string, author: string, _text: string, b: WaitBudget): Promise<void> {
    const socket = this.socket;
    const original = socket.messages(this.channel).find((m) => m.message.id === messageId);
    const userId = original?.message.user.id;
    const channel = this.channel;
    const removes = (f: ChatClient["frames"][number]) =>
      (f.op === "ban" && f.channel === channel && (f.userId === userId || f.username === author)) ||
      (f.op === "delete" && f.channel === channel && f.messageId === messageId) ||
      (f.op === "clear" && f.channel === channel);
    if (socket.frames.some(removes)) return;
    // One listener and one timer for both frame kinds, both released whichever way it ends.
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        off();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => done(new TimeoutError(`ban/delete of ${author}'s message ${messageId}`, b.timeoutMs)),
        b.timeoutMs,
      );
      const off = socket.onFrame((f) => {
        if (removes(f)) done();
      });
    });
  }

  async waitNotice(code: string, b: WaitBudget): Promise<void> {
    await this.socket.waitFor("notice", (n) => n.code === code, b.timeoutMs);
  }

  async moderationControls(): Promise<number> {
    const joined = this.socket.frames.find((f) => f.op === "joined" && f.channel === this.channel);
    return joined?.op === "joined" && joined.me.canModerate ? 1 : 0;
  }

  async timeoutAuthor(author: string): Promise<void> {
    await this.api.chat.bans.ban({ channel: this.channel, username: author, durationSeconds: TIMEOUT_SECONDS });
  }

  close(): void {
    this.chat?.close();
    this.chat = null;
  }
}
