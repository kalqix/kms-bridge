import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function createBridgeHandler(options) {
  let inflight = 0;

  return async function bridgeHandler(request, response) {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const operation = routeOperation(request.method, request.url);

    if (operation === 'health') {
      return send(response, 200, { ok: true });
    }
    if (operation === undefined) {
      return send(response, 404, { error: 'not_found' });
    }
    if (!authorized(request.headers.authorization, options.serviceToken)) {
      return send(response, 401, { error: 'unauthorized' });
    }
    if (!JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '')) {
      return send(response, 415, { error: 'content_type_must_be_application_json' });
    }
    if (inflight >= options.maxInflight) {
      return send(response, 503, { error: 'kms_bridge_busy' });
    }

    inflight += 1;
    let status = 500;
    try {
      const body = await readJsonBody(request, options.bodyLimitBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ClientInputError('request body must be an object');
      }
      const instanceId = validInstanceId(body.instance_id);

      if (operation === 'wrap') {
        const dek = validBase64(body.plaintext_dek_base64, 'plaintext_dek_base64', 32);
        const aad = validBase64(body.aad_base64, 'aad_base64');
        const ciphertext = await options.transit.wrap(instanceId, dek, aad);
        status = 200;
        return send(response, status, { ciphertext_base64: ciphertext });
      }
      if (operation === 'unwrap') {
        if (typeof body.ciphertext_base64 !== 'string' || !body.ciphertext_base64.startsWith('vault:v')) {
          throw new ClientInputError('invalid ciphertext_base64');
        }
        const aad = validBase64(body.aad_base64, 'aad_base64');
        const plaintext = await options.transit.unwrap(
          instanceId,
          body.ciphertext_base64,
          aad,
        );
        status = 200;
        return send(response, status, { plaintext_dek_base64: plaintext });
      }

      const attestation = await options.transit.destroy(instanceId);
      status = 200;
      return send(response, status, attestation);
    } catch (error) {
      if (error instanceof ClientInputError || error instanceof SyntaxError) {
        status = 400;
        return send(response, status, { error: 'invalid_request' });
      }
      if (error?.code === 'BODY_TOO_LARGE') {
        status = 413;
        return send(response, status, { error: 'request_too_large' });
      }
      options.logger?.error?.({
        event: 'kms_bridge_error',
        request_id: requestId,
        operation,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      status = 502;
      return send(response, status, { error: 'kms_backend_failure' });
    } finally {
      inflight -= 1;
      options.logger?.info?.({
        event: 'kms_bridge_request',
        request_id: requestId,
        operation,
        status,
        duration_ms: Number((performance.now() - startedAt).toFixed(3)),
      });
    }
  };
}

class ClientInputError extends Error {}

function routeOperation(method, url) {
  const path = new URL(url ?? '/', 'https://kms.invalid').pathname;
  if (method === 'GET' && path === '/health') return 'health';
  if (method !== 'POST') return undefined;
  if (path === '/wrap') return 'wrap';
  if (path === '/unwrap') return 'unwrap';
  if (path === '/destroy') return 'destroy';
  return undefined;
}

function authorized(header, expectedToken) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  const actualDigest = createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

async function readJsonBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validInstanceId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new ClientInputError('invalid instance_id');
  }
  return value;
}

function validBase64(value, field, decodedLength) {
  if (typeof value !== 'string' || value === '' || !BASE64.test(value)) {
    throw new ClientInputError(`invalid ${field}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decodedLength !== undefined && decoded.length !== decodedLength) {
    decoded.fill(0);
    throw new ClientInputError(`invalid ${field}`);
  }
  decoded.fill(0);
  return value;
}

function send(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': encoded.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(encoded);
}
