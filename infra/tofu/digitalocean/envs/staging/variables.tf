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
