// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, IconButton } from "@commonair/ui";
import { buttonVariants } from "@commonair/ui/components/button";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import { Message01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { ChatConnection, appendMessage, type ChatMessageFrame, type ChatStatus } from "./connection.ts";

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
  className?: string;
}

export function ChatPanel({ channel, signedIn, className }: ChatPanelProps): React.JSX.Element {
  const [status, setStatus] = React.useState<ChatStatus>("connecting");
  const [messages, setMessages] = React.useState<ChatMessageFrame[]>([]);
  const [canChat, setCanChat] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const connection = React.useRef<ChatConnection | null>(null);
  const listRef = React.useRef<HTMLOListElement>(null);

  React.useEffect(() => {
    const conn = new ChatConnection(
      channel,
      {
        getToken: () => api().chat.connectToken(),
        createSocket: (url) => new WebSocket(url),
      },
      {
        onStatus: setStatus,
        onJoined: (me) => setCanChat(me.canChat),
        onMessage: (m) => setMessages((list) => appendMessage(list, m)),
        onDelete: (id) => setMessages((list) => list.filter((m) => m.id !== id)),
        onClear: () => setMessages([]),
        onNotice: (text, kind) => (kind === "error" ? toast.error(text) : toast.info(text)),
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
  }, [messages]);

  const send = () => {
    if (!draft.trim()) return;
    if (connection.current?.send(draft)) setDraft("");
    else toast.error(t("chat.notConnected"));
  };

  return (
    <section
      data-testid="chat"
      data-state={status}
      aria-label={t("chat.title")}
      className={`flex min-h-0 flex-col border border-border ${className ?? ""}`}
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
        {messages.length === 0 ? (
          <li>
            <EmptyState icon={Message01Icon} title={t("chat.empty")} headingLevel={3} />
          </li>
        ) : (
          messages.map((m) => (
            <li key={m.id} data-testid="chat-message" data-author={m.user.username} className="py-0.5 break-words">
              <span className={`font-semibold ${nameColor(m.user.username)}`}>{m.user.displayName}</span>
              <span className="text-muted-foreground">: </span>
              <span className={m.isAction ? "italic" : undefined}>{m.body}</span>
            </li>
          ))
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
    </section>
  );
}
