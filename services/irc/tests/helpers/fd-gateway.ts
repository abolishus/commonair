// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A gateway started the way systemd starts it: the listening sockets arrive as inherited
 * descriptors described by LISTEN_PID/LISTEN_FDS/LISTEN_FDNAMES (see inherited-fd.int.test.ts).
 * Args: upstream URL, max connections per address. TLS material in IRC_TEST_CERT/IRC_TEST_KEY.
 * Prints one JSON line once listening, and shuts down on SIGTERM.
 */
import { createLogger } from "@commonair/observability";
import { startGateway } from "../../src/gateway.ts";
import { socketProblem, systemdListeners } from "../../src/systemd.ts";
import { websocketUpstream } from "../../src/upstream.ts";

const [upstreamUrl = "", maxPerIp = "1"] = process.argv.slice(2);
const logged: string[] = [];
const logger = createLogger({ service: "irc-fd-test", write: (line) => void logged.push(line) });
const activation = systemdListeners(process.env, process.pid, process.ppid);
if (activation.kind !== "fds") {
  process.stdout.write(`${JSON.stringify({ error: activation })}\n`);
  process.exit(1);
}
const problem = socketProblem(activation.tcp) ?? socketProblem(activation.tls);
if (problem) {
  process.stdout.write(`${JSON.stringify({ error: problem })}\n`);
  process.exit(1);
}
const gateway = startGateway({
  tcpPort: 6667,
  tlsPort: 6697,
  wsPort: null,
  inherited: activation,
  tls: { cert: process.env.IRC_TEST_CERT ?? "", key: process.env.IRC_TEST_KEY ?? "", ephemeral: false },
  upstream: websocketUpstream(upstreamUrl, logger),
  logger,
  motd: "fd test",
  connectionLimits: { maxPerIp: Number(maxPerIp) },
});
const ready = {
  ready: true,
  activation,
  ports: gateway.ports,
  envLeft: Object.keys(process.env).filter((k) => k.startsWith("LISTEN_")),
  listening: logged.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "irc gateway listening"),
};
process.stdout.write(`${JSON.stringify(ready)}\n`);
process.on("SIGTERM", () => {
  void gateway.shutdown(50).then(() => process.exit(0));
});
