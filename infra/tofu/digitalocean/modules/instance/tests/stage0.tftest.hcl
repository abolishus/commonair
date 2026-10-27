# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 0 (launch) with a mocked provider: no token, no account, no network.

mock_provider "digitalocean" {
  # The provider's droplet ids are numbers (reserved IP and volume attachments take one); the
  # mock's default is a random string.
  mock_resource "digitalocean_droplet" {
    defaults = {
      id = "100001"
    }
  }
  mock_resource "digitalocean_reserved_ip" {
    defaults = {
      ip_address = "192.0.2.10"
    }
  }

  mock_data "digitalocean_ssh_keys" {
    defaults = {
      ssh_keys = [{
        id          = 1
        name        = "operator"
        public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMock operator"
        fingerprint = "3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"
      }]
    }
  }
}

variables {
  environment          = "production"
  region               = "nyc3"
  backup_region        = "ams3"
  monitoring_region    = "fra1"
  droplet_size         = "g-4vcpu-16gb"
  ssh_key_fingerprints = ["3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"]
  operator_cidrs       = ["203.0.113.7/32", "2001:db8:1::/64"]
}

run "firewall_allows_exactly_the_documented_ports" {
  command = plan

  assert {
    condition = toset([for r in digitalocean_firewall.app.inbound_rule : "${r.protocol}/${r.port_range}"]) == toset([
      "tcp/22", "tcp/80", "tcp/443", "udp/443", "tcp/1935", "udp/8189", "udp/3478", "tcp/6697",
    ])
    error_message = "The app firewall must open exactly 22, 80, 443/tcp, 443/udp, 1935, 8189/udp, 3478/udp and 6697."
  }

  assert {
    condition     = contains([for r in digitalocean_firewall.app.inbound_rule : "${r.protocol}/${r.port_range}"], "udp/3478")
    error_message = "coturn's STUN port (3478/udp) is open for P2P playback."
  }

  assert {
    condition     = length(digitalocean_firewall.app.inbound_rule) == 8
    error_message = "One inbound rule per documented port, no duplicates."
  }

  assert {
    condition     = alltrue([for r in digitalocean_firewall.app.inbound_rule : can(tonumber(r.port_range))])
    error_message = "Inbound rules are single ports, never ranges."
  }

  assert {
    condition = alltrue([
      for r in digitalocean_firewall.app.inbound_rule :
      toset(r.source_addresses) == toset(["0.0.0.0/0", "::/0"]) if r.port_range != "22"
    ])
    error_message = "Every public port is open over both IPv4 and IPv6."
  }

  assert {
    condition     = toset(digitalocean_firewall.app.tags) == toset(["commonair-production-app"])
    error_message = "The firewall selects the environment's app droplets by tag."
  }

  assert {
    condition     = length(digitalocean_firewall.app.outbound_rule) == 3
    error_message = "Outbound TCP, UDP and ICMP stay open (a firewall with no outbound rule blocks all egress)."
  }
}

run "ssh_only_from_operator_cidrs" {
  command = plan

  assert {
    condition     = length([for r in digitalocean_firewall.app.inbound_rule : r if r.port_range == "22"]) == 1
    error_message = "Exactly one SSH rule."
  }

  assert {
    condition = alltrue([
      for r in digitalocean_firewall.app.inbound_rule :
      r.protocol == "tcp" && toset(r.source_addresses) == toset(["203.0.113.7/32", "2001:db8:1::/64"]) if r.port_range == "22"
    ])
    error_message = "SSH comes only from operator_cidrs."
  }

  assert {
    condition = alltrue([
      for r in digitalocean_firewall.monitoring[0].inbound_rule :
      toset(r.source_addresses) == toset(["203.0.113.7/32", "2001:db8:1::/64"]) if r.port_range == "22"
    ])
    error_message = "SSH to the monitoring droplet comes only from operator_cidrs too."
  }
}

run "ssh_open_to_the_world_is_rejected" {
  command = plan

  variables {
    operator_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.operator_cidrs]
}

run "plain_irc_is_behind_a_flag" {
  command = plan

  variables {
    irc_plaintext = true
  }

  assert {
    condition     = contains([for r in digitalocean_firewall.app.inbound_rule : "${r.protocol}/${r.port_range}"], "tcp/6667")
    error_message = "irc_plaintext opens 6667/tcp."
  }

  assert {
    condition     = length(digitalocean_firewall.app.inbound_rule) == 9
    error_message = "irc_plaintext adds only 6667."
  }
}

