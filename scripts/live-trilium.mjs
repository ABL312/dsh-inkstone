#!/usr/bin/env node
/**
 * Optional live Trilium smoke check.
 *
 * Resolves the ETAPI token through `lib/secrets.mjs` (config -> environment ->
 * `~/.dsh-inkstone/trilium-etapi-token.txt`), then calls `GET /etapi/app-info`
 * and `GET /etapi/notes?search=...` against the running instance.
 *
 * Usage:  node scripts/live-trilium.mjs
 *   - no token resolvable            -> prints SKIP, exit 0
 *   - token present but no instance  -> prints FAIL with the actionable error, exit 1
 *   - instance reachable             -> prints PASS lines, exit 0
 *
 * @module dsh-inkstone/scripts/live-trilium
 */

import path from 'node:path';

import { createTriliumClient } from '../lib/trilium-client.mjs';
import { SECRETS_DIR, TRILIUM_TOKEN_FILE, triliumToken } from '../lib/secrets.mjs';

const token = triliumToken();
if (!token) {
  console.log(
    'SKIP live Trilium check: no ETAPI token found. Create one in Trilium Options → ETAPI, then ' +
      `export TRILIUM_ETAPI_TOKEN or write it to ${path.join(SECRETS_DIR, TRILIUM_TOKEN_FILE)}.`,
  );
  process.exit(0);
}

const baseUrl = process.env.TRILIUM_ETAPI_URL || 'http://127.0.0.1:8080';
const client = createTriliumClient({ baseUrl, token, timeoutMs: 8000 });

const health = await client.health();
if (!health.connected) {
  console.error(`FAIL live Trilium check at ${baseUrl}: ${health.error}`);
  process.exit(1);
}

console.log(`PASS live Trilium health: ${baseUrl} (Trilium ${health.version})`);

try {
  const info = await client.appInfo();
  console.log(
    `PASS live app-info: appVersion=${info.appVersion} dbVersion=${info.dbVersion} syncVersion=${info.syncVersion}`,
  );
  const results = await client.search({ query: 'inkstone', limit: 5 });
  console.log(`PASS live search: ${results.length} note(s) matched "inkstone"`);
  for (const note of results) console.log(`  - ${note.noteId} | ${note.title} | ${note.dateModified}`);
  process.exit(0);
} catch (error) {
  console.error(`FAIL live Trilium smoke check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
