/**
 * Trilium integration tests — no DSH runtime required.
 *
 * Runs the real ETAPI client and the real `trilium-paper` plugin registrations
 * against an in-process mock ETAPI server (`fixtures/trilium/mock-etapi.mjs`),
 * then validates every tool output against its declared JSON schema.
 *
 * Run with:  node scripts/test-trilium.mjs
 * Exit code: 0 = all tests passed, 1 = at least one failure.
 *
 * A live Trilium smoke check runs only when a token is resolvable through
 * `lib/secrets.mjs` (TRILIUM_ETAPI_TOKEN or ~/.dsh-inkstone/trilium-etapi-token.txt);
 * otherwise it prints SKIP and does not affect the exit code.
 *
 * @module dsh-inkstone/scripts/test-trilium
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTriliumClient, MISSING_TOKEN_MESSAGE } from '../lib/trilium-client.mjs';
import { SECRETS_DIR, TRILIUM_TOKEN_FILE, triliumToken } from '../lib/secrets.mjs';
import { apply, inject, name as pluginName } from '../plugins/trilium-paper/index.js';
import { looksLikeMarkdown, markdownToHtml } from '../plugins/trilium-paper/markdown.mjs';
import { startMockEtapi } from '../fixtures/trilium/mock-etapi.mjs';

/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                           */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

/**
 * Run one asynchronous test.
 * @param {string} title
 * @param {() => Promise<void> | void} body
 */
async function test(title, body) {
  try {
    await body();
    passed += 1;
    console.log(`PASS ${title}`);
  } catch (error) {
    failed += 1;
    failures.push({ title, error });
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`FAIL ${title}`);
    console.log(`     ${message}`);
  }
}

/**
 * Record a skipped check.
 * @param {string} title
 * @param {string} reason
 */
function skip(title, reason) {
  skipped += 1;
  console.log(`SKIP ${title} — ${reason}`);
}

/**
 * Assert that an async function rejects with a message matching a pattern.
 * @param {() => Promise<any>} fn
 * @param {RegExp | string} pattern
 * @param {string} label
 */
async function assertRejects(fn, pattern, label) {
  let thrown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${label}: expected the call to reject`);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (pattern instanceof RegExp) {
    assert.ok(pattern.test(message), `${label}: error "${message}" does not match ${pattern}`);
  } else if (typeof pattern === 'string') {
    assert.ok(message.includes(pattern), `${label}: error "${message}" does not include "${pattern}"`);
  }
  return thrown;
}

/* -------------------------------------------------------------------------- */
/* JSON-Schema subset validation (mirrors the Harness-enforced subset)         */
/* -------------------------------------------------------------------------- */

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Assert a schema stays inside the supported JSON-Schema subset.
 * @param {any} schema
 * @param {string} at
 */
function assertSupportedSchema(schema, at) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${at}: must be a schema object`);
  for (const keyword of Object.keys(schema)) {
    assert.ok(ALLOWED_SCHEMA_KEYWORDS.has(keyword), `${at}: unsupported schema keyword "${keyword}"`);
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  assert.ok(!(hasType && hasOneOf), `${at}: cannot declare both type and oneOf`);
  assert.ok(hasType || hasOneOf, `${at}: must declare type or oneOf`);
  if (!hasType) return;
  assert.ok(typeof schema.type === 'string' && SCHEMA_TYPES.has(schema.type), `${at}: type must be a single supported type`);
  const type = schema.type;
  if (type === 'object') {
    if (Object.hasOwn(schema, 'properties')) {
      assert.ok(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), `${at}.properties must be an object`);
      for (const [key, child] of Object.entries(schema.properties)) assertSupportedSchema(child, `${at}.properties.${key}`);
    }
    if (Object.hasOwn(schema, 'required')) {
      assert.ok(Array.isArray(schema.required), `${at}.required must be an array`);
      for (const key of schema.required) {
        assert.ok(schema.properties && Object.hasOwn(schema.properties, key), `${at}.required names "${key}" which is not declared`);
      }
    }
    if (Object.hasOwn(schema, 'additionalProperties')) {
      assert.equal(typeof schema.additionalProperties, 'boolean', `${at}.additionalProperties must be a boolean`);
    }
  } else if (type === 'array') {
    assert.ok(Object.hasOwn(schema, 'items'), `${at}: array schemas must declare items`);
    assertSupportedSchema(schema.items, `${at}.items`);
    for (const forbidden of ['properties', 'required', 'additionalProperties']) {
      assert.ok(!Object.hasOwn(schema, forbidden), `${at}.${forbidden} is only supported on object schemas`);
    }
  } else {
    for (const forbidden of ['properties', 'required', 'additionalProperties', 'items']) {
      assert.ok(!Object.hasOwn(schema, forbidden), `${at}.${forbidden} is only supported on object/array schemas`);
    }
    if (Object.hasOwn(schema, 'enum')) {
      assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, `${at}.enum must be a non-empty array`);
    }
  }
}

/**
 * Validate a value against a schema from the supported subset.
 * @param {any} schema
 * @param {any} value
 * @param {string} [at]
 * @returns {string[]} violations
 */
