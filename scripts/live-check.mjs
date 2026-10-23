/**
 * Live environment check for the inkstone stack.
 *
 * Run from the package root: node scripts/live-check.mjs
 *
 * Checks are best-effort: credentials and local services that are not running
 * are reported as SKIP/WARN instead of failing the whole check, so the script
 * works before installation and before the user provides a token.
 */

import fs from 'node:fs';
import path from 'node:path';

const results = [];
let hardFailure = false;

/**
 * Record one check result.
 * @param {'ok' | 'warn' | 'skip' | 'fail'} status
 * @param {string} name
 * @param {string} detail
 */
function record(status, name, detail) {
  results.push({ status, name, detail });
  if (status === 'fail') hardFailure = true;
}

/**
 * Check that every runtime file referenced by the bundle exists.
 */
function checkPackageFiles() {
  const root = process.cwd();
  const required = [
    'package.json',
    'cordis.patch.yml',
    'index.js',
    'locale/zh.json',
    'locale/en.json',
    'icon.svg',
    'lib/tool-kit.mjs',
    'lib/paths.mjs',
    'lib/http.mjs',
    'lib/secrets.mjs',
    'lib/run-store.mjs',
    'lib/pipeline-engine.mjs',
    'lib/pipeline-steps.mjs',
    'lib/trilium-client.mjs',
    'lib/zotero-client.mjs',
    'lib/bib.mjs',
    'lib/typst-runner.mjs',
    'lib/heal.mjs',
    'lib/typst-scaffold.mjs',
    'plugins/trilium-paper/index.js',
    'plugins/zotero-ink/index.js',
    'plugins/typst-brush/index.js',
    'plugins/inkstone-flow/index.js',
  ];
  const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
  if (missing.length > 0) record('fail', 'package files', `missing: ${missing.join(', ')}`);
  else record('ok', 'package files', `${required.length} runtime files present`);
}

/**
 * Trilium ETAPI app-info with the resolved token.
 */
async function checkTrilium() {
  let token;
  try {
    const { triliumToken } = await import('../lib/secrets.mjs');
    token = triliumToken({});
  } catch (error) {
    record('fail', 'trilium token module', String(error));
    return;
  }
  const baseUrl = process.env.TRILIUM_ETAPI_URL || 'http://127.0.0.1:8080';
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/etapi/app-info`, {
      headers: token ? { Authorization: token } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) {
      record('warn', 'trilium ETAPI', `reachable but unauthenticated (${baseUrl}): create an ETAPI token and write it to ~/.dsh-inkstone/trilium-etapi-token.txt`);
      return;
    }
    if (!response.ok) {
      record('warn', 'trilium ETAPI', `HTTP ${response.status}`);
      return;
    }
    const info = await response.json();
    record('ok', 'trilium ETAPI', `appVersion=${info.appVersion ?? '?'} dbVersion=${info.dbVersion ?? '?'}`);
  } catch (error) {
    record('warn', 'trilium ETAPI', `unreachable: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Decode one JSON-RPC response that may arrive as JSON or SSE (`data:` lines).
 * @param {string} text
 * @returns {any | null}
 */
function parseMcpPayload(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return null;
  if (value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data.length === 0) continue;
    try {
      return JSON.parse(data);
    } catch {
      // try the next event
    }
  }
  return null;
}

/**
 * Trilium MCP endpoint (Bearer token): initialize and list tools.
 */
async function checkTriliumMcp() {
  let token;
  try {
    const { triliumToken } = await import('../lib/secrets.mjs');
    token = triliumToken({});
  } catch {
    return;
  }
  if (!token) {
    record('skip', 'trilium MCP', 'no token available');
    return;
  }
  const baseUrl = (process.env.TRILIUM_ETAPI_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  try {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'inkstone-live-check', version: '0.1.0' } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!init.ok) {
      record('warn', 'trilium MCP', `initialize HTTP ${init.status}`);
      return;
    }
    const initPayload = parseMcpPayload(await init.text());
    const sessionId = init.headers.get('mcp-session-id') ?? initPayload?.result?.sessionId;
    const serverName = initPayload?.result?.serverInfo?.name ?? 'unknown server';
    const sessionHeaders = sessionId ? { ...baseHeaders, 'mcp-session-id': sessionId } : baseHeaders;
    if (sessionId) {
      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    }
    const listed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (!listed.ok) {
      record('ok', 'trilium MCP', `initialize ok (${serverName}); tools/list HTTP ${listed.status}`);
      return;
    }
    const listPayload = parseMcpPayload(await listed.text());
    const tools = Array.isArray(listPayload?.result?.tools) ? listPayload.result.tools : [];
    const names = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
    record('ok', 'trilium MCP', `initialize ok (${serverName}); ${names.length} tool(s): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`);
  } catch (error) {
    record('warn', 'trilium MCP', `unreachable: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Zotero local API ping.
 */
async function checkZotero() {
  const base = (process.env.ZOTERO_LOCAL_API_URL || 'http://127.0.0.1:23119').replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/api/users/0/items?limit=1`, {
      headers: { 'Zotero-API-Version': '3' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      record('warn', 'zotero local API', `HTTP ${response.status} — start Zotero and allow local applications in Settings → Advanced`);
      return;
    }
    const data = await response.json();
    record('ok', 'zotero local API', `reachable (${Array.isArray(data) ? data.length : '?'} sample items)`);
  } catch (error) {
    record('warn', 'zotero local API', `unreachable: ${error instanceof Error ? error.message : error} — start Zotero`);
  }
}

/**
 * Typst binary and font probe.
 */
async function checkTypst() {
  try {
    const { probe } = await import('../lib/typst-runner.mjs');
    const info = await probe({});
    record('ok', 'typst', `${info.version ?? '?'} @ ${info.binary} · CJK fonts: ${(info.fonts?.cjkFamilies ?? []).slice(0, 4).join(', ') || 'none detected'}`);
  } catch (error) {
    record('fail', 'typst', error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  checkPackageFiles();
  await checkTrilium();
  await checkTriliumMcp();
  await checkZotero();
  await checkTypst();

  console.log('\ninkstone live environment check\n');
  for (const result of results) {
    const mark = { ok: 'OK  ', warn: 'WARN', skip: 'SKIP', fail: 'FAIL' }[result.status];
    console.log(`[${mark}] ${result.name}: ${result.detail}`);
  }
  console.log('');
  if (hardFailure) {
    console.log('Result: FAIL — fix the failing checks above.');
    process.exit(1);
  }
  console.log('Result: environment is usable for the available integrations.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
