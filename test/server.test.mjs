import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createBridgeHandler } from '../src/server.mjs';

const SERVICE_TOKEN = 't'.repeat(48);

test('HTTP contract matches the signer wrapper and fails closed', async (context) => {
  const operations = [];
  const transit = {
    async wrap(instanceId, dek, aad) {
      operations.push(['wrap', instanceId, dek, aad]);
      return 'vault:v1:wrapped';
    },
    async unwrap(instanceId, ciphertext, aad) {
      operations.push(['unwrap', instanceId, ciphertext, aad]);
      return Buffer.alloc(32, 9).toString('base64');
    },
    async destroy(instanceId) {
      operations.push(['destroy', instanceId]);
      return { verified: true, attestation_id: 'attestation-1' };
    },
  };
  const server = createServer(
    createBridgeHandler({
      transit,
      serviceToken: SERVICE_TOKEN,
      bodyLimitBytes: 8_192,
      maxInflight: 4,
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const dek = Buffer.alloc(32, 9).toString('base64');
  const aad = Buffer.from('instance aad').toString('base64');

  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await request(baseUrl, '/wrap', {}, 'wrong')).status, 401);
  assert.equal(
    (
      await fetch(`${baseUrl}/wrap`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
        body: '{}',
      })
    ).status,
    415,
  );

  const wrapped = await request(baseUrl, '/wrap', {
    instance_id: 'instance-1',
    plaintext_dek_base64: dek,
    aad_base64: aad,
  });
  assert.equal(wrapped.status, 200);
  assert.deepEqual(await wrapped.json(), { ciphertext_base64: 'vault:v1:wrapped' });

  const unwrapped = await request(baseUrl, '/unwrap', {
    instance_id: 'instance-1',
    ciphertext_base64: 'vault:v1:wrapped',
    aad_base64: aad,
  });
  assert.equal(unwrapped.status, 200);
  assert.deepEqual(await unwrapped.json(), { plaintext_dek_base64: dek });

  const destroyed = await request(baseUrl, '/destroy', { instance_id: 'instance-1' });
  assert.equal(destroyed.status, 200);
  assert.deepEqual(await destroyed.json(), {
    verified: true,
    attestation_id: 'attestation-1',
  });
  assert.deepEqual(operations.map((entry) => entry[0]), ['wrap', 'unwrap', 'destroy']);
});

test('rejects malformed and oversized payloads before reaching Transit', async (context) => {
  const transit = {
    wrap() {
      throw new Error('must not be reached');
    },
  };
  const server = createServer(
    createBridgeHandler({ transit, serviceToken: SERVICE_TOKEN, bodyLimitBytes: 1_024, maxInflight: 1 }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const invalid = await request(baseUrl, '/wrap', null);
  assert.equal(invalid.status, 400);
  const oversized = await request(baseUrl, '/wrap', { padding: 'x'.repeat(2_000) });
  assert.equal(oversized.status, 413);
});

function request(baseUrl, path, body, token = SERVICE_TOKEN) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
