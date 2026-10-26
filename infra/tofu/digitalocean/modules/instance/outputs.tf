# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Tofu does not touch DNS (Cloudflare, DNS-only records; ADR 0025 decision 4). These are the
# values the operator sets there by hand.
output "dns_records" {
  description = "A and AAAA values for the instance's domain (DNS only, grey cloud)."
  value = {
    a    = local.stage2 ? digitalocean_loadbalancer.app[0].ip : digitalocean_reserved_ip.app.ip_address
    aaaa = local.stage2 ? digitalocean_loadbalancer.app[0].ipv6 : digitalocean_droplet.app[0].ipv6_address
  }
}

output "monitoring_dns_records" {
  description = "A and AAAA values for the status page host, if the monitoring droplet exists."
  value = var.enable_monitoring_droplet ? {
    a    = digitalocean_droplet.monitoring[0].ipv4_address
    aaaa = digitalocean_droplet.monitoring[0].ipv6_address
  } : null
}

output "app_droplets" {
  description = "Name, public IPv4 and IPv6 of each app droplet, for SSH and selfhost.sh install."
  value = [for d in digitalocean_droplet.app : {
    name = d.name
    ipv4 = d.ipv4_address
    ipv6 = d.ipv6_address
  }]
}

output "reserved_ip" {
  description = "The reserved IPv4 on app[0]. SSH here: it survives recreating the droplet."
  value       = digitalocean_reserved_ip.app.ip_address
}

output "tags" {
  description = "Droplet tags the firewalls and database firewalls select on."
  value = {
    app        = local.tag_app
    monitoring = local.tag_monitoring
  }
}

output "backups" {
  description = "Settings for WAL-G (commonair.env) and object backups. Keys are in the sensitive outputs below."
  value = {
    endpoint              = "https://${var.backup_region}.digitaloceanspaces.com"
    region                = var.backup_region
    walg_s3_prefix        = "s3://${digitalocean_spaces_bucket.walg.name}/wal"
    object_backups_bucket = digitalocean_spaces_bucket.object_backups.name
  }
}

output "walg_key" {
  description = "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for WAL-G, limited to the WAL-G bucket."
  sensitive   = true
  value = {
    access_key_id     = digitalocean_spaces_key.walg.access_key
    secret_access_key = digitalocean_spaces_key.walg.secret_key
  }
}

output "object_backups_key" {
  description = "Spaces key limited to the object backup bucket."
  sensitive   = true
  value = {
    access_key_id     = digitalocean_spaces_key.object_backups.access_key
    secret_access_key = digitalocean_spaces_key.object_backups.secret_key
  }
}

output "managed_state" {
  description = "Stage 1 endpoints (null until enable_managed_state). Connection secrets are in managed_state_secrets."
  value = var.enable_managed_state ? {
    pg_host         = digitalocean_database_cluster.pg[0].private_host
    pg_port         = digitalocean_database_cluster.pg[0].port
    valkey_host     = digitalocean_database_cluster.valkey[0].private_host
    valkey_port     = digitalocean_database_cluster.valkey[0].port
    s3_endpoint     = "https://${var.region}.digitaloceanspaces.com"
    s3_region       = var.region
    media_bucket    = digitalocean_spaces_bucket.instance["media"].name
    exports_bucket  = digitalocean_spaces_bucket.instance["exports"].name
    evidence_bucket = digitalocean_spaces_bucket.instance["evidence"].name
  } : null
}

output "managed_state_secrets" {
  description = "Owner connection URIs (doadmin, private network) and the instance's Spaces key."
  sensitive   = true
  value = var.enable_managed_state ? {
    pg_owner_uri      = digitalocean_database_cluster.pg[0].private_uri
    valkey_uri        = digitalocean_database_cluster.valkey[0].private_uri
    access_key_id     = digitalocean_spaces_key.instance[0].access_key
    secret_access_key = digitalocean_spaces_key.instance[0].secret_key
  } : null
}
