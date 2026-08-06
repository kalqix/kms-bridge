import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenBaoTransitClient, keyNameForInstance } from '../src/openbao-client.mjs';

test('wrap, unwrap, and verified destruction use one non-exportable key per instance', async () => {
  const calls = [];
  let exists = false;
  let deletionAllowed = false;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, token: init.headers['x-vault-token'] });

    if (path === '/v1/auth/approle/login') {
      assert.deepEqual(body, { role_id: 'role', secret_id: 'secret'.repeat(6) });
      return json(200, { auth: { client_token: 'token', lease_duration: 300 } });
    }
    if (path.includes('/keys/')) {
      if (init.method === 'GET') {
        return exists
          ? json(200, {
              data: {
                type: 'aes256-gcm96',
                derived: false,
                exportable: false,
                allow_plaintext_backup: false,
                deletion_allowed: deletionAllowed,
              },
            })
          : json(404, { errors: ['missing'] });
      }
      if (path.endsWith('/config')) {
        deletionAllowed = body.deletion_allowed;
        return new Response(null, { status: 204 });
      }
      if (init.method === 'POST') {
        exists = true;
        assert.deepEqual(body, {
          type: 'aes256-gcm96',
          derived: false,
          exportable: false,
          allow_plaintext_backup: false,
        });
        return new Response(null, { status: 204 });
      }
      if (init.method === 'DELETE') {
        if (!exists) return json(404, { errors: ['missing'] });
        exists = false;
        return new Response(null, { status: 204 });
      }
    }
    if (path.includes('/encrypt/')) {
      assert.equal(body.associated_data, Buffer.from('aad').toString('base64'));
      return json(200, { data: { ciphertext: 'vault:v1:ciphertext' } });
    }
    if (path.includes('/decrypt/')) {
      assert.equal(body.ciphertext, 'vault:v1:ciphertext');
      return json(200, { data: { plaintext: Buffer.alloc(32, 7).toString('base64') } });
    }
    throw new Error(`unexpected request: ${init.method} ${path}`);
  };

  const client = new OpenBaoTransitClient({
    baseUrl: 'https://127.0.0.1:8200',
    mount: 'kalqix-transit',
    roleId: 'role',
    secretId: 'secret'.repeat(6),
    fetchImpl,
    now: () => 1_000,
  });
  const aad = Buffer.from('aad').toString('base64');
  const dek = Buffer.alloc(32, 7).toString('base64');

  assert.equal(await client.wrap('instance-1', dek, aad), 'vault:v1:ciphertext');
  assert.equal(await client.unwrap('instance-1', 'vault:v1:ciphertext', aad), dek);
  const attestation = await client.destroy('instance-1');
  assert.equal(attestation.verified, true);
  assert.match(
    attestation.attestation_id,
    /^openbao-live-key-deleted:kalqix-[a-f0-9]{64}:1000:/,
  );
  assert.equal((await client.destroy('instance-1')).verified, true);
  assert.equal(exists, false);
  assert.equal(calls.filter((call) => call.path === '/v1/auth/approle/login').length, 1);
  assert.ok(calls.slice(1).every((call) => call.token === 'token'));
});

test('instance ids become fixed-length, non-reversible Transit key names', () => {
  assert.equal(keyNameForInstance('tenant@example.com').length, 71);
  assert.match(keyNameForInstance('tenant@example.com'), /^kalqix-[a-f0-9]{64}$/);
  assert.notEqual(keyNameForInstance('tenant-a'), keyNameForInstance('tenant-b'));
  assert.throws(() => keyNameForInstance(''), /invalid instance_id/);
  assert.throws(() => keyNameForInstance('x'.repeat(129)), /invalid instance_id/);
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
