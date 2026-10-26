# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# ---------------------------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------------------------

variable "environment" {
  description = "staging or production. Names, tags and the project come from it."
  type        = string
  nullable    = false

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "name_prefix" {
  description = "Prefix for droplet, VPC, firewall and bucket names. Defaults to commonair-<environment>."
  type        = string
  default     = null
}

variable "region" {
  description = "Region of the app droplet(s), the VPC and, at stage 1, the managed databases and instance buckets."
  type        = string
  nullable    = false
}

variable "vpc_ip_range" {
  description = "Optional RFC 1918 range for the app VPC (/16 to /24). Null lets DigitalOcean choose one that does not overlap."
  type        = string
  default     = null
}

variable "ssh_key_fingerprints" {
  description = "Fingerprints (MD5, colon-separated, as `doctl compute ssh-key list` prints them) of SSH keys already uploaded to the account. Tofu never creates keys from private material."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.ssh_key_fingerprints) > 0
    error_message = "Give at least one SSH key fingerprint."
  }

  validation {
    condition     = alltrue([for f in var.ssh_key_fingerprints : can(regex("^([0-9a-f]{2}:){15}[0-9a-f]{2}$", f))])
    error_message = "SSH key fingerprints are 16 colon-separated lowercase hex pairs (MD5), as DigitalOcean shows them."
  }
}

variable "operator_cidrs" {
  description = "IPv4 and IPv6 CIDRs allowed to reach SSH (22/tcp). Never the whole internet."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.operator_cidrs) > 0
    error_message = "Give at least one operator CIDR for SSH."
  }

  validation {
    condition     = alltrue([for c in var.operator_cidrs : can(cidrhost(c, 0))])
    error_message = "operator_cidrs must be CIDRs such as 203.0.113.7/32 or 2001:db8::/64."
  }

  validation {
    condition     = alltrue([for c in var.operator_cidrs : !contains(["0.0.0.0/0", "::/0"], c)])
    error_message = "SSH must not be open to the whole internet."
  }
}

# ---------------------------------------------------------------------------------------------
# Stage 0: the droplet, its firewall, backups and monitoring
# ---------------------------------------------------------------------------------------------

# Intentionally no default: the S1-a load test picks the production size, and staging names its
# own. A test (tests/stage0.tftest.hcl) fails if a default appears.
variable "droplet_size" {
  description = "Droplet size slug for every app droplet, e.g. g-4vcpu-16gb (dedicated) or s-4vcpu-8gb (shared, staging)."
  type        = string

  validation {
    # HCL's && does not short-circuit, hence try() for an explicit null.
    condition     = try(length(trimspace(var.droplet_size)) > 0, false)
    error_message = "droplet_size is required: S1-a's load test chooses it."
  }
}

variable "droplet_image" {
  description = "Image slug. Debian 13 ships Podman 5 and systemd 257, which the Quadlet units need."
  type        = string
  default     = "debian-13-x64"
  nullable    = false
}

variable "cloud_init_updates" {
  description = "Pass cloud-init user data that only updates packages on first boot. It never carries secrets: droplet metadata is readable from the droplet."
  type        = bool
  default     = true
  nullable    = false
}

variable "media_volume_size_gb" {
  description = "Size of a block storage volume for MEDIA_WORK_DIR_* on the first app droplet. 0 creates none."
  type        = number
  default     = 0
  nullable    = false

  validation {
    condition     = var.media_volume_size_gb == 0 || (var.media_volume_size_gb >= 1 && var.media_volume_size_gb <= 16384)
    error_message = "media_volume_size_gb is 0 (no volume) or 1 to 16384."
  }
}

variable "irc_plaintext" {
  description = "Open 6667/tcp for plain IRC. Off unless the instance offers it."
  type        = bool
  default     = false
  nullable    = false
}

variable "backup_region" {
  description = "Spaces region for the WAL-G and object backup buckets. Must differ from region."
  type        = string
  nullable    = false
}

variable "backup_noncurrent_days" {
  description = "Days a deleted or overwritten backup object stays recoverable. The backup keys can delete objects (Spaces grants have no write-without-delete), so versioning is what protects backups from a stolen droplet key."
  type        = number
  default     = 14
  nullable    = false

  validation {
    condition     = var.backup_noncurrent_days >= 1
    error_message = "backup_noncurrent_days must be at least 1."
  }
}

variable "multipart_abort_days" {
  description = "Days after which Spaces aborts an incomplete multipart upload in every bucket tofu manages."
  type        = number
  default     = 2
  nullable    = false

  validation {
    condition     = var.multipart_abort_days >= 1
    error_message = "multipart_abort_days must be at least 1."
  }
}

variable "enable_monitoring_droplet" {
  description = "Create the small droplet for uptime checks and the status page in monitoring_region."
  type        = bool
  default     = true
  nullable    = false
}

variable "monitoring_region" {
  description = "Region of the monitoring droplet. Must differ from region, so monitoring outlives the host it watches."
  type        = string
  default     = null
}

variable "monitoring_size" {
  description = "Size slug of the monitoring droplet."
  type        = string
  default     = "s-1vcpu-1gb"
  nullable    = false
}

# ---------------------------------------------------------------------------------------------
# Stage 1: managed Postgres and Valkey, instance buckets in Spaces
# ---------------------------------------------------------------------------------------------

variable "enable_managed_state" {
  description = "Stage 1 (ADR 0032): managed PostgreSQL and Valkey with one standby each, and the instance's buckets in Spaces."
  type        = bool
  default     = false
  nullable    = false
}

variable "pg_version" {
  description = "Managed PostgreSQL major version. 17 matches infra/postgres/Containerfile, what releases are tested with."
  type        = string
  default     = "17"
  nullable    = false
}

variable "pg_size" {
  description = "Managed PostgreSQL node size. A standby needs at least db-s-1vcpu-2gb; S1-a's numbers choose the real one."
  type        = string
  default     = "db-s-1vcpu-2gb"
  nullable    = false
}

variable "valkey_version" {
  description = "Managed Valkey major version (8 or 9)."
  type        = string
  default     = "8"
  nullable    = false
}

variable "valkey_size" {
  description = "Managed Valkey node size."
  type        = string
  default     = "db-s-1vcpu-2gb"
  nullable    = false
}

variable "instance_origin" {
  description = "The instance's public origin (https://stream.example.org), allowed by CORS on the media bucket. Required with enable_managed_state."
  type        = string
  default     = null

  validation {
    condition     = var.instance_origin == null || can(regex("^https://[^/]+$", var.instance_origin))
    error_message = "instance_origin is an https origin with no path, e.g. https://stream.example.org."
  }
}

# ---------------------------------------------------------------------------------------------
# Stage 2: app tier behind a network load balancer
# ---------------------------------------------------------------------------------------------

variable "app_count" {
  description = "Number of app droplets. 1 is stages 0 and 1; more than 1 is stage 2 and adds the network load balancer."
  type        = number
  default     = 1
  nullable    = false

  validation {
    condition     = var.app_count >= 1 && floor(var.app_count) == var.app_count
    error_message = "app_count is a whole number of at least 1."
  }
}

variable "lb_size_unit" {
  description = "Load balancer size units (1 to 200), stage 2 only."
  type        = number
  default     = 1
  nullable    = false
}
