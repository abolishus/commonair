// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The API is up, a new member can sign up through the real flow, and sign in again. */
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "smoke",
  description: "API up; sign up (ALTCHA + email verification) and sign in",
  needs: ["api", "mail"],
  timeoutMs: 3 * 60_000,
  async run(ctx) {
    const p = ctx.platform;
    const info = await ctx.step("instance info", () => p.api().client.instance.info());
    ctx.check("instance has a name", info.name.length > 0, { name: info.name });
    ctx.check("instance publishes a source link", info.sourceUrl.startsWith("http"), { sourceUrl: info.sourceUrl });

    const started = performance.now();
    const user = await ctx.step("sign up", () => p.signUp({ prefix: "smoke" }));
    ctx.metric("signup", performance.now() - started, "ms");
    ctx.assert("me.username matches the signup", user.me.username === user.username, { got: user.me.username });
    ctx.check("email is verified", user.me.emailVerified, { emailVerified: user.me.emailVerified });
    ctx.check("signup created the member's channel", user.me.channelSlug === user.username, {
      channelSlug: user.me.channelSlug,
    });

    const again = await ctx.step("sign in with a fresh session", () => p.users.signIn(user));
    ctx.assert("same account after sign-in", again.id === user.id);
    ctx.check("fresh session has its own cookie jar", again.api.jar !== user.api.jar && again.api.jar.size > 0);

    const channel = await ctx.step("channel page", () => p.api().client.channels.get({ channel: user.username }));
    ctx.assert("channel is owned by the new member", channel.owner.id === user.id, { owner: channel.owner.id });
    ctx.check("new channel is offline", channel.live === null);

    await ctx.step("sign out", () => p.users.signOut(again));
  },
});
