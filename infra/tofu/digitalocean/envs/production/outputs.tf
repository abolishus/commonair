# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

output "dns_records" {
  description = "Set these as DNS-only A and AAAA records for the instance's domain in Cloudflare."
  value       = module.instance.dns_records
}

output "monitoring_dns_records" {
  description = "A and AAAA records for the status page host."
  value       = module.instance.monitoring_dns_records
}

output "app_droplets" {
  description = "App droplet addresses, for selfhost.sh install over SSH."
  value       = module.instance.app_droplets
}

output "reserved_ip" {
  description = "The reserved IPv4 on the first app droplet."
  value       = module.instance.reserved_ip
}

output "backups" {
  description = "WAL-G and object backup settings for commonair.env."
  value       = module.instance.backups
}

output "walg_key" {
  description = "WAL-G's Spaces key (tofu output -json walg_key)."
  value       = module.instance.walg_key
  sensitive   = true
}

output "object_backups_key" {
  description = "The object backup Spaces key."
  value       = module.instance.object_backups_key
  sensitive   = true
}

output "managed_state" {
  description = "Stage 1 endpoints and bucket names."
  value       = module.instance.managed_state
}

output "managed_state_secrets" {
  description = "Stage 1 owner URIs and the instance's Spaces key."
  value       = module.instance.managed_state_secrets
  sensitive   = true
}
