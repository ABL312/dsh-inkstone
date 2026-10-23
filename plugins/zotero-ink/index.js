/**
 * `墨 · Zotero 文献` — Zotero Host plugin for the dsh-inkstone bundle.
 *
 * Registers the model-facing tools:
 * - `zotero_search`   search/filter the local Zotero library;
 * - `zotero_item`     one item with metadata, citekey, attachments/annotations;
 * - `zotero_bib`      .bib project operations (index/export/validate/merge);
 * - `zotero_pdf`      attachment path, PDF text (`pdftotext`), annotations;
 * - `zotero_enrich`   read-only Crossref/OpenAlex/arXiv metadata completion;
 * - `zotero_write`    advanced + Zotero Web API key only (add-item/tag/note).
 *
 * Data comes from Zotero's read-only local API (`ZOTERO_LOCAL_API_URL`,
 * default `http://127.0.0.1:23119`), Better BibTeX-exported `.bib` files and
 * the Zotero data directory (`ZOTERO_DATA_DIR`, default `~/Zotero`). Writes
 * only go through the Zotero Web API and only when a key is available through
 * `lib/secrets.mjs` (config.apiKey → ZOTERO_API_KEY → config.apiKeyFile →
 * `~/.dsh-inkstone/zotero-api-key.txt`).
 *
 * Known limitations (reported in tool `notes` rather than silently hidden):
 * - the local API must be enabled in Zotero Settings → Advanced;
 * - PDF text extraction requires Poppler's `pdftotext` on PATH;
 * - bib-index caching invalidates on file mtime/size and on `refresh: true`; a
 *   newly added file inside a watched directory needs an explicit refresh;
 * - `citationStyle` is carried for pipeline/Typst use; this plugin does not
 *   format citations itself.
 *
 * Only Node built-ins and relative imports are used.
 *
 * @module dsh-inkstone/plugins/zotero-ink
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createZoteroClient } from '../../lib/zotero-client.mjs';
import {
  citekeyOf,
  findMissingFields,
  indexByCitekey,
  loadBibFiles,
  mergeEntries,
  parseBib,
  serializeBib,
} from '../../lib/bib.mjs';
import {
  envValue,
  errorMessage,
  normalizeConfig,
  optionalInteger,
  optionalString,
  renderSummary,
  requireString,
  sessionCwd,
  configured,
  truncate,
} from '../../lib/tool-kit.mjs';
import { ensureDir } from '../../lib/paths.mjs';
import { secretHint, zoteroApiKey } from '../../lib/secrets.mjs';

/** Plugin id shown by the DSH plugin loader. */
export const name = 'zotero-ink';

/** This plugin only registers tools. */
export const inject = ['tools'];

/** Hard cap on text handed back in a single tool output (CONTRACT §0.6). */
const TOOL_TEXT_LIMIT = 30000;

/** Module-level bib cache bound (one entry per discovered file set). */
const BIB_CACHE_LIMIT = 16;

/** Citekey index cache shared by all tool calls of this plugin instance. */
const bibCache = new Map();

/**
 * JSON round-trip: guarantees tool outputs are lossless plain JSON records
 * (drops `undefined`, never exposes class instances to the output validator).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolve a possibly relative path against the invoking session cwd.
 * @param {string} cwd
 * @param {string} value
 * @returns {string}
 */
function resolvePath(cwd, value) {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/**
 * Read an optional string-array argument.
 * @param {Record<string, any>} args
 * @param {string} name
 * @returns {string[] | undefined}
 */
function stringArray(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`invalid arguments: "${name}" must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Read an optional plain-object argument.
 * @param {Record<string, any>} args
 * @param {string} name
 * @returns {Record<string, any> | undefined}
 */
function plainObject(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid arguments: "${name}" must be an object`);
  }
  return value;
}

/**
 * File signature used for the bib cache (mtime + size per discovered file).
 * @param {string[]} files
 * @returns {string}
 */