run "stage1_and_stage2_are_absent_by_default" {
  command = plan

  assert {
    condition = (
      length(digitalocean_database_cluster.pg) == 0 &&
      length(digitalocean_database_cluster.valkey) == 0 &&
      length(digitalocean_database_firewall.pg) == 0 &&
      length(digitalocean_database_firewall.valkey) == 0 &&
      length(digitalocean_database_valkey_config.valkey) == 0 &&
      length(digitalocean_spaces_bucket.instance) == 0 &&
      length(digitalocean_spaces_bucket_cors_configuration.media) == 0 &&
      length(digitalocean_spaces_key.instance) == 0
    )
    error_message = "Stage 1 resources exist only with enable_managed_state."
  }

  assert {
    condition     = length(digitalocean_loadbalancer.app) == 0 && length(digitalocean_droplet.app) == 1
    error_message = "Stage 2 (load balancer, more app droplets) exists only with app_count > 1."
  }

  assert {
    condition     = length(digitalocean_volume.media) == 0 && length(digitalocean_volume_attachment.media) == 0
    error_message = "The media volume is optional and off by default."
  }
}

run "droplet_shape" {
  command = plan

  assert {
    condition = (
      digitalocean_droplet.app[0].image == "debian-13-x64" &&
      digitalocean_droplet.app[0].size == "g-4vcpu-16gb" &&
      digitalocean_droplet.app[0].ipv6 &&
      digitalocean_droplet.app[0].monitoring
    )
    error_message = "The app droplet is Debian 13 at the given size, with IPv6 and the monitoring agent."
  }

  assert {
    condition     = toset(digitalocean_droplet.app[0].tags) == toset(["commonair", "commonair-production", "commonair-app", "commonair-production-app"])
    error_message = "App droplets carry the shared, environment, role and environment-app tags."
  }
}

run "size_variable_has_no_default" {
  command = plan

  assert {
    condition = !can(regex(
      "(?m)^\\s*default\\s*=",
      regex("(?s)variable \"droplet_size\" \\{(.*?)\\n\\}", file("${path.module}/variables.tf"))[0],
    ))
    error_message = "droplet_size must have no default: S1-a's load test chooses it."
  }
}

run "blank_size_is_rejected" {
  command = plan

  variables {
    droplet_size = " "
  }

  expect_failures = [var.droplet_size]
}

run "backup_buckets_are_in_another_region" {
  command = plan

  assert {
    condition = (
      digitalocean_spaces_bucket.walg.region != digitalocean_droplet.app[0].region &&
      digitalocean_spaces_bucket.object_backups.region != digitalocean_droplet.app[0].region
    )
    error_message = "Backups live in a region other than the droplet's."
  }

  assert {
    condition     = digitalocean_spaces_bucket.walg.acl == "private" && digitalocean_spaces_bucket.object_backups.acl == "private"
    error_message = "Backup buckets are private."
  }

  assert {
    condition = alltrue([
      for b in [digitalocean_spaces_bucket.walg, digitalocean_spaces_bucket.object_backups] :
      anytrue([for r in b.lifecycle_rule : r.enabled && r.abort_incomplete_multipart_upload_days == 2])
    ])
    error_message = "Backup buckets abort incomplete multipart uploads."
  }

  assert {
    condition = (
      one(digitalocean_spaces_key.walg.grant).bucket == "commonair-production-walg" &&
      one(digitalocean_spaces_key.walg.grant).permission == "readwrite" &&
      one(digitalocean_spaces_key.object_backups.grant).bucket == "commonair-production-object-backups"
    )
    error_message = "Each backup key is limited to its own bucket."
  }
}

run "backups_in_the_droplet_region_are_rejected" {
  command = plan

  variables {
    backup_region = "nyc3"
  }

  expect_failures = [
    digitalocean_spaces_bucket.walg,
    digitalocean_spaces_bucket.object_backups,
  ]
}

run "monitoring_droplet_in_a_second_region" {
  command = plan

  assert {
    condition     = digitalocean_droplet.monitoring[0].region == "fra1" && digitalocean_droplet.monitoring[0].region != digitalocean_droplet.app[0].region
    error_message = "The monitoring droplet sits in monitoring_region, away from the app."
  }
}

run "monitoring_in_the_app_region_is_rejected" {
  command = plan

  variables {
    monitoring_region = "nyc3"
  }

  expect_failures = [digitalocean_droplet.monitoring]
}

run "monitoring_droplet_without_a_region_is_rejected" {
  command = plan

  variables {
    monitoring_region = null
  }

  # The VPC is skipped without a region, so the droplet's precondition, not a provider error,
  # is what the operator sees.
  expect_failures = [digitalocean_droplet.monitoring]
}

run "media_volume_when_asked" {
  command = plan

  variables {
    media_volume_size_gb = 200
  }

  assert {
    condition     = digitalocean_volume.media[0].size == 200 && digitalocean_volume.media[0].region == "nyc3"
    error_message = "The media volume is created in the droplet's region at the given size."
  }

  assert {
    condition     = length(digitalocean_volume_attachment.media) == 1
    error_message = "The media volume is attached to the first app droplet."
  }
}
