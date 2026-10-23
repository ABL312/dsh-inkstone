#!/usr/bin/env node
/**
 * Standalone tests for the `zotero-ink` plugin, `lib/bib.mjs` and
 * `lib/zotero-client.mjs`.
 *
 * No DSH process and no external dependencies are needed:
 * - a `node:http` mock implements the Zotero local API fixtures;
 * - a fake `ctx.tools.register` captures the registered tool definitions and
 *   every tool is executed directly through `execute(args, exec)`;
 * - output values are checked against a local re-implementation of DSH's
 *   enforced JSON-Schema subset (type/properties/required/additionalProperties/
 *   items/enum/const/oneOf + lossless JSON);
 * - Crossref/OpenAlex/arXiv are mocked by temporarily replacing global fetch,
 *   so the enrich tests stay hermetic;
 * - real Zotero checks run only when 127.0.0.1:23119 is reachable, otherwise a
 *   `SKIP` line is printed.
 *
 * Run: `node scripts/test-zotero.mjs` (exit code 0 = pass).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply } from '../plugins/zotero-ink/index.js';
import {
  buildBibFromItems,
  citekeyOf,
  dedupeEntries,
  findMissingFields,
  formatAuthors,
  indexByCitekey,
  loadBibFiles,
  mergeEntries,
  parseBib,
  serializeBib,
} from '../lib/bib.mjs';
import { createZoteroClient } from '../lib/zotero-client.mjs';
import { zoteroApiKey } from '../lib/secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'zotero');
const BIB_FIXTURES = path.join(FIXTURES, 'bib');
const API_FIXTURES = path.join(FIXTURES, 'api');
const TMP = path.join(FIXTURES, '_tmp');
const CWD = path.join(TMP, 'cwd');
const DATA_DIR = path.join(TMP, 'data');

let passed = 0;
const failures = [];
const skipped = [];

/**
 * Record one passing check.
 * @param {string} name
 */
function pass(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

/**
 * Run one synchronous test.
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run one asynchronous test.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function testAsync(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Assert a condition.
 * @param {unknown} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Assert strict equality.
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Assert deep JSON equality.
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 */
function assertDeepEqual(actual, expected, message) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

/**
 * Assert a substring occurs.
 * @param {string} haystack
 * @param {string} needle
 * @param {string} message
 */
function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message}: ${JSON.stringify(String(haystack).slice(0, 400))} does not include ${JSON.stringify(needle)}`);
}

/**
 * Assert that an async function rejects with a message matching a pattern.
 * @param {() => Promise<any>} fn
 * @param {RegExp | string} pattern
 * @param {string} message
 */
async function assertRejects(fn, pattern, message) {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`${message}: expected an error, but the call succeeded`);
  const text = error instanceof Error ? error.message : String(error);
  const matched = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  if (!matched) throw new Error(`${message}: error ${JSON.stringify(text.slice(0, 500))} does not match ${String(pattern)}`);
}

// ---------------------------------------------------------------------------
// Enforced JSON-Schema subset (mirrors @deepseek-ai/dsh-tools validation)
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Whether a value is lossless JSON: plain records/arrays, finite numbers,
 * dense arrays and only enumerable string keys.
 * @param {unknown} value
 * @returns {boolean}
 */
function isLosslessJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isLosslessJson(value[index])) return false;
    }
    return true;
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false;
      if (!isLosslessJson(value[key])) return false;
    }
    return true;
  }
  return false;
}

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);
const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/**
 * Collect violations of the DSH-enforced schema subset.
 * @param {unknown} schema
 * @param {string} label
 * @returns {string[]}
 */
function collectSchemaViolations(schema, label = 'schema') {
  const violations = [];
  const walk = (node, nodePath) => {
    if (!isPlainObject(node)) {
      violations.push(`${nodePath} must be a schema object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYS.has(key) || ANNOTATION_KEYS.has(key)) continue;
      violations.push(`${nodePath}.${key} is not a supported keyword`);
    }
    for (const key of ['description', 'title']) {
      if (Object.hasOwn(node, key) && typeof node[key] !== 'string') violations.push(`${nodePath}.${key} must be a string`);
    }
    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) violations.push(`${nodePath} cannot declare both type and oneOf`);
    if (!hasType && !hasOneOf) {
      violations.push(`${nodePath} must declare type or oneOf`);
      return;
    }
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${nodePath}.${key} is not supported beside oneOf`);
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${nodePath}.oneOf must be an array of at least two schemas`);
      else node.oneOf.forEach((branch, index) => walk(branch, `${nodePath}.oneOf[${index}]`));
      return;
    }
    const type = node.type;
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(`${nodePath}.type must be a single supported type string`);
      return;
    }
    const allowedFor = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    };
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(type)) violations.push(`${nodePath}.${key} is not supported on type "${type}"`);
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!isPlainObject(node.properties)) violations.push(`${nodePath}.properties must be an object of schemas`);
      else for (const [name, child] of Object.entries(node.properties)) walk(child, `${nodePath}.properties.${name}`);
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${nodePath}.required must be an array of strings`);
      } else {
        const properties = isPlainObject(node.properties) ? node.properties : {};
        for (const name of node.required) {
          if (!Object.hasOwn(properties, name)) violations.push(`${nodePath}.required names "${name}" which is not declared`);
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${nodePath}.additionalProperties must be a boolean`);
    }
    if (Object.hasOwn(node, 'items')) {
      walk(node.items, `${nodePath}.items`);
    }
    if (Object.hasOwn(node, 'enum')) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${nodePath}.enum must be a non-empty array`);
    }
  };
  walk(schema, label);
  return violations;
}

/**
 * Validate a value against a supported schema.
 * @param {Record<string, any>} schema
 * @param {unknown} value
 * @param {string} valuePath
 * @returns {string[]}
 */
function validateValue(schema, value, valuePath = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((branch) => validateValue(branch, value, valuePath).length === 0).length;
    return matches === 1 ? [] : [`"${valuePath}" must match exactly one oneOf branch (matched ${matches})`];
  }
  const type = schema.type;
  if (type === 'object') {
    if (!isPlainObject(value)) return [`"${valuePath}" must be an object`];
    const violations = [];
    const properties = Object.hasOwn(schema, 'properties') ? schema.properties : {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name) || value[name] === undefined) violations.push(`missing required property "${valuePath}.${name}"`);
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) && value[name] !== undefined) {
        violations.push(...validateValue(child, value[name], valuePath === '' ? name : `${valuePath}.${name}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`"${valuePath}.${key}" is not a declared property`);
      }
    }
    if (!isLosslessJson(value)) violations.push(`"${valuePath}" must be a lossless JSON object`);
    return violations;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`"${valuePath}" must be an array`];
    const violations = [];
    if (Object.hasOwn(schema, 'items')) {
      value.forEach((entry, index) => violations.push(...validateValue(schema.items, entry, `${valuePath}[${index}]`)));
    }
    if (!isLosslessJson(value)) violations.push(`"${valuePath}" must be a dense lossless JSON array`);
    return violations;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`"${valuePath}" must be a string`];
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`"${valuePath}" must be a finite number`];
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return [`"${valuePath}" must be an integer`];
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`"${valuePath}" must be a boolean`];
  } else if (type === 'null') {
    if (value !== null) return [`"${valuePath}" must be null`];
  }
  const violations = [];
  if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(value)) violations.push(`"${valuePath}" must be one of ${JSON.stringify(schema.enum)}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`"${valuePath}" must be ${JSON.stringify(schema.const)}`);
  return violations;
}

// ---------------------------------------------------------------------------
// Fixtures and mock local API
// ---------------------------------------------------------------------------

/**
 * @param {string} file
 * @returns {any}
 */
function readJsonFixture(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} file
 * @returns {string}
 */
function readTextFixture(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Start the mock Zotero local API.
 * @returns {Promise<{url: string, state: any, close: () => Promise<void>}>}
 */
async function startMockZotero() {
  const items = readJsonFixture(path.join(API_FIXTURES, 'items.json'));
  const childrenByKey = readJsonFixture(path.join(API_FIXTURES, 'children.json'));
  const collections = readJsonFixture(path.join(API_FIXTURES, 'collections.json'));
  const collectionItems = readJsonFixture(path.join(API_FIXTURES, 'collection-items.json'));
  const bibtexText = readTextFixture(path.join(API_FIXTURES, 'bibtex.txt'));
  const state = { requests: [], bibtexFails: false, bibtexAsJson: false };

  const sendJson = (response, value, status = 200) => {
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Total-Results': Array.isArray(value) ? String(value.length) : '1' });
    response.end(body);
  };
  const sendText = (response, value, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(value));
  };
  const filterItems = (list, searchParams) => {
    let filtered = list.slice();
    const itemKey = searchParams.get('itemKey');
    if (itemKey) {
      const keys = new Set(itemKey.split(',').map((key) => key.trim()));
      filtered = filtered.filter((item) => keys.has(item.data.key));
    }
    const itemType = searchParams.get('itemType');
    if (itemType) filtered = filtered.filter((item) => item.data.itemType === itemType);
    const q = searchParams.get('q');
    if (q) {
      const needle = q.toLowerCase();
      filtered = filtered.filter((item) => {
        const data = item.data;
        const creators = (data.creators ?? []).map((creator) => `${creator.firstName ?? ''} ${creator.lastName ?? ''}`).join(' ');
        return `${data.title ?? ''} ${creators}`.toLowerCase().includes(needle);
      });
    }
    const tag = searchParams.get('tag');
    if (tag) {
      filtered = filtered.filter((item) => (item.data.tags ?? []).some((entry) => (entry.tag ?? entry) === tag));
    }
    const limit = Number(searchParams.get('limit') ?? '100');
    const start = Number(searchParams.get('start') ?? '0');
    return filtered.slice(start, start + limit);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push({ method: request.method, url: request.url, headers: request.headers });
    const route = url.pathname;
    const searchParams = url.searchParams;

    if (route === '/api/users/0/items' || route === '/api/users/0/items/') {
      const format = searchParams.get('format');
      if (format === 'bibtex') {
        if (state.bibtexFails) return sendText(response, 'mock: bibtex exporter unavailable', 500);
        if (state.bibtexAsJson) return sendText(response, JSON.stringify(filterItems(items, searchParams)));
        return sendText(response, bibtexText);
      }
      return sendJson(response, filterItems(items, searchParams));
    }
    const childrenMatch = route.match(/^\/api\/users\/0\/items\/([A-Za-z0-9]+)\/children$/);
    if (childrenMatch) {
      const key = childrenMatch[1];
      if (!items.some((item) => item.data.key === key)) return sendJson(response, { error: 'Not found' }, 404);
      return sendJson(response, childrenByKey[key] ?? []);
    }
    const itemMatch = route.match(/^\/api\/users\/0\/items\/([A-Za-z0-9]+)$/);
    if (itemMatch) {
      const key = itemMatch[1];
      const item = items.find((entry) => entry.data.key === key);
      if (!item) return sendJson(response, { error: 'Not found' }, 404);
      if (searchParams.get('format') === 'bibtex') {
        if (state.bibtexFails) return sendText(response, 'mock: bibtex exporter unavailable', 500);
        return sendText(response, bibtexText);
      }
      return sendJson(response, item);
    }
    if (route === '/api/users/0/collections' || route === '/api/users/0/collections/') {
      return sendJson(response, collections);
    }
    const collectionItemsMatch = route.match(/^\/api\/users\/0\/collections\/([A-Za-z0-9]+)\/items$/);
    if (collectionItemsMatch) {
      const key = collectionItemsMatch[1];
      const format = searchParams.get('format');
      if (format === 'bibtex') {
        if (state.bibtexFails) return sendText(response, 'mock: bibtex exporter unavailable', 500);
        if (state.bibtexAsJson) return sendText(response, JSON.stringify(collectionItems[key] ?? []));
        return sendText(response, bibtexText);
      }
      return sendJson(response, collectionItems[key] ?? []);
    }
    return sendJson(response, { error: `mock: no route for ${route}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/**
 * Write a minimal one-page PDF that pdftotext can extract.
 * @param {string} file
 * @param {string} text
 */
function writeMinimalPdf(file, text) {
  const escapePdfString = (value) => String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 24 Tf 72 700 Td (${escapePdfString(text)}) Tj ET\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pdf, 'latin1');
}

