# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Staging's status_page_url, with a mocked provider (no token, no account; tofu test keeps its
# state in memory, so the s3 backend is never used).

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
  ssh_key_fingerprints = ["3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa"]
  operator_cidrs       = ["203.0.113.7/32"]
}

run "watched_from_production_by_default" {
  command = plan

  assert {
    condition     = output.status_page_url == null
    error_message = "Staging has no status stack of its own by default, so no STATUS_PAGE_URL."
  }
}

run "its_own_status_stack_when_asked" {
  command = plan

  variables {
    enable_monitoring_droplet = true
    monitoring_region         = "fra1"
    instance_origin           = "https://staging.example.org"
  }

  assert {
    condition     = output.status_page_url == "https://status.staging.example.org"
    error_message = "With its own monitoring droplet and an origin, staging names its status page."
  }
}
