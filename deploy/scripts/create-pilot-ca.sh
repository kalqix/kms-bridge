#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <kms-droplet-private-ip>" >&2
  exit 1
fi

kms_private_ip="$1"
if ! [[ "${kms_private_ip}" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  echo "expected a DigitalOcean VPC IPv4 address" >&2
  exit 1
fi

output_directory="generated-certs"
if [[ -e "${output_directory}" ]]; then
  echo "${output_directory} already exists; move it aside rather than overwriting keys" >&2
  exit 1
fi

umask 077
mkdir "${output_directory}"

openssl genpkey -algorithm ED25519 -out "${output_directory}/ca.key"
openssl req -x509 -new -key "${output_directory}/ca.key" -days 3650 \
  -subj "/CN=KalqiX Pilot KMS CA" -out "${output_directory}/ca.crt"

openssl genpkey -algorithm ED25519 -out "${output_directory}/bridge.key"
openssl req -new -key "${output_directory}/bridge.key" \
  -subj "/CN=kalqix-kms-bridge" -out "${output_directory}/bridge.csr"
openssl x509 -req -in "${output_directory}/bridge.csr" \
  -CA "${output_directory}/ca.crt" -CAkey "${output_directory}/ca.key" -CAcreateserial \
  -days 397 -extfile <(printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\n' "${kms_private_ip}") \
  -out "${output_directory}/bridge.crt"

openssl genpkey -algorithm ED25519 -out "${output_directory}/openbao.key"
openssl req -new -key "${output_directory}/openbao.key" \
  -subj "/CN=openbao-loopback" -out "${output_directory}/openbao.csr"
openssl x509 -req -in "${output_directory}/openbao.csr" \
  -CA "${output_directory}/ca.crt" -CAkey "${output_directory}/ca.key" -CAcreateserial \
  -days 397 -extfile <(printf 'subjectAltName=IP:127.0.0.1,IP:%s\nextendedKeyUsage=serverAuth\n' "${kms_private_ip}") \
  -out "${output_directory}/openbao.crt"

rm "${output_directory}/bridge.csr" "${output_directory}/openbao.csr" "${output_directory}/ca.srl"
chmod 0600 "${output_directory}"/*.key
chmod 0644 "${output_directory}"/*.crt

echo "certificates created in ${output_directory}"
echo "keep generated-certs/ca.key offline; never copy it to either Droplet"