/**
 * Whether pdftotext is available in this environment.
 * @returns {boolean}
 */
function hasPdftotext() {
  const result = spawnSync('pdftotext', ['-v'], { encoding: 'utf8', windowsHide: true });
  return !result.error;
}

// ---------------------------------------------------------------------------
// Prepare fixtures on disk
// ---------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'storage', 'ATTA4444'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'storage', 'UNIQ1234'), { recursive: true });
writeMinimalPdf(path.join(DATA_DIR, 'storage', 'ATTA4444', 'wang-2024-inkstone.pdf'), 'Inkstone Zotero smoke 2026');
fs.writeFileSync(path.join(DATA_DIR, 'storage', 'UNIQ1234', 'only-file.pdf'), '%PDF-1.4\n%%EOF\n', 'latin1');
const pdfAvailable = hasPdftotext();
if (!pdfAvailable) {
  skipped.push('pdftotext positive path (poppler not on PATH)');
  console.log('SKIP pdftotext positive path: pdftotext not found on PATH');
}

// ---------------------------------------------------------------------------
// lib/bib.mjs
// ---------------------------------------------------------------------------

test('bib: parse basic fixture', () => {
  const parsed = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'basic.bib')));
  assertEqual(parsed.entries.length, 5, 'entry count');
  assertEqual(parsed.errors.length, 0, 'parse errors');
  const wang = parsed.entries.find((entry) => entry.key === 'wang2024inkstone');
  assert(wang, 'wang entry present');
  assertEqual(wang.type, 'article', 'type lowercased');
  assertIncludes(wang.fields.author, '李, Ming', 'UTF-8 author preserved');
  assertIncludes(wang.fields.author, 'Müller, Anna', 'UTF-8 family name preserved');
  assertIncludes(wang.fields.title, '{Chinese}', 'nested braces preserved');
  assert(wang.line > 0, 'line number recorded');
});

