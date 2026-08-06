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
  capabilities = ["read", "list", "sudo"]
}

path "sys/audit-hash/*" {
  capabilities = ["update"]
}

# OpenBao 2.6 root-token generation is authenticated. These permissions only
# start and advance the workflow; a 3-of-5 Shamir quorum is still required.
path "sys/generate-root-token/attempt" {
  capabilities = ["read", "update", "delete", "sudo"]
}

path "sys/generate-root-token/update" {
  capabilities = ["update", "sudo"]
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
