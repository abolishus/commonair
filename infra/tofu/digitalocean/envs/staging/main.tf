# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Staging: one shared-vCPU droplet, stage 0 only, upgraded to every release candidate with
# selfhost.sh (ADR 0025 decision 2). It replaces the hand-made commonair-rc-test (README,
# "Adopting the staging droplet").

terraform {
  required_version = "= 1.13.1"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "= 2.106.0"
    }
  }

  # The state bucket is created by hand once (README, "State"). Credentials come from
  # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the operator's shell, never from a file.
  backend "s3" {
    bucket = "commonair-tofu-state"
    key    = "staging/terraform.tfstate"
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

  # State holds Spaces secret keys and, at stage 1, database URIs: it is encrypted client-side
  # before it reaches the bucket, with a passphrase from TF_VAR_state_passphrase.
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

# DIGITALOCEAN_TOKEN, SPACES_ACCESS_KEY_ID and SPACES_SECRET_ACCESS_KEY come from the
# environment (ADR 0025 decision 5).
provider "digitalocean" {}

module "instance" {
  source = "../../modules/instance"

  environment = "staging"

  # Where commonair-rc-test runs today (PROGRESS, session thirteen, section 5).
  region       = "mkc1"
  droplet_size = "s5-4vcpu-8gb-80gb"

  backup_region = "nyc3"

  # Staging is watched from production's monitoring droplet.
  enable_monitoring_droplet = false

  ssh_key_fingerprints = var.ssh_key_fingerprints
  operator_cidrs       = var.operator_cidrs
}
