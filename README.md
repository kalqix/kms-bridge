# KalqiX KMS bridge

Private, dependency-free Node.js bridge between the KalqiX signer and an
OpenBao Transit backend. This project is intentionally separate from the
market-maker repository and should be hosted with the KMS security boundary.

The bridge implements the production contract expected by
`RemoteKmsDekWrapper`:

- `POST /wrap`
- `POST /unwrap`
- `POST /destroy`
- `GET /health` for liveness only

Every KalqiX instance receives a distinct OpenBao AES-256-GCM key. The Transit
key name is `kalqix-` plus the SHA-256 digest of the instance ID, so tenant
identifiers do not appear in OpenBao paths or bridge logs. The signer-provided
AAD is passed to Transit unchanged. Keys are non-exportable, plaintext backup
is disabled, and Transit automatic key upsert is disabled.

`/destroy` deletes the instance key from the live cluster and then verifies
that reading the key returns 404 before issuing an attestation. Existing
ciphertext becomes undecryptable by the live cluster. This is deliberately
different from OpenBao soft-delete.

An older Raft snapshot can still contain a deleted Transit key. The attestation
therefore says `openbao-live-key-deleted`; it does not claim irreversible
cryptographic erasure across retained backups. Backup retention must be short,
access-controlled, audited, and disclosed in any deletion statement.

## Security boundary

This is a software KMS pilot, not a hardware HSM:

- suitable for supervised or limited testnet operation;
- not sufficient by itself for mainnet custody;
- OpenBao and the bridge belong on a dedicated Droplet, never the application
  Droplet;
- OpenBao binds to loopback, while the bridge binds to the Droplet's exact VPC
  address;
- bridge TLS uses a private offline CA and TLS 1.3;
- the signer authenticates using a separate 48-byte bearer token;
- the bridge authenticates to OpenBao with a narrowly scoped AppRole;
- the initial root token is revoked after bootstrap;
- OpenBao uses five Shamir shares with a threshold of three.

## Local verification

Requires Node.js 24 and no package installation:

```bash
npm run verify
```

## Deployment

Follow [DEPLOY_DIGITALOCEAN.md](./DEPLOY_DIGITALOCEAN.md). Do not initialize
OpenBao until the TLS material, PGP keys for all Shamir shareholders, backup
destination, and Droplet firewall have been prepared.