test('bib: nested braces / quoted values / @string / concatenation', () => {
  const parsed = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'nested.bib')));
  assertEqual(parsed.entries.length, 2, 'entry count (comments and preamble ignored)');
  assertEqual(parsed.errors.length, 0, 'parse errors');
  assert(parsed.warnings.some((warning) => warning.includes('@string')), '@string warning present');
  const braces = parsed.entries.find((entry) => entry.key === 'nested2021braces');
  assertEqual(braces.fields.title, 'The {DNA} of {BibTeX}: {Nested {Braces}} Explained', 'deep nested braces');
  assertEqual(braces.fields.journal, 'Journal of the ACM', '@string macro expanded');
  assertEqual(braces.fields.month, 'January', 'built-in month macro expanded');
  assertEqual(braces.fields.keywords, 'parsing and indexing', '# concatenation');
  assertEqual(braces.fields.crossref, 'parent2020', 'crossref preserved');
  const quoted = parsed.entries.find((entry) => entry.key === 'nested1999quotes');
  assertEqual(quoted.fields.title, 'Việt Nam: {UTF-8} and Unicode author names', 'quoted value with braces');
  assertIncludes(quoted.fields.author, 'Nguyễn, Thị Hương', 'UTF-8 quoted author');
});

test('bib: BBT fields preserved verbatim', () => {
  const parsed = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'bbt.bib')));
  assertEqual(parsed.entries.length, 2, 'entry count');
  const entry = parsed.entries.find((item) => item.key === 'vaswani2017attention');
  assertEqual(entry.fields['tex.ids'], 'vaswani2017attention', 'tex.ids preserved');
  assertEqual(entry.fields['tex.venue'], 'NeurIPS', 'tex.venue preserved');
  assertEqual(entry.fields.citationkey, 'vaswani2017attention', 'citationKey preserved and lowercased field name');
});

test('bib: corrupt fixture reports errors and no entries', () => {
  const parsed = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'corrupt.bib')));
  assertEqual(parsed.entries.length, 0, 'no entries from corrupt file');
  assert(parsed.errors.length >= 1, 'at least one parse error');
});

test('bib: serializeBib is deterministic and sorted by key', () => {
  const parsed = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'basic.bib')));
  const serialized = serializeBib(parsed.entries);
  const reparsed = parseBib(serialized);
  assertEqual(reparsed.entries.length, parsed.entries.length, 'round-trip count');
  assertEqual(reparsed.errors.length, 0, 'round-trip parse errors');
  const keys = reparsed.entries.map((entry) => entry.key);
  assertDeepEqual(keys, [...keys].sort((left, right) => (left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0)), 'sorted keys');
  const reversed = serializeBib([...parsed.entries].reverse());
  assertEqual(reversed, serialized, 'input order does not change output');
  const normalizeFields = (fields) => Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  const byKey = (entries) => entries.slice().sort((left, right) => (left.key.toLowerCase() < right.key.toLowerCase() ? -1 : 1));
  const fieldMap = (entries) => Object.fromEntries(byKey(entries).map((entry) => [entry.key, normalizeFields(entry.fields)]));
  assertDeepEqual(fieldMap(reparsed.entries), fieldMap(parsed.entries), 'round-trip fields');
});

test('bib: indexByCitekey uses lowercase lookups', () => {
  const parsed = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'basic.bib')));
  const index = indexByCitekey(parsed.entries);
  assert(index.get('wang2024inkstone'), 'lowercase lookup hits');
  assert([...index.keys()].every((key) => key === key.toLowerCase()), 'all index keys are lowercase');
  assertEqual(index.get('wang2024inkstone').key, 'wang2024inkstone', 'original key spelling kept');
});

test('bib: findMissingFields honours per-type rules', () => {
  const basic = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'basic.bib'))).entries;
  const missing = (key) => findMissingFields(basic.find((entry) => entry.key === key));
  assertDeepEqual(missing('doe2020incomplete'), ['journal|journaltitle', 'year|date'], 'article missing journal+year');
  assertDeepEqual(missing('wang2024inkstone'), [], 'complete article');
  assertDeepEqual(missing('li2023typography'), [], 'editor satisfies author|editor for book');
  assertDeepEqual(findMissingFields({ type: 'misc', fields: {} }), ['title'], 'misc only needs title');
  assertDeepEqual(findMissingFields({ type: 'unknown-type', fields: {} }), ['title'], 'unknown types fall back to title');
});

test('bib: loadBibFiles detects cross-file duplicates', () => {
  const loaded = loadBibFiles([path.join(BIB_FIXTURES, 'basic.bib'), path.join(BIB_FIXTURES, 'duplicates.bib')]);
  assertEqual(loaded.entries.length, 6, 'de-duplicated entry count');
  assertEqual(loaded.files.length, 2, 'loaded file count');
  assertEqual(loaded.duplicates.length, 1, 'duplicate record count');
  assertEqual(loaded.duplicates[0].key, 'wang2024inkstone', 'duplicate key');
  assertEqual(loaded.duplicates[0].count, 2, 'duplicate count');
  assertEqual(loaded.duplicates[0].files.length, 2, 'duplicate source files');
  assertEqual(loaded.errors.length, 0, 'no errors');
});

test('bib: loadBibFiles recurses directories and reports missing files', () => {
  const loaded = loadBibFiles([path.join(FIXTURES, 'bibdir')]);
  assertEqual(loaded.entries.length, 3, 'directory recursion entry count');
  assertEqual(loaded.files.length, 2, 'directory recursion file count');
  const missing = loadBibFiles([path.join(FIXTURES, 'does-not-exist.bib')]);
  assertEqual(missing.entries.length, 0, 'missing file has no entries');
  assert(missing.errors.length >= 1, 'missing file reported');
});

test('bib: dedupeEntries reports duplicate keys and keeps first', () => {
  const basic = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'basic.bib'))).entries;
  const duplicate = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'duplicates.bib'))).entries;
  const deduped = dedupeEntries([...basic, ...duplicate]);
  assertEqual(deduped.entries.length, 6, 'deduped count');
  assertEqual(deduped.duplicates[0].count, 2, 'duplicate count');
  const wang = deduped.entries.find((entry) => entry.key === 'wang2024inkstone');
  assertEqual(wang.fields.title, basic[0].fields.title, 'first occurrence wins');
});

test('bib: mergeEntries adds, updates, reports conflicts', () => {
  const base = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'basic.bib'))).entries;
  const extra = parseBib(readTextFixture(path.join(BIB_FIXTURES, 'merge-extra.bib'))).entries;
  const merged = mergeEntries(base, extra);
  assertEqual(merged.entries.length, 6, 'merged entry count');
  assertDeepEqual(merged.added, ['zhao2025extra'], 'added new key');
  assert(merged.updated.includes('wang2024inkstone') && merged.updated.includes('li2023typography'), 'updated overlapping keys');
  assertEqual(merged.conflicts.length, 1, 'pages conflict recorded');
  assertEqual(merged.conflicts[0].field, 'pages', 'conflict field');
  const wang = merged.entries.find((entry) => entry.key === 'wang2024inkstone');
  assertEqual(wang.fields.issn, '1234-5678', 'new field merged');
  assertEqual(wang.fields.pages, '101--120', 'conflicting base value kept');
});

