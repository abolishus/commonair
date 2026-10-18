// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export { startGateway, type Gateway, type GatewayOptions, type GatewayStats } from "./gateway.ts";
export { websocketUpstream, type Upstream, type UpstreamFactory, type UpstreamHandlers } from "./upstream.ts";
export { generateSelfSignedCert, loadTls, type TlsMaterial } from "./tls.ts";
export { SERVER_NAME, LIMITS } from "./constants.ts";
export { SUPPORTED_CAPS } from "./caps.ts";
export { COMMANDS } from "./commands.ts";
export { NOTICE_MSG_IDS } from "./notices.ts";
export { startHealth } from "./health.ts";
