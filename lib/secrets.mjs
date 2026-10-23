/**
 * Credential resolution shared by the inkstone plugins.
 *
 * DSH Host plugins run inside a long-lived process whose environment is fixed
 * at launch, so a token exported in a later shell session is not visible to the
 * running host. Each secret therefore resolves in this order:
 *
 *   1. explicit plugin config value (never committed by this project)
 *   2. environment variable (works when DSH was launched with it)
 *   3. a local secret file under `~/.dsh-inkstone/` (read at call time)
 *
 * Secret files are plain text, first line = secret, no trailing newline needed.
 *
 * @module dsh-inkstone/lib/secrets
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directory holding local secret files. */
export const SECRETS_DIR = path.join(os.homedir(), '.dsh-inkstone');

/** File name of the Trilium ETAPI token. */
export const TRILIUM_TOKEN_FILE = 'trilium-etapi-token.txt';

/** File name of the optional Zotero Web API key. */
export const ZOTERO_KEY_FILE = 'zotero-api-key.txt';

/**
 * Read the first non-empty line of a secret file.
 * @param {string} file
 * @returns {string | undefined}
 */
export function readSecretFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0);
    return line;
  } catch {
    return undefined;
  }
}

/**
 * Resolve one secret from config, environment, or the local secret directory.
 * @param {object} options
 * @param {Record<string, any>} [options.config] plugin config
 * @param {string} [options.configKey] direct config key holding the secret
 * @param {string} options.envName environment variable name
 * @param {string} options.fileName file name inside `~/.dsh-inkstone/`
 * @param {string} [options.explicitFile] config key holding a custom secret file path
 * @returns {string | undefined}
 */
export function resolveSecret({ config = {}, configKey, envName, fileName, explicitFile }) {
  if (configKey) {
    const direct = config?.[configKey];
    if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  }
  if (explicitFile && typeof config?.[explicitFile] === 'string' && config[explicitFile].length > 0) {
    const value = readSecretFile(config[explicitFile]);
    if (value) return value;
  }
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return readSecretFile(path.join(SECRETS_DIR, fileName));
}

/**
 * Resolve the Trilium ETAPI token.
 * @param {Record<string, any>} [config]
 * @returns {string | undefined}
 */
export function triliumToken(config = {}) {
  return resolveSecret({
    config,
    configKey: 'token',
    envName: typeof config.tokenEnv === 'string' && config.tokenEnv.length > 0 ? config.tokenEnv : 'TRILIUM_ETAPI_TOKEN',
    fileName: TRILIUM_TOKEN_FILE,
    explicitFile: 'tokenFile',
  });
}

/**
 * Resolve the optional Zotero Web API key.
 * @param {Record<string, any>} [config]
 * @returns {string | undefined}
 */
export function zoteroApiKey(config = {}) {
  return resolveSecret({
    config,
    configKey: 'apiKey',
    envName: 'ZOTERO_API_KEY',
    fileName: ZOTERO_KEY_FILE,
    explicitFile: 'apiKeyFile',
  });
}

/**
 * Model-facing instructions for a missing secret.
 * @param {'trilium' | 'zotero'} kind
 * @returns {string}
 */
export function secretHint(kind) {
  if (kind === 'trilium') {
    return [
      'Trilium ETAPI token is not available.',
      'Create one in Trilium: Options → ETAPI → Create new token.',
      `Then either export TRILIUM_ETAPI_TOKEN before launching DeepSeek Harness, or write the token to ${path.join(SECRETS_DIR, TRILIUM_TOKEN_FILE)} (first line only).`,
    ].join(' ');
  }
  return [
    'Zotero Web API key is not available.',
    `Set ZOTERO_API_KEY, or write the key to ${path.join(SECRETS_DIR, ZOTERO_KEY_FILE)}.`,
  ].join(' ');
}