function validateValue(schema, value, at = 'value') {
  const violations = [];
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((branch) => validateValue(branch, value, at).length === 0).length;
    if (matches !== 1) violations.push(`${at}: must match exactly one oneOf branch (matched ${matches})`);
    return violations;
  }
  const type = schema.type;
  const typeOk =
    type === 'object'
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'array'
        ? Array.isArray(value)
        : type === 'integer'
          ? Number.isInteger(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : type === 'string'
              ? typeof value === 'string'
              : type === 'boolean'
                ? typeof value === 'boolean'
                : type === 'null'
                  ? value === null
                  : true;
  if (!typeOk) {
    violations.push(`${at}: expected ${type}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
    return violations;
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`${at}.${key}: missing required property`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) violations.push(...validateValue(child, value[key], `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${at}.${key}: not declared (additionalProperties: false)`);
      }
    }
  } else if (type === 'array') {
    if (Object.hasOwn(schema, 'items')) {
      value.forEach((entry, index) => violations.push(...validateValue(schema.items, entry, `${at}[${index}]`)));
    }
  } else {
    if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(value)) {
      violations.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
    }
    if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  return violations;
}

/* -------------------------------------------------------------------------- */
/* Fake Cordis context                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Create a fake `ctx` that records registered tools.
 * @returns {{ctx: any, tools: Map<string, any>}}
 */
function createFakeCtx() {
  /** @type {Map<string, any>} */
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(definition && typeof definition.name === 'string' && definition.name.length > 0, 'registered tool must have a name');
        assert.ok(!tools.has(definition.name), `duplicate tool registration: ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  return { ctx, tools };
}

/**
 * Apply the plugin and return its registered tools.
 * @param {Record<string, any>} config
 * @returns {Map<string, any>}
 */
function applyPlugin(config) {
  const { ctx, tools } = createFakeCtx();
  apply(ctx, config);
  return tools;
}

/**
 * Fake tool execution context carrying a session working directory.
 * @param {string} cwd
 * @returns {any}
 */
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

/**
 * Validate a tool output against both the declared schema and its renderer.
 * @param {any} tool
 * @param {any} value
 */
function assertToolOutput(tool, value) {
  const violations = validateValue(tool.output.schema, value);
  assert.deepEqual(violations, [], `${tool.name} output violates its schema: ${violations.join('; ')}`);
  const blocks = tool.output.render({}, structuredClone(value));
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name} render must return at least one block`);
  for (const block of blocks) {
    assert.equal(block.type, 'text', `${tool.name} render block type must be text`);
    assert.equal(typeof block.text, 'string', `${tool.name} render block text must be a string`);
  }
  const text = blocks.map((block) => block.text).join('\n');
  assert.ok(text.length > 0, `${tool.name} render must produce text`);
  assert.ok(text.length <= 31000, `${tool.name} render output should stay bounded (got ${text.length} chars)`);
}

/**
 * Latest recorded mock request matching a predicate.
 * @param {object[]} requests
 * @param {(request: any) => boolean} predicate
 * @returns {any | undefined}
 */
function findLastRequest(requests, predicate) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    if (predicate(requests[index])) return requests[index];
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Test run                                                                    */
/* -------------------------------------------------------------------------- */

async function main() {
  const mock = await startMockEtapi({ tokens: ['test-token', 'env-token', 'file-token'] });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inkstone-trilium-test-'));
  const exec = makeExec(tempRoot);
  const baseConfig = {
    baseUrl: mock.baseUrl,
    token: 'test-token',
    allowWrites: true,
    advancedTools: false,
    timeoutMs: 15000,
  };

  try {
    const tools = applyPlugin(baseConfig);
    const advancedTools = applyPlugin({ ...baseConfig, advancedTools: true });
    const readOnlyTools = applyPlugin({ ...baseConfig, allowWrites: false });
    const readOnlyAdvancedTools = applyPlugin({ ...baseConfig, allowWrites: false, advancedTools: true });

    /* ---------------------------------------------------------------- */
    /* Plugin metadata and tool definitions                              */
    /* ---------------------------------------------------------------- */

    await test('plugin exports name, inject and apply', () => {
      assert.equal(pluginName, 'trilium-paper');
      assert.deepEqual(inject, ['tools']);
      assert.equal(typeof apply, 'function');
    });

    await test('default registration exposes the five task tools', () => {
      assert.deepEqual([...tools.keys()], ['trilium_search', 'trilium_read', 'trilium_write', 'trilium_attach', 'trilium_history']);
    });

    await test('advancedTools adds trilium_attributes and trilium_delete', () => {
      assert.deepEqual(
        [...advancedTools.keys()],
        ['trilium_search', 'trilium_read', 'trilium_write', 'trilium_attach', 'trilium_history', 'trilium_attributes', 'trilium_delete'],
      );
      assert.equal(advancedTools.size, 7);
    });

    await test('every tool declares descriptions, supported schemas, render and timeout', () => {
      for (const tool of advancedTools.values()) {
        assert.equal(typeof tool.name, 'string');
        assert.ok(tool.description.length > 20, `${tool.name}: description too short`);
        assertSupportedSchema(tool.parameters, `${tool.name}.parameters`);
        assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`);
        assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render is required`);
        assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `${tool.name}: timeoutMs must be positive`);
      }
    });

    await test('parameter schemas require only declared properties and reject extras', () => {
      for (const tool of advancedTools.values()) {
        assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters must be object-rooted`);
        assert.equal(tool.parameters.additionalProperties, false, `${tool.name}: parameters should reject unknown keys`);
      }
    });

    /* ---------------------------------------------------------------- */
    /* ETAPI client                                                      */
    /* ---------------------------------------------------------------- */

    await test('client throws the CONTRACT token error when no token is configured', async () => {
      const client = createTriliumClient({ baseUrl: mock.baseUrl, token: '' });
      await assertRejects(() => client.appInfo(), /TRILIUM_ETAPI_TOKEN is not set/, 'appInfo');
      const error = await assertRejects(() => client.search({ query: 'x' }), '', 'search');
      assert.equal(error.message, MISSING_TOKEN_MESSAGE);
      await assertRejects(() => client.getNote('noteAlpha'), /Options → ETAPI/, 'getNote');
      const health = await client.health();
      assert.equal(health.connected, false);
      assert.equal(health.error, MISSING_TOKEN_MESSAGE);
    });

    const client = createTriliumClient({ baseUrl: mock.baseUrl, token: 'test-token', timeoutMs: 5000 });

    await test('client sends the raw ETAPI token (no Bearer prefix)', async () => {
      await client.appInfo();
      const request = findLastRequest(mock.requests, (item) => item.path === '/etapi/app-info');
      assert.ok(request, 'app-info request was recorded');
      assert.equal(request.headers.authorization, 'test-token');
      assert.ok(!/^Bearer /i.test(request.headers.authorization), 'ETAPI must not use a Bearer prefix');
    });

    await test('appInfo returns version fields and utcDate', async () => {
      const info = await client.appInfo();
      assert.equal(info.appVersion, '0.106.0');
      assert.equal(info.dbVersion, 233);
      assert.equal(info.syncVersion, 38);
      assert.equal(info.utcDate, '2026-10-23T13:49:00.000Z');
    });

    await test('search passes query parameters and unwraps results', async () => {
      const results = await client.search({
        query: 'Paper',
        ancestorNoteId: 'parentNote1',
        limit: 5,
        orderBy: 'dateModified',
        orderDirection: 'asc',
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].noteId, 'noteAlpha');
      assert.deepEqual(Object.keys(results[0]).sort(), ['dateCreated', 'dateModified', 'labels', 'noteId', 'parentNoteIds', 'title', 'type']);
      const request = findLastRequest(mock.requests, (item) => item.path === '/etapi/notes');
      assert.deepEqual(request.query, {
        search: 'Paper',
        ancestorNoteId: 'parentNote1',
        limit: '5',
        orderBy: 'dateModified',
        orderDirection: 'asc',
      });
    });

    await test('getNote returns inline attributes and child ids', async () => {
      const note = await client.getNote('noteAlpha');
      assert.equal(note.title, 'Paper Draft');
      assert.equal(note.attributes.length, 2);
      assert.ok(Array.isArray(note.childNoteIds));
      assert.deepEqual(note.parentNoteIds, ['parentNote1']);
    });

    await test('getContent returns the note HTML', async () => {
      const content = await client.getContent('noteAlpha');
      assert.ok(content.includes('Draft body with'));
    });

    await test('getPath walks parentNoteIds up to the root', async () => {
      const result = await client.getPath('noteAlpha');
      assert.deepEqual(result, { noteId: 'noteAlpha', title: 'Paper Draft', path: ['root', 'Inkstone 项目', 'Paper Draft'] });
    });

    await test('getChildren uses inline childNoteIds because 0.106.0 has no children route', async () => {
      const children = await client.getChildren('parentNote1');
      assert.ok(children.some((child) => child.noteId === 'noteAlpha'), 'noteAlpha is a child of parentNote1');
      const request = findLastRequest(mock.requests, (item) => item.path === '/etapi/notes/parentNote1/children');
      assert.equal(request, undefined, 'the unavailable children route must not be called');
    });

    await test('getAttributes reads the inline note attributes', async () => {
      const attributes = await client.getAttributes('noteAlpha');
      assert.equal(attributes.length, 2);
      assert.equal(attributes[0].name, 'inkstone/status');
      assert.equal(attributes[1].type, 'relation');
    });

    await test('setAttribute creates a label through POST /attributes', async () => {
      const attribute = await client.setAttribute({
        noteId: 'noteAlpha',
        type: 'label',
        name: 'inkstone/reviewed',
        value: 'yes',
      });
      assert.equal(attribute.attributeId, 'attr1');
      const request = findLastRequest(mock.requests, (item) => item.method === 'POST' && item.path === '/etapi/attributes');
      assert.deepEqual(request.json, {
        noteId: 'noteAlpha',
        type: 'label',
        name: 'inkstone/reviewed',
        value: 'yes',
        isInheritable: false,
      });
    });

    await test('getAttribute and deleteAttribute round-trip and 404 afterwards', async () => {
      const attribute = await client.getAttribute('attr1');
      assert.equal(attribute.name, 'inkstone/reviewed');
      const deleted = await client.deleteAttribute('attr1');
      assert.deepEqual(deleted, { attributeId: 'attr1', deleted: true });
      await assertRejects(() => client.getAttribute('attr1'), /HTTP 404/, 'deleted attribute lookup');
    });

    let clientCreatedNoteId = '';
    await test('createNote returns the created note with noteId and branch', async () => {
      const created = await client.createNote({
        parentNoteId: 'parentNote1',
        title: 'Client Created',
        type: 'text',
        content: '<p>client created</p>',
      });
      assert.equal(created.noteId, 'createdNote1');
      assert.equal(created.title, 'Client Created');
      assert.ok(created.branch && created.branch.parentNoteId === 'parentNote1');
      clientCreatedNoteId = created.noteId;
      const request = findLastRequest(mock.requests, (item) => item.method === 'POST' && item.path === '/etapi/create-note');
      assert.deepEqual(request.json, {
        parentNoteId: 'parentNote1',
        title: 'Client Created',
        type: 'text',
        content: '<p>client created</p>',
      });
    });

    await test('updateNote patches a note title', async () => {
      const updated = await client.updateNote(clientCreatedNoteId, { title: 'Client Renamed' });
      assert.equal(updated.title, 'Client Renamed');
      const request = findLastRequest(
        mock.requests,
        (item) => item.method === 'PATCH' && item.path === `/etapi/notes/${clientCreatedNoteId}`,
      );
      assert.deepEqual(request.json, { title: 'Client Renamed' });
    });

    await test('setContent puts a plain-text body into the note', async () => {
      const result = await client.setContent(clientCreatedNoteId, '<p>updated by client</p>');
      assert.deepEqual(result, { noteId: clientCreatedNoteId, updated: true });
      const request = findLastRequest(
        mock.requests,
        (item) => item.method === 'PUT' && item.path === `/etapi/notes/${clientCreatedNoteId}/content`,
      );
      assert.equal(request.headers['content-type'], 'text/plain');
      assert.equal(request.text, '<p>updated by client</p>');
      assert.ok((await client.getContent(clientCreatedNoteId)).includes('updated by client'));
    });

    await test('deleteNote moves a note to the trash and restoreNote undeletes it', async () => {
      const trashed = await client.deleteNote(clientCreatedNoteId);
      assert.deepEqual(trashed, { noteId: clientCreatedNoteId, trashed: true });
      assert.equal(mock.state.trashed.has(clientCreatedNoteId), true);
      const restored = await client.restoreNote(clientCreatedNoteId);
      assert.deepEqual(restored, { noteId: clientCreatedNoteId, restored: true });
      assert.equal(mock.state.trashed.has(clientCreatedNoteId), false);
      const request = findLastRequest(
        mock.requests,
        (item) => item.method === 'POST' && item.path === `/etapi/notes/${clientCreatedNoteId}/undelete`,
      );
      assert.ok(request, 'undelete endpoint was called');
    });

    await test('getAttachments and getAttachment expose attachment metadata', async () => {
      const attachments = await client.getAttachments('noteAlpha');
      assert.equal(attachments.length, 2);
      const attachment = await client.getAttachment('att1');
      assert.equal(attachment.title, 'draft.pdf');
      assert.equal(attachment.mime, 'application/pdf');
    });

    await test('downloadAttachment writes the attachment bytes', async () => {
      const destination = path.join(tempRoot, 'downloads', 'draft.pdf');
      const result = await client.downloadAttachment('att1', destination);
      assert.equal(result.bytes, 7);
      assert.equal(fs.readFileSync(destination, 'utf8'), 'PDFDATA');
    });

    let uploadedAttachmentId = '';
    await test('uploadAttachment creates metadata then PUTs the bytes', async () => {
      const source = path.join(tempRoot, 'client-upload.bin');
      fs.writeFileSync(source, 'CLIENT-UPLOAD');
      const uploaded = await client.uploadAttachment({ noteId: 'noteAlpha', filePath: source, title: 'client-upload.bin' });
      uploadedAttachmentId = uploaded.attachmentId;
      assert.equal(uploaded.bytes, 13);
      const createRequest = findLastRequest(
        mock.requests,
        (item) => item.method === 'POST' && item.path === '/etapi/attachments' && item.json?.title === 'client-upload.bin',
      );
      assert.equal(createRequest.json.ownerId, 'noteAlpha');
      assert.equal(createRequest.json.role, 'file');
      const contentRequest = findLastRequest(
        mock.requests,
        (item) => item.method === 'PUT' && item.path === `/etapi/attachments/${uploadedAttachmentId}/content`,
      );
      assert.equal(contentRequest.text, 'CLIENT-UPLOAD');
    });

    await test('deleteAttachment removes the attachment', async () => {
      const deleted = await client.deleteAttachment(uploadedAttachmentId);
      assert.deepEqual(deleted, { attachmentId: uploadedAttachmentId, deleted: true });
      await assertRejects(() => client.getAttachment(uploadedAttachmentId), /HTTP 404/, 'deleted attachment lookup');
    });

    await test('revision endpoints list, read and create revisions', async () => {
      const revisions = await client.getRevisions('noteAlpha');
      assert.equal(revisions.length, 2);
      const content = await client.getRevisionContent('noteAlpha', 'rev1');
      assert.ok(content.includes('Older draft'));
      const created = await client.createRevision('noteAlpha');
      assert.deepEqual(created, { noteId: 'noteAlpha', revisionCreated: true });
    });

    await test('exportNote extracts text from the ETAPI export ZIP', async () => {
      const markdown = await client.exportNote('noteAlpha');
      assert.equal(markdown, '# Paper Draft\n\nDraft body with **bold** text.\n');
      const html = await client.exportNote('noteAlpha', 'html');
      assert.ok(html.includes('<h1>Paper Draft</h1>'));
      const request = findLastRequest(
        mock.requests,
        (item) => item.path === '/etapi/notes/noteAlpha/export' && item.query.format === 'html',
      );
      assert.ok(request, 'export format query was sent');
    });

    await test('health reports the live connection', async () => {
      const health = await client.health();
      assert.deepEqual(health, { connected: true, version: '0.106.0' });
    });

    await test('a rejected token produces an actionable 401 error', async () => {
      const wrongClient = createTriliumClient({ baseUrl: mock.baseUrl, token: 'bad-token' });
      const error = await assertRejects(() => wrongClient.getNote('noteAlpha'), /HTTP 401/, 'bad token');
      assert.ok(/Options → ETAPI/.test(error.message), 'error should explain how to create a token');
    });

    await test('an unreachable instance produces an actionable network error', async () => {
      const offlineClient = createTriliumClient({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 1500 });
      const error = await assertRejects(() => offlineClient.appInfo(), /cannot reach Trilium/, 'unreachable instance');
      assert.ok(/Start Trilium Notes/.test(error.message));
    });

    await test('read-only client rejects every mutating call', async () => {
      const readOnlyClient = createTriliumClient({ baseUrl: mock.baseUrl, token: 'test-token', allowWrites: false });
      assert.equal((await readOnlyClient.appInfo()).appVersion, '0.106.0');
      await assertRejects(() => readOnlyClient.createNote({ parentNoteId: 'parentNote1', title: 'x' }), /allowWrites: false/, 'createNote');
      await assertRejects(() => readOnlyClient.deleteNote('noteAlpha'), /allowWrites: false/, 'deleteNote');
      await assertRejects(
        () => readOnlyClient.setAttribute({ noteId: 'noteAlpha', name: 'x' }),
        /allowWrites: false/,
        'setAttribute',
      );
    });

    /* ---------------------------------------------------------------- */
    /* Default plugin tools                                              */
    /* ---------------------------------------------------------------- */

    await test('trilium_search executes, validates and renders', async () => {
      const tool = tools.get('trilium_search');
      const value = await tool.execute({ query: 'Paper', limit: 5 }, exec);
      assert.equal(value.count, 1);
      assert.equal(value.results[0].noteId, 'noteAlpha');
      assertToolOutput(tool, value);
      const text = tool.output.render({}, value).map((block) => block.text).join('\n');
      assert.ok(text.includes('noteAlpha | Paper Draft'));
    });

    await test('trilium_read executes with labels, children and attachments', async () => {
      const tool = tools.get('trilium_read');
      const value = await tool.execute({ noteId: 'noteAlpha', includeChildren: true, includeAttachments: true, maxChars: 500 }, exec);
      assert.equal(value.title, 'Paper Draft');
      assert.deepEqual(value.path, ['root', 'Inkstone 项目', 'Paper Draft']);
      assert.ok(value.labels.some((label) => label.name === 'inkstone/status' && label.value === 'draft'));
      assert.ok(value.content.includes('Draft body with'));
      assert.equal(value.contentTruncated, false);
      assert.ok(Array.isArray(value.children));
      assert.ok(value.attachments.length >= 2, 'noteAlpha attachments are listed');
      assertToolOutput(tool, value);
      const text = tool.output.render({}, value).map((block) => block.text).join('\n');
      assert.ok(text.includes('Draft body with'));
    });

    await test('trilium_read returns children of a parent note', async () => {
      const tool = tools.get('trilium_read');
      const value = await tool.execute({ noteId: 'parentNote1', includeChildren: true }, exec);
      assert.ok(value.children.some((child) => child.noteId === 'noteAlpha'));
      assertToolOutput(tool, value);
    });

    await test('trilium_read truncates long content and says so', async () => {
      const tool = tools.get('trilium_read');
      const value = await tool.execute({ noteId: 'noteAlpha', maxChars: 10 }, exec);
      assert.equal(value.contentTruncated, true);
      assertToolOutput(tool, value);
    });

    let toolCreatedNoteId = '';
    await test('trilium_write create converts markdown to safe HTML', async () => {
      const tool = tools.get('trilium_write');
      const value = await tool.execute(
        {
          action: 'create',
          parentNoteId: 'parentNote1',
          title: 'Tool Created',
          content: '# Heading\n\n**bold** and `code`',
          format: 'markdown',
        },
        exec,
      );
      assert.equal(value.action, 'create');
      toolCreatedNoteId = value.noteId;
      const request = findLastRequest(mock.requests, (item) => item.method === 'POST' && item.path === '/etapi/create-note');
      assert.equal(request.json.type, 'text');
      assert.ok(request.json.content.includes('<h1>Heading</h1>'), 'markdown heading converted');
      assert.ok(request.json.content.includes('<strong>bold</strong>'), 'bold converted');
      assert.ok(request.json.content.includes('<code>code</code>'), 'code converted');
      assertToolOutput(tool, value);
    });

    await test('trilium_write append, replace and title actions work', async () => {
      const tool = tools.get('trilium_write');
      const appended = await tool.execute({ action: 'append', noteId: toolCreatedNoteId, content: '<p>tail</p>', format: 'html' }, exec);
      assertToolOutput(tool, appended);
      const appendRequest = findLastRequest(
        mock.requests,
        (item) => item.method === 'PUT' && item.path === `/etapi/notes/${toolCreatedNoteId}/content`,
      );
      assert.ok(appendRequest.text.includes('<p>tail</p>'));
      assert.ok(appendRequest.text.includes('<h1>Heading</h1>'), 'append keeps existing content');

      const replaced = await tool.execute({ action: 'replace', noteId: toolCreatedNoteId, content: 'plain content', format: 'html' }, exec);
      assertToolOutput(tool, replaced);
      const replaceRequest = findLastRequest(
        mock.requests,
        (item) => item.method === 'PUT' && item.path === `/etapi/notes/${toolCreatedNoteId}/content`,
      );
      assert.equal(replaceRequest.text, 'plain content');

      const renamed = await tool.execute({ action: 'title', noteId: toolCreatedNoteId, title: 'Tool Renamed' }, exec);
      assert.equal(renamed.title, 'Tool Renamed');
      assertToolOutput(tool, renamed);
    });

    await test('trilium_attach uploads, lists and downloads attachments', async () => {
      const tool = tools.get('trilium_attach');
      fs.writeFileSync(path.join(tempRoot, 'upload.txt'), 'ATTACH-BYTES');
      const uploaded = await tool.execute({ action: 'upload', noteId: 'noteAlpha', path: 'upload.txt', title: 'upload.txt' }, exec);
      assert.equal(uploaded.action, 'upload');
      assert.equal(uploaded.bytes, 12);
      assert.ok(uploaded.attachmentId.startsWith('attUpload'));
      const createRequest = findLastRequest(
        mock.requests,
        (item) => item.method === 'POST' && item.path === '/etapi/attachments' && item.json?.title === 'upload.txt',
      );
      assert.equal(createRequest.json.ownerId, 'noteAlpha');
      const contentRequest = findLastRequest(
        mock.requests,
        (item) => item.method === 'PUT' && item.path === `/etapi/attachments/${uploaded.attachmentId}/content`,
      );
      assert.equal(contentRequest.text, 'ATTACH-BYTES');
      assertToolOutput(tool, uploaded);

      const listed = await tool.execute({ action: 'list', noteId: 'noteAlpha' }, exec);
      assert.ok(listed.attachments.some((attachment) => attachment.attachmentId === 'att1'));
      assertToolOutput(tool, listed);

      const downloaded = await tool.execute({ action: 'download', attachmentId: 'att2', path: 'downloads/notes.md' }, exec);
      assert.equal(downloaded.path, 'downloads/notes.md');
      assert.equal(fs.readFileSync(path.join(tempRoot, 'downloads', 'notes.md'), 'utf8'), 'hello world');
      assertToolOutput(tool, downloaded);
    });

    await test('trilium_history revisions sorts newest first and validates', async () => {
      const tool = tools.get('trilium_history');
      const value = await tool.execute({ action: 'revisions', noteId: 'noteAlpha', limit: 2 }, exec);
      assert.equal(value.revisions.length, 2);
      assert.equal(value.revisions[0].revisionId, 'rev1');
      assert.equal(value.revisions[1].revisionId, 'rev2');
      assertToolOutput(tool, value);
      const text = tool.output.render({}, value).map((block) => block.text).join('\n');
      assert.ok(text.includes('rev1'));
    });

    await test('trilium_history export writes a workspace file and returns inline text', async () => {
      const tool = tools.get('trilium_history');
      const saved = await tool.execute(
        { action: 'export', noteId: 'noteAlpha', format: 'markdown', outputPath: 'exports/draft.md' },
        exec,
      );
      assert.equal(saved.outputPath, 'exports/draft.md');
      assert.ok(saved.chars > 0);
      assert.equal(fs.readFileSync(path.join(tempRoot, 'exports', 'draft.md'), 'utf8'), '# Paper Draft\n\nDraft body with **bold** text.\n');
      assertToolOutput(tool, saved);

      const inline = await tool.execute({ action: 'export', noteId: 'noteAlpha' }, exec);
      assert.ok(inline.content.includes('# Paper Draft'));
      assert.equal(inline.contentTruncated, false);
      assertToolOutput(tool, inline);
    });

    /* ---------------------------------------------------------------- */
    /* Advanced tools                                                    */
    /* ---------------------------------------------------------------- */

    await test('trilium_attributes get, set and delete', async () => {
      const tool = advancedTools.get('trilium_attributes');
      const listed = await tool.execute({ action: 'get', noteId: 'noteAlpha' }, exec);
      assert.ok(listed.attributes.length >= 2);
      assertToolOutput(tool, listed);

      const created = await tool.execute(
        { action: 'set', noteId: 'noteAlpha', type: 'label', name: 'inkstone/tool', value: 'ok' },
        exec,
      );
      assert.equal(created.attribute.name, 'inkstone/tool');
      assert.equal(created.attribute.value, 'ok');
      assertToolOutput(tool, created);

      const deleted = await tool.execute({ action: 'delete', attributeId: created.attributeId }, exec);
      assert.equal(deleted.attributeId, created.attributeId);
      assertToolOutput(tool, deleted);
    });

    await test('trilium_delete trashes and restores a note', async () => {
      const tool = advancedTools.get('trilium_delete');
      const trashed = await tool.execute({ action: 'trash', noteId: 'noteBeta' }, exec);
      assert.equal(trashed.success, true);
      assert.equal(mock.state.trashed.has('noteBeta'), true);
      assertToolOutput(tool, trashed);

      const restored = await tool.execute({ action: 'restore', noteId: 'noteBeta' }, exec);
      assert.equal(restored.success, true);
      assert.equal(mock.state.trashed.has('noteBeta'), false);
      assertToolOutput(tool, restored);
    });

    /* ---------------------------------------------------------------- */
    /* Error paths                                                       */
    /* ---------------------------------------------------------------- */

    await test('a missing token produces an actionable plugin error', async () => {
      const homeTokenFile = path.join(SECRETS_DIR, TRILIUM_TOKEN_FILE);
      if (fs.existsSync(homeTokenFile)) {
        skip('missing-token plugin error', `a real secret file exists at ${homeTokenFile}`);
        return;
      }
      const tokenlessTools = applyPlugin({ baseUrl: mock.baseUrl, tokenEnv: 'TRILIUM_ETAPI_UNSET_TOKEN' });
      const tool = tokenlessTools.get('trilium_search');
      const error = await assertRejects(() => tool.execute({ query: 'x' }, exec), /Trilium ETAPI token is not available/, 'missing token');
      assert.ok(/Options → ETAPI/.test(error.message), 'error should point at Trilium Options → ETAPI');
      assert.ok(error.message.includes(TRILIUM_TOKEN_FILE), 'error should mention the local secret file');
    });

    await test('reading a missing note produces a 404 error naming the id', async () => {
      const tool = tools.get('trilium_read');
      await assertRejects(() => tool.execute({ noteId: 'missingNote' }, exec), /HTTP 404/, 'missing note');
    });

    await test('invalid tool arguments are rejected with clear messages', async () => {
      const search = tools.get('trilium_search');
      await assertRejects(() => search.execute({}, exec), /"query" must be a non-empty string/, 'empty query');
      const write = tools.get('trilium_write');
      await assertRejects(() => write.execute({ action: 'nuke' }, exec), /action must be one of/, 'invalid action');
      const attach = tools.get('trilium_attach');
      await assertRejects(
        () => attach.execute({ action: 'upload', noteId: 'noteAlpha', path: 'does-not-exist.txt' }, exec),
        /File not found for attachment upload/,
        'missing upload source',
      );
    });

    await test('allowWrites=false rejects every mutating tool with enabling instructions', async () => {
      const write = readOnlyTools.get('trilium_write');
      const error = await assertRejects(
        () => write.execute({ action: 'create', parentNoteId: 'parentNote1', title: 'x', content: 'y' }, exec),
        /allowWrites: false/,
        'read-only create',
      );
      assert.ok(/Set allowWrites: true/.test(error.message), 'error should explain how to enable writes');

      const attach = readOnlyTools.get('trilium_attach');
      await assertRejects(
        () => attach.execute({ action: 'upload', noteId: 'noteAlpha', path: 'upload.txt' }, exec),
        /allowWrites: false/,
        'read-only upload',
      );

      const attributes = readOnlyAdvancedTools.get('trilium_attributes');
      await assertRejects(
        () => attributes.execute({ action: 'set', noteId: 'noteAlpha', name: 'x' }, exec),
        /allowWrites: false/,
        'read-only attribute set',
      );

      const remove = readOnlyAdvancedTools.get('trilium_delete');
      await assertRejects(() => remove.execute({ action: 'trash', noteId: 'noteBeta' }, exec), /allowWrites: false/, 'read-only trash');

      // Read-only mode still allows reads.
      const search = readOnlyTools.get('trilium_search');
      const results = await search.execute({ query: 'Paper' }, exec);
      assert.equal(results.count, 1);
    });

    /* ---------------------------------------------------------------- */
    /* Credential resolution (lib/secrets.mjs)                           */
    /* ---------------------------------------------------------------- */

    await test('tokenEnv config resolves the token from the environment', async () => {
      process.env.TRILIUM_ETAPI_TEST_TOKEN = 'env-token';
      try {
        const envTools = applyPlugin({ baseUrl: mock.baseUrl, tokenEnv: 'TRILIUM_ETAPI_TEST_TOKEN' });
        const results = await envTools.get('trilium_search').execute({ query: 'Paper' }, exec);
        assert.equal(results.count, 1);
        const request = findLastRequest(mock.requests, (item) => item.path === '/etapi/notes');
        assert.equal(request.headers.authorization, 'env-token');
      } finally {
        delete process.env.TRILIUM_ETAPI_TEST_TOKEN;
      }
    });

    await test('tokenFile config resolves the token from a secret file', async () => {
      const tokenFile = path.join(tempRoot, 'trilium-token.txt');
      fs.writeFileSync(tokenFile, 'file-token\n');
      const fileTools = applyPlugin({ baseUrl: mock.baseUrl, tokenFile });
      const results = await fileTools.get('trilium_search').execute({ query: 'Paper' }, exec);
      assert.equal(results.count, 1);
      const request = findLastRequest(mock.requests, (item) => item.path === '/etapi/notes');
      assert.equal(request.headers.authorization, 'file-token');
    });

    await test('explicit config.token wins over tokenFile and environment', async () => {
      const tokenFile = path.join(tempRoot, 'trilium-token-2.txt');
      fs.writeFileSync(tokenFile, 'file-token-ignored\n');
      process.env.TRILIUM_ETAPI_TEST_TOKEN = 'env-token-ignored';
      try {
        const directTools = applyPlugin({ baseUrl: mock.baseUrl, token: 'test-token', tokenFile });
        const results = await directTools.get('trilium_search').execute({ query: 'Paper' }, exec);
        assert.equal(results.count, 1);
        const request = findLastRequest(mock.requests, (item) => item.path === '/etapi/notes');
        assert.equal(request.headers.authorization, 'test-token');
      } finally {
        delete process.env.TRILIUM_ETAPI_TEST_TOKEN;
      }
    });

    /* ---------------------------------------------------------------- */
    /* Markdown conversion                                               */
    /* ---------------------------------------------------------------- */

    await test('markdownToHtml converts supported constructs and escapes raw HTML', () => {
      const html = markdownToHtml(
        '# Title\n\n**bold** *italic* `code` [link](https://example.com)\n\n- one\n- two\n\n> quote\n\n```js\nconst a = 1 < 2;\n```\n\n<script>alert(1)</script>',
      );
      assert.ok(html.includes('<h1>Title</h1>'));
      assert.ok(html.includes('<strong>bold</strong>'));
      assert.ok(html.includes('<em>italic</em>'));
      assert.ok(html.includes('<code>code</code>'));
      assert.ok(html.includes('<a href="https://example.com">link</a>'));
      assert.ok(html.includes('<ul>'));
      assert.ok(html.includes('<li>one</li>'));
      assert.ok(html.includes('<blockquote>quote</blockquote>'));
      assert.ok(html.includes('const a = 1 &lt; 2;'), 'code block content is escaped');
      assert.ok(html.includes('&lt;script&gt;'), 'raw HTML is escaped');
      assert.ok(!html.includes('<script>'), 'raw script tag must not survive');
    });

    await test('markdown links with unsafe protocols do not become anchors', () => {
      const html = markdownToHtml('[click](javascript:alert(1))');
      assert.ok(!html.includes('<a '), 'javascript: links must not become anchors');
      assert.ok(html.includes('click'));
    });

    await test('looksLikeMarkdown distinguishes Markdown from HTML', () => {
      assert.equal(looksLikeMarkdown('# Heading\n\n**bold**'), true);
      assert.equal(looksLikeMarkdown('<p>already html</p>'), false);
      assert.equal(looksLikeMarkdown('plain text without markup'), false);
    });

    /* ---------------------------------------------------------------- */
    /* Optional live check                                               */
    /* ---------------------------------------------------------------- */

    let liveToken;
    try {
      liveToken = triliumToken();
    } catch {
      liveToken = undefined;
    }
    if (!liveToken) {
      skip('live Trilium health/appInfo', 'no token in TRILIUM_ETAPI_TOKEN or ~/.dsh-inkstone/trilium-etapi-token.txt');
    } else {
      const liveUrl = process.env.TRILIUM_ETAPI_URL || 'http://127.0.0.1:8080';
      const liveClient = createTriliumClient({ baseUrl: liveUrl, token: liveToken, timeoutMs: 5000 });
      const health = await liveClient.health();
      if (!health.connected) {
        skip('live Trilium health/appInfo', health.error);
      } else {
        await test('live Trilium health/appInfo', async () => {
          const info = await liveClient.appInfo();
          assert.ok(info.appVersion.length > 0, 'live appVersion decoded');
          const results = await liveClient.search({ query: 'inkstone', limit: 5 });
          assert.ok(Array.isArray(results));
        });
      }
    }
  } finally {
    await mock.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  failed += 1;
  failures.push({ title: '<fatal>', error });
  console.error('FATAL', error);
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const failure of failures) {
    console.log(`- ${failure.title}`);
    console.log(`  ${failure.error instanceof Error ? (failure.error.stack ?? failure.error.message) : String(failure.error)}`);
  }
  process.exitCode = 1;
} else {
  console.log('ALL TRILIUM TESTS PASSED');
}
