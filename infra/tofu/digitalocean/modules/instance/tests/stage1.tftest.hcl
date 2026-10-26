# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 1 (managed state) with a mocked provider.

mock_provider "digitalocean" {
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
  region               = "nyc1"
  backup_region        = "ams3"
  monitoring_region    = "fra1"
  droplet_size         = "g-4vcpu-16gb"
  ssh_key_fingerprints = ["3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"]
  operator_cidrs       = ["203.0.113.7/32"]
  enable_managed_state = true
  instance_origin      = "https://stream.example.org"
}

run "managed_postgres_and_valkey_with_a_standby" {
  command = plan

  assert {
    condition = (
      digitalocean_database_cluster.pg[0].engine == "pg" &&
      digitalocean_database_cluster.pg[0].version == "17" &&
      digitalocean_database_cluster.pg[0].node_count == 2 &&
      digitalocean_database_cluster.pg[0].region == "nyc1"
    )
    error_message = "Postgres 17 by default, one standby, in the app's region."
  }

  assert {
    condition     = digitalocean_database_cluster.valkey[0].engine == "valkey" && digitalocean_database_cluster.valkey[0].node_count == 2
    error_message = "Valkey with one standby."
  }

  assert {
    condition     = digitalocean_database_valkey_config.valkey[0].valkey_maxmemory_policy == "noeviction"
    error_message = "Valkey must not evict: BullMQ requires noeviction."
  }

  assert {
    condition     = digitalocean_database_valkey_config.valkey[0].persistence == "rdb"
    error_message = "Valkey persistence stays on."
  }
}

run "database_firewalls_use_the_app_tag" {
  command = plan

  assert {
    condition = alltrue([
      for fw in [digitalocean_database_firewall.pg[0], digitalocean_database_firewall.valkey[0]] :
      length(fw.rule) == 1 && alltrue([for r in fw.rule : r.type == "tag" && r.value == "commonair-production-app"])
    ])
    error_message = "Only droplets tagged commonair-production-app reach the databases."
  }
}

run "instance_buckets_and_cors" {
  command = plan

  assert {
    condition     = toset(keys(digitalocean_spaces_bucket.instance)) == toset(["media", "exports", "evidence"])
    error_message = "Stage 1 creates the media, exports and evidence buckets."
  }

  assert {
    condition     = alltrue([for b in digitalocean_spaces_bucket.instance : b.acl == "private" && b.region == "nyc1"])
    error_message = "Instance buckets are private and in the app's region."
  }

  assert {
    condition = alltrue([
      for r in digitalocean_spaces_bucket_cors_configuration.media[0].cors_rule :
      toset(r.allowed_origins) == toset(["https://stream.example.org"])
    ])
    error_message = "CORS on the media bucket allows only the instance's origin."
  }

  assert {
    condition = (
      length(digitalocean_spaces_key.instance[0].grant) == 3 &&
      alltrue([for g in digitalocean_spaces_key.instance[0].grant : g.permission == "readwrite" && g.bucket != ""])
    )
    error_message = "The instance key is limited to the three instance buckets (an empty bucket would mean every bucket)."
  }
}

run "managed_state_needs_an_origin" {
  command = plan

  variables {
    instance_origin = null
  }

  expect_failures = [digitalocean_spaces_bucket.instance]
}

run "stage2_still_off" {
  command = plan

  assert {
    condition     = length(digitalocean_loadbalancer.app) == 0
    error_message = "Stage 1 alone adds no load balancer."
  }
}
