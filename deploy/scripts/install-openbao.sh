#!/usr/bin/env bash
set -euo pipefail

OPENBAO_VERSION="2.6.1"
OPENBAO_RELEASE_BASE="https://github.com/openbao/openbao/releases/download/v${OPENBAO_VERSION}"
OPENBAO_GPG_KEY_SHA256="1862a196422947124282e026ea4e09d6f7c5d383b628d90c17906936e6e5a8e0"

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

case "$(dpkg --print-architecture)" in
  amd64|arm64) architecture="$(dpkg --print-architecture)" ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac

package="openbao_${OPENBAO_VERSION}_linux_${architecture}.deb"
temporary_directory="$(mktemp -d /tmp/kalqix-openbao-install.XXXXXX)"
trap 'rm -rf -- "${temporary_directory}"' EXIT

apt-get update
apt-get install --yes ca-certificates curl gnupg jq openssl

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_directory}/${package}" "${OPENBAO_RELEASE_BASE}/${package}"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_directory}/checksums.txt" "${OPENBAO_RELEASE_BASE}/checksums.txt"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_directory}/checksums.txt.gpgsig" "${OPENBAO_RELEASE_BASE}/checksums.txt.gpgsig"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${temporary_directory}/openbao.asc" "${OPENBAO_RELEASE_BASE}/openbao-gpg-pub-20240618.asc"

echo "${OPENBAO_GPG_KEY_SHA256}  ${temporary_directory}/openbao.asc" | sha256sum --check --status
gpg --batch --no-default-keyring --keyring "${temporary_directory}/openbao.gpg" \
  --import "${temporary_directory}/openbao.asc"
gpg --batch --no-default-keyring --keyring "${temporary_directory}/openbao.gpg" \
  --verify "${temporary_directory}/checksums.txt.gpgsig" "${temporary_directory}/checksums.txt"

expected_checksum="$(awk -v target="${package}" '$2 == target { print $1 }' "${temporary_directory}/checksums.txt")"
if [[ ! "${expected_checksum}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "release checksum not found" >&2
  exit 1
fi
echo "${expected_checksum}  ${temporary_directory}/${package}" | sha256sum --check --status

dpkg --install "${temporary_directory}/${package}"
systemctl disable --now openbao.service >/dev/null 2>&1 || true
bao version
