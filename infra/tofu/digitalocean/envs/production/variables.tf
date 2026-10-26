# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Open decisions have no default, so a plan cannot run until they are made: the region
# (ADR 0025's open question) and the droplet size (S1-a's load test).

variable "state_passphrase" {
  description = "State and plan encryption passphrase. Set TF_VAR_state_passphrase from a password manager; never write it to a file in the repository."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "The state passphrase must be at least 16 characters."
  }
}

variable "region" {
  description = "Production region (open: ADR 0025)."
  type        = string
}

variable "backup_region" {
  description = "Spaces region for backups; must differ from region."
  type        = string
}

variable "monitoring_region" {
  description = "Region of the monitoring droplet; must differ from region."
  type        = string
}

variable "droplet_size" {
  description = "Dedicated-vCPU droplet size chosen by the S1-a load test."
  type        = string
}

variable "ssh_key_fingerprints" {
  description = "Fingerprints of operator SSH keys already on the account (doctl compute ssh-key list)."
  type        = list(string)
}

variable "operator_cidrs" {
  description = "Operator CIDRs allowed to reach SSH."
  type        = list(string)
}

variable "media_volume_size_gb" {
  description = "Block storage for MEDIA_WORK_DIR_*; 0 for none."
  type        = number
  default     = 0
}

variable "irc_plaintext" {
  description = "Open 6667/tcp for plain IRC."
  type        = bool
  default     = false
}

variable "enable_managed_state" {
  description = "Stage 1: managed PostgreSQL and Valkey, instance buckets in Spaces."
  type        = bool
  default     = false
}

variable "pg_size" {
  description = "Managed PostgreSQL node size (stage 1)."
  type        = string
  default     = "db-s-1vcpu-2gb"
}

variable "valkey_size" {
  description = "Managed Valkey node size (stage 1)."
  type        = string
  default     = "db-s-1vcpu-2gb"
}

variable "instance_origin" {
  description = "The instance's https origin, for CORS on the media bucket (stage 1)."
  type        = string
  default     = null
}

variable "app_count" {
  description = "App droplets; more than 1 is stage 2 and needs stage 1."
  type        = number
  default     = 1
}