function fileSignature(files) {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${file}:missing`;
    }
  }).join('|');
}

/**
 * Load a bib project (with module-level cache) and build its citekey index.
 *
 * The cache key is the resolved input list; the signature is the mtime/size of
 * the discovered `.bib` files, so edits are picked up without a restart.
 *
 * @param {string[]} rawFiles absolute or relative .bib files / directories
 * @param {{refresh?: boolean}} [options]
 * @returns {object} loadBibFiles result plus `index` and `missing`
 */
function loadBibIndex(rawFiles, options = {}) {
  const resolved = [...new Set((rawFiles ?? [])
    .filter((file) => typeof file === 'string' && file.trim().length > 0)
    .map((file) => path.resolve(file.trim())))];
  if (resolved.length === 0) {
    return {
      files: [],
      entries: [],
      duplicates: [],
      errors: [],
      warnings: [],
      index: new Map(),
      missing: [],
    };
  }
  const cacheKey = resolved.join('\n');
  const cached = bibCache.get(cacheKey);
  if (cached && options.refresh !== true) {
    const signature = fileSignature(cached.value.files.length > 0 ? cached.value.files : resolved);
    if (signature === cached.signature) {
      // Refresh LRU position.
      bibCache.delete(cacheKey);
      bibCache.set(cacheKey, cached);
      return cached.value;
    }
    bibCache.delete(cacheKey);
  } else if (cached) {
    bibCache.delete(cacheKey);
  }
  const result = loadBibFiles(resolved);
  const index = indexByCitekey(result.entries);
  const missing = result.entries
    .map((entry) => ({ key: entry.key, type: entry.type, fields: findMissingFields(entry) }))
    .filter((item) => item.fields.length > 0);
  const value = { ...result, index, missing };
  bibCache.set(cacheKey, {
    signature: fileSignature(result.files.length > 0 ? result.files : resolved),
    value,
  });
  while (bibCache.size > BIB_CACHE_LIMIT) {
    const oldest = bibCache.keys().next().value;
    bibCache.delete(oldest);
  }
  return value;
}

/**
 * Build the configured bib index (CONTRACT: `config.bibFiles` participates in
 * every action). Bib problems are reported as notes, never fatal here.
 * @param {string[]} configuredFiles
 * @param {string} cwd
 * @returns {{index: Map<string, any> | null, notes: string[], loaded: object | null}}
 */
function configuredBibIndex(configuredFiles, cwd) {
  if (configuredFiles.length === 0) return { index: null, notes: [], loaded: null };
  try {
    const loaded = loadBibIndex(configuredFiles.map((file) => resolvePath(cwd, file)));
    const notes = [];
    if (loaded.errors.length > 0) {
      notes.push(`配置的 bibFiles 存在解析错误：${loaded.errors.slice(0, 3).join('；')}`);
    }
    return { index: loaded.index, notes, loaded };
  } catch (error) {
    return { index: null, notes: [`读取配置的 bibFiles 失败：${errorMessage(error)}`], loaded: null };
  }
}

/**
 * Display name of one Zotero creator.
 * @param {any} creator
 * @returns {string}
 */
function creatorDisplayName(creator) {
  if (!creator || typeof creator !== 'object') return '';
  if (typeof creator.name === 'string' && creator.name.trim().length > 0) return creator.name.trim();
  return [creator.firstName, creator.lastName]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
}

/**
 * BBT citation key stored on a Zotero item (property or `extra` line).
 * @param {Record<string, any>} data
 * @returns {string}
 */
function citationKeyFromItem(data) {
  if (data && typeof data.citationKey === 'string' && data.citationKey.trim().length > 0) {
    return data.citationKey.trim();
  }
  const extra = typeof data?.extra === 'string' ? data.extra : '';
  const match = extra.match(/^(?:citation\s*key|citekey)\s*[:=]\s*(\S+)\s*$/im);
  return match && typeof match[1] === 'string' ? match[1] : '';
}

/**
 * Year string of a Zotero date field.
 * @param {unknown} value
 * @returns {string}
 */
function yearOfDate(value) {
  const match = String(value ?? '').match(/(\d{4})/);
  return match ? match[1] : '';
}

/**
 * Citekey of a Zotero item, but only when it hits the configured bib index.
 * @param {Record<string, any>} data
 * @param {Map<string, any> | null} index
 * @returns {string}
 */
function indexedCitekey(data, index) {
  if (!index) return '';
  const direct = citationKeyFromItem(data);
  if (direct.length > 0) {
    const hit = index.get(direct.toLowerCase());
    if (hit) return hit.key;
  }
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const authors = creators
    .filter((creator) => creator && (creator.creatorType === 'author' || creator.creatorType === undefined))
    .map(creatorDisplayName)
    .filter(Boolean);
  const derived = citekeyOf({
    type: 'misc',
    key: '',
    fields: {
      author: authors.join(' and '),
      year: yearOfDate(data.date),
      title: String(data.title ?? ''),
    },
  });
  const hit = index.get(derived.toLowerCase());
  return hit ? hit.key : '';
}

/**
 * Tag names of a Zotero item.
 * @param {any} tags
 * @returns {string[]}
 */
function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.tag))
    .filter((tag) => typeof tag === 'string' && tag.length > 0);
}

/**
 * Compact search-result view of one Zotero item.
 * @param {any} item
 * @param {Map<string, any> | null} index
 * @returns {object}
 */
function summarizeItem(item, index) {
  const data = item?.data ?? item ?? {};
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const authors = creators
    .filter((creator) => creator && (creator.creatorType === 'author' || creator.creatorType === 'editor'))
    .map(creatorDisplayName)
    .filter(Boolean);
  const venue = String(
    data.publicationTitle ?? data.bookTitle ?? data.proceedingsTitle ?? data.conferenceName ?? '',
  );
  const citekey = indexedCitekey(data, index) || citationKeyFromItem(data);
  return {
    key: String(data.key ?? item?.key ?? ''),
    itemType: String(data.itemType ?? ''),
    title: String(data.title ?? ''),
    authors,
    year: yearOfDate(data.date),
    date: String(data.date ?? ''),
    venue,
    doi: String(data.DOI ?? ''),
    url: String(data.url ?? ''),
    tags: tagNames(data.tags),
    citekey,
  };
}

/**
 * Metadata view of one Zotero item for `zotero_item`.
 * @param {Record<string, any>} data
 * @returns {Record<string, any>}
 */
function itemMetadata(data) {
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const metadata = {
    key: String(data.key ?? ''),
    itemType: String(data.itemType ?? ''),
    title: String(data.title ?? ''),
    creators: creators.map((creator) => ({
      creatorType: String(creator?.creatorType ?? ''),
      name: creatorDisplayName(creator),
    })),
    date: String(data.date ?? ''),
    year: yearOfDate(data.date),
    tags: tagNames(data.tags),
    collections: Array.isArray(data.collections) ? data.collections.map(String) : [],
    extra: String(data.extra ?? ''),
    citationKey: citationKeyFromItem(data),
    dateAdded: String(data.dateAdded ?? ''),
    dateModified: String(data.dateModified ?? ''),
  };
  const stringFields = [
    'publicationTitle',
    'bookTitle',
    'proceedingsTitle',
    'conferenceName',
    'volume',
    'issue',
    'pages',
    'DOI',
    'url',
    'abstractNote',
    'language',
    'publisher',
    'place',
    'university',
    'thesisType',
    'reportType',
    'reportNumber',
    'ISBN',
    'ISSN',
    'shortTitle',
    'note',
  ];
  for (const field of stringFields) {
    if (typeof data[field] === 'string' && data[field].length > 0) {
      metadata[field] = field === 'abstractNote' || field === 'note' ? truncate(data[field], 4000) : data[field];
    }
  }
  return metadata;
}

/**
 * Map a child attachment item to the tool output shape.
 * @param {any} child
 * @param {any} client
 * @param {string[]} notes
 * @returns {object}
 */
function attachmentView(child, client, notes) {
  const data = child?.data ?? child ?? {};
  const key = String(data.key ?? child?.key ?? '');
  let attachmentPath = '';
  let pathError = '';
  try {
    attachmentPath = client.getAttachmentPath(child);
  } catch (error) {
    pathError = errorMessage(error);
    notes.push(`附件 ${key} 的路径无法解析：${pathError}`);
  }
  let exists = false;
  if (attachmentPath.length > 0) {
    try {
      exists = fs.existsSync(attachmentPath);
    } catch {
      exists = false;
    }
  }
  return {
    key,
    title: String(data.title ?? ''),
    filename: String(data.filename ?? (attachmentPath.length > 0 ? path.basename(attachmentPath) : '')),
    contentType: String(data.contentType ?? ''),
    path: attachmentPath,
    exists,
  };
}

/**
 * Map an annotation child item to the tool output shape.
 * @param {any} child
 * @returns {object}
 */
function annotationView(child) {
  const data = child?.data ?? child ?? {};
  return {
    key: String(data.key ?? child?.key ?? ''),
    type: String(data.annotationType ?? data.itemType ?? ''),
    text: String(data.annotationText ?? ''),
    comment: String(data.annotationComment ?? ''),
    pageLabel: String(data.annotationPageLabel ?? ''),
    color: String(data.annotationColor ?? ''),
    dateModified: String(data.dateModified ?? ''),
  };
}

/**
 * Strip HTML tags from a Zotero note for plain-text output.
 * @param {unknown} html
 * @returns {string}
 */
function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Escape text for a minimal HTML note body.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Candidate → one-entry BibTeX fragment for `zotero_enrich { asBibtex: true }`.
 * @param {object} candidate
 * @returns {{type: string, key: string, fields: Record<string, string>}}
 */
function candidateToEntry(candidate) {
  const fields = {};
  if (typeof candidate.title === 'string' && candidate.title.length > 0) fields.title = candidate.title;
  if (Array.isArray(candidate.authors) && candidate.authors.length > 0) fields.author = candidate.authors.join(' and ');
  if (Number.isInteger(candidate.year)) fields.year = String(candidate.year);
  if (typeof candidate.doi === 'string' && candidate.doi.length > 0) fields.doi = candidate.doi;
  if (typeof candidate.venue === 'string' && candidate.venue.length > 0) fields.journal = candidate.venue;
  if (typeof candidate.url === 'string' && candidate.url.length > 0) fields.url = candidate.url;
  const entry = { type: 'article', key: '', fields };
  entry.key = citekeyOf(entry);
  return entry;
}

/**
 * Deduplicate a list of `{ key, count }` duplicate records.
 * @param {Array<{key: string, count: number}>} duplicates
 * @returns {Array<{key: string, count: number}>}
 */
function mergeDuplicateRecords(duplicates) {
  const map = new Map();
  for (const duplicate of duplicates) {
    if (!duplicate || typeof duplicate.key !== 'string') continue;
    const lowered = duplicate.key.toLowerCase();
    const existing = map.get(lowered);
    if (existing) existing.count += duplicate.count ?? 1;
    else map.set(lowered, { key: duplicate.key, count: duplicate.count ?? 1 });
  }
  return [...map.values()].sort((left, right) => (left.key.toLowerCase() < right.key.toLowerCase() ? -1 : 1));
}

/**
 * Collect the bib inputs for an action: configured files first, then arguments.
 * @param {string[]} configuredFiles
 * @param {string} cwd
 * @param {string[] | undefined} extraPaths
 * @returns {string[]}
 */
function bibInputs(configuredFiles, cwd, extraPaths) {
  const inputs = [];
  for (const file of configuredFiles) inputs.push(path.resolve(cwd, file));
  for (const file of extraPaths ?? []) inputs.push(path.resolve(cwd, file));
  return [...new Set(inputs)];
}

/**
 * Read the Zotero Web API user id from the environment.
 * @returns {string}
 */
function webApiUserId() {
  return envValue('ZOTERO_API_USER_ID') ?? '0';
}

/**
 * Extract `{ key, version }` from a Zotero Web API write response.
 * @param {any} response
 * @param {string} actionLabel
 * @returns {{key: string, version: number | null}}
 */
function writeResult(response, actionLabel) {
  if (!response || typeof response !== 'object') return { key: '', version: null };
  const failed = response.failed && typeof response.failed === 'object' ? Object.entries(response.failed) : [];
  if (failed.length > 0) {
    const first = failed[0][1];
    const message = typeof first === 'string' ? first : JSON.stringify(first).slice(0, 500);
    throw new Error(`Zotero Web API ${actionLabel} 失败：${message}`);
  }
  const successful = response.successful && typeof response.successful === 'object'
    ? Object.values(response.successful)[0]
    : undefined;
  if (successful && typeof successful === 'object') {
    return {
      key: typeof successful.key === 'string' ? successful.key : '',
      version: Number.isInteger(successful.version) ? successful.version : null,
    };
  }
  return { key: '', version: null };
}

// ---------------------------------------------------------------------------
// Shared JSON-Schema fragments. Only the enforced subset is used: one scalar
// `type`, properties/required/additionalProperties, items, enum/const, oneOf
// and annotations. Nullable values use an exact-one `oneOf` branch pair.
// ---------------------------------------------------------------------------

/** @type {object} */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] };

/** @type {object} */
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] };

/** @type {object} */
const STRING_LIST = { type: 'array', items: { type: 'string' } };

/** @type {object} */
const SEARCH_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'itemType', 'title', 'authors', 'year', 'date', 'venue', 'doi', 'url', 'tags', 'citekey'],
  properties: {
    key: { type: 'string', description: 'Zotero item key' },
    itemType: { type: 'string' },
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    year: { type: 'string' },
    date: { type: 'string' },
    venue: { type: 'string' },
    doi: { type: 'string' },
    url: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    citekey: { type: 'string' },
  },
};

/** @type {object} */
const ATTACHMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'title', 'filename', 'contentType', 'path', 'exists'],
  properties: {
    key: { type: 'string' },
    title: { type: 'string' },
    filename: { type: 'string' },
    contentType: { type: 'string' },
    path: { type: 'string', description: 'Absolute path, empty when unresolvable' },
    exists: { type: 'boolean' },
  },
};

/** @type {object} */
const ANNOTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'type', 'text', 'comment', 'pageLabel', 'color', 'dateModified'],
  properties: {
    key: { type: 'string' },
    type: { type: 'string' },
    text: { type: 'string' },
    comment: { type: 'string' },
    pageLabel: { type: 'string' },
    color: { type: 'string' },
    dateModified: { type: 'string' },
  },
};

/** @type {object} */
const DUPLICATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'count', 'files'],
  properties: {
    key: { type: 'string' },
    count: { type: 'integer' },
    files: { type: 'array', items: { type: 'string' } },
  },
};

/** @type {object} */
const MISSING_FIELDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'type', 'fields'],
  properties: {
    key: { type: 'string' },
    type: { type: 'string' },
    fields: { type: 'array', items: { type: 'string' } },
  },
};

/** @type {object} */
const CONFLICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'field', 'base', 'extra'],
  properties: {
    key: { type: 'string' },
    field: { type: 'string' },
    base: { type: 'string' },
    extra: { type: 'string' },
  },
};

/** @type {object} */
const ENRICH_CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'authors', 'year', 'doi', 'venue', 'url', 'source'],
  properties: {
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    year: NULLABLE_INTEGER,
    doi: NULLABLE_STRING,
    venue: NULLABLE_STRING,
    url: NULLABLE_STRING,
    source: { type: 'string', enum: ['crossref', 'openalex', 'arxiv'] },
  },
};

/** @type {object} */
const CREATOR_ARG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    name: { type: 'string', description: 'Single-field creator name' },
    creatorType: { type: 'string', description: 'author/editor/…, default author' },
  },
};

/**
 * Register all Zotero tools on the provided context.
 * @param {any} ctx plugin context
 * @param {any} rawConfig plugin config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const localApiUrl = configured(config, 'localApiUrl', 'ZOTERO_LOCAL_API_URL', 'http://127.0.0.1:23119');
  const dataDir = configured(config, 'dataDir', 'ZOTERO_DATA_DIR', undefined);
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 15000;
  const citationStyle = typeof config.citationStyle === 'string' && config.citationStyle.length > 0
    ? config.citationStyle
    : 'gb-7714-2015-numeric';
  const configuredBibFiles = Array.isArray(config.bibFiles)
    ? config.bibFiles.filter((file) => typeof file === 'string' && file.trim().length > 0)
    : [];
  const userId = webApiUserId();
  const clientOptions = { localApiUrl, dataDir, timeoutMs, userId };
  const client = createZoteroClient(clientOptions);

  /**
   * Resolve a collection argument (key or human-readable name) to a key.
   * @param {string | undefined} value
   * @returns {Promise<{key: string | undefined, notes: string[]}>}
   */
  async function resolveCollectionKey(value) {
    if (typeof value !== 'string' || value.length === 0) return { key: undefined, notes: [] };
    if (/^[A-Za-z0-9]{8}$/.test(value)) return { key: value, notes: [] };
    const collections = await client.listCollections();
    const wanted = value.toLowerCase();
    const exact = collections.filter((collection) => collection.name.toLowerCase() === wanted);
    const partial = collections.filter((collection) => collection.name.toLowerCase().includes(wanted));
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 0) {
      const available = collections.slice(0, 12).map((collection) => `${collection.key} (${collection.name})`).join('、');
      throw new Error(`找不到名为 "${value}" 的 Zotero collection。可用 collection：${available || '（无）'}。`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((collection) => `${collection.key} (${collection.name})`).join('、');
      throw new Error(`collection 名称 "${value}" 匹配到多个：${candidates}。请直接传入 collection key。`);
    }
    return { key: matches[0].key, notes: [`collection "${matches[0].name}" 已解析为 key ${matches[0].key}。`] };
  }

  /**
   * Resolve i) an explicit attachment argument or ii) the PDF attachment of an
   * item to one attachment item. Returns helper notes for ambiguous choices.
   * @param {Record<string, any>} args
   * @returns {Promise<{attachment: any, data: Record<string, any>, itemKey: string, notes: string[]}>}
   */
  async function resolveAttachment(args) {
    const attachmentKey = optionalString(args, 'attachmentKey');
    const itemKey = optionalString(args, 'itemKey');
    if (!attachmentKey && !itemKey) {
      throw new Error('zotero_pdf 需要 itemKey 或 attachmentKey（二选一）。先调用 zotero_search 找到条目的 key。');
    }
    if (attachmentKey) {
      const item = await client.getItem(attachmentKey);
      const data = item?.data ?? item ?? {};
      if (data.itemType === 'annotation') {
        throw new Error(`"${attachmentKey}" 是批注（annotation），不是附件。请传入附件 key 或父条目 key。`);
      }
      if (data.itemType !== 'attachment') {
        throw new Error(`"${attachmentKey}" 不是 Zotero 附件条目（itemType=${String(data.itemType ?? 'unknown')}）。请传入附件 key，或用 itemKey 传入父条目。`);
      }
      return {
        attachment: item,
        data,
        itemKey: typeof data.parentItem === 'string' ? data.parentItem : '',
        notes: [],
      };
    }
    const item = await client.getItem(itemKey);
    const data = item?.data ?? item ?? {};
    if (data.itemType === 'attachment') {
      return { attachment: item, data, itemKey: typeof data.parentItem === 'string' ? data.parentItem : '', notes: [] };
    }
    const children = await client.getChildren(itemKey);
    const attachments = children.filter((child) => (child?.data ?? child)?.itemType === 'attachment');
    const pdfs = attachments.filter((child) => {
      const childData = child?.data ?? child;
      return String(childData.contentType ?? '').toLowerCase() === 'application/pdf'
        || String(childData.filename ?? '').toLowerCase().endsWith('.pdf');
    });
    const chosen = pdfs[0] ?? attachments[0];
    if (!chosen) {
      throw new Error(`条目 "${itemKey}" 没有附件。可用 zotero_item(includeAttachments=true) 查看条目详情。`);
    }
    const notes = [];
    if (pdfs.length === 0) {
      notes.push(`条目 "${itemKey}" 没有 PDF 附件，改用第一个附件（${(chosen.data ?? chosen).title ?? ''}）。`);
    } else if (pdfs.length > 1) {
      notes.push(`条目 "${itemKey}" 有 ${pdfs.length} 个 PDF 附件，使用第一个（${(chosen.data ?? chosen).key ?? ''}）。`);
    }
    return { attachment: chosen, data: chosen?.data ?? chosen, itemKey, notes };
  }

  // -------------------------------------------------------------------------
  // 1. zotero_search
  // -------------------------------------------------------------------------
  ctx.tools.register({
    name: 'zotero_search',
    description: 'Search the local Zotero library (read-only) and return compact item summaries with keys, authors, year, venue and citekeys. Use collection (key or name), tag, itemType, title/author/year filters, or q for a general query.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'General search query passed to the Zotero local API.' },
        title: { type: 'string', description: 'Case-insensitive title substring filter.' },
        author: { type: 'string', description: 'Case-insensitive creator name filter.' },
        year: { type: 'integer', description: 'Publication year filter.' },
        tag: { type: 'string', description: 'Exact tag filter.' },
        collection: { type: 'string', description: 'Collection key (8 chars) or collection name.' },
        itemType: { type: 'string', description: 'Zotero item type (journalArticle/book/...) or BibTeX type (article/book/...).' },
        limit: { type: 'integer', description: 'Maximum results (1-100, default 20).' },
        sort: { type: 'string', description: 'Local API sort field, e.g. dateModified, date, title, creator.' },
        direction: { type: 'string', enum: ['asc', 'desc'] },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'count', 'items', 'notes'],
        properties: {
          query: { type: 'object', additionalProperties: true },
          count: { type: 'integer' },
          items: { type: 'array', items: SEARCH_ITEM_SCHEMA },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = value.items.slice(0, 20).map((item) => {
          const authors = item.authors.length > 0 ? item.authors.join(', ') : '—';
          const citekey = item.citekey.length > 0 ? ` @${item.citekey}` : '';
          return `${item.key} | ${authors} ${item.year || '????'} | ${item.title} | ${item.itemType}${citekey}`;
        });
        const summary = value.count > 0
          ? `Zotero 检索：${value.count} 条结果${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`
          : 'Zotero 检索：没有匹配的文献。';
        return renderSummary(summary, { items: value.items, notes: value.notes });
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const limit = optionalInteger(args, 'limit', 20, 100);
      const year = Number.isInteger(args.year) ? args.year : undefined;
      const collectionArg = optionalString(args, 'collection');
      const collection = await resolveCollectionKey(collectionArg);
      const configured = configuredBibIndex(configuredBibFiles, cwd);
      const items = await client.search({
        q: optionalString(args, 'q'),
        title: optionalString(args, 'title'),
        author: optionalString(args, 'author'),
        year,
        tag: optionalString(args, 'tag'),
        collection: collection.key,
        itemType: optionalString(args, 'itemType'),
        limit,
        sort: optionalString(args, 'sort'),
        direction: optionalString(args, 'direction'),
      });
      const summaries = items.map((item) => summarizeItem(item, configured.index));
      return jsonSafe({
        query: {
          q: optionalString(args, 'q') ?? '',
          title: optionalString(args, 'title') ?? '',
          author: optionalString(args, 'author') ?? '',
          year: year ?? 0,
          tag: optionalString(args, 'tag') ?? '',
          collection: collection.key ?? '',
          itemType: optionalString(args, 'itemType') ?? '',
          limit,
        },
        count: summaries.length,
        items: summaries,
        notes: [...collection.notes, ...configured.notes],
      });
    },
  });

  // -------------------------------------------------------------------------
  // 2. zotero_item
  // -------------------------------------------------------------------------
  ctx.tools.register({
    name: 'zotero_item',
    description: 'Read one Zotero item by key: metadata, BBT citekey and matching .bib entry, attachments (with absolute paths) and annotations. Set includeAttachments/includeAnnotations to fetch child data (one extra local API call each).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Zotero item key (8-character).' },
        includeAttachments: { type: 'boolean', description: 'Include child attachment items with resolved file paths.' },
        includeAnnotations: { type: 'boolean', description: 'Include PDF annotations (and notes) of the item/its PDF attachments.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'itemType', 'metadata', 'citekey', 'citekeySource', 'bibEntry', 'attachments', 'annotations', 'notes'],
        properties: {
          key: { type: 'string' },
          itemType: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
          citekey: { type: 'string' },
          citekeySource: { type: 'string', enum: ['bib', 'zotero', 'none'] },
          bibEntry: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          attachments: { type: 'array', items: ATTACHMENT_SCHEMA },
          annotations: { type: 'array', items: ANNOTATION_SCHEMA },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const authors = value.metadata.creators.map((creator) => creator.name).filter(Boolean).join(', ');
        const header = [
          `${value.key} (${value.itemType}) ${value.metadata.title}`,
          authors ? `作者：${authors}` : '',
          value.metadata.year ? `年份：${value.metadata.year}` : '',
          value.citekey ? `citekey：${value.citekey}（${value.citekeySource}）` : 'citekey：未命中（可用 zotero_bib index 建立 .bib 索引）',
          value.attachments.length > 0 ? `附件：${value.attachments.length} 个` : '',
          value.annotations.length > 0 ? `批注：${value.annotations.length} 条` : '',
        ].filter(Boolean);
        return renderSummary(header.join('\n'), {
          metadata: value.metadata,
          bibEntry: value.bibEntry,
          attachments: value.attachments,
          annotations: value.annotations,
          notes: value.notes,
        });
      },
    },
    async execute(args, exec) {
      const key = requireString(args, 'key');
      const includeAttachments = args.includeAttachments === true;
      const includeAnnotations = args.includeAnnotations === true;
      const cwd = sessionCwd(exec);
      const item = await client.getItem(key);
      const data = item?.data ?? item ?? {};
      const itemKey = String(data.key ?? key);
      const itemType = String(data.itemType ?? '');
      const configured = configuredBibIndex(configuredBibFiles, cwd);
      const notes = [...configured.notes];
      const rawCitationKey = citationKeyFromItem(data);
      let citekey = rawCitationKey;
      let citekeySource = rawCitationKey.length > 0 ? 'zotero' : 'none';
      const indexed = indexedCitekey(data, configured.index);
      if (indexed.length > 0) {
        citekey = indexed;
        citekeySource = 'bib';
      }
      let bibEntry = null;
      if (citekey.length > 0 && configured.index) {
        const hit = configured.index.get(citekey.toLowerCase());
        if (hit) {
          bibEntry = { type: hit.type, key: hit.key, fields: hit.fields ?? {} };
          citekeySource = 'bib';
        }
      }
      const attachments = [];
      const annotations = [];
      const childCache = new Map();
      const loadChildren = async (childKey) => {
        if (!childCache.has(childKey)) childCache.set(childKey, await client.getChildren(childKey));
        return childCache.get(childKey);
      };
      if (includeAttachments || includeAnnotations) {
        let children = [];
        if (itemType !== 'attachment' && itemType !== 'annotation' && itemType !== 'note') {
          children = await loadChildren(itemKey);
        }
        if (includeAttachments) {
          const candidates = itemType === 'attachment' ? [item] : children;
          for (const child of candidates) {
            const childData = child?.data ?? child ?? {};
            if (childData.itemType !== 'attachment') continue;
            attachments.push(attachmentView(child, client, notes));
          }
        }
        if (includeAnnotations) {
          const annotationTargets = itemType === 'annotation'
            ? [{ data }]
            : (itemType === 'attachment' ? [item] : children).filter((child) => (child?.data ?? child)?.itemType === 'attachment');
          for (const target of annotationTargets) {
            const targetKey = String((target?.data ?? target)?.key ?? '');
            if (targetKey.length === 0) continue;
            let targetChildren = childCache.get(targetKey);
            if (!targetChildren) {
              targetChildren = await loadChildren(targetKey);
            }
            for (const child of targetChildren) {
              const childData = child?.data ?? child ?? {};
              if (childData.itemType === 'annotation') annotations.push(annotationView(child));
              else if (childData.itemType === 'note' && String(childData.note ?? '').length > 0) {
                notes.push(`笔记 ${String(childData.key ?? '')}：${truncate(stripHtml(childData.note), 2000)}`);
              }
            }
          }
          if (itemType === 'annotation') annotations.push(annotationView(item));
          if (itemType === 'note' && String(data.note ?? '').length > 0) {
            notes.push(`笔记 ${itemKey}：${truncate(stripHtml(data.note), 2000)}`);
          }
        }
        // Notes attached directly to a top-level item are useful context.
        for (const child of children) {
          const childData = child?.data ?? child ?? {};
          if (childData.itemType === 'note' && String(childData.note ?? '').length > 0) {
            notes.push(`笔记 ${String(childData.key ?? '')}：${truncate(stripHtml(childData.note), 2000)}`);
          }
        }
      }
      return jsonSafe({
        key: itemKey,
        itemType,
        metadata: itemMetadata(data),
        citekey,
        citekeySource,
        bibEntry,
        attachments,
        annotations,
        notes,
      });
    },
  });

  // -------------------------------------------------------------------------
  // 3. zotero_bib
  // -------------------------------------------------------------------------
  ctx.tools.register({
    name: 'zotero_bib',
    description: 'Work with .bib bibliography files: index (parse config.bibFiles + bibPaths, report duplicates/missing fields), export (Zotero → .bib file at outPath, default <cwd>/refs.bib), validate (missing fields/duplicate keys), merge (merge multiple .bib sources into outPath).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['index', 'export', 'validate', 'merge'] },
        bibPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra .bib files or directories (relative to the session cwd) for index/validate/merge.',
        },
        collection: { type: 'string', description: 'Zotero collection key or name for export.' },
        itemKeys: { type: 'array', items: { type: 'string' }, description: 'Zotero item keys for export.' },
        outPath: { type: 'string', description: 'Output .bib path for export/merge (default <cwd>/refs.bib).' },
        mergeFrom: { type: 'array', items: { type: 'string' }, description: 'Merge sources for action=merge; falls back to bibPaths/config.bibFiles.' },
        refresh: { type: 'boolean', description: 'Force re-reading bib files (ignore the mtime cache).' },
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'files', 'entries', 'duplicates', 'missing', 'warnings', 'errors', 'citekeys'],
            properties: {
              action: { type: 'string', const: 'index' },
              files: STRING_LIST,
              entries: { type: 'integer' },
              duplicates: { type: 'array', items: DUPLICATE_SCHEMA },
              missing: { type: 'array', items: MISSING_FIELDS_SCHEMA },
              warnings: STRING_LIST,
              errors: STRING_LIST,
              citekeys: STRING_LIST,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'outPath', 'source', 'count', 'citekeys', 'notes', 'bytes'],
            properties: {
              action: { type: 'string', const: 'export' },
              outPath: { type: 'string' },
              source: { type: 'string', enum: ['local-api', 'generated'] },
              count: { type: 'integer' },
              citekeys: STRING_LIST,
              notes: STRING_LIST,
              bytes: { type: 'integer' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'ok', 'files', 'entries', 'duplicates', 'missing', 'errors', 'warnings'],
            properties: {
              action: { type: 'string', const: 'validate' },
              ok: { type: 'boolean' },
              files: STRING_LIST,
              entries: { type: 'integer' },
              duplicates: { type: 'array', items: DUPLICATE_SCHEMA },
              missing: { type: 'array', items: MISSING_FIELDS_SCHEMA },
              errors: STRING_LIST,
              warnings: STRING_LIST,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'outPath', 'files', 'entries', 'added', 'updated', 'duplicates', 'conflicts', 'notes'],
            properties: {
              action: { type: 'string', const: 'merge' },
              outPath: { type: 'string' },
              files: STRING_LIST,
              entries: { type: 'integer' },
              added: STRING_LIST,
              updated: STRING_LIST,
              duplicates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'count'],
                  properties: { key: { type: 'string' }, count: { type: 'integer' } },
                },
              },
              conflicts: { type: 'array', items: CONFLICT_SCHEMA },
              notes: STRING_LIST,
            },
          },
        ],
      },
      render: (_args, value) => {
        if (value.action === 'export') {
          return renderSummary(
            `已导出 ${value.count} 条文献到 ${value.outPath}（来源：${value.source}，${value.bytes} 字节）。\ncitekey：${value.citekeys.slice(0, 15).join(', ') || '（无）'}`,
            { citekeys: value.citekeys, notes: value.notes },
          );
        }
        if (value.action === 'merge') {
          return renderSummary(
            `已合并 ${value.files.length} 个来源 → ${value.outPath}：${value.entries} 条（新增 ${value.added.length}，更新 ${value.updated.length}，冲突 ${value.conflicts.length}）。`,
            { added: value.added, updated: value.updated, duplicates: value.duplicates, conflicts: value.conflicts, notes: value.notes },
          );
        }
        const missing = value.missing.map((item) => `${item.key}: ${item.fields.join(', ')}`).join('\n');
        const duplicates = value.duplicates.map((item) => `${item.key} ×${item.count}`).join(', ');
        const okLabel = value.action === 'validate' ? (value.ok ? '通过' : '未通过') : '索引完成';
        return renderSummary(
          `bib ${value.action}：${okLabel}，${value.entries} 条，${value.duplicates.length} 个重复 key，${value.missing.length} 条缺字段。${duplicates ? `\n重复：${duplicates}` : ''}${missing ? `\n缺字段：\n${missing}` : ''}`,
          {
            files: value.files,
            errors: value.errors,
            warnings: value.warnings,
            missing: value.missing,
            citekeys: value.citekeys ?? [],
          },
        );
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const action = requireString(args, 'action');
      const refresh = args.refresh === true;
      const bibPaths = stringArray(args, 'bibPaths');
      const outPath = path.resolve(cwd, optionalString(args, 'outPath') ?? 'refs.bib');

      if (action === 'export') {
        const collection = await resolveCollectionKey(optionalString(args, 'collection'));
        const result = await client.exportBibtex({
          collection: collection.key,
          itemKeys: stringArray(args, 'itemKeys'),
        });
        const parsed = parseBib(result.text);
        ensureDir(path.dirname(outPath));
        fs.writeFileSync(outPath, result.text, 'utf8');
        const bytes = Buffer.byteLength(result.text, 'utf8');
        const notes = [...collection.notes, ...(result.notes ?? [])];
        if (parsed.errors.length > 0) {
          notes.push(`导出的 BibTeX 有解析告警：${parsed.errors.slice(0, 5).join('；')}`);
        }
        notes.push(`已写入 ${outPath}（${bytes} 字节，citationStyle=${citationStyle} 仅供排版端使用）。`);
        return jsonSafe({
          action: 'export',
          outPath,
          source: result.source,
          count: parsed.entries.length,
          citekeys: parsed.entries.map((entry) => entry.key).slice(0, 200),
          notes,
          bytes,
        });
      }

      if (action === 'merge') {
        const mergeFrom = stringArray(args, 'mergeFrom');
        const explicit = (mergeFrom && mergeFrom.length > 0) ? mergeFrom : bibPaths;
        // Explicit merge sources win; config.bibFiles are the fallback so that
        // `zotero_bib merge` also works with a configured bibliography project.
        const sources = explicit && explicit.length > 0
          ? [...new Set(explicit.map((file) => path.resolve(cwd, file)))]
          : bibInputs(configuredBibFiles, cwd, []);
        if (sources.length < 2) {
          throw new Error('zotero_bib merge 需要至少两个 .bib 来源：请通过 mergeFrom（或 bibPaths；未提供时使用配置的 bibFiles）提供。');
        }
        if (sources.includes(outPath)) {
          throw new Error(`merge 的 outPath 不能与任何输入文件相同：${outPath}。请换一个输出路径。`);
        }
        const notes = [];
        const errors = [];
        const warnings = [];
        const files = [];
        const duplicateRecords = [];
        const conflicts = [];
        const added = [];
        const updated = [];
        const first = loadBibFiles([sources[0]]);
        let entries = first.entries;
        files.push(...first.files);
        errors.push(...first.errors);
        warnings.push(...first.warnings);
        duplicateRecords.push(...first.duplicates);
        for (const source of sources.slice(1)) {
          const loaded = loadBibFiles([source]);
          for (const file of loaded.files) if (!files.includes(file)) files.push(file);
          errors.push(...loaded.errors);
          warnings.push(...loaded.warnings);
          duplicateRecords.push(...loaded.duplicates);
          // Drop cache entries so later calls see the merged files.
          const merged = mergeEntries(entries, loaded.entries);
          entries = merged.entries;
          added.push(...merged.added);
          updated.push(...merged.updated);
          duplicateRecords.push(...merged.duplicates.map((duplicate) => ({ key: duplicate.key, count: duplicate.count, files: [] })));
          conflicts.push(...merged.conflicts);
        }
        if (entries.length === 0) {
          throw new Error(`zotero_bib merge 没有解析出任何条目。错误：${errors.slice(0, 3).join('；') || '（无）'}。`);
        }
        ensureDir(path.dirname(outPath));
        fs.writeFileSync(outPath, serializeBib(entries), 'utf8');
        if (errors.length > 0) notes.push(`解析错误（已尽量恢复）：${errors.slice(0, 5).join('；')}`);
        if (warnings.length > 0) notes.push(`解析告警：${warnings.slice(0, 5).join('；')}`);
        notes.push(`已写入 ${outPath}（${entries.length} 条）。`);
        return jsonSafe({
          action: 'merge',
          outPath,
          files,
          entries: entries.length,
          added: [...new Set(added)],
          updated: [...new Set(updated)],
          duplicates: mergeDuplicateRecords(duplicateRecords),
          conflicts: conflicts.slice(0, 50),
          notes,
        });
      }

      // action: index | validate
      const inputs = bibInputs(configuredBibFiles, cwd, bibPaths);
      if (inputs.length === 0) {
        throw new Error('zotero_bib 需要 .bib 输入：请在插件配置 bibFiles 或参数 bibPaths 中提供 .bib 文件/目录。');
      }
      const loaded = loadBibIndex(inputs, { refresh });
      if (loaded.entries.length === 0) {
        const detail = loaded.errors.slice(0, 3).join('；') || '（没有可读条目）';
        throw new Error(`无法从提供的 bib 文件解析出任何条目：${detail}。请检查文件路径与 BibTeX 语法（可用 @misc{key, title={...}} 最小条目验证）。`);
      }
      const missing = loaded.missing.slice(0, 50);
      const errors = loaded.errors.slice(0, 40);
      const warnings = loaded.warnings.slice(0, 40);
      if (action === 'validate') {
        return jsonSafe({
          action: 'validate',
          ok: loaded.duplicates.length === 0 && missing.length === 0 && loaded.errors.length === 0,
          files: loaded.files,
          entries: loaded.entries.length,
          duplicates: loaded.duplicates,
          missing,
          errors,
          warnings,
        });
      }
      return jsonSafe({
        action: 'index',
        files: loaded.files,
        entries: loaded.entries.length,
        duplicates: loaded.duplicates,
        missing,
        warnings,
        errors,
        citekeys: loaded.entries.map((entry) => entry.key).slice(0, 200),
      });
    },
  });

  // -------------------------------------------------------------------------
  // 4. zotero_pdf
  // -------------------------------------------------------------------------
  ctx.tools.register({
    name: 'zotero_pdf',
    description: 'Resolve a Zotero attachment path, extract PDF text with pdftotext, or list PDF annotations. Provide itemKey (parent item) or attachmentKey (attachment item).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['path', 'text', 'annotations'] },
        itemKey: { type: 'string', description: 'Zotero parent item key; the first PDF attachment is used.' },
        attachmentKey: { type: 'string', description: 'Zotero attachment item key.' },
        maxChars: { type: 'integer', description: 'Maximum characters returned for action=text (default 20000, max 28000).' },
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'attachmentKey', 'itemKey', 'filename', 'path', 'exists', 'sizeBytes', 'contentType', 'notes'],
            properties: {
              action: { type: 'string', const: 'path' },
              attachmentKey: { type: 'string' },
              itemKey: { type: 'string' },
              filename: { type: 'string' },
              path: { type: 'string' },
              exists: { type: 'boolean' },
              sizeBytes: { type: 'integer' },
              contentType: { type: 'string' },
              notes: STRING_LIST,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'attachmentKey', 'path', 'method', 'text', 'chars', 'truncated', 'notes'],
            properties: {
              action: { type: 'string', const: 'text' },
              attachmentKey: { type: 'string' },
              path: { type: 'string' },
              method: { type: 'string', enum: ['pdftotext', 'none'] },
              text: { type: 'string' },
              chars: { type: 'integer' },
              truncated: { type: 'boolean' },
              notes: STRING_LIST,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'attachmentKey', 'path', 'count', 'annotations', 'notes'],
            properties: {
              action: { type: 'string', const: 'annotations' },
              attachmentKey: { type: 'string' },
              path: { type: 'string' },
              count: { type: 'integer' },
              annotations: { type: 'array', items: ANNOTATION_SCHEMA },
              notes: STRING_LIST,
            },
          },
        ],
      },
      render: (_args, value) => {
        if (value.action === 'path') {
          const summary = value.exists
            ? `PDF：${value.path}（${value.filename}，${value.sizeBytes} 字节）`
            : `PDF 路径无法解析：${value.notes.join('；') || '（未知原因）'}`;
          return renderSummary(summary, value);
        }
        if (value.action === 'text') {
          const preview = value.text.length > 0 ? value.text.slice(0, 2000) : '（无文本；见 notes）';
          return renderSummary(
            `PDF 文本：${value.method === 'pdftotext' ? 'pdftotext 提取成功' : '未提取到文本'}，${value.chars} 字符${value.truncated ? '（已截断）' : ''}。\n\n${preview}`,
            { path: value.path, method: value.method, notes: value.notes },
          );
        }
        return renderSummary(
          `PDF 批注：${value.count} 条${value.path ? `\n文件：${value.path}` : ''}`,
          { annotations: value.annotations, notes: value.notes },
        );
      },
    },
    async execute(args, exec) {
      const action = requireString(args, 'action');
      const resolved = await resolveAttachment(args);
      const notes = [...resolved.notes];
      const attachmentData = resolved.data ?? {};
      const attachmentKey = String(attachmentData.key ?? '');
      let attachmentPath = '';
      try {
        attachmentPath = client.getAttachmentPath(resolved.attachment);
      } catch (error) {
        notes.push(errorMessage(error));
      }
      if (action === 'path') {
        let exists = false;
        let sizeBytes = 0;
        if (attachmentPath.length > 0) {
          try {
            const stat = fs.statSync(attachmentPath);
            exists = stat.isFile();
            sizeBytes = exists ? stat.size : 0;
          } catch {
            exists = false;
          }
        }
        if (attachmentPath.length > 0 && !exists) notes.push(`路径存在记录但文件缺失：${attachmentPath}`);
        return jsonSafe({
          action: 'path',
          attachmentKey,
          itemKey: resolved.itemKey,
          filename: String(attachmentData.filename ?? (attachmentPath ? path.basename(attachmentPath) : '')),
          path: attachmentPath,
          exists,
          sizeBytes,
          contentType: String(attachmentData.contentType ?? ''),
          notes,
        });
      }
      if (action === 'text') {
        if (attachmentPath.length === 0) {
          throw new Error(`无法定位附件文件：${notes.join('；') || '未知原因'}。请先用 zotero_pdf(action=path) 检查附件。`);
        }
        const maxChars = optionalInteger(args, 'maxChars', 20000, 28000);
        const extraction = client.readPdfText(attachmentPath);
        if (extraction.note) notes.push(extraction.note);
        const fullText = typeof extraction.text === 'string' ? extraction.text : '';
        const truncated = fullText.length > maxChars;
        return jsonSafe({
          action: 'text',
          attachmentKey,
          path: attachmentPath,
          method: extraction.method,
          text: truncated ? truncate(fullText, maxChars) : fullText,
          chars: fullText.length,
          truncated,
          notes,
        });
      }
      if (action !== 'annotations') {
        throw new Error(`zotero_pdf 不支持 action="${action}"；可用 path/text/annotations。`);
      }
      const children = await client.getChildren(attachmentKey);
      const annotations = children
        .filter((child) => (child?.data ?? child)?.itemType === 'annotation')
        .map((child) => annotationView(child));
      for (const child of children) {
        const childData = child?.data ?? child ?? {};
        if (childData.itemType === 'note' && String(childData.note ?? '').length > 0) {
          notes.push(`笔记 ${String(childData.key ?? '')}：${truncate(stripHtml(childData.note), 2000)}`);
        }
      }
      return jsonSafe({
        action: 'annotations',
        attachmentKey,
        path: attachmentPath,
        count: annotations.length,
        annotations,
        notes,
      });
    },
  });

  // -------------------------------------------------------------------------
  // 5. zotero_enrich
  // -------------------------------------------------------------------------
  ctx.tools.register({
    name: 'zotero_enrich',
    description: 'Look up bibliographic metadata online (read-only): Crossref, OpenAlex and arXiv, returning up to 5 candidates (title/authors/year/doi/venue/url). Pass query or title (and optionally doi). Set asBibtex=true for a ready-to-paste BibTeX entry of the best candidate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Bibliographic search text (title/authors/keywords).' },
        title: { type: 'string', description: 'Paper title (used when query is absent).' },
        doi: { type: 'string', description: 'DOI for an exact lookup (Crossref/OpenAlex).' },
        source: { type: 'string', enum: ['auto', 'crossref', 'openalex', 'arxiv'] },
        asBibtex: { type: 'boolean', description: 'Return a BibTeX snippet for the best candidate.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'candidates', 'notes', 'bibtex'],
        properties: {
          query: { type: 'object', additionalProperties: true },
          candidates: { type: 'array', items: ENRICH_CANDIDATE_SCHEMA },
          notes: { type: 'array', items: { type: 'string' } },
          bibtex: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = value.candidates.map((candidate, index) => {
          const authors = candidate.authors.length > 0 ? candidate.authors.join(', ') : '—';
          const year = candidate.year === null ? '????' : String(candidate.year);
          return `${index + 1}. ${candidate.title} — ${authors} (${year})${candidate.venue ? ` · ${candidate.venue}` : ''} [${candidate.source}]${candidate.doi ? ` doi:${candidate.doi}` : ''}`;
        });
        const summary = value.candidates.length > 0
          ? `在线元数据候选（${value.candidates.length}）：\n${lines.join('\n')}`
          : '在线元数据：没有候选。';
        return renderSummary(summary, {
          notes: value.notes,
          bibtex: value.bibtex,
          candidates: value.candidates,
        });
      },
    },
    async execute(args) {
      const query = optionalString(args, 'query');
      const title = optionalString(args, 'title');
      const doi = optionalString(args, 'doi');
      const sourceValue = optionalString(args, 'source') ?? 'auto';
      const source = ['auto', 'crossref', 'openalex', 'arxiv'].includes(sourceValue) ? sourceValue : 'auto';
      if (!query && !title && !doi) {
        throw new Error('zotero_enrich 需要 query、title 或 doi 中至少一个参数。');
      }
      const detailed = await client.enrichDetailed({ query, title, doi, source });
      const candidates = detailed.candidates;
      const asBibtex = args.asBibtex === true;
      let bibtex = '';
      if (asBibtex && candidates.length > 0) {
        bibtex = serializeBib([candidateToEntry(candidates[0])]);
      }
      return jsonSafe({
        query: {
          query: query ?? '',
          title: title ?? '',
          doi: doi ?? '',
          source,
        },
        candidates,
        notes: detailed.notes,
        bibtex,
      });
    },
  });

  // -------------------------------------------------------------------------
  // 6. zotero_write (advanced + Web API key only)
  // -------------------------------------------------------------------------
  const advancedTools = config.advancedTools === true;
  const apiKeyAtLoad = zoteroApiKey(config);
  if (advancedTools && apiKeyAtLoad) {
    ctx.tools.register({
      name: 'zotero_write',
      description: 'Write to Zotero through the Web API (requires advancedTools and a Zotero API key): add-item (new bibliography item), add-tag (add a tag to an existing item), add-note (attach a child note).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['add-item', 'add-tag', 'add-note'] },
          itemKey: { type: 'string', description: 'Target item key for add-tag/add-note.' },
          title: { type: 'string', description: 'Item title for add-item.' },
          itemType: { type: 'string', description: 'Zotero item type for add-item, default journalArticle.' },
          creators: { type: 'array', items: CREATOR_ARG_SCHEMA, description: 'Creators for add-item (default creatorType author).' },
          date: { type: 'string', description: 'Date string for add-item.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for add-item.' },
          collections: { type: 'array', items: { type: 'string' }, description: 'Collection keys for add-item.' },
          fieldValues: { type: 'object', additionalProperties: true, description: 'Extra Zotero data fields for add-item (e.g. publicationTitle, volume, DOI, url).' },
          tag: { type: 'string', description: 'Tag to add for add-tag.' },
          note: { type: 'string', description: 'Plain text or HTML note body for add-note.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'success', 'key', 'version', 'message'],
          properties: {
            action: { type: 'string', enum: ['add-item', 'add-tag', 'add-note'] },
            success: { type: 'boolean' },
            key: { type: 'string' },
            version: NULLABLE_INTEGER,
            message: { type: 'string' },
          },
        },
        render: (_args, value) => renderSummary(
          `Zotero 写回 ${value.action}：${value.success ? '成功' : '失败'}${value.key ? `，key=${value.key}` : ''}。\n${value.message}`,
          value,
        ),
      },
      async execute(args) {
        const action = requireString(args, 'action');
        const apiKey = zoteroApiKey(config);
        if (!apiKey) throw new Error(secretHint('zotero'));
        const writeClient = createZoteroClient({ ...clientOptions, apiKey });
        const uid = encodeURIComponent(userId);
        if (action === 'add-item') {
          const title = requireString(args, 'title');
          const itemType = optionalString(args, 'itemType') ?? 'journalArticle';
          const creators = Array.isArray(args.creators)
            ? args.creators
              .filter((creator) => creator && typeof creator === 'object')
              .map((creator) => {
                const entry = { creatorType: optionalString(creator, 'creatorType') ?? 'author' };
                if (typeof creator.firstName === 'string') entry.firstName = creator.firstName;
                if (typeof creator.lastName === 'string') entry.lastName = creator.lastName;
                if (typeof creator.name === 'string') entry.name = creator.name;
                return entry;
              })
            : [];
          const extraFields = plainObject(args, 'fieldValues') ?? {};
          // Explicit arguments win over fieldValues so the required title and
          // chosen itemType can never be silently overridden.
          const data = { ...extraFields, itemType, title };
          if (creators.length > 0) data.creators = creators;
          const date = optionalString(args, 'date');
          if (date) data.date = date;
          const tags = stringArray(args, 'tags');
          if (tags && tags.length > 0) data.tags = tags.map((tag) => ({ tag }));
          const collections = stringArray(args, 'collections');
          if (collections && collections.length > 0) data.collections = collections;
          const result = await writeClient.webApiRequest(`/users/${uid}/items`, {
            method: 'POST',
            body: [data],
            headers: { 'Zotero-Write-Token': randomUUID() },
          });
          const written = writeResult(result, 'add-item');
          return jsonSafe({
            action,
            success: true,
            key: written.key,
            version: written.version,
            message: `已创建 ${itemType} 条目${written.key ? `（key=${written.key}）` : ''}：${title}`,
          });
        }
        if (action === 'add-tag') {
          const itemKey = requireString(args, 'itemKey');
          const tag = requireString(args, 'tag');
          const existing = await writeClient.webApiRequest(`/users/${uid}/items/${encodeURIComponent(itemKey)}`);
          const data = existing?.data ?? existing ?? {};
          const currentTags = tagNames(data.tags);
          if (!currentTags.some((name) => name.toLowerCase() === tag.toLowerCase())) currentTags.push(tag);
          const headers = {};
          if (Number.isInteger(data.version)) headers['If-Unmodified-Since-Version'] = String(data.version);
          const result = await writeClient.webApiRequest(`/users/${uid}/items/${encodeURIComponent(itemKey)}`, {
            method: 'PATCH',
            body: { tags: currentTags.map((name) => ({ tag: name })) },
            headers,
          });
          return jsonSafe({
            action,
            success: true,
            key: itemKey,
            version: Number.isInteger(result?.version) ? result.version : (Number.isInteger(data.version) ? data.version : null),
            message: `已为条目 ${itemKey} 添加标签 "${tag}"（现有标签：${currentTags.join(', ')}）。`,
          });
        }
        if (action === 'add-note') {
          const parentItem = requireString(args, 'itemKey');
          const note = requireString(args, 'note');
          const html = /^\s*</.test(note)
            ? note
            : `<p>${escapeHtml(note).replace(/\r?\n/g, '<br/>')}</p>`;
          const result = await writeClient.webApiRequest(`/users/${uid}/items`, {
            method: 'POST',
            body: [{ itemType: 'note', parentItem, note: html, tags: [] }],
            headers: { 'Zotero-Write-Token': randomUUID() },
          });
          const written = writeResult(result, 'add-note');
          return jsonSafe({
            action,
            success: true,
            key: written.key,
            version: written.version,
            message: `已在条目 ${parentItem} 下创建笔记${written.key ? `（key=${written.key}）` : ''}。`,
          });
        }
        throw new Error(`zotero_write 不支持 action="${action}"；可用 add-item/add-tag/add-note。`);
      },
    });
  }
}
