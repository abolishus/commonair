// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One IRC client connection, independent of transport (TCP, TLS, WebSocket).
 * Owns exactly one upstream chat WebSocket and translates in both directions.
 * No chat rule is decided here; the gateway only enforces protocol limits.
 */
import type { ChannelChatSettings, ClientFrame } from "@commonair/contracts";
import type { ChatMessage } from "@commonair/contracts/dto";
import type { Logger } from "@commonair/observability";
import { CapNegotiator, type Cap } from "./caps.ts";
import { translatePrivmsg } from "./commands.ts";
import { LIMITS, SERVER_NAME } from "./constants.ts";
import { parseMessage, type IrcMessage, type OutgoingMessage } from "./irc/message.ts";
import { NOTICE_MSG_IDS, noticeMsgId } from "./notices.ts";
import { TokenBucket } from "./ratelimit.ts";
import {
  clearchat,
  clearmsg,
  globaluserstate,
  ircChannel,
  notice,
  parseBadgeStrings,
  privmsg,
  render,
  roomstate,
  userPrefix,
  usernotice,
  userstate,
  type Badge,
  type GiftPool,
  type RoomInfo,
  type SelfState,
} from "./translate.ts";
import type { Upstream, UpstreamCloseKind, UpstreamFactory, UpstreamFrame } from "./upstream.ts";

type Frame<Op extends UpstreamFrame["op"]> = Extract<UpstreamFrame, { op: Op }>;

export type TransportKind = "tcp" | "tls" | "ws";

/** What a session needs from its transport. `close()` flushes queued output first. */
export interface Transport {
  readonly kind: TransportKind;
  write(lines: string[]): void;
  bufferedBytes(): number;
  close(): void;
}

export type SessionLimits = { -readonly [K in keyof typeof LIMITS]: number };

export interface SessionOptions {
  upstream: UpstreamFactory;
  logger: Logger;
  /** Text of the 372 MOTD line. */
  motd: string;
  limits?: Partial<SessionLimits>;
  onClosed?: (session: IrcSession) => void;
}

interface Room extends RoomInfo {
  settings: ChannelChatSettings;
  badges: Badge[];
  canModerate: boolean;
  /** Recent message bodies by id, so CLEARMSG can carry the deleted text like Twitch does. */
  recent: Map<string, string>;
  /** Chatters already announced with a synthetic JOIN (twitch.tv/membership). */
  seen: Set<string>;
  giftPool: GiftPool | null;
}

interface PendingCommand {
  slug: string;
  command: string;
  expiresAt: number;
}

/** A JOIN the client asked for that upstream has not answered yet. `nonce` is null while still queued. */
interface PendingJoin {
  nonce: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ControlItem {
  op: "join" | "part";
  slug: string;
}

/** What an upstream notice/error turned out to answer. */
interface Reply {
  command?: string;
  failedJoin?: string;
}

const SLUG = /^[a-z0-9_]{3,25}$/;
const NICK = /^[a-z0-9_]{1,25}$/;
const ANON_NICK = /^justinfan\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_BODIES = 300;
const SEEN_CHATTERS = 2000;
const SELF_ECHO_HOLD_MS = 2000;
const MIN_HEARTBEAT_MS = 5000;

let sessionSeq = 0;

/** Make client-supplied text safe as a middle param (no spaces, no leading colon, not empty). */
export function middleParam(s: string): string {
  const cleaned = s
    .replace(/[\s\0]/g, "")
    .replace(/^:+/, "")
    .slice(0, 64);
  return cleaned === "" ? "*" : cleaned;
}

export class IrcSession {
  readonly id = `irc-${++sessionSeq}`;
  readonly caps = new CapNegotiator();
  private readonly limits: SessionLimits;
  private readonly log: Logger;
  private readonly bucket: TokenBucket;

  private pass: string | null = null;
  private nick: string | null = null;
  private anonymous = false;
  private state: "new" | "registering" | "registered" | "closed" = "new";
  private self: SelfState | null = null;
  private upstream: Upstream | null = null;

