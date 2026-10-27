# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# The cloud firewall is the outer layer; nftables on the host is the inner one. The public
# ports are exactly docs/deploy/digitalocean.md#firewall, over IPv4 and IPv6. Everything else
# (Postgres, Valkey, Garage, Grafana) stays on 127.0.0.1.

locals {
  anywhere = ["0.0.0.0/0", "::/0"]

  public_inbound = concat(
    [
      { protocol = "tcp", port_range = "80" },   # Caddy: ACME, HTTP -> HTTPS
      { protocol = "tcp", port_range = "443" },  # HTTPS, WHIP signaling
      { protocol = "udp", port_range = "443" },  # HTTP/3
      { protocol = "tcp", port_range = "1935" }, # RTMP ingest
      { protocol = "udp", port_range = "8189" }, # WebRTC ICE
      { protocol = "udp", port_range = "3478" }, # coturn STUN for P2P playback (UDP only)
      { protocol = "tcp", port_range = "6697" }, # IRC over TLS
    ],
    var.irc_plaintext ? [{ protocol = "tcp", port_range = "6667" }] : [],
  )

  # Cloud firewalls are stateful, but with no outbound rule nothing leaves the droplet at all:
  # package updates, ACME, image pulls, the SMTP relay and Spaces all need egress.
  outbound_all = [
    { protocol = "tcp", port_range = "1-65535" },
    { protocol = "udp", port_range = "1-65535" },
    { protocol = "icmp", port_range = null },
  ]
}

resource "digitalocean_firewall" "app" {
  name = "${local.prefix}-app"
  tags = [digitalocean_tag.this[local.tag_app].name]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_cidrs
  }

  dynamic "inbound_rule" {
    for_each = local.public_inbound
    content {
      protocol         = inbound_rule.value.protocol
      port_range       = inbound_rule.value.port_range
      source_addresses = local.anywhere
    }
  }

  dynamic "outbound_rule" {
    for_each = local.outbound_all
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = local.anywhere
    }
  }
}

# The monitoring droplet serves the status page and runs uptime checks; nothing else is open.
resource "digitalocean_firewall" "monitoring" {
  count = var.enable_monitoring_droplet ? 1 : 0

  name = "${local.prefix}-monitoring"
  tags = [digitalocean_tag.this[local.tag_monitoring].name]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_cidrs
  }

  dynamic "inbound_rule" {
    for_each = [
      { protocol = "tcp", port_range = "80" },
      { protocol = "tcp", port_range = "443" },
      { protocol = "udp", port_range = "443" },
    ]
    content {
      protocol         = inbound_rule.value.protocol
      port_range       = inbound_rule.value.port_range
      source_addresses = local.anywhere
    }
  }

  dynamic "outbound_rule" {
    for_each = local.outbound_all
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = local.anywhere
    }
  }
}
