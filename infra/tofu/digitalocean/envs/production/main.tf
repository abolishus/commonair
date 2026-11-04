# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Production: stage 1 at launch (U4): one dedicated-vCPU app droplet, managed PostgreSQL and
# Valkey with one standby each and the instance buckets in Spaces (enable_managed_state, default
# true here), backups and monitoring in other regions. Stage 2 is app_count > 1 (ADR 0032). The
# self-host default stays stage 0; this is only how our own instance is deployed.

terraform {
  required_version = "= 1.13.1"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "= 2.106.0"
    }
  }

  backend "s3" {
    bucket = "commonair-tofu-state"
    key    = "production/terraform.tfstate"
    region = "us-east-1" # ignored by Spaces; the endpoint picks the region
    endpoints = {
      s3 = "https://nyc3.digitaloceanspaces.com"
    }
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    use_lockfile                = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }

    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

provider "digitalocean" {}

module "instance" {
  source = "../../modules/instance"

  environment = "production"

  region            = var.region
  backup_region     = var.backup_region
  monitoring_region = var.monitoring_region
  droplet_size      = var.droplet_size

  media_volume_size_gb = var.media_volume_size_gb
  irc_plaintext        = var.irc_plaintext
  turn_relay           = var.turn_relay
  status_site_name     = var.status_site_name
  status_locale        = var.status_locale

  enable_managed_state = var.enable_managed_state
  pg_size              = var.pg_size
  valkey_size          = var.valkey_size
  instance_origin      = var.instance_origin

  app_count = var.app_count

  ssh_key_fingerprints = var.ssh_key_fingerprints
  operator_cidrs       = var.operator_cidrs
}