  private readonly rooms = new Map<string, Room>();
  private readonly pendingJoins = new Map<string, PendingJoin>();
  /** nonce → slug, for joins and parts sent upstream. */
  private readonly joinNonces = new Map<string, string>();
  private readonly partNonces = new Map<string, string>();
  private readonly pendingSends = new Map<string, string>();
  /** nonce → command, in send order (Map iteration order) for the no-nonce fallback. */
  private readonly pendingCommands = new Map<string, PendingCommand>();
  /** Joins and parts wait here so we never exceed upstream's control-frame rate. */
  private readonly controlQueue: ControlItem[] = [];
  private readonly controlBucket: TokenBucket;
  private controlTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ackedIds = new Set<string>();
  private readonly heldSelf = new Map<string, ReturnType<typeof setTimeout>>();
  private nonceSeq = 0;

  private outbox: string[] = [];
  private flushScheduled = false;
  private lastActivity = Date.now();
  /** When the idle PING went out; null until one is outstanding. */
  private pingSentAt: number | null = null;
  private dropped = 0;
  private rateNoticeSent = false;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly opts: SessionOptions,
  ) {
    this.limits = { ...LIMITS, ...opts.limits };
    this.log = opts.logger.child({ session: this.id, transport: transport.kind });
    this.bucket = new TokenBucket(this.limits.rateBurst, this.limits.ratePerSecond);
    this.controlBucket = new TokenBucket(this.limits.controlBurst, this.limits.controlPerSecond);
    this.timers.push(
      setTimeout(() => {
        if (this.state !== "registered") this.close("Registration timeout", true);
      }, this.limits.registrationTimeoutMs),
    );
    const idleCheck = setInterval(() => this.checkIdle(), Math.max(50, this.limits.idlePingMs / 4));
    this.timers.push(idleCheck);
  }

  get registered(): boolean {
    return this.state === "registered";
  }
  get isClosed(): boolean {
    return this.state === "closed";
  }
  get transportKind(): TransportKind {
    return this.transport.kind;
  }
  get channelCount(): number {
    return this.rooms.size;
  }

  // ------------------------------------------------------------ inbound (client → gateway)

  /** The framer found a line longer than the hard cap. */
  overflow(): void {
    this.reply("417", "Input line was too long");
  }

  line(raw: string): void {
    if (this.state === "closed") return;
    this.lastActivity = Date.now();
    this.pingSentAt = null;

    if (!this.bucket.take()) {
      this.dropped++;
      if (this.dropped > this.limits.floodDisconnectAfter) return this.close("Excess Flood", true);
      if (!this.rateNoticeSent && this.state === "registered") {
        this.rateNoticeSent = true;
        this.emit(
          notice("*", "msg_ratelimit", "Your message was not sent because you are sending messages too quickly."),
          "twitch.tv/commands",
        );
      }
      return;
    }
    this.dropped = 0;
    this.rateNoticeSent = false;

    if (!this.withinLength(raw)) return this.reply("417", "Input line was too long");
    const msg = parseMessage(raw);
    if (!msg) return;
    try {
      this.dispatch(msg);
    } catch (err) {
      // One bad line must never take down the connection or the rest of its frame.
      this.log.error("failed to handle client line", { err, command: msg.command });
    }
  }

  private withinLength(raw: string): boolean {
    let rest = raw;
    if (raw.startsWith("@")) {
      const sp = raw.indexOf(" ");
      const tagBytes = Buffer.byteLength(sp === -1 ? raw : raw.slice(0, sp), "utf8");
      if (tagBytes > this.limits.maxTagBytes) return false;
      rest = sp === -1 ? "" : raw.slice(sp + 1);
    }
    // PRIVMSG text is limited in characters upstream (Twitch-style); the framer caps total bytes.
    if (/^(:\S+ +)?PRIVMSG /i.test(rest)) return true;
    return Buffer.byteLength(rest, "utf8") + 2 <= this.limits.maxLineBytes;
  }

