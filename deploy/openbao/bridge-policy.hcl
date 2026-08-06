# Per-instance names are SHA-256-derived by the bridge and always start with
# kalqix-. Transit automatic upsert is disabled during bootstrap.
path "kalqix-transit/keys/kalqix-*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "kalqix-transit/encrypt/kalqix-*" {
  capabilities = ["update"]
}

path "kalqix-transit/decrypt/kalqix-*" {
  capabilities = ["update"]
}
