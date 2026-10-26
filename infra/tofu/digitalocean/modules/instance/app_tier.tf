# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 2 (ADR 0032 §5): a regional network (layer 4) load balancer passes TCP and UDP through
# with the client's address, so Caddy stays the TLS endpoint on each droplet and no PROXY
# protocol is needed. WebRTC ICE (8189/udp) is not balanced: each droplet advertises its own
# address as a candidate.

locals {
  lb_forwarding = [
    { protocol = "tcp", port = 80 },
    { protocol = "tcp", port = 443 },
    { protocol = "udp", port = 443 },
    { protocol = "tcp", port = 1935 },
    { protocol = "tcp", port = 6697 },
  ]
}

resource "digitalocean_loadbalancer" "app" {
  count = local.stage2 ? 1 : 0

  name          = "${local.prefix}-app"
  region        = var.region
  type          = "REGIONAL_NETWORK"
  network_stack = "DUALSTACK"
  size_unit     = var.lb_size_unit
  vpc_uuid      = digitalocean_vpc.app.id
  droplet_tag   = digitalocean_tag.this[local.tag_app].name

  # Explicit, so a change of provider default cannot slip PROXY protocol in front of Caddy.
  enable_proxy_protocol = false

  dynamic "forwarding_rule" {
    for_each = local.lb_forwarding
    content {
      entry_protocol  = forwarding_rule.value.protocol
      entry_port      = forwarding_rule.value.port
      target_protocol = forwarding_rule.value.protocol
      target_port     = forwarding_rule.value.port
    }
  }

  # Health checks are HTTP(S) or TCP only; HTTP/3 rides on the TCP check of 443.
  healthcheck {
    protocol                 = "tcp"
    port                     = 443
    check_interval_seconds   = 10
    response_timeout_seconds = 5
    unhealthy_threshold      = 3
    healthy_threshold        = 3
  }
}
