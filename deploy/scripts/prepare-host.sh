#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

apt-get update
apt-get install --yes ca-certificates curl gnupg jq openssl rsync xz-utils

node_version="24.18.0"
case "$(dpkg --print-architecture)" in
  amd64)
    node_architecture="x64"
    node_checksum="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
    ;;
  arm64)
    node_architecture="arm64"
    node_checksum="58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"
    ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac
node_archive="node-v${node_version}-linux-${node_architecture}.tar.xz"
temporary_directory="$(mktemp -d /tmp/kalqix-node-install.XXXXXX)"
trap 'rm -rf -- "${temporary_directory}"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "${temporary_directory}/${node_archive}" \
  "https://nodejs.org/dist/v${node_version}/${node_archive}"
echo "${node_checksum}  ${temporary_directory}/${node_archive}" | sha256sum --check --status
install -d -o root -g root -m 0755 /usr/local/lib/nodejs
tar -xJf "${temporary_directory}/${node_archive}" -C /usr/local/lib/nodejs
ln -sfn "/usr/local/lib/nodejs/node-v${node_version}-linux-${node_architecture}/bin/node" \
  /usr/local/bin/node
ln -sfn "/usr/local/lib/nodejs/node-v${node_version}-linux-${node_architecture}/bin/npm" \
  /usr/local/bin/npm

if [[ "$(/usr/local/bin/node --version)" != "v${node_version}" ]]; then
  echo "Node 24 installation failed" >&2
  exit 1
fi

if ! id openbao >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/openbao --shell /usr/sbin/nologin openbao
fi
if ! id kalqix-kms-bridge >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kalqix-kms-bridge
fi

install -d -o root -g root -m 0755 /opt/kalqix-kms-bridge/releases
install -d -o root -g openbao -m 0750 /etc/openbao /etc/openbao/tls
install -d -o openbao -g openbao -m 0700 /var/lib/openbao /var/lib/openbao/raft
install -d -o openbao -g openbao -m 0750 /var/log/openbao
install -d -o root -g kalqix-kms-bridge -m 0750 /etc/kalqix-kms /etc/kalqix-kms/tls
install -d -o root -g root -m 0700 /etc/kalqix-kms/credentials

echo "host preparation complete"
