// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, EmptyState, StatusBadge } from "@commonair/ui";
import { ChatComposer, ChatMessage, ChatPanel as ChatPanelShell } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Message01Icon, UserBlock01Icon } from "@hugeicons/core-free-icons";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { HeldQueue } from "../components/mod/held-queue.tsx";
import { EMPTY_HELD, heldReducer } from "../components/mod/held-state.ts";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { ChatEventRow } from "./chat-event-row.tsx";
import { ChatConnection, type ChatStatus } from "./connection.ts";
import { chatEventView } from "./events.ts";
import { browserInteractClient, type InteractClient } from "./interact/client.ts";
import { PointsChip } from "./interact/points-chip.tsx";
import { ChatPollCard } from "./interact/poll-card.tsx";
import { ChatPredictionCard } from "./interact/prediction-card.tsx";
import { RaidBanner } from "./interact/raid-banner.tsx";
import { useChatInteract } from "./interact/use-chat-interact.ts";
import { errorMessage, noticeMessage } from "./messages.ts";
import { ModMenu, TIMEOUT_SECONDS } from "./mod-menu.tsx";
import { chatReducer, type ChatRow } from "./state.ts";
import { badgeAttr, chatStatusView, nameColorIndex, visibleBadges } from "./view.ts";

export interface ChatPanelProps {
  channel: string;
  signedIn: boolean;
  /** The signed-in viewer's username, so moderation controls skip their own messages. */
  selfUsername?: string | null;
  className?: string;
  /** Poll, prediction and points calls; tests pass a fake. */
  interactClient?: InteractClient;
}

interface ModTarget {
  username: string;
  displayName: string;
}

const EMPTY_ROWS: ChatRow[] = [];
const noop = () => {};

export function ChatPanel({
  channel,
  signedIn,
  selfUsername = null,
  className,
  interactClient,
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
  const [draft, setDraft] = React.useState("");
  const connection = React.useRef<ChatConnection | null>(null);
  const noticeSeq = React.useRef(0);
  const navigate = useNavigate();
  const [client] = React.useState(() => interactClient ?? browserInteractClient());
  const interact = useChatInteract({
    channel,
    signedIn,
    selfUsername,
    client,
    onFollowRaid: (to) => void navigate({ to: "/$channel", params: { channel: to } }),
  });
  // The connection keeps the handlers it was given; they reach the latest state through this.
  const interactRef = React.useRef(interact);
  React.useEffect(() => {
    interactRef.current = interact;
  });

  React.useEffect(() => {
    heldDispatch({ type: "reset" });
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
        },
        onMessage: (message) => {
          dispatch({ type: "message", message });
          // An allowed held message comes back as an ordinary one.
          heldDispatch({ type: "remove", id: message.id });
        },
        onHeld: (message) => heldDispatch({ type: "held", message }),
        onDelete: (messageId) => {
          dispatch({ type: "delete", messageId });
          heldDispatch({ type: "remove", id: messageId });
        },
        onClear: () => dispatch({ type: "clear" }),
        onBan: (userId, username) => {
          dispatch({ type: "ban", userId, username });
          heldDispatch({ type: "removeUser", userId });
        },
        // Notices answer something the viewer did, so they belong inline; socket errors stay toasts.
        onNotice: (code, kind) => {
          if (kind === "error") toast.error(errorMessage(code));
          else dispatch({ type: "notice", id: `notice-${++noticeSeq.current}`, code });
        },
        onEvent: (type, data) => {
          // Poll and prediction frames update their cards, never the log.
          if (interactRef.current.onEvent(type, data)) return;
          const event = chatEventView(type, data);
          if (event) dispatch({ type: "event", id: `event-${++noticeSeq.current}`, event });
        },
        onRaid: (raid) => interactRef.current.onRaid(raid),
      },
    );
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
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

  const self = selfUsername?.toLowerCase() ?? null;
  const statusView = chatStatusView(status);
  const inputDisabled = status !== "open" || !canChat;
  const isBroadcaster = self !== null && self === channel.toLowerCase();
  const { poll, prediction, points, raid } = interact;
  const pinned =
    raid || poll || prediction ? (
      <div className="grid gap-3">
        {raid && <RaidBanner raid={raid} isBroadcaster={isBroadcaster} />}
        {poll && (
          <ChatPollCard
            key={poll.id}
            poll={poll}
            signedIn={signedIn}
            points={points}
            client={client}
            onVoted={interact.setPoll}
            onPointsSpent={interact.refreshPoints}
          />
        )}
        {prediction && (
          <ChatPredictionCard
            key={prediction.id}
            prediction={prediction}
            signedIn={signedIn}
            staff={canModerate || isBroadcaster}
            points={points}
            client={client}
            onBet={interact.setPrediction}
            onPointsSpent={interact.refreshPoints}
          />
        )}
      </div>
    ) : undefined;

  return (
    <ChatPanelShell
      data-testid="chat"
      data-state={status}
      aria-label={t("chat.title")}
      title={t("chat.title")}
      logLabel={t("chat.log")}
      newMessagesLabel={t("chat.newMessages")}
      pinned={pinned}
      viewersAction={
        <>
          {points && <PointsChip balance={points} />}
          {canModerate && <HeldQueue channel={channel} state={held} dispatch={heldDispatch} />}
          <StatusBadge tone={statusView.tone} aria-live="polite">
            {statusView.label}
          </StatusBadge>
        </>
      }
      className={className}
      footer={
        signedIn ? (
          <ChatComposer
            value={draft}
            onValueChange={setDraft}
            onSubmit={send}
            maxLength={500}
            placeholder={t("chat.placeholder")}
            sendLabel={t("chat.send")}
            disabled={inputDisabled}
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
            signin={
              <>
                {t("chat.signInPrompt")}
                <Button variant="outline" size="xs" nativeButton={false} render={<Link to="/signin" />}>
                  {t("nav.signIn")}
                </Button>
              </>
            }
          />
        )
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon={Message01Icon} title={t("chat.empty")} headingLevel={3} />
      ) : (
        rows.map((row) => {
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
          const { user } = row.message;
          const target = { username: user.username, displayName: user.displayName };
          return (
            <ChatMessage
              key={row.id}
              data-testid="chat-message"
              data-id={row.id}
              data-author={user.username}
              data-badges={badgeAttr(user.badges)}
              badges={visibleBadges(user.badges)}
              data-deleted={row.deleted ? "true" : undefined}
              author={user.displayName}
              colorIndex={nameColorIndex(user.username)}
              body={row.message.body}
              action={row.message.isAction}
              deleted={row.deleted}
              deletedLabel={t("chat.messageDeleted")}
              actions={
                canModerate && !row.deleted && user.username.toLowerCase() !== self ? (
                  <ModMenu
                    displayName={user.displayName}
                    onTimeout={() => void timeout(target)}
                    onBan={() => setBanDialog({ open: true, target })}
                  />
                ) : undefined
              }
            />
          );
        })
      )}
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
    </ChatPanelShell>
  );
}
