# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

variable "state_passphrase" {
  description = "State and plan encryption passphrase. Set TF_VAR_state_passphrase from a password manager; never write it to a file in the repository."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "The state passphrase must be at least 16 characters."
  }
}

variable "ssh_key_fingerprints" {
  description = "Fingerprints of operator SSH keys already on the account (doctl compute ssh-key list)."
  type        = list(string)
}

variable "operator_cidrs" {
  description = "Operator CIDRs allowed to reach SSH."
  type        = list(string)
}

variable "enable_managed_state" {
  description = "Stage 1 (ADR 0032): managed PostgreSQL and Valkey, instance buckets in Spaces. Off for staging; the U5 agent track turns it on for one run and destroys the clusters at its end."
  type        = bool
  default     = false
  nullable    = false
}

variable "instance_origin" {
  description = "Staging's https origin, for CORS on the media bucket. Required only with enable_managed_state."
  type        = string
  default     = null
}

variable "enable_monitoring_droplet" {
  description = "The monitoring droplet (status page and outside probes, docs/operators/status-page.md). Off for staging; the U5 agent track turns it on to bring the status stack up."
  type        = bool
  default     = false
  nullable    = false
}

variable "monitoring_region" {
  description = "Region of the monitoring droplet; required with enable_monitoring_droplet, and not staging's region."
  type        = string
  default     = null
}

variable "turn_relay" {
  description = "Open coturn's TURN relay range (selfhost.sh --turn-relay)."
  type        = bool
  default     = false
}

variable "status_site_name" {
  description = "The instance's INSTANCE_NAME, shown on the status page and in its alert mails. Null shows the origin's host."
  type        = string
  default     = null
}

variable "status_locale" {
  description = "Language of the status page: en or es."
  type        = string
  default     = "en"
  nullable    = false
}