test('bib: buildBibFromItems maps Zotero items to BibLaTeX', () => {
  const items = readJsonFixture(path.join(API_FIXTURES, 'items.json'));
  const built = buildBibFromItems(items);
  assertEqual(built.entries.length, 4, 'bibliography entries');
  assertEqual(built.skipped.length, 3, 'attachment/note/annotation skipped');
  const wang = built.entries.find((entry) => entry.key === 'wang2024inkstone');
  assert(wang, 'BBT citationKey used');
  assertEqual(wang.type, 'article', 'journalArticle → article');
  assertIncludes(wang.fields.author, '李, Ming', 'creator names');
  assertEqual(wang.fields.journaltitle, 'Journal of Academic Tooling', 'journaltitle');
  assertEqual(wang.fields.date, '2024-05-01', 'date');
  const conference = built.entries.find((entry) => entry.key.endsWith('2022') || entry.type === 'inproceedings');
  assert(conference, 'conferencePaper present');
  assertEqual(conference.type, 'inproceedings', 'conferencePaper → inproceedings');
  const roundTrip = parseBib(serializeBib(built.entries));
  assertEqual(roundTrip.errors.length, 0, 'generated BibLaTeX parses cleanly');
  assertEqual(roundTrip.entries.length, 4, 'generated BibLaTeX round-trips');
});

test('bib: formatAuthors and citekeyOf', () => {
  assertEqual(
    formatAuthors([{ firstName: 'Xiao', lastName: 'Wang' }, { name: 'World Health Organization' }]),
    'Wang, Xiao and {World Health Organization}',
    'creator formatting',
  );
  assertEqual(citekeyOf({ type: 'article', key: 'explicit2020', fields: {} }), 'explicit2020', 'explicit key wins');
  assertEqual(
    citekeyOf({ type: 'article', key: '', fields: { author: 'Wang, Xiao', year: '2024', title: 'Inkstone: A Suite' } }),
    'wang2024inkstone',
    'derived citekey',
  );
  assertEqual(
    citekeyOf({ type: 'article', key: '', fields: { citationkey: 'pin2021', author: 'X', title: 'Y', year: '2021' } }),
    'pin2021',
    'BBT citationKey used',
  );
});

// ---------------------------------------------------------------------------
// lib/zotero-client.mjs (mock local API)
// ---------------------------------------------------------------------------

const mock = await startMockZotero();
const client = createZoteroClient({ localApiUrl: mock.url, dataDir: DATA_DIR, timeoutMs: 5000 });
const unreachable = createZoteroClient({ localApiUrl: 'http://127.0.0.1:1', dataDir: DATA_DIR, timeoutMs: 1000 });
const bibtexFixture = readTextFixture(path.join(API_FIXTURES, 'bibtex.txt'));

await testAsync('client: health reflects mock availability', async () => {
  const up = await client.health();
  assertEqual(up.localApi, true, 'localApi true when server is up');
  assertEqual(up.zoteroRunning, true, 'zoteroRunning true');
  const down = await unreachable.health();
  assertEqual(down.localApi, false, 'localApi false when unreachable');
  assertIncludes(down.error, '设置', 'actionable hint mentions settings');
  assertIncludes(down.error, '高级', 'actionable hint mentions advanced settings');
  assertIncludes(down.error, 'Zotero', 'hint names Zotero');
});

await testAsync('client: search with q filters child items out', async () => {
  const items = await client.search({ q: 'citation', limit: 10 });
  assertEqual(items.length, 2, 'two matching top-level items');
  assert(items.every((item) => item.data.itemType !== 'attachment' && item.data.itemType !== 'note'), 'child items excluded');
});

await testAsync('client: title/author/year/itemType filters are applied locally', async () => {
  const byTitle = await client.search({ title: 'typography', limit: 10 });
  assertEqual(byTitle.length, 1, 'title filter');
  assertEqual(byTitle[0].data.key, 'BBBB2222', 'title filter result');
  const byAuthor = await client.search({ author: 'chen', limit: 10 });
  assertEqual(byAuthor.length, 1, 'author filter');
  assertEqual(byAuthor[0].data.key, 'CCCC3333', 'author filter result');
  const byYear = await client.search({ year: 2018, limit: 10 });
  assertEqual(byYear.length, 1, 'year filter');
  assertEqual(byYear[0].data.key, 'DDDD7777', 'year filter result');
  const byBibType = await client.search({ itemType: 'article', limit: 10 });
  assertEqual(byBibType.length, 2, 'BibTeX type article maps to journalArticle');
  const byTag = await client.search({ tag: 'diffusion', limit: 10 });
  assertEqual(byTag.length, 1, 'tag filter');
  assertEqual(byTag[0].data.key, 'DDDD7777', 'tag filter result');
});

await testAsync('client: collection search uses the collection path', async () => {
  const items = await client.search({ collection: 'COLL0001', limit: 10 });
  assertEqual(items.length, 1, 'collection item count');
  assertEqual(items[0].data.key, 'AAAA1111', 'collection item key');
  assert(mock.state.requests.some((request) => request.url.includes('/collections/COLL0001/items')), 'collection endpoint called');
});

await testAsync('client: collection names are resolved for search and export', async () => {
  const items = await client.search({ collection: 'Inkstone Papers', limit: 10 });
  assertEqual(items.length, 1, 'name-resolved search count');
  assertEqual(items[0].data.key, 'AAAA1111', 'name-resolved search item');
  mock.state.requests = [];
  const exported = await client.exportBibtex({ collection: 'Typography' });
  assertEqual(exported.source, 'local-api', 'name-resolved export source');
  assert(mock.state.requests.some((request) => request.url.includes('/collections/COLL0002/items')), 'resolved collection key used');
  assert(exported.notes.some((note) => note.includes('COLL0002')), 'resolution note present');
  await assertRejects(() => client.search({ collection: 'No Such Collection' }), /找不到.*collection/, 'unknown collection name');
});

await testAsync('client: local requests carry the Zotero-API-Version header', async () => {
  await client.search({ limit: 1 });
  const request = mock.state.requests.find((entry) => entry.url.includes('/api/users/0/items') && !entry.url.includes('/collections/'));
  assert(request, 'local item request recorded');
  assertEqual(request.headers['zotero-api-version'], '3', 'API version header');
});

await testAsync('client: getItem returns one item and 404s with an actionable message', async () => {
  const item = await client.getItem('AAAA1111');
  assertEqual(item.data.title, 'Inkstone: A Suite for Chinese Academic Writing', 'item title');
  await assertRejects(() => client.getItem('NOPE0000'), /找不到/, 'missing item error');
  let status;
  try {
    await client.getItem('NOPE0000');
  } catch (error) {
    status = error.status;
  }
  assertEqual(status, 404, '404 status preserved');
});

await testAsync('client: getChildren returns attachments and annotations', async () => {
  const children = await client.getChildren('AAAA1111');
  assertEqual(children.length, 2, 'child count of parent item');
  assert(children.some((child) => child.data.itemType === 'attachment'), 'attachment child present');
  const annotations = await client.getChildren('ATTA4444');
  assertEqual(annotations.length, 1, 'annotation child count');
  assertEqual(annotations[0].data.annotationText, 'Inkstone matters', 'annotation text');
});

