// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The subset of tmi.js 1.8.5's API the harness bot uses (the package ships no types). */
declare module "tmi.js" {
  export interface ChatUserstate {
    username?: string;
    "display-name"?: string;
    "user-id"?: string;
    id?: string;
    [tag: string]: unknown;
  }
  export interface Options {
    options?: { debug?: boolean; skipUpdatingEmotesets?: boolean; skipMembership?: boolean };
    connection?: { server?: string; port?: number; secure?: boolean; reconnect?: boolean; timeout?: number };
    identity?: { username: string; password: string };
    channels?: string[];
    logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  }
  export class Client {
    constructor(opts: Options);
    connect(): Promise<[string, number]>;
    disconnect(): Promise<[string, number]>;
    say(channel: string, message: string): Promise<[string]>;
    join(channel: string): Promise<[string]>;
    on(
      event: "message",
      listener: (channel: string, tags: ChatUserstate, message: string, self: boolean) => void,
    ): this;
    on(event: "connected", listener: (address: string, port: number) => void): this;
    on(event: "disconnected", listener: (reason: string) => void): this;
    on(event: "join", listener: (channel: string, username: string, self: boolean) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    readyState(): "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED";
  }
  const tmi: { Client: typeof Client; client: typeof Client };
  export default tmi;
}
