#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root on the KMS Droplet" >&2
  exit 1
fi
if [[ -z "${BAO_ADDR:-}" || -z "${BAO_CACERT:-}" ]]; then
  echo "set BAO_ADDR and BAO_CACERT" >&2
  exit 1
fi

read -r -s -p "Initial OpenBao root token: " root_token
echo
read -r -s -p "New kms-admin password (32+ characters): " admin_password
echo
if [[ "${#admin_password}" -lt 32 ]]; then
  echo "admin password is too short" >&2
  exit 1
fi

bao_root() {
  BAO_TOKEN="${root_token}" bao "$@"
}

bao_root secrets enable -path=kalqix-transit transit
bao_root write kalqix-transit/config/keys disable_upsert=true
bao_root policy write kalqix-kms-bridge /opt/kalqix-kms-bridge/current/deploy/openbao/bridge-policy.hcl
bao_root policy write kalqix-kms-admin /opt/kalqix-kms-bridge/current/deploy/openbao/admin-policy.hcl

bao_root auth enable approle
bao_root write auth/approle/role/kalqix-kms-bridge \
  token_policies=kalqix-kms-bridge \
  token_ttl=15m token_max_ttl=1h \
  secret_id_ttl=720h secret_id_num_uses=0

bao_root auth enable userpass
bao_root write auth/userpass/users/kms-admin \
  password="${admin_password}" token_policies=kalqix-kms-admin token_ttl=30m token_max_ttl=2h

install -d -o root -g root -m 0700 /etc/kalqix-kms/credentials
bao_root read -field=role_id auth/approle/role/kalqix-kms-bridge/role-id \
  > /etc/kalqix-kms/credentials/openbao-role-id
bao_root write -f -field=secret_id auth/approle/role/kalqix-kms-bridge/secret-id \
  > /etc/kalqix-kms/credentials/openbao-secret-id
chmod 0600 /etc/kalqix-kms/credentials/openbao-role-id /etc/kalqix-kms/credentials/openbao-secret-id

BAO_TOKEN="${root_token}" bao token revoke -self
unset root_token admin_password
echo "OpenBao bootstrap complete; the initial root token has been revoked"
echo "rotate the bridge SecretID before its 30-day TTL expires"
