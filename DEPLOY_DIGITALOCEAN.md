# Frankfurt DigitalOcean pilot deployment

This runbook deploys one OpenBao `2.6.1` node and the KalqiX KMS bridge on a
dedicated Ubuntu 24.04 Droplet in DigitalOcean `fra1`.

It is a **testnet pilot**, not an HSM and not a mainnet authorization. A single
node has no availability or host-compromise tolerance. OpenBao recommends five
Raft nodes for production; expand to at least three before running unattended
testnet workloads.

## 1. Record the deployment values

Keep these non-secret values in your operator notes:

| Name | Expected value |
|---|---|
| Region | `fra1` |
| OS | Ubuntu 24.04 LTS |
| KMS VPC IP | Exact private IPv4 of the new Droplet |
| Application VPC IP | Exact private IPv4 of the application Droplet |
| KMS port | `9445/tcp` |
| OpenBao API | `https://127.0.0.1:8200` on the KMS Droplet only |

## 2. Create the Droplet and firewall

Create a regular Droplet with public and VPC networking so security updates do
not require a NAT gateway. Use at least 2 vCPU, 4 GiB RAM, Ubuntu 24.04, SSH-key
authentication, monitoring, and the same VPC as the application Droplet.

Attach a DigitalOcean Cloud Firewall with these inbound rules only:

| Protocol/port | Source |
|---|---|
| TCP 22 | Your fixed operator IP; never `0.0.0.0/0` |
| TCP 9445 | Application Droplet's exact VPC IP `/32` |

Do not allow inbound `8200` or `8201`. The service also binds only to loopback
or the exact VPC IP, so a firewall mistake does not publish OpenBao.

Apply pending updates and reboot before initialization:

```bash
sudo apt-get update
sudo apt-get dist-upgrade --yes
sudo reboot
```

## 3. Generate TLS material off-host

On a trusted operator workstation, clone this private repository and run:

```bash
./deploy/scripts/create-pilot-ca.sh <KMS_VPC_IP>
```

Keep `generated-certs/ca.key` offline. Never upload it. Transfer only:

- `ca.crt`
- `bridge.crt` and `bridge.key`
- `openbao.crt` and `openbao.key`

The application Droplet receives only `ca.crt` so Node can verify the bridge.

## 4. Install the host and OpenBao

Copy this repository to `/opt/kalqix-kms-bridge/releases/<release-id>` on the
KMS Droplet, create `/opt/kalqix-kms-bridge/current` as a symlink to it, then:

```bash
cd /opt/kalqix-kms-bridge/current
sudo ./deploy/scripts/prepare-host.sh
sudo ./deploy/scripts/install-openbao.sh
```

`prepare-host.sh` installs the official Node.js `24.18.0` LTS binary after
verifying its pinned SHA-256 digest. `install-openbao.sh` pins OpenBao `2.6.1`,
verifies the release checksum file's GPG signature, and verifies the package
checksum before installation.

Install the transferred files with explicit ownership:

```bash
sudo install -o root -g openbao -m 0644 ca.crt /etc/openbao/tls/ca.crt
sudo install -o root -g openbao -m 0644 openbao.crt /etc/openbao/tls/openbao.crt
sudo install -o root -g openbao -m 0640 openbao.key /etc/openbao/tls/openbao.key

sudo install -o root -g kalqix-kms-bridge -m 0644 ca.crt /etc/kalqix-kms/tls/ca.crt
sudo install -o root -g kalqix-kms-bridge -m 0644 bridge.crt /etc/kalqix-kms/tls/bridge.crt
sudo install -o root -g kalqix-kms-bridge -m 0640 bridge.key /etc/kalqix-kms/tls/bridge.key
```

Create the runtime configuration without editing the tracked templates:

```bash
sed 's/__KMS_PRIVATE_IP__/<KMS_VPC_IP>/g' deploy/openbao/openbao.hcl.example \
  | sudo tee /etc/openbao/openbao.hcl >/dev/null
sudo chown root:openbao /etc/openbao/openbao.hcl
sudo chmod 0640 /etc/openbao/openbao.hcl

sed 's/__KMS_PRIVATE_IP__/<KMS_VPC_IP>/g' deploy/env/bridge.env.example \
  | sudo tee /etc/kalqix-kms/bridge.env >/dev/null
sudo chown root:kalqix-kms-bridge /etc/kalqix-kms/bridge.env
sudo chmod 0640 /etc/kalqix-kms/bridge.env

sudo install -o root -g root -m 0644 deploy/systemd/openbao.service \
  /etc/systemd/system/openbao.service
sudo install -o root -g root -m 0644 deploy/systemd/kalqix-kms-bridge.service \
  /etc/systemd/system/kalqix-kms-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now openbao
```

Confirm OpenBao is running but sealed:

```bash
export BAO_ADDR=https://127.0.0.1:8200
export BAO_CACERT=/etc/openbao/tls/ca.crt
bao status
```

Expected: initialized `false`, sealed `true`. Do not use `-tls-skip-verify`.