  private dispatch(msg: IrcMessage): void {
    const p = msg.params;
    switch (msg.command) {
      case "CAP":
        return this.onCap(p);
      case "PASS":
        if (this.state === "new") this.pass = p[0] ?? null;
        return;
      case "NICK":
        return this.onNick(p[0]);
      case "USER":
        return;
      case "PING":
        // tmi.js sends a bare PING and only accepts an unprefixed PONG; RFC clients send a token.
        if (p.length === 0) return this.emit({ command: "PONG", trailing: SERVER_NAME });
        return this.emit({ prefix: SERVER_NAME, command: "PONG", params: [SERVER_NAME], trailing: p[0] ?? "" });
      case "PONG":
        return;
      case "QUIT":
        return this.close("Quit", true);
    }
    if (this.state !== "registered") return this.reply("451", "You have not registered", [msg.command]);
    switch (msg.command) {
      case "JOIN":
        return this.onJoin(p[0] ?? "");
      case "PART":
        return this.onPart(p[0] ?? "");
      case "PRIVMSG":
        return this.onPrivmsg(p[0] ?? "", p[1] ?? "", msg.tags);
      default:
        return this.reply("421", "Unknown command", [msg.command]);
    }
  }

  private onCap(params: string[]): void {
    const [sub = "", ...args] = params;
    // `CAP LS 302`: the version argument is not a cap list.
    const result = this.caps.handle(sub, sub.toUpperCase() === "LS" ? [] : args, this.state === "registered");
    const target = this.nick ?? "*";
    if (result.kind === "reply")
      this.emit({
        prefix: SERVER_NAME,
        command: "CAP",
        params: [target, result.reply.subcommand],
        trailing: result.reply.caps,
      });
    else if (result.kind === "invalid") this.reply("410", "Invalid CAP command", [result.subcommand]);
    else if (result.kind === "end") this.tryRegister();
  }

  private onNick(raw: string | undefined): void {
    if (this.state !== "new") return; // Twitch nicks are the account login and cannot change
    const nick = raw?.toLowerCase();
    if (!nick || !NICK.test(nick)) {
      this.emit(notice("*", null, "Invalid NICK"));
      return this.close("Invalid NICK", false);
    }
    this.nick = nick;
    this.tryRegister();
  }