await testAsync('client: listCollections maps keys/names', async () => {
  const collections = await client.listCollections();
  assertEqual(collections.length, 2, 'collection count');
  assertDeepEqual(collections[0], { key: 'COLL0001', name: 'Inkstone Papers', parentCollection: null }, 'first collection shape');
});

await testAsync('client: getAttachmentPath resolves stored files', async () => {
  const attachment = readJsonFixture(path.join(API_FIXTURES, 'items.json')).find((item) => item.data.key === 'ATTA4444');
  const resolved = client.getAttachmentPath(attachment);
  assertEqual(resolved, path.join(DATA_DIR, 'storage', 'ATTA4444', 'wang-2024-inkstone.pdf'), 'storage filename path');
  assert(fs.existsSync(resolved), 'resolved file exists');
  const unique = client.getAttachmentPath({ key: 'UNIQ1234', data: { key: 'UNIQ1234', itemType: 'attachment' } });
  assertEqual(unique, path.join(DATA_DIR, 'storage', 'UNIQ1234', 'only-file.pdf'), 'unique-file fallback');
  await assertRejects(async () => client.getAttachmentPath({ data: { key: 'MISS0000' } }), /附件存储目录不存在/, 'missing storage directory');
});

await testAsync('client: exportBibtex prefers the local API exporter', async () => {
  const exported = await client.exportBibtex({});
  assertEqual(exported.source, 'local-api', 'source');
  assertIncludes(exported.text, '@article{wang2024inkstone', 'bibtex text');
  const parsed = parseBib(exported.text);
  assertEqual(parsed.entries.length, 2, 'exported entries');
});

await testAsync('client: exportBibtex itemKeys are fetched per item', async () => {
  const exported = await client.exportBibtex({ itemKeys: ['AAAA1111', 'NOPE0000'] });
  assertEqual(exported.source, 'local-api', 'itemKeys export source');
  assertIncludes(exported.text, '@article{wang2024inkstone', 'itemKeys export text');
  assert(exported.notes.some((note) => note.includes('NOPE0000')), 'missing key reported in notes');
});

await testAsync('client: exportBibtex ignores non-BibTeX local API responses', async () => {
  mock.state.bibtexAsJson = true;
  try {
    const exported = await client.exportBibtex({});
    assertEqual(exported.source, 'generated', 'non-BibTeX response triggers generation');
    assert(exported.notes.some((note) => note.includes('format=bibtex')), 'fallback note explains ignored response');
    assertEqual(parseBib(exported.text).entries.length, 4, 'generated entries still exported');
  } finally {
    mock.state.bibtexAsJson = false;
  }
});

await testAsync('client: exportBibtex falls back to generated BibLaTeX', async () => {
  mock.state.bibtexFails = true;
  try {
    const exported = await client.exportBibtex({});
    assertEqual(exported.source, 'generated', 'generated source');
    const parsed = parseBib(exported.text);
    assertEqual(parsed.entries.length, 4, 'generated entry count');
    assert(exported.notes.length >= 1, 'degradation note present');
    assertIncludes(exported.notes.join(' '), 'format=bibtex', 'note explains fallback');
  } finally {
    mock.state.bibtexFails = false;
  }
});

await testAsync('client: exportBibtex surfaces local-API connection errors', async () => {
  mock.state.bibtexFails = true;
  try {
    await assertRejects(
      () => unreachable.exportBibtex({}),
      /BibTeX 导出失败[\s\S]*设置/,
      'unreachable export error',
    );
  } finally {
    mock.state.bibtexFails = false;
  }
});

await testAsync('client: readPdfText returns text or a documented failure', async () => {
  const pdfPath = path.join(DATA_DIR, 'storage', 'ATTA4444', 'wang-2024-inkstone.pdf');
  const extracted = client.readPdfText(pdfPath);
  if (pdfAvailable) {
    assertEqual(extracted.method, 'pdftotext', 'pdftotext method');
    assertIncludes(extracted.text, 'Inkstone Zotero smoke', 'extracted text');
  } else {
    assertEqual(extracted.method, 'none', 'none method without poppler');
    assert(typeof extracted.note === 'string' && extracted.note.length > 0, 'failure note');
  }
  const missing = client.readPdfText(path.join(TMP, 'nope.pdf'));
  assertEqual(missing.method, 'none', 'missing file method');
  assertIncludes(missing.note, '不存在', 'missing file note');
});

await testAsync('client: readPdfText reports a missing pdftotext binary', async () => {
  const saved = process.env.INKSTONE_DISABLE_PDFTOTEXT;
  process.env.INKSTONE_DISABLE_PDFTOTEXT = '1';
  try {
    const result = client.readPdfText(path.join(DATA_DIR, 'storage', 'ATTA4444', 'wang-2024-inkstone.pdf'));
    assertEqual(result.method, 'none', 'method none without pdftotext');
    assertIncludes(result.note, 'pdftotext', 'install hint mentions pdftotext');
  } finally {
    if (saved === undefined) delete process.env.INKSTONE_DISABLE_PDFTOTEXT;
    else process.env.INKSTONE_DISABLE_PDFTOTEXT = saved;
  }
});

await testAsync('client: enrich parses mocked Crossref/OpenAlex/arXiv results', async () => {
  const realFetch = globalThis.fetch;
  const crossrefItem = {
    title: ['Inkstone: A Suite for Chinese Academic Writing'],
    author: [{ given: 'Xiao', family: 'Wang' }, { given: 'Ming', family: 'Li' }],
    issued: { 'date-parts': [[2024, 5, 1]] },
    'container-title': ['Journal of Academic Tooling'],
    DOI: '10.1000/inkstone.2024.001',
    URL: 'https://example.org/inkstone',
  };
  const openalexWork = {
    display_name: 'OpenAlex Inkstone Test Record',
    authorships: [{ author: { display_name: 'Anna Müller' } }],
    publication_year: 2023,
    doi: 'https://doi.org/10.1000/inkstone.2023.002',
    primary_location: { source: { display_name: 'OpenAlex Journal' }, landing_page_url: 'https://openalex.example/record' },
  };
  const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>An arXiv Inkstone Paper</title>
    <published>2022-01-02T00:00:00Z</published>
    <author><name>Rui Zhao</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/arxiv.2022.003</arxiv:doi>
  </entry>
</feed>`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.crossref.org/works/')) {
      return new Response(JSON.stringify({ message: crossrefItem }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.crossref.org')) {
      return new Response(JSON.stringify({ message: { items: [crossrefItem] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.openalex.org')) {
      return new Response(JSON.stringify({ results: [openalexWork] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('export.arxiv.org')) {
      return new Response(atomXml, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const detailed = await client.enrichDetailed({ query: 'inkstone' });
    assertEqual(detailed.candidates.length, 3, 'one candidate per source');
    const sources = detailed.candidates.map((candidate) => candidate.source).sort();
    assertDeepEqual(sources, ['arxiv', 'crossref', 'openalex'], 'candidate sources');
    const arxiv = detailed.candidates.find((candidate) => candidate.source === 'arxiv');
    assertEqual(arxiv.title, 'An arXiv Inkstone Paper', 'arXiv title parsed');
    assertEqual(arxiv.year, 2022, 'arXiv year parsed');
    const candidates = await client.enrich({ query: 'inkstone' });
    assert(Array.isArray(candidates) && candidates.length === 3, 'enrich returns a plain array');
    const doiOnly = await client.enrichDetailed({ doi: '10.1000/inkstone.2024.001', source: 'crossref' });
    assertEqual(doiOnly.candidates.length, 1, 'DOI lookup candidate');
    assertEqual(doiOnly.candidates[0].doi, '10.1000/inkstone.2024.001', 'DOI lookup result');
    // Degradation: every source fails → empty array plus notes.
    globalThis.fetch = async () => {
      throw new Error('offline mock');
    };
    const failed = await client.enrichDetailed({ query: 'nothing' });
    assertEqual(failed.candidates.length, 0, 'no candidates when offline');
    assertEqual(failed.notes.length, 3, 'one note per failed source');
    await assertRejects(() => client.enrichDetailed({}), /至少一个/, 'missing query/doi error');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('client: webApiAvailable/webApiRequest require a key', async () => {
  const keyless = createZoteroClient({ localApiUrl: mock.url, dataDir: DATA_DIR, timeoutMs: 1000, apiKey: '' });
  const savedKey = process.env.ZOTERO_API_KEY;
  delete process.env.ZOTERO_API_KEY;
  try {
    const available = await keyless.webApiAvailable();
    // A real secret file may exist on this machine; only assert absence when no source resolves.
    if (!zoteroApiKey({})) {
      assertEqual(available, false, 'webApiAvailable false without key');
      await assertRejects(() => keyless.webApiRequest('/users/0/items'), /Zotero Web API key/, 'webApiRequest key error');
    } else {
      skipped.push('webApiRequest missing-key error (a Zotero API key is configured on this machine)');
      console.log('SKIP webApiRequest missing-key error: a Zotero API key resolves on this machine');
    }
  } finally {
    if (savedKey !== undefined) process.env.ZOTERO_API_KEY = savedKey;
  }
});

// ---------------------------------------------------------------------------
// Plugin tools (fake ctx + mock local API)
// ---------------------------------------------------------------------------

/**
 * Capture tool definitions from a fake plugin context.
 * @param {object} config plugin config
 * @returns {{tools: Map<string, any>}}
 */
function createFakeContext(config) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`);
        tools.set(definition.name, definition);
      },
    },
  };
  apply(ctx, config);
  return { tools };
}

