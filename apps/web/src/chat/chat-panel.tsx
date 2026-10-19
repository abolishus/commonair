// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, EmptyState, IconButton } from "@commonair/ui";
import { buttonVariants } from "@commonair/ui/components/button";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import { cn } from "@commonair/ui/lib/utils";
import { Message01Icon, SentIcon, UserBlock01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { ChatConnection, type ChatStatus } from "./connection.ts";
import { errorMessage, noticeMessage } from "./messages.ts";
import { ModMenu, TIMEOUT_SECONDS } from "./mod-menu.tsx";
import { chatReducer, type ChatRow } from "./state.ts";

/** Chat name colors come from the AA-checked `--chat-N` tokens, picked by username. */
const NAME_COLORS = [
  "text-chat-1",
  "text-chat-2",
  "text-chat-3",
  "text-chat-4",
  "text-chat-5",
  "text-chat-6",
  "text-chat-7",
  "text-chat-8",
  "text-chat-9",
  "text-chat-10",
  "text-chat-11",
  "text-chat-12",
] as const;

export function nameColor(username: string): string {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length] ?? NAME_COLORS[0];
}

function statusLabel(status: ChatStatus): string {
  if (status === "open") return t("chat.status.open");
  if (status === "connecting") return t("chat.status.connecting");
  return t("chat.status.closed");
}

export interface ChatPanelProps {
  channel: string;
  signedIn: boolean;
  /** The signed-in viewer's username, so moderation controls skip their own messages. */
  selfUsername?: string | null;
  className?: string;
}

interface ModTarget {
  username: string;
  displayName: string;
}

const EMPTY_ROWS: ChatRow[] = [];

export function ChatPanel({ channel, signedIn, selfUsername = null, className }: ChatPanelProps): React.JSX.Element {
  const [status, setStatus] = React.useState<ChatStatus>("connecting");
  const [rows, dispatch] = React.useReducer(chatReducer, EMPTY_ROWS);
  const [canChat, setCanChat] = React.useState(false);
  const [canModerate, setCanModerate] = React.useState(false);
  // The target outlives `open` so the dialog title keeps its name while it animates closed.
  const [banDialog, setBanDialog] = React.useState<{ open: boolean; target: ModTarget | null }>({
    open: false,
    target: null,
  });
  const [draft, setDraft] = React.useState("");
  const connection = React.useRef<ChatConnection | null>(null);
  const listRef = React.useRef<HTMLOListElement>(null);
  const noticeSeq = React.useRef(0);

  React.useEffect(() => {
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
        onMessage: (message) => dispatch({ type: "message", message }),
        onDelete: (messageId) => dispatch({ type: "delete", messageId }),
        onClear: () => dispatch({ type: "clear" }),
        onBan: (userId, username) => dispatch({ type: "ban", userId, username }),
        // Notices answer something the viewer did, so they belong inline; socket errors stay toasts.
        onNotice: (code, kind) => {
          if (kind === "error") toast.error(errorMessage(code));
          else dispatch({ type: "notice", id: `notice-${++noticeSeq.current}`, code });
        },
      },
    );
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
      connection.current = null;
    };
  }, [channel, signedIn]);

  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows]);

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
    } catch {
      toast.error(t("chat.mod.failed"));
    }
  };

  const ban = async (target: ModTarget) => {
    await api().chat.bans.ban({ channel, username: target.username });
    toast.success(t("chat.mod.banned", { name: target.displayName }));
  };

  const self = selfUsername?.toLowerCase() ?? null;

  return (
    <section
      data-testid="chat"
      data-state={status}
      aria-label={t("chat.title")}
      className={cn("flex min-h-0 flex-col border border-border", className)}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-medium">
        <span>{t("chat.title")}</span>
        <span className="text-muted-foreground" aria-live="polite">
          {statusLabel(status)}
        </span>
      </header>
      <ol
        ref={listRef}
        className="min-h-48 flex-1 overflow-y-auto px-3 py-2 text-xs"
        aria-live="polite"
        aria-relevant="additions"
      >
        {rows.length === 0 ? (
          <li>
            <EmptyState icon={Message01Icon} title={t("chat.empty")} headingLevel={3} />
          </li>
        ) : (
          rows.map((row) => {
            if (row.kind === "notice")
              return (
                <li
                  key={row.id}
                  data-testid="chat-notice"
                  data-code={row.code}
                  className="py-0.5 break-words text-muted-foreground italic"
                >
                  {noticeMessage(row.code)}
                </li>
              );
            const { user } = row.message;
            const target = { username: user.username, displayName: user.displayName };
            return (
              <li
                key={row.id}
                data-testid="chat-message"
                data-id={row.id}
                data-author={user.username}
                data-deleted={row.deleted ? "true" : undefined}
                className="flex items-start gap-1 py-0.5"
              >
                <p className="min-w-0 flex-1 break-words">
                  <span className={cn("font-semibold", nameColor(user.username))}>{user.displayName}</span>
                  <span className="text-muted-foreground">{t("chat.nameSeparator")}</span>
                  {row.deleted ? (
                    <span className="text-muted-foreground italic">{t("chat.messageDeleted")}</span>
                  ) : (
                    <span className={row.message.isAction ? "italic" : undefined}>{row.message.body}</span>
                  )}
                </p>
                {canModerate && user.username.toLowerCase() !== self && (
                  <ModMenu
                    displayName={user.displayName}
                    onTimeout={() => void timeout(target)}
                    onBan={() => setBanDialog({ open: true, target })}
                  />
                )}
              </li>
            );
          })
        )}
      </ol>
      <div className="border-t border-border p-2">
        {signedIn ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <Input
              data-testid="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              maxLength={500}
              placeholder={t("chat.placeholder")}
              aria-label={t("chat.placeholder")}
              disabled={status !== "open" || !canChat}
            />
            <IconButton
              data-testid="chat-send"
              type="submit"
              label={t("chat.send")}
              icon={SentIcon}
              disabled={status !== "open" || !canChat || !draft.trim()}
            />
          </form>
        ) : (
          <p
            data-testid="chat-signin-prompt"
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            {t("chat.signInPrompt")}
            <Link to="/signin" className={buttonVariants({ variant: "outline", size: "xs" })}>
              {t("nav.signIn")}
            </Link>
          </p>
        )}
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
        onError={() => toast.error(t("chat.mod.failed"))}
      />
    </section>
  );
}