  private onJoin(list: string): void {
    if (list === "0") {
      for (const slug of [...this.rooms.keys(), ...this.pendingJoins.keys()]) this.part(slug);
      return;
    }
    for (const name of list.split(",").filter(Boolean)) {
      const slug = name.replace(/^#/, "").toLowerCase();
      if (!name.startsWith("#") || !SLUG.test(slug)) {
        this.reply("403", "No such channel", [name]);
        continue;
      }
      if (this.rooms.has(slug) || this.pendingJoins.has(slug)) continue;
      if (this.rooms.size + this.pendingJoins.size >= this.limits.maxChannels) {
        this.reply("405", "You have joined too many channels", [name]);
        continue;
      }
      this.pendingJoins.set(slug, { nonce: null, timer: null });
      this.enqueueControl({ op: "join", slug });
    }
  }

  private onPart(list: string): void {
    for (const name of list.split(",").filter(Boolean)) {
      const slug = name.replace(/^#/, "").toLowerCase();
      if (this.rooms.has(slug) || this.pendingJoins.has(slug)) this.part(slug);
    }
  }

  private part(slug: string): void {
    const pending = this.pendingJoins.get(slug);
    if (pending) {
      this.forgetJoin(slug);
      if (pending.nonce === null) {
        // Never sent: just take it off the queue.
        const i = this.controlQueue.findIndex((c) => c.op === "join" && c.slug === slug);
        if (i !== -1) this.controlQueue.splice(i, 1);
        return;
      }
    }
    // Queued behind the join (if any), so upstream sees join-then-part and ends parted.
    this.enqueueControl({ op: "part", slug });
  }

  private forgetJoin(slug: string): void {
    const pending = this.pendingJoins.get(slug);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.nonce !== null) this.joinNonces.delete(pending.nonce);
    this.pendingJoins.delete(slug);
  }

  private enqueueControl(item: ControlItem): void {
    this.controlQueue.push(item);
    this.pumpControl();
  }

  /** Send queued joins/parts as fast as the control-frame budget allows. */
  private pumpControl(): void {
    this.controlTimer = null;
    if (this.state === "closed") return;
    while (this.controlQueue.length > 0 && this.controlBucket.take()) {
      const item = this.controlQueue.shift();
      if (!item) break;
      const nonce = this.nextNonce();
      if (item.op === "part") {
        this.partNonces.set(nonce, item.slug);
        this.send({ op: "part", channel: item.slug, nonce });
        continue;
      }
      const pending = this.pendingJoins.get(item.slug);
      if (!pending) continue;
      pending.nonce = nonce;
      this.joinNonces.set(nonce, item.slug);
      // Free the slot if upstream never answers, so the 100-channel cap cannot fill up with ghosts.
      pending.timer = setTimeout(() => {
        if (this.pendingJoins.get(item.slug)?.nonce !== nonce) return;
        this.log.info("join timed out", { channel: item.slug });
        this.forgetJoin(item.slug);
      }, this.limits.joinTimeoutMs);
      this.send({ op: "join", channel: item.slug, nonce });
    }
    if (this.controlQueue.length > 0 && this.controlTimer === null)
      this.controlTimer = setTimeout(() => this.pumpControl(), Math.ceil(1000 / this.limits.controlPerSecond));
  }

  private nextNonce(): string {
    return `irc${++this.nonceSeq}`;
  }

  private onPrivmsg(target: string, text: string, tags: Record<string, string>): void {
    const slug = target.replace(/^#/, "").toLowerCase();
    // Twitch has no PRIVMSG to users (whispers moved to the API); drop like Twitch does.
    if (!target.startsWith("#") || !SLUG.test(slug)) return;
    const t = translatePrivmsg(text);
    const nonce = this.nextNonce();
    switch (t.kind) {
      case "ignore":
        return;
      case "notice":
        return this.emit(notice(ircChannel(slug), t.msgId, t.text), "twitch.tv/commands");
      case "command":
        this.prunePendingCommands();
        this.pendingCommands.set(nonce, {
          slug,
          command: t.command,
          expiresAt: Date.now() + this.limits.pendingCommandTimeoutMs,
        });
        return this.send({ op: "command", channel: slug, command: t.command, args: t.args, nonce });
      case "send": {
        this.pendingSends.set(nonce, slug);
        const reply = tags["reply-parent-msg-id"];
        const frame: ClientFrame = { op: "send", channel: slug, body: t.body, isAction: t.isAction, nonce };
        if (reply && UUID.test(reply)) frame.replyToId = reply.toLowerCase();
        return this.send(frame);
      }
    }
  }

  // ------------------------------------------------------------ registration

  private tryRegister(): void {
    if (this.state !== "new" || this.nick === null || this.caps.suspended) return;
    this.anonymous = ANON_NICK.test(this.nick);
    const token = this.anonymous ? null : (this.pass ?? "").replace(/^oauth:/i, "");
    if (!this.anonymous && !token) {
      this.emit(notice("*", null, "Improperly formatted auth"));
      return this.close("Improperly formatted auth", false);
    }
    this.state = "registering";
    this.pass = null; // do not keep the token around longer than needed
    const connectTimer = setTimeout(() => {
      if (this.state === "registering") this.close("Chat service unavailable", true);
    }, this.limits.upstreamConnectTimeoutMs);
    this.timers.push(connectTimer);
    this.upstream = this.opts.upstream(token, {
      open: () => {},
      frame: (f) => this.onFrame(f),
      close: (kind, reason) => this.onUpstreamClose(kind, reason),
    });
  }

  private completeRegistration(f: Frame<"welcome">): void {
    const nick = this.nick ?? "";
    if (this.anonymous) {
      this.self = { login: nick, displayName: nick, userId: null, color: null };
    } else if (f.user) {
      this.self = { login: f.user.username, displayName: f.user.displayName, userId: f.user.id, color: null };
    } else {
      // Upstream accepted the connection but did not authenticate the token.
      return this.loginFailed();
    }
    this.state = "registered";
    const login = this.self.login;
    const welcome: [string, string][] = [
      ["001", "Welcome, GLHF!"],
      ["002", `Your host is ${SERVER_NAME}`],
      ["003", "This server is rather new"],
      ["004", "-"],
      ["375", "-"],
      ["372", this.opts.motd],
      ["376", ">"],
    ];
    for (const [code, text] of welcome)
      this.emit({ prefix: SERVER_NAME, command: code, params: [login], trailing: text });
    if (!this.anonymous) this.emit(globaluserstate(this.self), "twitch.tv/commands");

    const every = Math.max(MIN_HEARTBEAT_MS, f.heartbeatMs);
    this.heartbeat = setInterval(() => this.send({ op: "ping" }), every);
  }

  private loginFailed(): void {
    this.emit(notice("*", null, "Login authentication failed"));
    this.close("Login authentication failed", false);
  }

  // ------------------------------------------------------------ upstream (chat → gateway)

  private onFrame(f: UpstreamFrame): void {
    if (this.state === "closed") return;
    if (f.op === "welcome") {
      if (this.state === "registering") this.completeRegistration(f);
      return;
    }
    if (f.op === "error") {
      if (this.state !== "registered") return this.loginFailed();
      this.log.warn("upstream error frame", { code: f.code });
      const reply = this.takeReply(f.nonce, f.channel ?? null, f.code);
      const known = (NOTICE_MSG_IDS as Record<string, string | undefined>)[f.code];
      // tmi.js rejects a pending join() on msg_room_not_found.
      const msgId = known ?? (reply.failedJoin ? "msg_room_not_found" : null);
      const target = f.channel ? ircChannel(f.channel) : "*";
      return this.emit(notice(target, msgId, f.message), "twitch.tv/commands");
    }
    if (this.state !== "registered") return;
    switch (f.op) {
      case "joined":
        return this.onJoined(f);
      case "parted":
        return this.onParted(f.channel);
      case "message":
        return this.onMessage(f.channel, f.message);
      case "ack":
        return this.onAck(f);
      case "delete": {
        const room = this.rooms.get(f.channel);
        if (room) this.emit(clearmsg(room, f, room.recent.get(f.messageId) ?? ""), "twitch.tv/commands");
        return;
      }
      case "clear":
      case "ban": {
        const room = this.rooms.get(f.channel);
        if (room) this.emit(clearchat(room, f), "twitch.tv/commands");
        return;
      }
      case "settings": {
        const room = this.rooms.get(f.channel);
        if (!room) return;
        const line = roomstate(room, f.settings, room.settings);
        room.settings = f.settings;
        if (line) this.emit(line, "twitch.tv/commands");
        return;
      }
      case "notice":
        return this.onNotice(f);
      case "event": {
        const room = this.rooms.get(f.channel);
        if (!room) return;
        const line = usernotice(room, f, room);
        if (line) this.emit(line, "twitch.tv/commands");
        return;
      }
      case "raid":
        return; // an outgoing raid countdown has no Twitch IRC line (the incoming raid is the channel.raid USERNOTICE)
      case "surge":
        return; // surge mode has no Twitch IRC line; the denial NOTICE carries it
      case "pong":
        return;
    }
  }

  private onJoined(f: Frame<"joined">): void {
    const self = this.self;
    if (!self) return;
    const pending = this.pendingJoins.get(f.channel);
    if (this.rooms.has(f.channel)) return; // duplicate
    if (!pending || pending.nonce === null) {
      // Parted or timed out while the join was in flight: leave upstream too, so both sides agree.
      if (!this.controlQueue.some((c) => c.op === "part" && c.slug === f.channel))
        this.enqueueControl({ op: "part", slug: f.channel });
      return;
    }
    this.forgetJoin(f.channel);
    const room: Room = {
      slug: f.channel,
      channelId: f.channelId,
      settings: f.settings,
      badges: parseBadgeStrings(f.me.badges),
      canModerate: f.me.canModerate,
      recent: new Map(),
      seen: new Set(),
      giftPool: null,
    };
    this.rooms.set(f.channel, room);
    const chan = ircChannel(room.slug);
    const nickHost = `${self.login}.${SERVER_NAME}`;
    this.emit({ prefix: userPrefix(self.login), command: "JOIN", params: [chan] });
    this.emit({ prefix: nickHost, command: "353", params: [self.login, "=", chan], trailing: self.login });
    this.emit({ prefix: nickHost, command: "366", params: [self.login, chan], trailing: "End of /NAMES list" });
    if (!this.anonymous) this.emit(userstate(room, self, room.badges, room.canModerate), "twitch.tv/commands");
    const rs = roomstate(room, room.settings);
    if (rs) this.emit(rs, "twitch.tv/commands");
  }

  private onParted(slug: string): void {
    for (const [nonce, s] of this.partNonces) if (s === slug) this.partNonces.delete(nonce);
    if (!this.rooms.delete(slug) || !this.self) return;
    this.emit({ prefix: userPrefix(this.self.login), command: "PART", params: [ircChannel(slug)] });
  }

  private onMessage(slug: string, m: ChatMessage): void {
    const room = this.rooms.get(slug);
    const self = this.self;
    if (!room || !self) return;
    room.recent.set(m.id, m.body);
    if (room.recent.size > RECENT_BODIES) room.recent.delete(room.recent.keys().next().value as string);

    if (self.userId !== null && m.user.id === self.userId) {
      self.color = m.user.color;
      room.badges = m.user.badges;
      // Twitch never echoes a client's own PRIVMSG back to it; messages sent from elsewhere are delivered.
      if (this.ackedIds.has(m.id)) return;
      if ([...this.pendingSends.values()].includes(slug)) {
        this.heldSelf.set(
          m.id,
          setTimeout(() => {
            this.heldSelf.delete(m.id);
            this.deliver(room, m);
          }, SELF_ECHO_HOLD_MS),
        );
        return;
      }
    }
    this.deliver(room, m);
  }

  private deliver(room: Room, m: ChatMessage): void {
    if (this.state !== "registered" || !this.rooms.has(room.slug)) return;
    const login = m.user.username;
    if (this.caps.has("twitch.tv/membership") && login !== this.self?.login && !room.seen.has(login)) {
      // We have no presence feed; announce chatters when first seen, like Twitch's batched JOINs.
      room.seen.add(login);
      if (room.seen.size > SEEN_CHATTERS) room.seen.delete(room.seen.values().next().value as string);
      this.emit({ prefix: userPrefix(login), command: "JOIN", params: [ircChannel(room.slug)] });
    }
    this.emit(privmsg(room, m));
  }

  private onAck(f: Frame<"ack">): void {
    if (f.nonce === undefined) return;
    const slug = this.pendingSends.get(f.nonce);
    if (slug === undefined) return;
    this.pendingSends.delete(f.nonce);
    if (f.id === null) return; // rejected; the notice explains why
    this.ackedIds.add(f.id);
    if (this.ackedIds.size > RECENT_BODIES) this.ackedIds.delete(this.ackedIds.values().next().value as string);
    const held = this.heldSelf.get(f.id);
    if (held) {
      clearTimeout(held);
      this.heldSelf.delete(f.id);
    }
    const room = this.rooms.get(slug);
    // Twitch answers every accepted PRIVMSG with USERSTATE.
    if (room && this.self && !f.held)
      this.emit(userstate(room, this.self, room.badges, room.canModerate), "twitch.tv/commands");
  }

  private onNotice(f: Frame<"notice">): void {
    const slug = f.channel;
    const { command } = this.takeReply(f.nonce, slug, f.code);
    const msgId = noticeMsgId(f.code, f.code === "cmd_success" ? (command ?? "") : undefined);
    if (msgId === null) return;
    this.emit(notice(slug === null ? "*" : ircChannel(slug), msgId, f.text), "twitch.tv/commands");
  }

  /**
   * Work out which request an upstream notice/error answers. Replies carry our nonce;
   * for a reply without one (older upstream), the oldest pending command on that
   * channel is taken as answered, and failing that a pending join on it.
   */
  private takeReply(nonce: string | undefined, slug: string | null, code: string): Reply {
    this.prunePendingCommands();
    if (nonce !== undefined) {
      const cmd = this.pendingCommands.get(nonce);
      if (cmd) {
        this.pendingCommands.delete(nonce);
        return { command: cmd.command };
      }
      const joinSlug = this.joinNonces.get(nonce);
      if (joinSlug !== undefined) {
        if (code !== "cmd_success") this.forgetJoin(joinSlug);
        return { failedJoin: joinSlug };
      }
      this.partNonces.delete(nonce);
      return {};
    }
    if (slug === null) return {};
    for (const [n, c] of this.pendingCommands) {
      if (c.slug !== slug) continue;
      this.pendingCommands.delete(n);
      return { command: c.command };
    }
    const join = this.pendingJoins.get(slug);
    if (join && join.nonce !== null && code !== "cmd_success") {
      this.forgetJoin(slug);
      return { failedJoin: slug };
    }
    return {};
  }

  private prunePendingCommands(): void {
    const now = Date.now();
    for (const [n, c] of this.pendingCommands) {
      if (c.expiresAt >= now) break; // Map order = send order, and every entry has the same timeout
      this.pendingCommands.delete(n);
    }
  }

  private onUpstreamClose(kind: UpstreamCloseKind, reason: string): void {
    this.upstream = null;
    if (this.state === "closed") return;
    this.log.info("upstream closed", { kind, reason });
    if (this.state !== "registered" && kind === "rejected" && !this.anonymous) return this.loginFailed();
    this.close(this.state === "registered" ? "Chat connection closed" : "Chat service unavailable", true);
  }

  // ------------------------------------------------------------ outbound

  private send(frame: ClientFrame): void {
    this.upstream?.send(frame);
  }

  /** Queue a line for the client; lines produced in one tick go out together (one WS frame / one write). */
  private emit(msg: OutgoingMessage, cap?: Cap): void {
    if (this.state === "closed") return;
    if (cap && !this.caps.has(cap)) return;
    this.outbox.push(render(msg, this.caps.has("twitch.tv/tags")));
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private reply(code: string, text: string, extra: string[] = []): void {
    this.emit({
      prefix: SERVER_NAME,
      command: code,
      params: [this.self?.login ?? this.nick ?? "*", ...extra.map(middleParam)],
      trailing: text,
    });
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.outbox.length === 0) return;
    const lines = this.outbox;
    this.outbox = [];
    this.transport.write(lines);
    if (this.transport.bufferedBytes() > this.limits.maxBufferedBytes && this.state !== "closed") {
      this.log.warn("client too slow, disconnecting");
      this.close("Slow consumer", false);
    }
  }

  private checkIdle(): void {
    if (this.state === "closed") return;
    const now = Date.now();
    // Drop only after an unanswered PING: a late check must never skip straight to the timeout.
    if (this.pingSentAt !== null) {
      if (now - this.pingSentAt > this.limits.idlePingMs) this.close("Ping timeout", true);
      return;
    }
    if (now - this.lastActivity > this.limits.idlePingMs) {
      this.pingSentAt = now;
      this.emit({ command: "PING", trailing: SERVER_NAME });
    }
  }

  // ------------------------------------------------------------ lifecycle

  /** Graceful shutdown: tell the client to reconnect (it will land on another instance). */
  announceReconnect(): void {
    if (this.state === "registered") this.emit({ prefix: SERVER_NAME, command: "RECONNECT" }, "twitch.tv/commands");
  }

  /** The transport closed from the client side. */
  transportClosed(): void {
    if (this.state === "closed") return;
    this.close("Connection closed", false);
  }

  close(reason: string, withError: boolean): void {
    if (this.state === "closed") return;
    // Mark closed first: flush() may detect a slow consumer and must not re-enter close().
    this.state = "closed";
    if (withError) this.outbox.push(`ERROR :Closing Link: ${reason}`);
    this.flush();
    for (const t of this.timers) clearTimeout(t);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const t of this.heldSelf.values()) clearTimeout(t);
    this.heldSelf.clear();
    if (this.controlTimer) clearTimeout(this.controlTimer);
    for (const slug of this.pendingJoins.keys()) this.forgetJoin(slug);
    this.upstream?.close();
    this.upstream = null;
    this.transport.close();
    this.opts.onClosed?.(this);
  }
}
