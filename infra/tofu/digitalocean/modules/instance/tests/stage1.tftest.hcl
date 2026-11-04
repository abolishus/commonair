# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 1 (managed state) with a mocked provider.

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
      digitalocean_database_cluster.pg[0].region == "nyc3"
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
    condition     = alltrue([for b in digitalocean_spaces_bucket.instance : b.acl == "private" && b.region == "nyc3"])
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

run "shared_tags_are_never_tofu_resources" {
  command = plan

  variables {
    extra_tags = ["commonair-agent-check"]
  }

  # Destroying a tag resource deletes the tag from everything that carries it, including other
  # environments' droplets, so only the environment's own tags are managed.
  assert {
    condition     = toset(keys(digitalocean_tag.this)) == toset(["commonair-production", "commonair-production-app", "commonair-production-monitoring"])
    error_message = "Only the environment's own tags are tag resources."
  }

  assert {
    condition = alltrue([
      contains(digitalocean_droplet.app[0].tags, "commonair-agent-check"),
      contains(digitalocean_droplet.monitoring[0].tags, "commonair-agent-check"),
      contains(digitalocean_database_cluster.pg[0].tags, "commonair-agent-check"),
      contains(digitalocean_database_cluster.valkey[0].tags, "commonair-agent-check"),
    ])
    error_message = "Extra tags reach the droplets and the database clusters."
  }
}

run "own_project_by_default" {
  command = plan

  assert {
    condition     = length(digitalocean_project.this) == 1 && length(digitalocean_project_resources.existing) == 0
    error_message = "Without project_id the environment gets its own project."
  }
}

run "existing_project_is_only_assigned_to" {
  command = plan

  variables {
    project_id = "00000000-0000-4000-8000-000000000001"
  }

  assert {
    condition     = length(digitalocean_project.this) == 0 && digitalocean_project_resources.existing[0].project == "00000000-0000-4000-8000-000000000001"
    error_message = "With project_id the resources are assigned to that project and no project is created."
  }
}