/**
 * Assert a tool output and render against the declared output contract.
 * @param {any} definition
 * @param {Record<string, any>} args
 * @param {any} value
 */
function assertToolOutput(definition, args, value) {
  const schemaViolations = collectSchemaViolations(definition.output.schema, `${definition.name}.output`);
  assertEqual(schemaViolations.length, 0, `${definition.name} output schema: ${schemaViolations.join('; ')}`);
  const violations = validateValue(definition.output.schema, value, 'value');
  assertEqual(violations.length, 0, `${definition.name} output invalid: ${violations.join('; ')}`);
  const blocks = definition.output.render(args, value);
  assert(Array.isArray(blocks) && blocks.length > 0, `${definition.name}: render must return blocks`);
  let total = 0;
  for (const block of blocks) {
    assert(block && block.type === 'text' && typeof block.text === 'string', `${definition.name}: render block shape`);
    total += block.text.length;
  }
  assert(total <= 30000, `${definition.name}: render text ${total} chars exceeds 30000`);
}

const main = createFakeContext({
  localApiUrl: mock.url,
  dataDir: DATA_DIR,
  bibFiles: [path.join(BIB_FIXTURES, 'basic.bib'), path.join(BIB_FIXTURES, 'nested.bib')],
  advancedTools: false,
  timeoutMs: 5000,
});
const exec = { agent: { session: { header: { cwd: CWD } } } };

/**
 * Call one registered tool like the harness would: args schema → execute → output schema → render.
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {Promise<any>}
 */
async function callTool(name, args) {
  const definition = main.tools.get(name);
  assert(definition, `tool ${name} is not registered`);
  assertEqual(collectSchemaViolations(definition.parameters, `${name}.parameters`).length, 0, `${name} parameter schema supported`);
  const argumentViolations = validateValue(definition.parameters, args, 'args');
  assertEqual(argumentViolations.length, 0, `${name} arguments invalid: ${argumentViolations.join('; ')}`);
  const value = await definition.execute(args, exec);
  assertToolOutput(definition, args, value);
  return value;
}

await testAsync('plugin: registers exactly the five default tools with full contracts', async () => {
  const names = [...main.tools.keys()].sort();
  assertDeepEqual(names, ['zotero_bib', 'zotero_enrich', 'zotero_item', 'zotero_pdf', 'zotero_search'], 'default tool names');
  assert(!main.tools.has('zotero_write'), 'zotero_write is advanced-only');
  for (const definition of main.tools.values()) {
    assertEqual(typeof definition.name, 'string', 'tool name');
    assert(typeof definition.description === 'string' && definition.description.length > 20, `${definition.name} description`);
    assertEqual(collectSchemaViolations(definition.parameters, `${definition.name}.parameters`).length, 0, `${definition.name} parameter schema`);
    assertEqual(collectSchemaViolations(definition.output.schema, `${definition.name}.output`).length, 0, `${definition.name} output schema`);
    assertEqual(typeof definition.output.render, 'function', `${definition.name} render function`);
    assertEqual(typeof definition.execute, 'function', `${definition.name} execute function`);
  }
});

await testAsync('plugin: rejects invalid arguments before execution', async () => {
  const definition = main.tools.get('zotero_bib');
  const violations = validateValue(definition.parameters, { action: 'bogus' }, 'args');
  assert(violations.length > 0, 'invalid enum action rejected by the argument schema');
  const missingRequired = validateValue(definition.parameters, {}, 'args');
  assert(missingRequired.some((violation) => violation.includes('action')), 'missing required action rejected');
});

await testAsync('plugin: zotero_search returns compact results and resolves collection names', async () => {
  const result = await callTool('zotero_search', { q: 'citation', limit: 10 });
  assertEqual(result.count, 2, 'search count');
  assert(result.items.every((item) => item.key.length === 8), 'item keys present');
  const first = result.items[0];
  assert(first.title.length > 0, 'title present');
  assert(Array.isArray(first.authors) && first.authors.length > 0, 'authors present');
  const byCollection = await callTool('zotero_search', { collection: 'Inkstone Papers', limit: 10 });
  assertEqual(byCollection.count, 1, 'collection name resolution count');
  assertEqual(byCollection.items[0].key, 'AAAA1111', 'collection name resolution key');
  assert(byCollection.notes.some((note) => note.includes('COLL0001')), 'resolution note present');
  const byTitle = await callTool('zotero_search', { title: 'typography' });
  assertEqual(byTitle.count, 1, 'title filter count');
  assertEqual(byTitle.items[0].key, 'BBBB2222', 'title filter key');
  const byType = await callTool('zotero_search', { itemType: 'article' });
  assertEqual(byType.count, 2, 'itemType article mapping');
  await assertRejects(
    () => callTool('zotero_search', { collection: 'No Such Collection' }),
    /找不到.*collection/,
    'unknown collection error',
  );
});

