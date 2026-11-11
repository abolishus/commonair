// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, EmptyState, StatusBadge } from "@commonair/ui";
import { ChatComposer, ChatMessage, ChatPanel as ChatPanelShell } from "@commonair/ui/blocks/media";
import { toast } from "@commonair/ui/toast";
import { cn } from "@commonair/ui/lib/utils";
import { Alert02Icon, Message01Icon, UnavailableIcon, UserBlock01Icon } from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { ChatSignUpPrompt } from "../components/auth-gate/chat-prompt.tsx";
import { LegalDocumentLink, type LegalDoc } from "../components/legal-document-link.tsx";
import type { ReportClient } from "../components/safety/client.ts";
import { HeldQueue } from "../components/mod/held-queue.tsx";
import { WatchRoomDrawer } from "../components/watch-room/drawer.tsx";
import { EMPTY_HELD, heldReducer } from "../components/mod/held-state.ts";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api, errorCode } from "../lib/api.ts";
import {
  blocksClient as defaultBlocksClient,
  noteBlocked,
  useBlocks,
  type BlockSet,
  type BlocksClient,
} from "./blocks.ts";
import { CalmControls, CALM_KEYS, useCalmSettings } from "./calm/calm-controls.tsx";
import { isForMe, isOwn, withoutBlocked } from "./calm/reducer.ts";
import { useCalm } from "./calm/use-calm.ts";
import { WaveRow } from "./calm/wave-row.tsx";
import { ChatEventRow } from "./chat-event-row.tsx";
import { ChatConnection, type ChatMessageFrame, type ChatStatus } from "./connection.ts";
import { chatEventView } from "./events.ts";
import { browserInteractClient, withPlayhead, type InteractClient } from "./interact/client.ts";
import { GiveawayCard } from "./interact/giveaway-card.tsx";
import { PointsChip } from "./interact/points-chip.tsx";
import { ChatPollCard } from "./interact/poll-card.tsx";
import { ChatPredictionCard, type PredictionChannel } from "./interact/prediction-card.tsx";
import { RaidBanner } from "./interact/raid-banner.tsx";
import { useChatInteract } from "./interact/use-chat-interact.ts";
import { errorMessage, noticeMessage } from "./messages.ts";
import { MessageMenu, TIMEOUT_SECONDS } from "./mod-menu.tsx";
import { useDismissed, type DismissStore } from "./pinned/dismissed.ts";
import { pinnedItems, undismissed, type PinnedItem } from "./pinned/model.ts";
import { PinnedStrip, usePinnedAnnouncement } from "./pinned/strip.tsx";
import { GoalCard } from "./pinned/goal-card.tsx";
import { ChatOffline } from "./offline.tsx";
import { presentationQueue } from "./presentation.ts";
import { chatReducer, EMPTY_GATE, gateReducer, Tombstones, type ChatRow } from "./state.ts";
import { SurgeBanner } from "./surge-banner.tsx";
import { badgeAttr, chatStatusView, nameColorIndex, visibleBadges } from "./view.ts";

export interface ChatPanelProps {
  channel: string;
  /** The channel's id and live state, passed to the prediction card (batch 8 contract step §3.8). */
  stream?: PredictionChannel;
  /** The channel's display name, for the offline state ("Chat is quiet until … goes live"); the slug otherwise. */
  channelName?: string;
  /**
   * The page holds the stream behind the 18+ check (or a locked restricted stream): chat shows
   * why instead of the log until the viewer confirms.
   */
  ageGated?: boolean;
  signedIn: boolean;
  /** The signed-in viewer's username, so moderation controls skip their own messages. */
  selfUsername?: string | null;
  className?: string;
  /** Poll, prediction, giveaway and points calls; tests pass a fake. */
  interactClient?: InteractClient;
  /** `me.blocks` calls; tests pass a fake. */
  blocksClient?: BlocksClient;
  /** `safety.report` for "Report wave"; tests pass a fake. */
  reportClient?: ReportClient;
  /** Where the pinned strip remembers dismissals (this tab's `sessionStorage`); tests pass a fake. */
  dismissStore?: DismissStore;
}

