# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Stage 2 (app tier behind a network load balancer) with a mocked provider.

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
  app_count            = 3
}

run "network_load_balancer_in_front_of_the_app_droplets" {
  command = plan

  assert {
    condition     = length(digitalocean_droplet.app) == 3
    error_message = "app_count droplets."
  }

  assert {
    condition = (
      digitalocean_loadbalancer.app[0].type == "REGIONAL_NETWORK" &&
      digitalocean_loadbalancer.app[0].network_stack == "DUALSTACK" &&
      digitalocean_loadbalancer.app[0].droplet_tag == "commonair-production-app"
    )
    error_message = "A regional network (layer 4) load balancer over IPv4 and IPv6, selecting app droplets by tag."
  }

  assert {
    condition = toset([
      for r in digitalocean_loadbalancer.app[0].forwarding_rule :
      "${r.entry_protocol}/${r.entry_port}->${r.target_protocol}/${r.target_port}"
    ]) == toset(["tcp/80->tcp/80", "tcp/443->tcp/443", "udp/443->udp/443", "tcp/1935->tcp/1935", "tcp/6697->tcp/6697"])
    error_message = "The load balancer passes 80, 443 TCP, 443 UDP, 1935 and 6697 straight through."
  }

  assert {
    condition     = digitalocean_loadbalancer.app[0].enable_proxy_protocol == false
    error_message = "A network load balancer keeps client addresses without PROXY protocol."
  }

  assert {
    condition     = one(digitalocean_loadbalancer.app[0].healthcheck).protocol == "tcp"
    error_message = "Health checks run against each droplet."
  }
}

run "stage2_needs_stage1" {
  command = plan

  variables {
    enable_managed_state = false
    instance_origin      = null
  }

  expect_failures = [digitalocean_droplet.app]
}