await testAsync('plugin: zotero_item returns metadata, citekey, attachments and annotations', async () => {
  const result = await callTool('zotero_item', { key: 'AAAA1111', includeAttachments: true, includeAnnotations: true });
  assertEqual(result.key, 'AAAA1111', 'item key');
  assertEqual(result.itemType, 'journalArticle', 'item type');
  assertEqual(result.metadata.title, 'Inkstone: A Suite for Chinese Academic Writing', 'metadata title');
  assertEqual(result.citekey, 'wang2024inkstone', 'citekey from bib index');
  assertEqual(result.citekeySource, 'bib', 'citekey source');
  assert(result.bibEntry && result.bibEntry.type === 'article', 'bib entry attached');
  assertEqual(result.attachments.length, 1, 'attachment count');
  assertEqual(result.attachments[0].filename, 'wang-2024-inkstone.pdf', 'attachment filename');
  assertEqual(result.attachments[0].exists, true, 'attachment file exists');
  assertEqual(result.annotations.length, 1, 'annotation count');
  assertEqual(result.annotations[0].text, 'Inkstone matters', 'annotation text');
  assertEqual(result.annotations[0].pageLabel, '3', 'annotation page');
  assert(result.notes.some((note) => note.includes('Reading notes')), 'child note text included');
  await assertRejects(() => callTool('zotero_item', { key: 'NOPE0000' }), /找不到/, 'missing item error');
});

await testAsync('plugin: zotero_item falls back to the Zotero citationKey without a bib index', async () => {
  const bare = createFakeContext({ localApiUrl: mock.url, dataDir: DATA_DIR, timeoutMs: 1000, advancedTools: false });
  const definition = bare.tools.get('zotero_item');
  const value = await definition.execute({ key: 'AAAA1111' }, exec);
  assertToolOutput(definition, { key: 'AAAA1111' }, value);
  assertEqual(value.citekey, 'wang2024inkstone', 'citekey from Zotero extra/citationKey');
  assertEqual(value.citekeySource, 'zotero', 'citekey source zotero');
  assertEqual(value.bibEntry, null, 'no bib entry without an index');
});

await testAsync('plugin: zotero_bib index/validate use configured + argument bib files', async () => {
  const indexed = await callTool('zotero_bib', { action: 'index' });
  assertEqual(indexed.entries, 7, 'configured files indexed (5 + 2)');
  assertEqual(indexed.duplicates.length, 0, 'no duplicates in config');
  assert(indexed.missing.some((item) => item.key === 'doe2020incomplete'), 'missing fields reported');
  assert(indexed.warnings.some((warning) => warning.includes('@string')), '@string warnings surfaced');
  assert(indexed.citekeys.includes('nested1999quotes'), 'citekeys listed');
  const validated = await callTool('zotero_bib', {
    action: 'validate',
    bibPaths: [path.join(BIB_FIXTURES, 'duplicates.bib')],
  });
  assertEqual(validated.ok, false, 'validate fails on duplicate key');
  assert(validated.duplicates.some((item) => item.key === 'wang2024inkstone'), 'duplicate key reported');
  assertEqual(validated.entries, 8, 'configured + extra file entries');
});

await testAsync('plugin: zotero_bib index reports corrupt bib files as actionable errors', async () => {
  // A context without configured bibFiles: the corrupt file is the only input,
  // so the action must fail with an actionable parse error.
  const bare = createFakeContext({ localApiUrl: mock.url, dataDir: DATA_DIR, timeoutMs: 1000, advancedTools: false });
  const bareBib = bare.tools.get('zotero_bib');
  await assertRejects(
    () => bareBib.execute({ action: 'index', bibPaths: [path.join(BIB_FIXTURES, 'corrupt.bib')] }, exec),
    /无法.*解析|解析.*条目/,
    'corrupt bib error',
  );
  // With valid configured files present, the corrupt path is reported but does not hide the good index.
  const validateCorrupt = await callTool('zotero_bib', {
    action: 'validate',
    bibPaths: [path.join(BIB_FIXTURES, 'corrupt.bib')],
  });
  assertEqual(validateCorrupt.ok, false, 'validate not ok');
  assert(validateCorrupt.errors.some((error) => error.includes('corrupt.bib')), 'corrupt file error reported');
});

await testAsync('plugin: zotero_bib export writes relative outPath and reports citekeys', async () => {
  const result = await callTool('zotero_bib', { action: 'export', outPath: 'out/refs.bib' });
  assertEqual(result.outPath, path.join(CWD, 'out', 'refs.bib'), 'outPath resolved against session cwd');
  assertEqual(result.source, 'local-api', 'export source');
  assertEqual(result.count, 2, 'exported entry count');
  assert(result.citekeys.includes('wang2024inkstone'), 'citekey list');
  assert(fs.existsSync(result.outPath), 'exported file exists');
  assertEqual(fs.readFileSync(result.outPath, 'utf8'), bibtexFixture, 'exported file content');
});

await testAsync('plugin: zotero_bib export falls back to generated entries', async () => {
  mock.state.bibtexFails = true;
  try {
    const result = await callTool('zotero_bib', { action: 'export', outPath: 'out/generated.bib' });
    assertEqual(result.source, 'generated', 'generated source');
    assertEqual(result.count, 4, 'generated entry count');
    assert(result.notes.some((note) => note.includes('format=bibtex')), 'fallback note');
    assert(fs.existsSync(result.outPath), 'generated file exists');
  } finally {
    mock.state.bibtexFails = false;
  }
});

await testAsync('plugin: zotero_bib export reports unreachable local API', async () => {
  const offline = createFakeContext({ localApiUrl: 'http://127.0.0.1:1', dataDir: DATA_DIR, timeoutMs: 1000, advancedTools: false });
  const definition = offline.tools.get('zotero_bib');
  await assertRejects(
    () => definition.execute({ action: 'export', outPath: 'refs.bib' }, exec),
    /导出失败[\s\S]*设置/,
    'unreachable export error',
  );
});

await testAsync('plugin: zotero_bib merge writes a de-duplicated result', async () => {
  const result = await callTool('zotero_bib', {
    action: 'merge',
    bibPaths: [path.join(BIB_FIXTURES, 'basic.bib'), path.join(BIB_FIXTURES, 'merge-extra.bib')],
    outPath: 'out/merged.bib',
  });
  assertEqual(result.entries, 6, 'merged entry count');
  assertDeepEqual(result.added, ['zhao2025extra'], 'added keys');
  assert(result.updated.includes('wang2024inkstone') && result.updated.includes('li2023typography'), 'updated keys');
  assert(result.conflicts.some((conflict) => conflict.field === 'pages'), 'field conflict reported');
  assert(fs.existsSync(result.outPath), 'merged file exists');
  const parsed = parseBib(fs.readFileSync(result.outPath, 'utf8'));
  assertEqual(parsed.errors.length, 0, 'merged file parses cleanly');
  assertEqual(parsed.entries.length, 6, 'merged file entry count');
  await assertRejects(
    () => callTool('zotero_bib', { action: 'merge', bibPaths: [path.join(BIB_FIXTURES, 'basic.bib')] }),
    /至少两个/,
    'merge needs two sources',
  );
});