interface ModTarget {
  id: string;
  username: string;
  displayName: string;
}

const EMPTY_ROWS: ChatRow[] = [];
const NO_BLOCKS: BlockSet = { ids: new Set(), usernames: new Set() };

const noop = () => {};

// One request per page load for the replay disclosure's privacy-policy link; a failure retries on the next mount.
let privacyPolicy: Promise<LegalDoc | null> | null = null;
function loadPrivacyPolicy(): Promise<LegalDoc | null> {
  // Inside `then`, so a client that cannot reach the API rejects instead of throwing during render.
  privacyPolicy ??= Promise.resolve()
    .then(() => api().legal.current())
    .then((docs) => docs.find((d) => d.kind === "privacy") ?? null)
    .catch(() => {
      privacyPolicy = null;
      return null;
    });
  return privacyPolicy;
}

/** ADR 0012 decision 9: chat is kept with the VOD and replayed beside it; says so where people type. */
function ReplayDisclosure(): React.JSX.Element {
  const [doc, setDoc] = React.useState<LegalDoc | null>(null);
  React.useEffect(() => {
    let live = true;
    void loadPrivacyPolicy().then((d) => {
      if (live) setDoc(d);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <p data-testid="chat-replay-disclosure" className="px-1 pt-1 text-xs text-muted-foreground">
      {t("chat.replayDisclosure")}
      {doc && (
        <>
          {" "}
          <LegalDocumentLink doc={doc} label={t("chat.replayDisclosureLink")} />
        </>
      )}
    </p>
  );
}

type MessageRow = Extract<ChatRow, { kind: "message" }>;

/** Usernames of blocked users: the ones this tab blocked plus the authors of blocked rows in the log. */
function blockedNames(rows: readonly ChatRow[], blocks: BlockSet): ReadonlySet<string> {
  if (blocks.ids.size === 0) return blocks.usernames;
  const names = new Set(blocks.usernames);
  for (const r of rows)
    if (r.kind === "message" && blocks.ids.has(r.message.user.id)) names.add(r.message.user.username);
  return names;
}

/** Whether a reply quotes a blocked user (by the quoted message's author, or by name). */
function quotesBlocked(m: ChatMessageFrame, rows: readonly ChatRow[], blocks: BlockSet, names: ReadonlySet<string>) {
  const reply = m.replyTo;
  if (!reply) return false;
  if (names.has(reply.username)) return true;
  return rows.some((r) => r.kind === "message" && r.id === reply.id && blocks.ids.has(r.message.user.id));
}

/**
 * j/k move focus between the list's rows, m jumps to the next mention of the viewer (Calm Chat's
 * keyboard help). Keys typed into a field, or with a modifier, are left alone.
 */
function onListKey(list: HTMLElement, e: KeyboardEvent, setActive: (id: string | null) => void): void {
  if (e.altKey || e.ctrlKey || e.metaKey || !(e.target instanceof HTMLElement)) return;
  const target = e.target;
  if (target.closest("input, textarea, [contenteditable='true']")) return;
  const key = e.key.toLowerCase();
  if (key !== CALM_KEYS.next && key !== CALM_KEYS.previous && key !== CALM_KEYS.mention) return;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-calm-row]")];
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r === target || r.contains(target));
  let next: HTMLElement | undefined;
  if (key === CALM_KEYS.next) next = rows[at < 0 ? 0 : Math.min(rows.length - 1, at + 1)];
  else if (key === CALM_KEYS.previous) next = rows[at < 0 ? rows.length - 1 : Math.max(0, at - 1)];
  else
    next =
      rows.slice(at + 1).find((r) => r.dataset.mention === "true") ?? rows.find((r) => r.dataset.mention === "true");
  if (!next) return;
  e.preventDefault();
  setActive(next.dataset.id ?? null);
  next.focus();
}

export function ChatPanel({
  channel,
  stream,
  channelName,
  ageGated = false,
  signedIn,
  selfUsername = null,
  className,
  interactClient,
  blocksClient,
  reportClient,
  dismissStore,
}: ChatPanelProps): React.JSX.Element {
  const [status, setStatus] = React.useState<ChatStatus>("connecting");
  const [rows, dispatch] = React.useReducer(chatReducer, EMPTY_ROWS);
  const [canChat, setCanChat] = React.useState(false);
  const [canModerate, setCanModerate] = React.useState(false);
  const [held, heldDispatch] = React.useReducer(heldReducer, EMPTY_HELD);
  // The target outlives `open` so the dialog title keeps its name while it animates closed.
  const [banDialog, setBanDialog] = React.useState<{ open: boolean; target: ModTarget | null }>({
    open: false,
    target: null,
  });
  const [blockDialog, setBlockDialog] = React.useState<{ open: boolean; target: ModTarget | null }>({
    open: false,
    target: null,
  });
  const [activeRow, setActiveRow] = React.useState<string | null>(null);
  // A listener, not a JSX handler: the rows are the focus targets, the wrapper only hears their keys.
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onKey = (e: KeyboardEvent) => onListKey(list, e, setActiveRow);
    list.addEventListener("keydown", onKey);
    return () => list.removeEventListener("keydown", onKey);
    // The log is not rendered while age-gated; attach once it mounts after the 18+ confirmation.
  }, [ageGated]);
  const [draft, setDraft] = React.useState("");
  // Fed to <SurgeBanner/> (W1-watch-gate): the latest settings and surge frames, and a refused send.
  const [{ settings, surge, gateDenied }, gateDispatch] = React.useReducer(gateReducer, EMPTY_GATE);
  const connection = React.useRef<ChatConnection | null>(null);
  const noticeSeq = React.useRef(0);
  const navigate = useNavigate();
  const [baseClient] = React.useState(() => interactClient ?? browserInteractClient());
  // Batch 7 decision (v): bets carry this channel's playhead and playback mode (the player seam).
  const client = React.useMemo(() => withPlayhead(baseClient, channel), [baseClient, channel]);
  const interact = useChatInteract({
    channel,
    signedIn,
    selfUsername,
    client,
    onFollowRaid: (to) => void navigate({ to: "/$channel", params: { channel: to } }),
  });
  // The connection keeps the handlers it was given; they reach the latest state through this.
  const interactRef = React.useRef(interact);
  const selfRef = React.useRef(selfUsername);
  React.useEffect(() => {
    interactRef.current = interact;
    selfRef.current = selfUsername;
  });

  React.useEffect(() => {
    heldDispatch({ type: "reset" });
    gateDispatch({ type: "reset" });
    // ADR 0012 amendment 1 decision 3: lines and inline events wait for the playhead when the
    // viewer opted in (alerts by default); the viewer's own lines are never held.
    const queue = presentationQueue({
      channel,
      creatorView: selfRef.current?.toLowerCase() === channel.toLowerCase(),
    });
    const tombstones = new Tombstones();
    const conn = new ChatConnection(
      channel,
      {
        getToken: () => api().chat.connectToken(),
        createSocket: (url) => new WebSocket(url),
      },
      {
        onStatus: setStatus,
        onJoined: (me) => {
          setCanChat(me.canChat);
          setCanModerate(me.canModerate);
          // A (re)join starts over: the gate is checked again on the next send.
          gateDispatch({ type: "joined" });
        },
        onSettings: (next) => gateDispatch({ type: "settings", settings: next }),
        onSurge: (next) => gateDispatch({ type: "surge", surge: next }),
        onMessage: (message) => {
          // An allowed held message comes back as an ordinary one.
          heldDispatch({ type: "remove", id: message.id });
          const arrived = tombstones.arrive();
          queue.present(
            { kind: "chat", mediaTs: message.mediaTs ?? null, own: isOwn(message, selfRef.current) },
            () => {
              // Moderation may have come while the queue held the line.
              if (!tombstones.hides(message, arrived)) dispatch({ type: "message", message });
            },
          );
        },
        onHeld: (message) => heldDispatch({ type: "held", message }),
        onDelete: (messageId) => {
          tombstones.delete(messageId);
          dispatch({ type: "delete", messageId });
          heldDispatch({ type: "remove", id: messageId });
        },
        onClear: () => {
          tombstones.clear();
          dispatch({ type: "clear" });
        },
        onBan: (userId, username) => {
          tombstones.ban(userId, username);
          dispatch({ type: "ban", userId, username });
          heldDispatch({ type: "removeUser", userId });
        },
        // Notices answer something the viewer did, so they belong inline; socket errors stay toasts.
        onNotice: (code, kind) => {
          if (code === "msg_verified_watch") gateDispatch({ type: "denied" });
          if (kind === "error") toast.error(errorMessage(code));
          else dispatch({ type: "notice", id: `notice-${++noticeSeq.current}`, code });
        },
        onEvent: (type, data) => {
          // Poll and prediction frames update their cards, never the log.
          if (interactRef.current.onEvent(type, data)) return;
          const event = chatEventView(type, data);
          if (!event) return;
          const id = `event-${++noticeSeq.current}`;
          queue.present({ kind: "alert", mediaTs: null, own: false }, () => dispatch({ type: "event", id, event }));
        },
        onRaid: (raid) => interactRef.current.onRaid(raid),
      },
    );
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
      queue.dispose();
      connection.current = null;
    };
  }, [channel, signedIn]);

  const send = () => {
    if (!draft.trim()) return;
    if (connection.current?.send(draft)) setDraft("");
    else toast.error(t("chat.notConnected"));
  };

  // Timeouts act at once (Twitch parity); bans go through a ConfirmDialog.
  const timeout = async (target: ModTarget) => {
    try {
      await api().chat.bans.ban({ channel, username: target.username, durationSeconds: TIMEOUT_SECONDS });
      toast.success(t("chat.mod.timedOut", { name: target.displayName }));
    } catch (err) {
      toastActionError(err, t("chat.mod.failed"));
    }
  };

  const ban = async (target: ModTarget) => {
    await api().chat.bans.ban({ channel, username: target.username });
    toast.success(t("chat.mod.banned", { name: target.displayName }));
  };

  const myBlocks = useBlocks(signedIn ? selfUsername : null, blocksClient);
  // Moderators (and the broadcaster) see blocked users' lines in channels they moderate, so they
  // can still time them out or ban them.
  const blocks = canModerate ? NO_BLOCKS : myBlocks;
  const block = async (target: ModTarget) => {
    const { user } = await (blocksClient ?? defaultBlocksClient()).add(target.username);
    noteBlocked(user);
    toast.success(t("blocks.done", { name: target.displayName }));
  };

  const self = selfUsername?.toLowerCase() ?? null;
  const visible = React.useMemo(() => withoutBlocked(rows, blocks.ids), [rows, blocks.ids]);
  const names = React.useMemo(() => blockedNames(rows, blocks), [rows, blocks]);
  const calmSettings = useCalmSettings();
  // Moderators always see raw chat.
  const calmOn = calmSettings.enabled && !canModerate;
  const calm = useCalm({
    rows: visible,
    log: rows,
    enabled: calmOn,
    rowsPerSecond: calmSettings.rowsPerSecond,
    subscriberPriority: calmSettings.subscriberPriority,
    self,
  });
  const statusView = chatStatusView(status);
  const inputDisabled = status !== "open" || !canChat;
  const isBroadcaster = self !== null && self === channel.toLowerCase();
  const { poll, prediction, giveaway, goals, points, raid } = interact;
  // The banner area opens only when there is something to say, so an empty bordered box never shows.
  const surgeActive = surge !== null && surge.state !== "off";
  // The viewer's gate hint (ADR 0015); the banner checks features.watchGate and renders nothing otherwise.
  const gated = !canModerate && (settings?.minVerifiedWatchSeconds ?? 0) > 0;
  // Predictions, polls and giveaways fold into one line at the top of the log (design review F6).
  const allPinned = React.useMemo(
    () => pinnedItems({ poll, prediction, giveaway, goals }),
    [poll, prediction, giveaway, goals],
  );
  const { dismissed, dismiss } = useDismissed(dismissStore);
  const shownPinned = React.useMemo(() => undismissed(allPinned, dismissed), [allPinned, dismissed]);
  const pinnedNews = usePinnedAnnouncement(allPinned, interact.loaded);
  // Dismissing the last item unmounts the strip and its focused button: move focus somewhere stable.
  const refocusAfterDismiss = React.useRef(false);
  React.useEffect(() => {
    if (!refocusAfterDismiss.current || shownPinned.length > 0) return;
    refocusAfterDismiss.current = false;
    const list = listRef.current;
    const panel = list?.closest<HTMLElement>('[data-testid="chat"]');
    const input = panel?.querySelector<HTMLInputElement>('[data-testid="chat-input"]:not(:disabled)');
    const rows = list ? [...list.querySelectorAll<HTMLElement>("[data-calm-row]")] : [];
    const row = rows.find((r) => r.dataset.id === activeRow) ?? rows.at(-1);
    const log = panel?.querySelector<HTMLElement>('[data-slot="chat-log"]');
    const target = input ?? row ?? log;
    if (!target) return;
    if (target === log && !log.hasAttribute("tabindex")) log.tabIndex = -1;
    target.focus();
  }, [shownPinned.length, activeRow]);
  const dismissPinned = (item: PinnedItem) => {
    if (shownPinned.length === 1) refocusAfterDismiss.current = true;
    dismiss(item.key);
  };
  const renderCard = (item: PinnedItem): React.ReactNode => {
    if (item.kind === "poll" && poll)
      return (
        <ChatPollCard
          key={poll.id}
          poll={poll}
          signedIn={signedIn}
          points={points}
          client={client}
          onVoted={interact.setPoll}
          onPointsSpent={interact.refreshPoints}
        />
      );
    if (item.kind === "prediction" && prediction)
      return (
        <ChatPredictionCard
          key={prediction.id}
          prediction={prediction}
          channel={stream ?? null}
          signedIn={signedIn}
          staff={canModerate || isBroadcaster}
          points={points}
          client={client}
          onBet={interact.setPrediction}
          onPointsSpent={interact.refreshPoints}
        />
      );
    if (item.kind === "giveaway" && giveaway)
      return (
        <GiveawayCard
          key={giveaway.id}
          channel={channel}
          giveaway={giveaway}
          signedIn={signedIn}
          client={client}
          onEntered={interact.setGiveaway}
        />
      );
    const goal = item.kind === "goal" ? goals.find((g) => g.id === item.id) : undefined;
    if (goal) return <GoalCard key={goal.id} goal={goal} item={item} />;
    return null;
  };
  const pinned =
    raid || shownPinned.length > 0 || surgeActive || gateDenied || gated ? (
      <div className="grid gap-2">
        <SurgeBanner
          channel={channel}
          canModerate={canModerate}
          signedIn={signedIn}
          settings={settings}
          surge={surge}
          gateDenied={gateDenied}
        />
        {raid && <RaidBanner raid={raid} isBroadcaster={isBroadcaster} />}
        {shownPinned.length > 0 && (
          <PinnedStrip items={shownPinned} renderCard={renderCard} onDismiss={dismissPinned} />
        )}
      </div>
    ) : undefined;

  const renderMessage = (row: MessageRow, roving: boolean, key = row.id) => {
    const { message } = row;
    const { user } = message;
    const target = { id: user.id, username: user.username, displayName: user.displayName };
    const own = user.username.toLowerCase() === self;
    const { deleted } = row;
    const forMe = isForMe(message, self);
    const reply = message.replyTo;
    const body = reply ? (
      <>
        <span className="block text-muted-foreground">
          {quotesBlocked(message, rows, blocks, names)
            ? t("blocks.replyToBlocked")
            : t("calmChat.replyTo", { name: reply.username })}
        </span>
        {message.body}
      </>
    ) : (
      message.body
    );
    return (
      <ChatMessage
        key={key}
        data-testid="chat-message"
        data-id={row.id}
        data-author={user.username}
        data-badges={badgeAttr(user.badges)}
        data-media-ts={message.mediaTs ?? ""}
        data-mention={forMe ? "true" : undefined}
        data-calm-row={roving ? "" : undefined}
        tabIndex={roving ? (row.id === focusId ? 0 : -1) : undefined}
        badges={visibleBadges(user.badges)}
        data-deleted={row.deleted ? "true" : undefined}
        className="focus-visible:bg-muted focus-visible:outline-none"
        highlight={forMe}
        author={user.displayName}
        colorIndex={nameColorIndex(user.username)}
        body={body}
        action={message.isAction}
        deleted={deleted}
        deletedLabel={t("chat.messageDeleted")}
        actions={
          signedIn && !deleted && !own ? (
            <MessageMenu
              displayName={user.displayName}
              onBlock={() => setBlockDialog({ open: true, target })}
              moderation={
                canModerate
                  ? { onTimeout: () => void timeout(target), onBan: () => setBanDialog({ open: true, target }) }
                  : null
              }
            />
          ) : undefined
        }
      />
    );
  };

  const renderRow = (row: ChatRow, roving: boolean) => {
    if (row.kind === "event") return <ChatEventRow key={row.id} event={row.event} />;
    if (row.kind === "notice")
      return (
        <ChatMessage
          key={row.id}
          notice
          data-testid="chat-notice"
          data-code={row.code}
          author=""
          colorIndex={1}
          body={noticeMessage(row.code)}
        />
      );
    return renderMessage(row, roving);
  };

  // Roving focus for j/k: the active row (else the newest) is the one Tab reaches.
  const rowIds = calm.rows
    ? calm.rows.flatMap((r) => (r.kind === "wave" ? [r.wave.id] : r.row.kind === "message" ? [r.row.id] : []))
    : visible.flatMap((r) => (r.kind === "message" ? [r.id] : []));
  const focusId = activeRow !== null && rowIds.includes(activeRow) ? activeRow : (rowIds.at(-1) ?? null);
  const list: React.ReactNode[] = calm.rows
    ? calm.rows.map((r) =>
        r.kind === "row" ? (
          renderRow(r.row, true)
        ) : (
          <WaveRow
            key={r.wave.id}
            wave={r.wave}
            expanded={r.expanded}
            onToggle={() => calm.toggleWave(r.wave.id)}
            canReport={signedIn}
            reportClient={reportClient}
            tabIndex={r.wave.id === focusId ? 0 : -1}
            renderMessage={(m) =>
              renderMessage({ kind: "message", id: m.id, message: m, deleted: false }, false, `wave-${m.id}`)
            }
          />
        ),
      )
    : visible.map((r) => renderRow(r, true));

  const name = channelName ?? channel;
  if (ageGated)
    // Nothing of the channel's chat shows before the 18+ check: no log frame, no composer.
    return (
      <section
        data-testid="chat"
        data-state="gated"
        aria-label={t("chat.title")}
        className={cn("flex min-h-0 min-w-0 flex-col border border-border bg-card", className)}
      >
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="truncate text-sm font-semibold">{t("chat.title")}</h2>
          {/* A room invite still opens here, so a refused join (e.g. a minor on a mature channel) says why. */}
          <WatchRoomDrawer channel={channel} signedIn={signedIn} selfUsername={selfUsername} />
        </header>
        <EmptyState
          data-testid="chat-gated"
          className="flex-1"
          icon={Alert02Icon}
          title={t("chat.column.gatedTitle")}
          description={t("chat.column.gatedBody")}
          headingLevel={3}
        />
      </section>
    );
  // Offline with nothing said yet: why it is quiet, not "No messages yet".
  const offline = stream !== undefined && !stream.live;
  const empty = offline ? (
    <ChatOffline channel={channel} name={name} />
  ) : (
    <EmptyState icon={Message01Icon} title={t("chat.empty")} headingLevel={3} />
  );

  return (
    <ChatPanelShell
      data-testid="chat"
      logLive={calmOn ? "off" : "polite"}
      data-state={status}
      aria-label={t("chat.title")}
      title={t("chat.title")}
      logLabel={t("chat.log")}
      newMessagesLabel={t("chat.newMessages")}
      pinned={pinned}
      viewersAction={
        <>
          {canModerate && <HeldQueue channel={channel} state={held} dispatch={heldDispatch} />}
          {!canModerate && <CalmControls settings={calmSettings} />}
          {/* W3-watch-rooms: the room trigger and its drawer (ADR 0017); renders nothing until that unit lands. */}
          <WatchRoomDrawer channel={channel} signedIn={signedIn} selfUsername={selfUsername} />
          <StatusBadge tone={statusView.tone} aria-live="polite">
            {statusView.label}
          </StatusBadge>
        </>
      }
      className={className}
      footer={
        <>
          {/* One polite line when a pinned item appears or changes state; never the countdown. */}
          <p data-part="pinned-announce" aria-live="polite" aria-atomic="true" className="sr-only">
            {pinnedNews}
          </p>
          {calmOn && (
            <output
              data-testid="calm-digest"
              aria-live="polite"
              aria-atomic="true"
              aria-label={t("calmChat.digestLabel")}
              className="block min-h-4 px-1 pb-1 text-xs text-muted-foreground"
            >
              {calm.digest}
            </output>
          )}
          {signedIn ? (
            <ChatComposer
              value={draft}
              onValueChange={setDraft}
              onSubmit={send}
              maxLength={500}
              placeholder={t("chat.placeholder")}
              sendLabel={t("chat.send")}
              disabled={inputDisabled}
              // The viewer's points sit in the input row, as on Twitch (design review F6).
              pointsAction={points ? <PointsChip balance={points} /> : undefined}
              inputProps={{ "data-testid": "chat-input" }}
              sendProps={{ "data-testid": "chat-send" }}
            />
          ) : (
            <ChatComposer
              data-testid="chat-signin-prompt"
              value=""
              onValueChange={noop}
              onSubmit={noop}
              placeholder={t("chat.placeholder")}
              sendLabel={t("chat.send")}
              signin={<ChatSignUpPrompt />}
            />
          )}
          <ReplayDisclosure />
        </>
      }
    >
      <div ref={listRef} className="contents">
        {list.length === 0 ? empty : list}
      </div>
      <ConfirmDialog
        open={banDialog.open}
        onOpenChange={(open) => {
          if (!open) setBanDialog((d) => ({ ...d, open: false }));
        }}
        variant="destructive"
        icon={UserBlock01Icon}
        title={t("chat.mod.banConfirmTitle", { name: banDialog.target?.displayName ?? "" })}
        description={t("chat.mod.banConfirmBody")}
        confirmLabel={t("chat.mod.ban")}
        onConfirm={() => (banDialog.target ? ban(banDialog.target) : undefined)}
        onError={(err) => toastActionError(err, t("chat.mod.failed"))}
      />
      <ConfirmDialog
        open={blockDialog.open}
        onOpenChange={(open) => {
          if (!open) setBlockDialog((d) => ({ ...d, open: false }));
        }}
        icon={UnavailableIcon}
        title={t("blocks.confirmTitle", { name: blockDialog.target?.displayName ?? "" })}
        description={t("blocks.confirmBody")}
        confirmLabel={t("blocks.confirm")}
        onConfirm={() => (blockDialog.target ? block(blockDialog.target) : undefined)}
        onError={(err) =>
          errorCode(err) === "PRECONDITION_FAILED"
            ? toast.error(t("blocks.limit"))
            : toastActionError(err, t("blocks.failed"))
        }
      />
    </ChatPanelShell>
  );
}
