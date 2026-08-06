#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: $0 <https://kms-private-ip:9445> <ca.crt> <service-token-file>" >&2
  exit 1
fi

bridge_url="${1%/}"
ca_certificate="$2"
service_token_file="$3"
instance_id="pilot-smoke-$(date +%s)"
dek="$(openssl rand -base64 32 | tr -d '\n')"
aad="$(printf 'kalqix-mm/v1|credential|%s' "${instance_id}" | base64 | tr -d '\n')"

authorization_header="Authorization: Bearer $(<"${service_token_file}")"
wrap_response="$(curl --fail --silent --show-error --cacert "${ca_certificate}" \
  -H "${authorization_header}" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg instance "${instance_id}" --arg dek "${dek}" --arg aad "${aad}" \
    '{instance_id:$instance,plaintext_dek_base64:$dek,aad_base64:$aad}')" \
  "${bridge_url}/wrap")"
ciphertext="$(jq -er '.ciphertext_base64' <<<"${wrap_response}")"

unwrap_response="$(curl --fail --silent --show-error --cacert "${ca_certificate}" \
  -H "${authorization_header}" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg instance "${instance_id}" --arg ciphertext "${ciphertext}" --arg aad "${aad}" \
    '{instance_id:$instance,ciphertext_base64:$ciphertext,aad_base64:$aad}')" \
  "${bridge_url}/unwrap")"
unwrapped="$(jq -er '.plaintext_dek_base64' <<<"${unwrap_response}")"
if [[ "${unwrapped}" != "${dek}" ]]; then
  echo "unwrap mismatch" >&2
  exit 1
fi

destroy_response="$(curl --fail --silent --show-error --cacert "${ca_certificate}" \
  -H "${authorization_header}" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg instance "${instance_id}" '{instance_id:$instance}')" \
  "${bridge_url}/destroy")"
jq -e '.verified == true and (.attestation_id | type == "string")' <<<"${destroy_response}" >/dev/null

if curl --fail --silent --cacert "${ca_certificate}" \
  -H "${authorization_header}" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg instance "${instance_id}" --arg ciphertext "${ciphertext}" --arg aad "${aad}" \
    '{instance_id:$instance,ciphertext_base64:$ciphertext,aad_base64:$aad}')" \
  "${bridge_url}/unwrap" >/dev/null; then
  echo "destroy verification failed: old ciphertext still decrypted" >&2
  exit 1
fi

unset dek unwrapped authorization_header
echo "PASS: wrap, unwrap, live key deletion, and post-destroy failure verified"
