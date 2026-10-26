# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

terraform {
  # Exact pins (ADR 0022). 1.13.1 is the newest OpenTofu release older than the 7-day cooldown
  # on 2026-10-26; 2.106.0 is the newest provider release, published 2026-10-12.
  required_version = "= 1.13.1"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "= 2.106.0"
    }
  }
}
