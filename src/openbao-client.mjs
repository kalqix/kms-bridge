import { createHash, randomUUID } from 'node:crypto';

export class OpenBaoHttpError extends Error {
  constructor(status, operation) {
    super(`OpenBao ${operation} failed with HTTP ${status}`);
    this.name = 'OpenBaoHttpError';
    this.status = status;
  }
}

export class OpenBaoTransitClient {
  #token;
  #tokenExpiresAt = 0;
  #loginPromise;
  #instanceOperations = new Map();

  constructor(options) {
    this.baseUrl = new URL(options.baseUrl);
    this.mount = options.mount;
    this.roleId = options.roleId;
    this.secretId = options.secretId;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async wrap(instanceId, plaintextDekBase64, aadBase64) {
    return this.#withInstanceLock(instanceId, async (keyName) => {
      await this.#ensureKey(keyName);
      const response = await this.#request('POST', `${this.mount}/encrypt/${keyName}`, {
        plaintext: plaintextDekBase64,
        associated_data: aadBase64,
      });
      const ciphertext = response.data?.ciphertext;
      if (typeof ciphertext !== 'string' || !ciphertext.startsWith('vault:v')) {
        throw new Error('OpenBao encrypt returned an invalid ciphertext');
      }
      return ciphertext;
    });
  }

  async unwrap(instanceId, ciphertext, aadBase64) {
    return this.#withInstanceLock(instanceId, async (keyName) => {
      const response = await this.#request('POST', `${this.mount}/decrypt/${keyName}`, {
        ciphertext,
        associated_data: aadBase64,
      });
      const plaintext = response.data?.plaintext;
      if (typeof plaintext !== 'string') {
        throw new Error('OpenBao decrypt returned invalid plaintext');
      }
      const decoded = Buffer.from(plaintext, 'base64');
      const validLength = decoded.length === 32;
      decoded.fill(0);
      if (validLength) return plaintext;
      throw new Error('OpenBao decrypt returned an invalid DEK');
    });
  }

  async destroy(instanceId) {
    return this.#withInstanceLock(instanceId, async (keyName) => {
      try {
        await this.#request('DELETE', `${this.mount}/keys/${keyName}`);
      } catch (error) {
        if (!(error instanceof OpenBaoHttpError) || error.status !== 404) throw error;
      }

      try {
        await this.#request('GET', `${this.mount}/keys/${keyName}`);
      } catch (error) {
        if (error instanceof OpenBaoHttpError && error.status === 404) {
          return {
            verified: true,
            attestation_id: `openbao-live-key-deleted:${keyName}:${this.now()}:${randomUUID()}`,
          };
        }
        throw error;
      }
      throw new Error('OpenBao key deletion was not verified');
    });
  }

  async health() {
    const response = await this.#rawRequest('GET', 'sys/health?standbyok=true&perfstandbyok=true', undefined, false);
    return response.status >= 200 && response.status < 300;
  }

  async #ensureKey(keyName) {
    try {
      const existing = await this.#request('GET', `${this.mount}/keys/${keyName}`);
      assertSafeKey(existing.data);
      if (existing.data.deletion_allowed !== true) {
        await this.#request('POST', `${this.mount}/keys/${keyName}/config`, {
          deletion_allowed: true,
        });
        const updated = await this.#request('GET', `${this.mount}/keys/${keyName}`);
        assertSafeKey(updated.data, true);
      }
      return;
    } catch (error) {
      if (!(error instanceof OpenBaoHttpError) || error.status !== 404) throw error;
    }

    await this.#request('POST', `${this.mount}/keys/${keyName}`, {
      type: 'aes256-gcm96',
      derived: false,
      exportable: false,
      allow_plaintext_backup: false,
    });
    await this.#request('POST', `${this.mount}/keys/${keyName}/config`, {
      deletion_allowed: true,
    });
    const created = await this.#request('GET', `${this.mount}/keys/${keyName}`);
    assertSafeKey(created.data, true);
  }

  async #withInstanceLock(instanceId, operation) {
    const keyName = keyNameForInstance(instanceId);
    const previous = this.#instanceOperations.get(keyName) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => operation(keyName));
    this.#instanceOperations.set(keyName, current);
    try {
      return await current;
    } finally {
      if (this.#instanceOperations.get(keyName) === current) {
        this.#instanceOperations.delete(keyName);
      }
    }
  }

  async #request(method, path, body) {
    let token = await this.#getToken();
    let response = await this.#rawRequest(method, path, body, true, token);
    if (response.status === 403) {
      this.#token = undefined;
      this.#tokenExpiresAt = 0;
      token = await this.#getToken();
      response = await this.#rawRequest(method, path, body, true, token);
    }
    if (!response.ok) throw new OpenBaoHttpError(response.status, `${method} ${path}`);
    if (response.status === 204) return {};
    return parseJsonResponse(response, `OpenBao ${method} ${path}`);
  }

  async #getToken() {
    if (this.#token && this.now() < this.#tokenExpiresAt) return this.#token;
    if (this.#loginPromise) return this.#loginPromise;

    this.#loginPromise = (async () => {
      const response = await this.#rawRequest('POST', 'auth/approle/login', {
        role_id: this.roleId,
        secret_id: this.secretId,
      });
      if (!response.ok) throw new OpenBaoHttpError(response.status, 'AppRole login');
      const payload = await parseJsonResponse(response, 'OpenBao AppRole login');
      const token = payload.auth?.client_token;
      const leaseSeconds = payload.auth?.lease_duration;
      if (typeof token !== 'string' || token === '' || !Number.isFinite(leaseSeconds)) {
        throw new Error('OpenBao AppRole login returned an invalid token');
      }
      this.#token = token;
      this.#tokenExpiresAt = this.now() + Math.max(1, leaseSeconds - 30) * 1_000;
      return token;
    })();

    try {
      return await this.#loginPromise;
    } finally {
      this.#loginPromise = undefined;
    }
  }

  async #rawRequest(method, path, body, authenticated = false, token) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authenticated) headers['x-vault-token'] = token;
    try {
      return await this.fetchImpl(new URL(`v1/${path}`, this.baseUrl), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error('OpenBao request failed');
    }
  }
}

export function keyNameForInstance(instanceId) {
  if (typeof instanceId !== 'string' || instanceId.length < 1 || instanceId.length > 128) {
    throw new Error('invalid instance_id');
  }
  return `kalqix-${createHash('sha256').update(instanceId, 'utf8').digest('hex')}`;
}

function assertSafeKey(data, deletionRequired = false) {
  if (
    !data ||
    data.type !== 'aes256-gcm96' ||
    data.derived !== false ||
    data.exportable !== false ||
    data.allow_plaintext_backup !== false ||
    (deletionRequired && data.deletion_allowed !== true)
  ) {
    throw new Error('OpenBao Transit key has unsafe configuration');
  }
}

async function parseJsonResponse(response, operation) {
  try {
    const parsed = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}
