import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.mjs';

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kalqix-kms-config-'));
  writeFileSync(join(directory, 'service-token'), 's'.repeat(48), { mode: 0o600 });
  writeFileSync(join(directory, 'openbao-role-id'), 'role-id', { mode: 0o600 });
  writeFileSync(join(directory, 'openbao-secret-id'), 'x'.repeat(32), { mode: 0o600 });
  return {
    directory,
    env: {
      NODE_ENV: 'production',
      CREDENTIALS_DIRECTORY: directory,
      KMS_BRIDGE_HOST: '10.10.0.5',
      KMS_BRIDGE_TLS_CERT_PATH: '/etc/kalqix-kms/tls/bridge.crt',
      KMS_BRIDGE_TLS_KEY_PATH: '/etc/kalqix-kms/tls/bridge.key',
      KMS_BRIDGE_OPENBAO_URL: 'https://127.0.0.1:8200',
      ...overrides,
    },
  };
}

test('reads secrets from the systemd credentials directory', () => {
  const { directory, env } = fixture();
  try {
    const config = readConfig(env);
    assert.equal(config.serviceToken, 's'.repeat(48));
    assert.equal(config.openBaoRoleId, 'role-id');
    assert.equal(config.port, 9445);
    assert.equal(config.openBaoMount, 'kalqix-transit');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production rejects plaintext OpenBao and wildcard public binding', () => {
  const plaintext = fixture({ KMS_BRIDGE_OPENBAO_URL: 'http://127.0.0.1:8200' });
  const wildcard = fixture({ KMS_BRIDGE_HOST: '0.0.0.0' });
  try {
    assert.throws(() => readConfig(plaintext.env), /must use https/);
    assert.throws(() => readConfig(wildcard.env), /VPC address/);
  } finally {
    rmSync(plaintext.directory, { recursive: true, force: true });
    rmSync(wildcard.directory, { recursive: true, force: true });
  }
});

test('rejects short service credentials without exposing their values', () => {
  const { directory, env } = fixture();
  writeFileSync(join(directory, 'service-token'), 'short', { mode: 0o600 });
  try {
    assert.throws(
      () => readConfig(env),
      (error) => error.message === 'invalid configuration: KMS_BRIDGE_SERVICE_TOKEN_FILE',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
