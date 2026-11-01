// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The watch-room drawer (ADR 0017; docs/testing/b7-selectors.md "Watch rooms") with a fake client
 * and socket: create, the invite landing and its refusal messages, the room's chat and sync frames,
 * keyboard use, leave and close through `ConfirmDialog`, and the report action.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SocketLike } from "../src/chat/connection.ts";
import type { WatchRoomClient, WatchRoomDto } from "../src/components/watch-room/client.ts";
import { inviteFromSearch, refusalOf, withoutInvite } from "../src/components/watch-room/client.ts";
import { RoomReport, WatchRoomDrawer } from "../src/components/watch-room/drawer.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const ROOM = "01890000-0000-7000-8000-00000000a001";
const HOST = "01890000-0000-7000-8000-00000000b001";
const GUEST = "01890000-0000-7000-8000-00000000b002";
const NONCE = "abcdefghijklmnopqrstuvwxyz012345";

const room = (over: Partial<WatchRoomDto> = {}): WatchRoomDto => ({
  id: ROOM,
  channel: { id: "01890000-0000-7000-8000-00000000c001", slug: "chan", displayName: "Chan", avatarUrl: null },
  broadcastId: "01890000-0000-7000-8000-00000000d001",
  host: { id: HOST, username: "host", displayName: "Host", avatarUrl: null },
  ageBand: "adult",
  mature: false,
  members: [
    {
      user: { id: HOST, username: "host", displayName: "Host", avatarUrl: null },
      joinedAt: "2026-11-01T10:00:00.000Z",
      host: true,
    },
  ],
  createdAt: "2026-11-01T10:00:00.000Z",
  endedAt: null,
  endReason: null,
  chatAudience: `room:${ROOM}`,
  ...over,
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(frame: Record<string, unknown>) {
    this.readyState = 1;
    for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(frame) });
  }
}

function fakeClient(over: Partial<WatchRoomClient> = {}) {
  const calls: string[] = [];
  const client: WatchRoomClient = {
    create: async (channel) => {
      calls.push(`create ${channel}`);
      return {
        ...room(),
        invite: { nonce: NONCE, url: `https://air.test/chan?room=${ROOM}&invite=${NONCE}`, expiresAt: null },
      };
    },
    get: async () => room(),
    invite: async () => ({ nonce: NONCE, url: "https://air.test/new", expiresAt: null }),
    join: async (id, nonce) => {
      calls.push(`join ${id} ${nonce}`);
      return {
        room: room(),
        chatToken: "room-token",
        chatUrl: "ws://chat.test/ws",
        expiresAt: "2026-11-01T11:00:00.000Z",
      };
    },
    leave: async (id) => {
      calls.push(`leave ${id}`);
      return { ok: true };
    },
    close: async (id) => {
      calls.push(`close ${id}`);
      return { ok: true };
    },
    mine: async () => [],
    chatToken: async () => ({ token: "chat-token", url: "ws://chat.test/ws" }),
    report: async (input) => {
      calls.push(`report ${input.subjectType} ${input.subjectId} ${input.reason}`);
      return { id: "01890000-0000-7000-8000-00000000e001" } as never;
    },
    ...over,
  };
  return { client, calls };
}

function show(opts: { client: WatchRoomClient; search?: string; self?: string }) {
  const sockets: FakeSocket[] = [];
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <WatchRoomDrawer
          channel="chan"
          signedIn
          selfUsername={opts.self ?? "host"}
          client={opts.client}
          search={() => opts.search ?? ""}
          reducedMotion={() => false}
          createSocket={(url) => {
            const s = new FakeSocket(url);
            sockets.push(s);
            return s;
          }}
        />
      </TooltipProvider>
    </LocaleProvider>,
  );
  return sockets;
}

const id = (testId: string) => screen.getByTestId(testId);

