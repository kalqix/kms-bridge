import { isIP } from 'node:net';

const SAFE_MOUNT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function readConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'production';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('invalid configuration: NODE_ENV');
  }

  const config = {
    nodeEnv,
    host: required(env, 'KMS_BRIDGE_HOST'),
    port: integer(env, 'KMS_BRIDGE_PORT', 9445, 1, 65_535),
    serviceToken: readSecret(env, 'service-token', 'KMS_BRIDGE_SERVICE_TOKEN_FILE', 32),
    tlsCertPath: required(env, 'KMS_BRIDGE_TLS_CERT_PATH'),
    tlsKeyPath: required(env, 'KMS_BRIDGE_TLS_KEY_PATH'),
    openBaoUrl: url(env, 'KMS_BRIDGE_OPENBAO_URL'),
    openBaoMount: env.KMS_BRIDGE_OPENBAO_MOUNT ?? 'kalqix-transit',
    openBaoRoleId: readSecret(env, 'openbao-role-id', 'KMS_BRIDGE_OPENBAO_ROLE_ID_FILE', 1),
    openBaoSecretId: readSecret(
      env,
      'openbao-secret-id',
      'KMS_BRIDGE_OPENBAO_SECRET_ID_FILE',
      16,
    ),
    requestTimeoutMs: integer(env, 'KMS_BRIDGE_REQUEST_TIMEOUT_MS', 5_000, 250, 30_000),
    bodyLimitBytes: integer(env, 'KMS_BRIDGE_BODY_LIMIT_BYTES', 8_192, 1_024, 65_536),
    maxInflight: integer(env, 'KMS_BRIDGE_MAX_INFLIGHT', 16, 1, 256),
  };

  if (!SAFE_MOUNT.test(config.openBaoMount)) {
    throw new Error('invalid configuration: KMS_BRIDGE_OPENBAO_MOUNT');
  }
  if (config.nodeEnv === 'production' && config.openBaoUrl.protocol !== 'https:') {
    throw new Error('invalid configuration: KMS_BRIDGE_OPENBAO_URL must use https');
  }
  if (config.nodeEnv === 'production' && config.host === '0.0.0.0') {
    throw new Error('invalid configuration: bind the bridge to its VPC address, not all interfaces');
  }
  if (isIP(config.host) === 0 && config.host !== 'localhost') {
    throw new Error('invalid configuration: KMS_BRIDGE_HOST');
  }
  return Object.freeze(config);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`invalid configuration: ${name}`);
  return value;
}

function url(env, name) {
  const value = required(env, name);
  try {
    return new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new Error(`invalid configuration: ${name}`);
  }
}

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid configuration: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`invalid configuration: ${name}`);
  }
  return value;
}

function readSecret(env, credentialName, explicitFileVariable, minimumLength) {
  const explicitPath = env[explicitFileVariable]?.trim();
  const credentialsDirectory = env.CREDENTIALS_DIRECTORY?.trim();
  const path = explicitPath || (credentialsDirectory ? `${credentialsDirectory}/${credentialName}` : '');
  if (!path) throw new Error(`invalid configuration: ${explicitFileVariable}`);

  let value;
  try {
    value = process.getBuiltinModule('node:fs').readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`invalid configuration: ${explicitFileVariable}`);
  }
  if (Buffer.byteLength(value, 'utf8') < minimumLength) {
    throw new Error(`invalid configuration: ${explicitFileVariable}`);
  }
  return value;
}
