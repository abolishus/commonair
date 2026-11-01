// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RoomEndReason } from "@commonair/contracts/enums";
import { ChannelAvatar, ConfirmDialog, EmptyState, IconButton, RelativeTime, StatusBadge } from "@commonair/ui";
import { ChatComposer, ChatMessage } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@commonair/ui/components/dialog";
import { Input } from "@commonair/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@commonair/ui/components/sheet";
import { toast } from "@commonair/ui/toast";
import { Copy01Icon, Flag01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { nameColorIndex } from "../../chat/view.ts";
import type { SocketLike } from "../../chat/connection.ts";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { roomPlayer } from "../../player/room-sync-registry.ts";
import { RoomSyncDriver } from "../../player/room-sync.ts";
import { ReportForm } from "../safety/report-dialog.tsx";
import {
  inviteFromSearch,
  MEMBER_REJOIN_NONCE,
  refusalOf,
  refusalOfNotice,
  watchRoomClient,
  withoutInvite,
  type InviteParams,
  type RoomRefusal,
  type WatchRoomClient,
  type WatchRoomDto,
  type WatchRoomInviteDto,
} from "./client.ts";
import { RoomConnection, type RoomFrame, type RoomMessageFrame } from "./connection.ts";

export interface WatchRoomDrawerProps {
  /** The channel whose broadcast the room watches. */
  channel: string;
  signedIn: boolean;
  selfUsername: string | null;
  /** Tests inject these; the page uses the API, the browser socket and the location. */
  client?: WatchRoomClient;
  createSocket?: (url: string) => SocketLike;
  search?: () => string;
  reducedMotion?: () => boolean;
}

/** Room messages kept in the drawer (the server sends the last 50 on join). */
export const ROOM_MESSAGES_MAX = 200;

type View =
  | { kind: "idle" }
  | { kind: "invited"; invite: InviteParams }
  | { kind: "refused"; code: RoomRefusal; invite: InviteParams | null }
  | { kind: "room"; room: WatchRoomDto; invite: WatchRoomInviteDto | null; nonce: string; token: string | null }
  | { kind: "ended"; reason: RoomEndReason };

const REFUSAL_KEYS: Record<RoomRefusal, MessageKey> = {
  room_age_band: "watchRooms.refusal.room_age_band",
  room_birth_date_unknown: "watchRooms.refusal.room_birth_date_unknown",
  room_mature_minor: "watchRooms.refusal.room_mature_minor",
  room_mature_unconfirmed: "watchRooms.refusal.room_mature_unconfirmed",
  room_banned: "watchRooms.refusal.room_banned",
  room_suspended: "watchRooms.refusal.room_suspended",
  room_blocked: "watchRooms.refusal.room_blocked",
  room_full: "watchRooms.refusal.room_full",
  room_closed: "watchRooms.refusal.room_closed",
  room_invite_invalid: "watchRooms.refusal.room_invite_invalid",
  room_not_live: "watchRooms.refusal.room_not_live",
};

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

/**
 * The watch-room drawer in the chat panel (ADR 0017, decisions (q) and (r)): open a room, copy the
 * invite, join from an invite link (`?room=&invite=` on the channel page), the members, the side
 * chat with a report action, leave and close. While in a room the player follows the room's sync
 * target (`player/room-sync*`). Signed-out viewers see nothing: rooms need an account.
 */
export function WatchRoomDrawer({
  channel,
  signedIn,
  selfUsername,
  client: injected,
  createSocket,
  search,
  reducedMotion = prefersReducedMotion,
}: WatchRoomDrawerProps): React.JSX.Element | null {
  const client = React.useMemo(() => injected ?? watchRoomClient(), [injected]);
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>({ kind: "idle" });
  const [messages, setMessages] = React.useState<RoomMessageFrame[]>([]);
  const [syncTarget, setSyncTarget] = React.useState<string>("");
  const [connected, setConnected] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const conn = React.useRef<RoomConnection | null>(null);
  const roomId = view.kind === "room" ? view.room.id : null;

  // An invite in the URL opens the drawer on the join landing; otherwise resume a room we are in.
  React.useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const invite = inviteFromSearch(search ? search() : typeof window !== "undefined" ? window.location.search : "");
    if (invite) {
      // The nonce leaves the address bar at once; the landing keeps it in state.
      if (!search && typeof window !== "undefined")
        window.history.replaceState(window.history.state, "", withoutInvite(window.location.href));
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setView({ kind: "invited", invite });
        setOpen(true);
      });
      return () => {
        cancelled = true;
      };
    }
    // Deferred, so a client that cannot reach the API (a page without it) fails quietly.
    Promise.resolve()
      .then(() => client.mine())
      .then((rooms) => {
        const here = rooms.find((r) => r.channel.slug === channel);
        if (!cancelled && here)
          setView((v) =>
            v.kind === "idle" ? { kind: "room", room: here, invite: null, nonce: MEMBER_REJOIN_NONCE, token: null } : v,
          );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [signedIn, channel, client, search]);

  // The room's socket and the player sync, for as long as we are in the room.
  const roomRef = React.useRef(view);
  React.useEffect(() => {
    roomRef.current = view;
  });
  React.useEffect(() => {
    if (!roomId) return;
    const current = roomRef.current;
    if (current.kind !== "room") return;
    let firstToken = current.token;
    const nonce = current.nonce;
    const driver = new RoomSyncDriver({ player: () => roomPlayer(channel), reducedMotion });
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      client
        .get(roomId)
        .then((room) => setView((v) => (v.kind === "room" && v.room.id === room.id ? { ...v, room } : v)))
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    };
    const onFrame = (f: RoomFrame) => {
      switch (f.op) {
        case "room.state":
          refresh();
          return;
        case "room.message":
          setMessages((ms) =>
            ms.some((m) => m.id === f.message.id) ? ms : [...ms, f.message].slice(-ROOM_MESSAGES_MAX),
          );
          return;
        case "room.sync":
          driver.onTarget(f.target);
          setSyncTarget(f.target);
          return;
        case "room.closed":
          driver.reset();
          setView({ kind: "ended", reason: f.reason });
          return;
      }
    };
    const onNotice = (code: string) => {
      const refusal = refusalOfNotice(code);
      if (refusal) {
        setView({ kind: "refused", code: refusal, invite: null });
        return;
      }
      if (code === "msg_ratelimit") toast.error(t("watchRooms.chat.rateLimited"));
      else if (code === "msg_rejected") toast.error(t("watchRooms.chat.filtered"));
      else if (code.startsWith("msg_")) toast.error(t("watchRooms.chat.notSent"));
    };
    const c = new RoomConnection(
      channel,
      roomId,
      {
        getChatToken: () => client.chatToken(),
        getRoomToken: async () => {
          if (firstToken) {
            const token = firstToken;
            firstToken = null;
            return token;
          }
          try {
            return (await client.join(roomId, nonce)).chatToken;
          } catch (err) {
            const refusal = refusalOf(err);
            if (refusal) setView({ kind: "refused", code: refusal, invite: null });
            throw err;
          }
        },
        createSocket: createSocket ?? ((url) => new WebSocket(url)),
      },
      { onStatus: (s) => setConnected(s === "open"), onFrame, onNotice },
    );
    conn.current = c;
    setMessages([]);
    c.start();
    return () => {
      c.stop();
      driver.reset();
      if (conn.current === c) conn.current = null;
      setConnected(false);
      setSyncTarget("");
    };
  }, [roomId, channel, client, createSocket, reducedMotion]);

  if (!signedIn) return null;

  const run = async (fn: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  };

  const create = () =>
    run(async () => {
      try {
        const room = await client.create(channel);
        setView({ kind: "room", room, invite: room.invite, nonce: room.invite.nonce, token: null });
      } catch (err) {
        const refusal = refusalOf(err);
        if (refusal) setView({ kind: "refused", code: refusal, invite: null });
        else toastActionError(err, t("watchRooms.createFailed"));
      }
    });

  const join = (invite: InviteParams) =>
    run(async () => {
      try {
        const joined = await client.join(invite.roomId, invite.nonce);
        setView({ kind: "room", room: joined.room, invite: null, nonce: invite.nonce, token: joined.chatToken });
      } catch (err) {
        const refusal = refusalOf(err);
        if (refusal) setView({ kind: "refused", code: refusal, invite });
        else toastActionError(err, t("watchRooms.actionFailed"));
      }
    });

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    if (conn.current?.send(body)) setDraft("");
    else toast.error(t("watchRooms.chat.notSent"));
  };

  const copyInvite = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("watchRooms.invite.copied"));
    } catch {
      toast.error(t("watchRooms.invite.copyFailed"));
    }
  };

  const hosting = view.kind === "room" && (view.invite !== null || view.room.host.username === selfUsername);
  const triggerState = view.kind === "room" ? (hosting ? "hosting" : "member") : "none";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <IconButton
            data-testid="watch-room-open"
            data-state={triggerState}
            label={t("watchRooms.open")}
            icon={UserGroupIcon}
            size="icon-xs"
            variant={view.kind === "room" ? "secondary" : "ghost"}
          />
        }
      />
      <SheetContent
        data-testid="watch-room-drawer"
        data-room-id={roomId ?? ""}
        data-band={view.kind === "room" ? view.room.ageBand : ""}
        data-sync-target={syncTarget}
        className="w-full gap-0 overflow-y-auto sm:max-w-sm"
      >
        <SheetHeader>
          <SheetTitle>{t("watchRooms.title")}</SheetTitle>
          <SheetDescription>{t("watchRooms.intro")}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4">
          {view.kind === "idle" && (
            <Button data-testid="watch-room-create" onClick={() => void create()} disabled={pending}>
              {t("watchRooms.create")}
            </Button>
          )}
          {view.kind === "invited" && (
            <section className="flex flex-col gap-2" aria-labelledby="watch-room-join-title">
              <h3 id="watch-room-join-title" className="text-sm font-medium">
                {t("watchRooms.join.title")}
              </h3>
              <p className="text-xs text-muted-foreground">{t("watchRooms.join.intro")}</p>
              <Button data-testid="watch-room-join" onClick={() => void join(view.invite)} disabled={pending}>
                {t("watchRooms.join.action")}
              </Button>
            </section>
          )}
          {view.kind === "refused" && (
            <div className="flex flex-col gap-2">
              <p data-testid="watch-room-join-refused" data-code={view.code} role="alert" className="text-sm">
                {t(REFUSAL_KEYS[view.code])}
              </p>
              <Button variant="outline" size="sm" onClick={() => setView({ kind: "idle" })}>
                {t("watchRooms.ended.again")}
              </Button>
            </div>
          )}
          {view.kind === "ended" && (
            <EmptyState
              icon={UserGroupIcon}
              title={t("watchRooms.ended.title")}
              description={t("watchRooms.ended.description", { reason: view.reason })}
              headingLevel={3}
              action={
                <Button variant="outline" size="sm" onClick={() => setView({ kind: "idle" })}>
                  {t("watchRooms.ended.again")}
                </Button>
              }
            />
          )}
          {view.kind === "room" && (
            <RoomBody
              view={view}
              hosting={hosting}
              onInvite={(invite) => setView((v) => (v.kind === "room" ? { ...v, invite } : v))}
              connected={connected}
              messages={messages}
              draft={draft}
              setDraft={setDraft}
              onSend={send}
              onCopy={(url) => void copyInvite(url)}
              client={client}
              onLeft={(reason) => setView(reason ? { kind: "ended", reason } : { kind: "idle" })}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RoomBody({
  view,
  hosting,
  onInvite,
  connected,
  messages,
  draft,
  setDraft,
  onSend,
  onCopy,
  client,
  onLeft,
}: {
  view: Extract<View, { kind: "room" }>;
  hosting: boolean;
  onInvite: (invite: WatchRoomInviteDto) => void;
  connected: boolean;
  messages: RoomMessageFrame[];
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  onCopy: (url: string) => void;
  client: WatchRoomClient;
  onLeft: (reason: RoomEndReason | null) => void;
}): React.JSX.Element {
  const { room } = view;
  const [inviting, setInviting] = React.useState(false);
  const newInvite = async () => {
    if (inviting) return;
    setInviting(true);
    try {
      onInvite(await client.invite(room.id));
    } catch (err) {
      toastActionError(err, t("watchRooms.actionFailed"));
    } finally {
      setInviting(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-2">
        <p data-testid="watch-room-band-notice" data-band={room.ageBand} className="text-xs">
          {t(room.ageBand === "minor" ? "watchRooms.band.minor" : "watchRooms.band.adult")}
        </p>
        {room.mature && (
          <p data-testid="watch-room-mature-notice" className="text-xs font-medium">
            {t("watchRooms.mature")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("watchRooms.sync")}</p>
        {!connected && <StatusBadge tone="neutral">{t("watchRooms.status.connecting")}</StatusBadge>}
      </div>

      {hosting && view.invite && (
        <div className="flex flex-col gap-1">
          <label htmlFor="watch-room-invite" className="text-xs font-medium">
            {t("watchRooms.invite.label")}
          </label>
          <div className="flex items-center gap-1">
            <Input
              id="watch-room-invite"
              data-testid="watch-room-invite-link"
              readOnly
              value={view.invite.url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1"
            />
            <IconButton
              data-testid="watch-room-invite-copy"
              label={t("watchRooms.invite.copy")}
              icon={Copy01Icon}
              size="icon-sm"
              onClick={() => onCopy(view.invite?.url ?? "")}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("watchRooms.invite.hint")}</p>
        </div>
      )}
      {hosting && !view.invite && (
        <Button
          data-testid="watch-room-invite-new"
          variant="outline"
          size="sm"
          onClick={() => void newInvite()}
          disabled={inviting}
        >
          {t("watchRooms.invite.new")}
        </Button>
      )}

      <section aria-labelledby="watch-room-members-title" className="flex flex-col gap-2">
        <h3 id="watch-room-members-title" className="text-xs font-medium">
          {t("watchRooms.members")}
        </h3>
        <ul className="flex flex-col gap-1">
          {room.members.map((m) => (
            <li
              key={m.user.id}
              data-testid="watch-room-member"
              data-user-id={m.user.id}
              data-host={m.host ? "true" : "false"}
              className="flex items-center gap-2 text-sm"
            >
              <ChannelAvatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" decorative />
              <span className="min-w-0 truncate">{m.user.displayName}</span>
              {m.host && <StatusBadge tone="neutral">{t("watchRooms.host")}</StatusBadge>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="watch-room-chat-title" className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="watch-room-chat-title" className="text-xs font-medium">
            {t("watchRooms.chat.label")}
          </h3>
          <RoomReport roomId={room.id} client={client} />
        </div>
        <ol
          data-testid="watch-room-chat"
          aria-live="polite"
          aria-labelledby="watch-room-chat-title"
          className="flex max-h-80 min-h-24 flex-col gap-1 overflow-y-auto"
        >
          {messages.length === 0 ? (
            <li className="text-xs text-muted-foreground">{t("watchRooms.chat.empty")}</li>
          ) : (
            messages.map((m) => (
              <li key={m.id} data-testid="watch-room-message" data-message-id={m.id} data-user-id={m.user.id}>
                <ChatMessage
                  author={m.user.displayName}
                  body={m.body}
                  colorIndex={nameColorIndex(m.user.username)}
                  timestamp={<RelativeTime date={m.createdAt} />}
                />
              </li>
            ))
          )}
        </ol>
        <ChatComposer
          value={draft}
          onValueChange={setDraft}
          onSubmit={onSend}
          maxLength={500}
          placeholder={t("watchRooms.chat.placeholder")}
          sendLabel={t("watchRooms.chat.send")}
          disabled={!connected}
          inputProps={{ "data-testid": "watch-room-input" }}
          sendProps={{ "data-testid": "watch-room-send" }}
        />
        <p className="text-xs text-muted-foreground">{t("watchRooms.retention")}</p>
      </section>

      <div className="flex flex-wrap gap-2">
        {hosting ? (
          <ConfirmDialog
            trigger={
              <Button data-testid="watch-room-close" variant="destructive" size="sm">
                {t("watchRooms.close")}
              </Button>
            }
            title={t("watchRooms.closeTitle")}
            description={t("watchRooms.closeDescription")}
            confirmLabel={t("watchRooms.closeConfirm")}
            variant="destructive"
            contentProps={{ "data-testid": "watch-room-close-confirm" }}
            onConfirm={async () => {
              await client.close(room.id);
              onLeft("host_closed");
            }}
            onError={(err) => toastActionError(err, t("watchRooms.actionFailed"))}
          />
        ) : (
          <ConfirmDialog
            trigger={
              <Button data-testid="watch-room-leave" variant="outline" size="sm">
                {t("watchRooms.leave")}
              </Button>
            }
            title={t("watchRooms.leaveTitle")}
            description={t("watchRooms.leaveDescription")}
            confirmLabel={t("watchRooms.leaveConfirm")}
            contentProps={{ "data-testid": "watch-room-leave-confirm" }}
            onConfirm={async () => {
              await client.leave(room.id);
              onLeft(null);
            }}
            onError={(err) => toastActionError(err, t("watchRooms.actionFailed"))}
          />
        )}
      </div>
    </>
  );
}

/** The room's report action: a `watch_room` report to the platform queue (ADR 0017 decision 2). */
export function RoomReport({ roomId, client }: { roomId: string; client: WatchRoomClient }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <IconButton
            data-testid="watch-room-report"
            data-room-id={roomId}
            label={t("watchRooms.report")}
            icon={Flag01Icon}
            size="icon-xs"
          />
        }
      />
      {open && (
        <DialogContent data-testid="report-dialog" data-subject-type="watch_room" data-subject-id={roomId}>
          <p className="text-xs text-muted-foreground">{t("watchRooms.reportDescription")}</p>
          <ReportForm
            onSubmit={async (reason, details) => {
              await client.report({ subjectType: "watch_room", subjectId: roomId, reason, details });
              setOpen(false);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
