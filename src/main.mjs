import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { readConfig } from './config.mjs';
import { OpenBaoTransitClient } from './openbao-client.mjs';
import { createBridgeHandler } from './server.mjs';

const config = readConfig();
const logger = {
  info: (entry) => console.log(JSON.stringify({ level: 'info', ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: 'error', ...entry })),
};

const transit = new OpenBaoTransitClient({
  baseUrl: config.openBaoUrl,
  mount: config.openBaoMount,
  roleId: config.openBaoRoleId,
  secretId: config.openBaoSecretId,
  timeoutMs: config.requestTimeoutMs,
});

const [key, cert] = await Promise.all([
  readFile(config.tlsKeyPath),
  readFile(config.tlsCertPath),
]);

const server = createServer(
  {
    key,
    cert,
    minVersion: 'TLSv1.3',
    requestCert: false,
  },
  createBridgeHandler({
    transit,
    serviceToken: config.serviceToken,
    bodyLimitBytes: config.bodyLimitBytes,
    maxInflight: config.maxInflight,
    logger,
  }),
);

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, config.host, resolve);
});

logger.info({
  event: 'kms_bridge_listening',
  host: config.host,
  port: config.port,
  openbao_mount: config.openBaoMount,
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    logger.info({ event: 'kms_bridge_shutdown', signal });
    server.closeIdleConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
