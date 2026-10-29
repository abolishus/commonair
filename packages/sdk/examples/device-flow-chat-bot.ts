// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A chat bot that signs in with the device flow (no browser on the bot's machine), keeps its tokens
 * in a file, refreshes them ahead of expiry, and answers `!ping`.
 *
 *   COMMONAIR_URL=https://your.instance COMMONAIR_CLIENT_ID=… COMMONAIR_CHANNEL=somechannel \
 *     bun examples/device-flow-chat-bot.ts
 *
 * Register a public app (no secret) in the developer console first. The token file is a secret:
 * keep it out of version control.
 */
import {
  ReauthorizeError,
  connectChat,
  createClient,
  deviceFlow,
  refreshingToken,
  type StoredTokens,
  type TokenStore,
} from "@commonair/sdk";

const baseUrl = process.env.COMMONAIR_URL ?? "http://localhost:3001";
const clientId = process.env.COMMONAIR_CLIENT_ID ?? "";
const channel = process.env.COMMONAIR_CHANNEL ?? "";
const tokenFile = process.env.COMMONAIR_TOKEN_FILE ?? ".commonair-tokens.json";
if (!clientId || !channel) throw new Error("set COMMONAIR_CLIENT_ID and COMMONAIR_CHANNEL");

/** A TokenStore on a JSON file. `save` runs before a rotated token is used: the old one is spent. */
const fileStore: TokenStore = {
  async load() {
    const f = Bun.file(tokenFile);
    return (await f.exists()) ? ((await f.json()) as StoredTokens) : null;
  },
  async save(tokens) {
    await Bun.write(tokenFile, JSON.stringify(tokens));
  },
};

if ((await fileStore.load()) === null) {
  const t = await deviceFlow({
    baseUrl,
    clientId,
    scopes: ["chat:read", "chat:edit"],
    onCode: (code) =>
      console.warn(`Open ${code.verificationUriComplete} (or ${code.verificationUri} and type ${code.userCode})`),
  });
  if (!t.refreshToken) throw new Error("the device flow issued no refresh token");
  await fileStore.save({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
    scopes: t.scopes,
  });
}

const getToken = refreshingToken({ baseUrl, clientId, store: fileStore });
const client = createClient({ baseUrl, getToken });

// Chat closes a socket when the token it opened with is rotated, so reconnect with a fresh token.
for (;;) {
  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    if (err instanceof ReauthorizeError) {
      console.error(`Authorization is gone (${err.reason}): delete ${tokenFile} and run again.`);
      process.exit(1);
    }
    throw err;
  }
  const chat = await connectChat({ client, token });
  await chat.join(channel);
  console.warn(`joined #${channel} as ${chat.welcome.user?.username ?? "?"}`);
  chat.onMessage((m) => {
    if (m.text.trim() === "!ping" && m.userId !== chat.welcome.user?.id)
      chat.say(m.channel, "pong", { replyToId: m.id }).catch((e: unknown) => console.error("reply failed", e));
  });
  const closed = await chat.closed;
  console.warn(`chat closed (${closed.code}); reconnecting`);
  await Bun.sleep(1_000);
}