await testAsync('plugin: bib cache invalidates on file changes and refresh', async () => {
  const cacheFile = path.join(TMP, 'cache-test.bib');
  fs.writeFileSync(cacheFile, '@misc{cacheone, title = {First}}\n', 'utf8');
  const first = await callTool('zotero_bib', { action: 'index', bibPaths: [cacheFile] });
  assert(first.citekeys.includes('cacheone'), 'initial entry indexed');
  fs.appendFileSync(cacheFile, '\n@misc{cachetwo, title = {Second}}\n', 'utf8');
  const second = await callTool('zotero_bib', { action: 'index', bibPaths: [cacheFile] });
  assertEqual(second.entries, first.entries + 1, 'cache invalidated by mtime/size change');
  assert(second.citekeys.includes('cachetwo'), 'new entry visible');
});

await testAsync('plugin: zotero_pdf path/text/annotations', async () => {
  const pathResult = await callTool('zotero_pdf', { action: 'path', itemKey: 'AAAA1111' });
  assertEqual(pathResult.action, 'path', 'path action');
  assertEqual(pathResult.attachmentKey, 'ATTA4444', 'resolved attachment key');
  assertEqual(pathResult.exists, true, 'attachment exists');
  assertEqual(pathResult.filename, 'wang-2024-inkstone.pdf', 'attachment filename');
  assert(pathResult.sizeBytes > 0, 'attachment size');
  const textResult = await callTool('zotero_pdf', { action: 'text', itemKey: 'AAAA1111', maxChars: 1000 });
  if (pdfAvailable) {
    assertEqual(textResult.method, 'pdftotext', 'text method');
    assertIncludes(textResult.text, 'Inkstone Zotero smoke', 'extracted text');
    assert(textResult.chars > 0, 'extracted char count');
  } else {
    assertEqual(textResult.method, 'none', 'none method');
    assert(textResult.notes.length > 0, 'no-text explanation');
  }
  const annotations = await callTool('zotero_pdf', { action: 'annotations', attachmentKey: 'ATTA4444' });
  assertEqual(annotations.count, 1, 'annotation count');
  assertEqual(annotations.annotations[0].comment, 'Key claim for the paper', 'annotation comment');
  await assertRejects(
    () => callTool('zotero_pdf', { action: 'path' }),
    /itemKey 或 attachmentKey/,
    'missing attachment arguments',
  );
});

await testAsync('plugin: zotero_enrich returns candidates and optional BibTeX', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.crossref.org')) {
      return new Response(JSON.stringify({
        message: {
          items: [{
            title: ['Enriched Inkstone Record'],
            author: [{ given: 'Xiao', family: 'Wang' }],
            issued: { 'date-parts': [[2024]] },
            'container-title': ['Journal of Enrichment'],
            DOI: '10.1000/enrich.2024.001',
            URL: 'https://example.org/enrich',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.openalex.org')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('export.arxiv.org')) {
      return new Response('<feed></feed>', { status: 200, headers: { 'content-type': 'application/atom+xml' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await callTool('zotero_enrich', { query: 'inkstone', asBibtex: true });
    assertEqual(result.candidates.length, 1, 'candidate count');
    assertEqual(result.candidates[0].title, 'Enriched Inkstone Record', 'candidate title');
    assertIncludes(result.bibtex, '@article{', 'BibTeX snippet');
    const parsed = parseBib(result.bibtex);
    assertEqual(parsed.entries.length, 1, 'BibTeX snippet parses');
    await assertRejects(() => callTool('zotero_enrich', {}), /至少一个/, 'missing enrich arguments');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await testAsync('plugin: local API unreachable produces actionable errors on tools', async () => {
  const offline = createFakeContext({ localApiUrl: 'http://127.0.0.1:1', dataDir: DATA_DIR, timeoutMs: 1000, advancedTools: false });
  const search = offline.tools.get('zotero_search');
  await assertRejects(() => search.execute({ q: 'anything' }, exec), /设置[\s\S]*高级/, 'search unreachable hint');
});

// ---------------------------------------------------------------------------
// Advanced tool registration (hermetic child processes for key resolution)
// ---------------------------------------------------------------------------

await testAsync('plugin: advancedTools gate registration of zotero_write', async () => {
  const advancedWithKey = createFakeContext({ localApiUrl: mock.url, dataDir: DATA_DIR, advancedTools: true, timeoutMs: 1000, apiKey: 'test-key' });
  assert(advancedWithKey.tools.has('zotero_write'), 'zotero_write registered with advancedTools + config apiKey');
  const writeDefinition = advancedWithKey.tools.get('zotero_write');
  assertEqual(collectSchemaViolations(writeDefinition.parameters, 'zotero_write.parameters').length, 0, 'write parameter schema');
  assertEqual(collectSchemaViolations(writeDefinition.output.schema, 'zotero_write.output').length, 0, 'write output schema');
  const advancedWithoutKey = createFakeContext({ localApiUrl: mock.url, dataDir: DATA_DIR, advancedTools: false, timeoutMs: 1000, apiKey: 'test-key' });
  assert(!advancedWithoutKey.tools.has('zotero_write'), 'zotero_write requires advancedTools: true');

  const pluginUrl = pathToFileURL(path.join(ROOT, 'plugins', 'zotero-ink', 'index.js')).href;
  const childScript = `
import { apply } from ${JSON.stringify(pluginUrl)};
const names = [];
apply({ tools: { register(definition) { names.push(definition.name); } } }, { advancedTools: true });
console.log(JSON.stringify(names));
`;
  const tempHome = path.join(TMP, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  const runChild = (apiKey) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        ZOTERO_API_KEY: apiKey,
        USERPROFILE: tempHome,
        HOME: tempHome,
        APPDATA: path.join(tempHome, 'AppData'),
      },
    });
    if (result.status !== 0) throw new Error(`child process failed (${result.status}): ${result.stderr}`);
    return JSON.parse(String(result.stdout).trim().split('\n').pop());
  };
  const withoutKey = runChild('');
  assert(!withoutKey.includes('zotero_write'), 'zotero_write not registered without any key source');
  const withEnvKey = runChild('child-test-key');
  assert(withEnvKey.includes('zotero_write'), 'zotero_write registered from ZOTERO_API_KEY');
});

// ---------------------------------------------------------------------------
// Optional real-Zotero verification
// ---------------------------------------------------------------------------

await testAsync('live: real Zotero local API when available', async () => {
  const liveClient = createZoteroClient({ timeoutMs: 1500 });
  const liveHealth = await liveClient.health();
  if (!liveHealth.localApi) {
    skipped.push('live Zotero checks (127.0.0.1:23119 unreachable)');
    console.log('SKIP live Zotero checks: 127.0.0.1:23119 unreachable');
    return;
  }
  const items = await liveClient.search({ limit: 3 });
  console.log(`LIVE Zotero: local API reachable, ${items.length} item(s) read (showing up to 3)`);
  const exported = await liveClient.exportBibtex({ limit: 3 });
  console.log(`LIVE Zotero: BibTeX export source=${exported.source}, ${exported.text.length} chars`);
  assert(Array.isArray(items), 'live search returns an array');
});

// ---------------------------------------------------------------------------
// Cleanup and summary
// ---------------------------------------------------------------------------

await mock.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log(`test-zotero: ${passed} passed, ${failures.length} failed, ${skipped.length} skipped.`);
if (failures.length > 0) {
  console.error('Failures:');
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
  process.exitCode = 1;
} else {
  console.log('test-zotero: OK');
}