describe("WatchRoomDrawer", () => {
  it("signed out renders nothing", () => {
    const { client } = fakeClient();
    const { container } = render(
      <WatchRoomDrawer channel="chan" signedIn={false} selfUsername={null} client={client} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("create: the band notice, the invite, the members, then the room socket joins with the room token", async () => {
    const { client, calls } = fakeClient();
    const sockets = show({ client });
    expect(id("watch-room-open").dataset.state).toBe("none");
    expect(id("watch-room-open").getAttribute("aria-label")).toBe(t("watchRooms.open"));
    fireEvent.click(id("watch-room-open"));
    fireEvent.click(await waitFor(() => id("watch-room-create")));
    await waitFor(() => expect(id("watch-room-drawer").dataset.roomId).toBe(ROOM));
    expect(calls).toContain("create chan");
    expect(id("watch-room-drawer").dataset.band).toBe("adult");
    expect(id("watch-room-band-notice").textContent).toBe(t("watchRooms.band.adult"));
    expect(screen.queryByTestId("watch-room-mature-notice")).toBeNull();
    expect((id("watch-room-invite-link") as HTMLInputElement).value).toContain(`invite=${NONCE}`);
    expect(id("watch-room-member").dataset.host).toBe("true");
    expect(id("watch-room-open").dataset.state).toBe("hosting");
    expect(screen.getByTestId("watch-room-close")).toBeTruthy();
    expect(screen.queryByTestId("watch-room-leave")).toBeNull();

    // The room's own socket: chat token in the URL, then room.join with the token from create/join.
    const s = await waitFor(() => {
      expect(sockets).toHaveLength(1);
      return sockets[0]!;
    });
    expect(new URL(s.url).searchParams.get("token")).toBe("chat-token");
    act(() => s.emit({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 }));
    expect(s.sent[0]).toMatchObject({ op: "room.join", roomId: ROOM });
    // A creator has no join token yet: the room token comes from watchRooms.join.
    expect(calls.some((c) => c.startsWith(`join ${ROOM}`))).toBe(true);

    act(() =>
      s.emit({
        op: "room.message",
        roomId: ROOM,
        message: {
          id: "01890000-0000-7000-8000-00000000f001",
          user: { id: GUEST, username: "guest", displayName: "Guest" },
          body: "hello room",
          createdAt: "2026-11-01T10:01:00.000Z",
        },
      }),
    );
    const msg = await waitFor(() => id("watch-room-message"));
    expect(msg.dataset.userId).toBe(GUEST);
    expect(msg.textContent).toContain("hello room");
    act(() => s.emit({ op: "room.sync", roomId: ROOM, target: "2026-11-01T10:01:02.000Z" }));
    expect(id("watch-room-drawer").dataset.syncTarget).toBe("2026-11-01T10:01:02.000Z");
  });

  it("a mature room shows the adults-only notice; a minor room its band", async () => {
    const { client } = fakeClient({
      create: async () => ({
        ...room({ mature: true }),
        invite: { nonce: NONCE, url: "https://air.test/x", expiresAt: null },
      }),
    });
    show({ client });
    fireEvent.click(id("watch-room-open"));
    fireEvent.click(await waitFor(() => id("watch-room-create")));
    expect((await waitFor(() => id("watch-room-mature-notice"))).textContent).toBe(t("watchRooms.mature"));
    cleanup();
    const minor = fakeClient({
      create: async () => ({ ...room({ ageBand: "minor" }), invite: { nonce: NONCE, url: "u", expiresAt: null } }),
    });
    show({ client: minor.client });
    fireEvent.click(id("watch-room-open"));
    fireEvent.click(await waitFor(() => id("watch-room-create")));
    const band = await waitFor(() => id("watch-room-band-notice"));
    expect(band.dataset.band).toBe("minor");
    expect(band.textContent).toBe(t("watchRooms.band.minor"));
  });

  it.each([
    "room_age_band",
    "room_birth_date_unknown",
    "room_mature_minor",
    "room_mature_unconfirmed",
    "room_banned",
    "room_suspended",
    "room_blocked",
    "room_full",
    "room_closed",
    "room_invite_invalid",
    "room_not_live",
  ] as const)("the invite landing shows the %s refusal", async (code) => {
    const { client, calls } = fakeClient({
      join: async () => {
        throw Object.assign(new Error("refused"), { code: "PRECONDITION_FAILED", data: { requirement: code } });
      },
    });
    show({ client, search: `?room=${ROOM}&invite=${NONCE}`, self: "guest" });
    const join = await waitFor(() => id("watch-room-join"));
    fireEvent.click(join);
    const refused = await waitFor(() => id("watch-room-join-refused"));
    expect(refused.dataset.code).toBe(code);
    expect(refused.textContent).toBe(t(`watchRooms.refusal.${code}`));
    expect(refused.getAttribute("role")).toBe("alert");
    expect(calls).toEqual([]);
  });

  it("a member joins from the invite, leaves through the confirm dialog", async () => {
    const { client, calls } = fakeClient({
      join: async (rid, nonce) => {
        calls.push(`join ${rid} ${nonce}`);
        return {
          room: room({
            members: [
              ...room().members,
              {
                user: { id: GUEST, username: "guest", displayName: "Guest", avatarUrl: null },
                joinedAt: "2026-11-01T10:02:00.000Z",
                host: false,
              },
            ],
          }),
          chatToken: "room-token",
          chatUrl: "ws://chat.test/ws",
          expiresAt: "2026-11-01T11:00:00.000Z",
        };
      },
    });
    const sockets = show({ client, search: `?room=${ROOM}&invite=${NONCE}`, self: "guest" });
    fireEvent.click(await waitFor(() => id("watch-room-join")));
    await waitFor(() => expect(screen.getAllByTestId("watch-room-member")).toHaveLength(2));
    expect(calls).toContain(`join ${ROOM} ${NONCE}`);
    expect(id("watch-room-open").dataset.state).toBe("member");
    expect(screen.queryByTestId("watch-room-invite-link")).toBeNull();
    const s = await waitFor(() => {
      expect(sockets).toHaveLength(1);
      return sockets[0]!;
    });
    act(() => s.emit({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 }));
    // The first room token is the one join returned: no second join call.
    expect(s.sent[0]).toMatchObject({ op: "room.join", token: "room-token" });

    fireEvent.click(id("watch-room-leave"));
    const dialog = await waitFor(() => id("watch-room-leave-confirm"));
    fireEvent.click(dialog.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    await waitFor(() => expect(calls).toContain(`leave ${ROOM}`));
    await waitFor(() => expect(id("watch-room-create")).toBeTruthy());
  });

  it("the host closes through the confirm dialog; a room.closed frame shows why it ended", async () => {
    const { client, calls } = fakeClient();
    show({ client });
    fireEvent.click(id("watch-room-open"));
    fireEvent.click(await waitFor(() => id("watch-room-create")));
    fireEvent.click(await waitFor(() => id("watch-room-close")));
    const dialog = await waitFor(() => id("watch-room-close-confirm"));
    fireEvent.click(dialog.querySelector('[data-testid="confirm-dialog-confirm"]')!);
    await waitFor(() => expect(calls).toContain(`close ${ROOM}`));
    await waitFor(() => expect(screen.getByText(t("watchRooms.ended.title"))).toBeTruthy());
  });

  it("a kick notice from chat shows the refusal", async () => {
    const { client } = fakeClient();
    const sockets = show({ client });
    fireEvent.click(id("watch-room-open"));
    fireEvent.click(await waitFor(() => id("watch-room-create")));
    const s = await waitFor(() => {
      expect(sockets).toHaveLength(1);
      return sockets[0]!;
    });
    act(() => s.emit({ op: "notice", channel: null, code: "room_banned", text: "x" }));
    expect((await waitFor(() => id("watch-room-join-refused"))).dataset.code).toBe("room_banned");
  });

  it("keyboard: the trigger and every control are labelled buttons or inputs; Escape closes the drawer", async () => {
    const { client } = fakeClient();
    show({ client });
    const trigger = id("watch-room-open");
    expect(trigger.tagName).toBe("BUTTON");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    const create = await waitFor(() => id("watch-room-create"));
    expect(create.tagName).toBe("BUTTON");
    fireEvent.click(create);
    await waitFor(() => id("watch-room-input"));
    expect(id("watch-room-input").tagName).toBe("INPUT");
    expect(id("watch-room-send").tagName).toBe("BUTTON");
    expect(id("watch-room-invite-copy").getAttribute("aria-label")).toBe(t("watchRooms.invite.copy"));
    fireEvent.keyDown(id("watch-room-drawer"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("watch-room-drawer")).toBeNull());
  });

  it("each room message offers a report action that opens a watch_room report on the room", async () => {
    const { client } = fakeClient();
    const sockets = show({ client });
    fireEvent.click(id("watch-room-open"));
    fireEvent.click(await waitFor(() => id("watch-room-create")));
    await waitFor(() => id("watch-room-input"));
    expect(screen.queryByTestId("watch-room-report")).toBeNull();
    const s = await waitFor(() => {
      expect(sockets).toHaveLength(1);
      return sockets[0]!;
    });
    act(() => s.emit({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 }));
    const MSG = "01890000-0000-7000-8000-00000000f002";
    act(() =>
      s.emit({
        op: "room.message",
        roomId: ROOM,
        message: {
          id: MSG,
          user: { id: GUEST, username: "guest", displayName: "Guest" },
          body: "rude",
          createdAt: "2026-11-01T10:01:00.000Z",
        },
      }),
    );
    const action = await waitFor(() => id("watch-room-report"));
    expect(action.dataset.messageId).toBe(MSG);
    expect(action.getAttribute("aria-label")).toBe(t("watchRooms.report"));
    expect(id("watch-room-message").contains(action)).toBe(true);
    fireEvent.click(action);
    const dialog = await waitFor(() => id("report-dialog"));
    expect(dialog.dataset.subjectType).toBe("watch_room");
    expect(dialog.dataset.subjectId).toBe(ROOM);
    expect(dialog.textContent).toContain(t("watchRooms.reportDescription"));
  });
});

describe("RoomReport", () => {
  it("files a watch_room report on the room with the chosen reason", async () => {
    const { client, calls } = fakeClient();
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <RoomReport roomId={ROOM} client={client} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    fireEvent.click(id("watch-room-report"));
    await waitFor(() => id("report-dialog"));
    fireEvent.click(id("report-reason"));
    fireEvent.click(await waitFor(() => id("report-reason-spam")));
    fireEvent.click(id("report-submit"));
    await waitFor(() => expect(calls).toContain(`report watch_room ${ROOM} spam`));
  });
});

describe("invite helpers", () => {
  it("parses and strips the invite", () => {
    expect(inviteFromSearch(`?room=${ROOM}&invite=${NONCE}`)).toEqual({ roomId: ROOM, nonce: NONCE });
    expect(inviteFromSearch(`?room=nope&invite=${NONCE}`)).toBeNull();
    expect(inviteFromSearch(`?room=${ROOM}&invite=short`)).toBeNull();
    expect(inviteFromSearch("")).toBeNull();
    expect(withoutInvite(`https://air.test/chan?room=${ROOM}&invite=${NONCE}&x=1#h`)).toBe("/chan?x=1#h");
  });

  it("maps errors to refusal codes", () => {
    expect(refusalOf({ code: "PRECONDITION_FAILED", data: { requirement: "room_full" } })).toBe("room_full");
    expect(refusalOf({ code: "PRECONDITION_FAILED", data: { requirement: "other" } })).toBeNull();
    expect(refusalOf({ code: "FORBIDDEN" })).toBe("room_suspended");
    expect(refusalOf(new Error("x"))).toBeNull();
  });
});

vi.setConfig({ testTimeout: 15_000 });
