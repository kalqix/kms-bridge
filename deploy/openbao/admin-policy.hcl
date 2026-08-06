# Pilot operator policy. Root-only endpoints remain unavailable; the Shamir
# quorum is still required to generate a replacement root token.
path "sys/health" {
  capabilities = ["read"]
}

path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}

path "sys/storage/raft/snapshot-force" {
  capabilities = ["update"]
}

path "sys/audit" {
  capabilities = ["read", "list"]
}

path "sys/audit-hash/*" {
  capabilities = ["update"]
}

path "kalqix-transit/keys" {
  capabilities = ["list"]
}

path "kalqix-transit/keys/*" {
  capabilities = ["read"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/approle/role/kalqix-kms-bridge/role-id" {
  capabilities = ["read"]
}

path "auth/approle/role/kalqix-kms-bridge/secret-id" {
  capabilities = ["create", "update"]
}

path "auth/approle/role/kalqix-kms-bridge/secret-id-accessor/*" {
  capabilities = ["update", "delete"]
}

path "auth/userpass/users/kms-admin" {
  capabilities = ["read", "update"]
}