## 5. Prepare the Shamir custody set

Before initialization, prepare five distinct PGP public keys and decide who or
what holds each private key. Use at least three genuinely separate custody
locations. For a one-person pilot, three encrypted offline devices in separate
physical locations are the minimum; five copies in one password manager are
not separate custody.

Prepare a sixth PGP public key for the initial root token. Its private key must
also remain off the Droplet.

## 6. Initialize and unseal

Run once, substituting the actual PGP public-key files:

```bash
bao operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -pgp-keys=share1.asc,share2.asc,share3.asc,share4.asc,share5.asc \
  -root-token-pgp-key=root-token.asc \
  -format=json > openbao-init-encrypted.json
chmod 0600 openbao-init-encrypted.json
```

The output remains PGP encrypted, but still copy it off-host and remove the
Droplet copy after verifying the custodians can decrypt their assigned shares.
Never combine three decrypted shares in a file.

Each of three custodians decrypts one share locally. Enter them one at a time:

```bash
bao operator unseal
bao operator unseal
bao operator unseal
bao status
```

Decrypt the initial root token only on the operator workstation. Do not put it
in shell history or a file on the Droplet.

## 7. Bootstrap Transit, audit, and service identities

Run:

```bash
export BAO_ADDR=https://127.0.0.1:8200
export BAO_CACERT=/etc/openbao/tls/ca.crt
sudo --preserve-env=BAO_ADDR,BAO_CACERT \
  /opt/kalqix-kms-bridge/current/deploy/scripts/bootstrap-openbao.sh
```

The script prompts without echo for the initial root token and a new 32+
character `kms-admin` password. It then:

- runs with the declarative append-only audit device configured in
  `/etc/openbao/openbao.hcl`;
- enables Transit at `kalqix-transit/`;
- disables encryption-path key upsert;
- installs least-privilege bridge and operator policies;
- creates the bridge AppRole with a 30-day SecretID;
- creates the restricted `kms-admin` operator login;
- writes the bridge AppRole credentials as root-only files;
- revokes the initial root token.

The `kms-admin` policy can initiate and cancel OpenBao 2.6's authenticated root
token generation workflow, but cannot complete it without three Shamir shares.
This preserves quorum recovery after the initial root token is revoked.

Store the `kms-admin` password in an offline/operator password manager. Test the
login before ending the maintenance session:

```bash
bao login -method=userpass username=kms-admin
bao token lookup
```

## 8. Create the bridge-to-signer service token

On the operator workstation:

```bash
umask 077
openssl rand -base64 48 > service-token
```

Copy the same file to both hosts. On the KMS Droplet:

```bash
sudo install -o root -g root -m 0600 service-token \
  /etc/kalqix-kms/credentials/service-token
sudo systemctl enable --now kalqix-kms-bridge
sudo systemctl status kalqix-kms-bridge --no-pager
```

On the application Droplet, configure the signer:

```env
NODE_ENV=production
KALQIX_SIGNER_KMS_URL=https://<KMS_VPC_IP>:9445
KALQIX_SIGNER_KMS_SERVICE_TOKEN=<contents of service-token>
NODE_EXTRA_CA_CERTS=/etc/kalqix/kms-ca.crt
```

Do not set `KALQIX_SIGNER_KEK_HEX`.

## 9. Qualify the bridge before importing credentials

From the application Droplet, with `jq`, `openssl`, and `curl` installed:

```bash
./deploy/scripts/smoke-test.sh \
  https://<KMS_VPC_IP>:9445 \
  /etc/kalqix/kms-ca.crt \
  /path/to/service-token
```

The check performs wrap, unwrap, live-cluster key deletion, and confirms that
the old ciphertext cannot be decrypted by the live cluster after deletion. It
uses only random dummy material. Do not import KalqiX credentials until this
passes.

## 10. Operations that remain manual

- After every OpenBao restart, three custodians must unseal it. There is no
  honest self-contained auto-unseal without another independent KMS/HSM.
- Rotate the bridge AppRole SecretID before its 30-day TTL expires.
- Renew bridge and OpenBao certificates before their 397-day expiry.
- Take encrypted Raft snapshots and copy them off the KMS Droplet:

  ```bash
  bao operator raft snapshot save /secure-temporary-path/openbao.snap
  ```

- Test restoration on an isolated replacement Droplet at least quarterly.
- Define and enforce a short snapshot-retention period. A snapshot taken before
  `/destroy` may retain the deleted Transit key, so live-cluster deletion is not
  irreversible cryptographic erasure until every such snapshot expires.
- Alert on OpenBao sealed state, bridge 5xx responses, audit-log failures, disk
  space, certificate expiry, and unexpected Transit key deletion.

## 11. Mainnet boundary

This pilot protects against theft of application-disk ciphertext and against an
application process reading the OpenBao master key. It does not protect against
a privileged compromise of the KMS Droplet or DigitalOcean's virtualization
layer. Mainnet requires a hardware-backed or confidential-compute root of trust,
plus the other GA gates in the application deployment runbook.
