# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Production's outputs for commonair.env, with a mocked provider (no token, no account; tofu test
# keeps its state in memory, so the s3 backend is never used).

mock_provider "digitalocean" {
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
  state_passphrase     = "test-only-not-a-secret-passphrase"
  region               = "nyc3"
  backup_region        = "ams3"
  monitoring_region    = "fra1"
  droplet_size         = "g-4vcpu-16gb"
  ssh_key_fingerprints = ["3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"]
  operator_cidrs       = ["203.0.113.7/32"]
  instance_origin      = "https://stream.example.org"
}

run "observability_env_names_the_status_page" {
  command = plan

  assert {
    condition = output.observability_env == {
      SLO_TARGET      = "0.999"
      STATUS_PAGE_URL = "https://status.stream.example.org"
    }
    error_message = "observability_env carries U4's target and the status page Prometheus checks for freshness."
  }

  assert {
    condition     = output.status_page_url == "https://status.stream.example.org"
    error_message = "status_page_url is the status page's origin."
  }
}

run "no_origin_no_status_page_key" {
  command = plan

  # Without an origin there is no status stack: the key is left out, not set to null or "".
  variables {
    enable_managed_state = false
    instance_origin      = null
  }

  assert {
    condition     = output.observability_env == { SLO_TARGET = "0.999" } && output.status_page_url == null
    error_message = "Without the status stack, observability_env has no STATUS_PAGE_URL."
  }
}

run "managed_state_reaches_install" {
  command = plan

  assert {
    condition = (
      output.managed_state.backups_bucket == "commonair-production-backups" &&
      output.managed_state.database_pool_max == 8
    )
    error_message = "managed_state passes the backups bucket and the pool size (default pg_size) through."
  }
}
