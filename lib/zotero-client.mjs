/**
 * Zotero client for the `zotero-ink` plugin.
 *
 * Three transports are used, deliberately:
 * - the read-only **local API** (`http://127.0.0.1:23119/api/...`) exposes the
 *   running Zotero library without credentials. It must be enabled by the user
 *   in Zotero: Settings → Advanced → "Allow other applications on this computer
 *   to communicate with Zotero";
 * - the optional **Web API** (`https://api.zotero.org`) is only used for writes
 *   and only when an API key is available (see `lib/secrets.mjs`);
 * - plain HTTPS calls to Crossref/OpenAlex/arXiv for read-only metadata
 *   enrichment.
 *
 * Known limitations (surfaced through `notes` instead of failing silently):
 * - The local API cannot write; `zotero_write` therefore requires the Web API.
 * - PDF text extraction needs `pdftotext` (Poppler) on `PATH`; otherwise the
 *   caller gets `{ text: null, method: 'none' }` plus an install hint.
 * - `format=bibtex` output depends on Zotero's export translators; when it is
 *   unavailable the client generates BibLaTeX from item metadata instead
 *   (`source: 'generated'`).
 * - Enrichment sources are best-effort and degrade to partial results with an
 *   explanatory note.
 *
 * Only Node built-ins and relative imports are used.
 *
 * @module dsh-inkstone/lib/zotero-client
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HttpError, httpRequest, joinUrl, query } from './http.mjs';
import { buildBibFromItems, serializeBib } from './bib.mjs';
import { errorMessage } from './tool-kit.mjs';
import { secretHint, zoteroApiKey } from './secrets.mjs';

/** Zotero Web API base URL (writes only). */
const WEB_API_BASE = 'https://api.zotero.org';

/** Actionable hint appended to local-API connection failures. */
const LOCAL_API_HINT = '请启动 Zotero，并在 设置 → 高级 → 允许本机应用通信（Allow other applications on this computer to communicate with Zotero）中勾选允许后重试。';

/** Zotero item types that are children of a regular item. */
const CHILD_ITEM_TYPES = new Set(['attachment', 'note', 'annotation']);

/** Zotero item types accepted by the local API `itemType` parameter. */
const ZOTERO_ITEM_TYPES = new Set([
  'journalArticle',
  'magazineArticle',
  'newspaperArticle',
  'book',
  'bookSection',
  'conferencePaper',
  'thesis',
  'report',
  'webpage',
  'blogPost',
  'forumPost',
  'encyclopediaArticle',
  'dictionaryEntry',
  'preprint',
  'manuscript',
  'document',
  'computerProgram',
  'dataset',
  'presentation',
  'patent',
  'standard',
  'artwork',
  'film',
  'videoRecording',
  'audioRecording',
  'interview',
  'letter',
  'email',
  'map',
  'podcast',
  'radioBroadcast',
  'tvBroadcast',
  'statute',
  'case',
  'hearing',
  'bill',
  'attachment',
  'note',
  'annotation',
]);

/** BibTeX entry type → Zotero item type (for `zotero_search` convenience). */
const BIB_TO_ZOTERO_TYPE = {
  article: 'journalArticle',
  book: 'book',
  incollection: 'bookSection',
  inbook: 'bookSection',
  inproceedings: 'conferencePaper',
  conference: 'conferencePaper',
  proceedings: 'conferencePaper',
  thesis: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  techreport: 'report',
  report: 'report',
  online: 'webpage',
  webpage: 'webpage',
  unpublished: 'manuscript',
  preprint: 'preprint',
};

/** Headers used for the read-only enrichment services. */
const ENRICH_HEADERS = {
  'User-Agent': 'dsh-inkstone/0.1.0 (zotero-ink plugin)',
  Accept: 'application/json, application/atom+xml, text/xml',
};

/**
 * Read the `data` record of a Zotero API envelope (or the record itself).
 * @param {any} item
 * @returns {Record<string, any>}
 */
function dataOf(item) {
  if (!item || typeof item !== 'object') return {};
  if (item.data && typeof item.data === 'object') return item.data;
  return item;
}

/**
 * Clamp an integer option.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInteger(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Year string of a Zotero date field.
 * @param {unknown} value
 * @returns {string}
 */
function yearOf(value) {
  const match = String(value ?? '').match(/(\d{4})/);
  return match ? match[1] : '';
}

/**
 * Whether any creator matches a case-insensitive needle.
 * @param {any} creators
 * @param {string} needle
 * @returns {boolean}
 */
function creatorsMatch(creators, needle) {
  if (!Array.isArray(creators)) return false;
  const wanted = needle.toLowerCase();
  return creators.some((creator) => {
    if (!creator || typeof creator !== 'object') return false;
    return [creator.firstName, creator.lastName, creator.name]
      .filter((part) => typeof part === 'string')
      .some((part) => part.toLowerCase().includes(wanted));
  });
}

/**
 * Whether an item carries a tag.
 * @param {any} tags
 * @param {string} needle
 * @returns {boolean}
 */
function tagsMatch(tags, needle) {
  if (!Array.isArray(tags)) return false;
  const wanted = needle.toLowerCase();
  return tags.some((tag) => {
    const name = typeof tag === 'string' ? tag : tag?.tag;
    return typeof name === 'string' && name.toLowerCase() === wanted;
  });
}

/**
 * Map a BibTeX entry type or Zotero item type to a local-API `itemType` value.
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function toZoteroItemType(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (ZOTERO_ITEM_TYPES.has(value)) return value;
  const mapped = BIB_TO_ZOTERO_TYPE[value.toLowerCase()];
  return mapped ?? undefined;
}

/**
 * Normalize a DOI argument (`https://doi.org/...` → bare DOI).
 * @param {string} doi
 * @returns {string}
 */
function normalizeDoi(doi) {
  return String(doi ?? '')
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim();
}

/**
 * Whether a response body looks like BibTeX/BibLaTeX rather than JSON or an
 * error page (the local API may ignore `format=bibtex` on some routes).
 * @param {unknown} text
 * @returns {boolean}
 */
function looksLikeBibtex(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('<')) return false;
  return /@[A-Za-z]+\s*[{(]/.test(trimmed);
}

/**
 * Decode the small XML entity subset used by arXiv's Atom feed.
 * @param {string} text
 * @returns {string}
 */
function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Collapse whitespace and decode entities from an Atom element.
 * @param {string} text
 * @returns {string}
 */
function cleanAtomText(text) {
  return decodeXmlEntities(String(text ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Create a Zotero client.
 *
 * @param {object} [options]
 * @param {string} [options.localApiUrl] local API base, default `http://127.0.0.1:23119`
 *   (falls back to `ZOTERO_LOCAL_API_URL`).
 * @param {string} [options.dataDir] Zotero data directory (falls back to
 *   `ZOTERO_DATA_DIR`, then `~/Zotero`).
 * @param {number} [options.timeoutMs] HTTP timeout, default 15000.
 * @param {string} [options.apiKey] Zotero Web API key (writes only).
 * @param {string} [options.userId] Web API user id, default `0` for the local API.
 * @returns {object} client with the methods documented in CONTRACT §3.
 */
export function createZoteroClient(options = {}) {
  const localApiUrl = String(options.localApiUrl ?? process.env.ZOTERO_LOCAL_API_URL ?? 'http://127.0.0.1:23119').replace(/\/+$/, '');
  const dataDir = path.resolve(String(options.dataDir ?? process.env.ZOTERO_DATA_DIR ?? path.join(os.homedir(), 'Zotero')));
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const apiKey = typeof options.apiKey === 'string' && options.apiKey.trim().length > 0
    ? options.apiKey.trim()
    : zoteroApiKey({});
  const userId = String(options.userId ?? process.env.ZOTERO_API_USER_ID ?? '0').trim() || '0';
  const enrichTimeout = Math.min(timeoutMs, 15000);

  /**
   * Translate low-level local-API failures into the actionable Zotero hint.
   * @param {unknown} error
   * @param {string} url
   * @returns {Error}
   */
  function translateLocalError(error, url) {
    if (error instanceof HttpError) {
      if (error.status === undefined) {
        return new HttpError(
          `无法连接 Zotero 本地 API（${localApiUrl}）。${LOCAL_API_HINT} 原始错误：${error.message}`,
          { url },
        );
      }
      if (error.status === 403) {
        return new HttpError(
          `Zotero 本地 API 拒绝访问（HTTP 403，${url}）。${LOCAL_API_HINT}`,
          { url, status: 403, body: error.body },
        );
      }
      return error;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Perform one local-API request.
   * @param {string} suffix path after `/api/users/<id>`
   * @param {object} [request]
   * @returns {Promise<any>}
   */
  async function localRequest(suffix, request = {}) {
    const url = `${joinUrl(localApiUrl, `/api/users/${encodeURIComponent(userId)}${suffix}`)}${query(request.queryParams ?? {})}`;
    try {
      return await httpRequest(url, {
        method: request.method ?? 'GET',
        headers: { 'Zotero-API-Version': '3', ...(request.headers ?? {}) },
        timeoutMs: request.timeoutMs ?? timeoutMs,
        expect: request.expect ?? 'json',
      });
    } catch (error) {
      throw translateLocalError(error, url);
    }
  }

  /**
   * Read pages of a list endpoint until data runs out.
   * @param {string} suffix
   * @param {Record<string, any>} queryParams
   * @param {{maxItems?: number, pageSize?: number}} [limits]
   * @returns {Promise<any[]>}
   */
  async function paginate(suffix, queryParams, limits = {}) {
    const maxItems = limits.maxItems ?? 500;
    const pageSize = limits.pageSize ?? 100;
    const out = [];
    let start = 0;
    for (;;) {
      const page = await localRequest(suffix, {
        queryParams: { ...queryParams, limit: pageSize, start },
      });
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < pageSize || out.length >= maxItems) break;
      start += pageSize;
    }
    return out.slice(0, maxItems);
  }

  /**
   * Keep only top-level, non-child bibliography items.
   * @param {any[]} items
   * @returns {any[]}
   */
  function topLevelItems(items) {
    return (Array.isArray(items) ? items : []).filter((item) => {
      const data = dataOf(item);
      if (CHILD_ITEM_TYPES.has(data.itemType)) return false;
      if (typeof data.parentItem === 'string' && data.parentItem.length > 0) return false;
      if (data.deleted === true) return false;
      return true;
    });
  }

  /**
   * Resolve a collection key or a human-readable collection name.
   * @param {string | undefined} value
   * @returns {Promise<{key: string | undefined, note: string}>}
   */
  async function resolveCollection(value) {
    if (typeof value !== 'string' || value.trim().length === 0) return { key: undefined, note: '' };
    const trimmed = value.trim();
    if (/^[A-Za-z0-9]{8}$/.test(trimmed)) return { key: trimmed, note: '' };
    const collections = await listCollections();
    const wanted = trimmed.toLowerCase();
    const exact = collections.filter((collection) => collection.name.toLowerCase() === wanted);
    const partial = collections.filter((collection) => collection.name.toLowerCase().includes(wanted));
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 0) {
      const available = collections.slice(0, 12).map((collection) => `${collection.key} (${collection.name})`).join('、');
      throw new Error(`找不到名为 "${trimmed}" 的 Zotero collection。可用 collection：${available || '（无）'}。`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((collection) => `${collection.key} (${collection.name})`).join('、');
      throw new Error(`collection 名称 "${trimmed}" 匹配到多个：${candidates}。请直接传入 collection key。`);
    }
    return { key: matches[0].key, note: `collection "${matches[0].name}" 已解析为 key ${matches[0].key}` };
  }

  /**
   * Search the local library.
   *
   * `title`, `author`, `year` and (defensively) `tag` are filtered locally
   * because the local API does not offer matching parameters for all of them.
   * Child items (attachments/notes/annotations) are excluded unless the caller
   * explicitly asks for one of those item types.
   *
   * `collection` accepts an 8-character key or a collection name (resolved via
   * `listCollections`, useful for pipeline recipe inputs).
   *
   * @param {object} [input]
   * @returns {Promise<any[]>}
   */
  async function search(input = {}) {
    const limit = clampInteger(input.limit, 20, 1, 100);
    const hasLocalFilters = Boolean(input.title || input.author || input.year || input.tag);
    const serverLimit = hasLocalFilters ? Math.min(100, Math.max(limit * 5, 50)) : limit;
    const queryParams = { format: 'json', limit: serverLimit, start: 0 };
    if (typeof input.q === 'string' && input.q.trim().length > 0) queryParams.q = input.q.trim();
    if (typeof input.sort === 'string' && input.sort.length > 0) queryParams.sort = input.sort;
    if (typeof input.direction === 'string' && input.direction.length > 0) queryParams.direction = input.direction;
    if (typeof input.tag === 'string' && input.tag.length > 0) queryParams.tag = input.tag;
    const zoteroItemType = toZoteroItemType(input.itemType);
    if (zoteroItemType) queryParams.itemType = zoteroItemType;
    const collection = await resolveCollection(input.collection);
    const suffix = collection.key
      ? `/collections/${encodeURIComponent(collection.key)}/items`
      : '/items';
    const raw = await localRequest(suffix, { queryParams });
    let items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    const allowChildTypes = zoteroItemType !== undefined && CHILD_ITEM_TYPES.has(zoteroItemType);
    if (!allowChildTypes) items = topLevelItems(items);
    if (typeof input.tag === 'string' && input.tag.length > 0) {
      items = items.filter((item) => tagsMatch(dataOf(item).tags, input.tag));
    }
    if (typeof input.title === 'string' && input.title.length > 0) {
      const needle = input.title.toLowerCase();
      items = items.filter((item) => String(dataOf(item).title ?? '').toLowerCase().includes(needle));
    }
    if (typeof input.author === 'string' && input.author.length > 0) {
      items = items.filter((item) => creatorsMatch(dataOf(item).creators, input.author));
    }
    if (input.year !== undefined && input.year !== null && String(input.year).length > 0) {
      const wantedYear = String(input.year);
      items = items.filter((item) => yearOf(dataOf(item).date) === wantedYear);
    }
    if (typeof input.itemType === 'string' && input.itemType.length > 0) {
      if (zoteroItemType === undefined) {
        const wanted = input.itemType.toLowerCase();
        items = items.filter((item) => String(dataOf(item).itemType ?? '').toLowerCase() === wanted);
      } else {
        items = items.filter((item) => dataOf(item).itemType === zoteroItemType);
      }
    }
    return items.slice(0, limit);
  }

  /**
   * Fetch one item by its 8-character key.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async function getItem(key) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('getItem: 需要 Zotero item key（8 位字符）。');
    }
    let raw;
    try {
      raw = await localRequest(`/items/${encodeURIComponent(key.trim())}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(
          `Zotero 中找不到条目 "${key}"（本地 API 返回 404）。请用 zotero_search 确认正确的 item key。`,
          { url: error.url, status: 404 },
        );
      }
      throw error;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        throw new HttpError(`Zotero 中找不到条目 "${key}"（本地 API 返回空列表）。请用 zotero_search 确认 key。`, { status: 404 });
      }
      return raw[0];
    }
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Zotero 本地 API 对条目 "${key}" 返回了无法识别的结果。`);
    }
    return raw;
  }

  /**
   * Fetch the child items (attachments, notes, annotations) of an item.
   * @param {string} key
   * @returns {Promise<any[]>}
   */
  async function getChildren(key) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('getChildren: 需要 Zotero item key（8 位字符）。');
    }
    try {
      return await paginate(`/items/${encodeURIComponent(key.trim())}/children`, { format: 'json' }, { maxItems: 500 });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(`Zotero 中找不到条目 "${key}" 的子条目（本地 API 返回 404）。`, { status: 404, url: error.url });
      }
      throw error;
    }
  }

  /**
   * List collections as `{ key, name, parentCollection }`.
   * @returns {Promise<Array<{key: string, name: string, parentCollection: string | null}>>}
   */
  async function listCollections() {
    const raw = await paginate('/collections', { format: 'json' }, { maxItems: 1000 });
    return raw.map((collection) => {
      const data = dataOf(collection);
      return {
        key: String(data.key ?? collection.key ?? ''),
        name: String(data.name ?? ''),
        parentCollection: typeof data.parentCollection === 'string' ? data.parentCollection : null,
      };
    });
  }

  /**
   * Resolve the file of an attachment item under `dataDir/storage/<key>/`.
   *
   * The file name comes from `item.data.filename`, a `storage:`-relative
   * `item.data.path`, or the single visible file in the storage directory.
   * Linked files with an absolute path are returned as-is.
   *
   * @param {any} attachmentItem Zotero attachment item
   * @returns {string} absolute file path (throws when it cannot be resolved)
   */
  function getAttachmentPath(attachmentItem) {
    const data = dataOf(attachmentItem);
    const key = String(data.key ?? attachmentItem?.key ?? '').trim();
    if (key.length === 0) {
      throw new Error('getAttachmentPath: 缺少附件 key。请传入 Zotero 附件条目。');
    }
    const rawPath = typeof data.path === 'string' ? data.path.trim() : '';
    const rawFilename = typeof data.filename === 'string' ? data.filename.trim() : '';
    const storageRelative = rawPath.startsWith('storage:') ? rawPath.slice('storage:'.length) : '';
    const linkedAbsolute = path.isAbsolute(rawPath) ? rawPath : '';
    if (linkedAbsolute.length > 0) {
      if (!fs.existsSync(linkedAbsolute)) {
        throw new Error(`附件是链接文件，但目标不存在：${linkedAbsolute}。请检查 Zotero 链接附件设置。`);
      }
      return linkedAbsolute;
    }
    const directory = path.join(dataDir, 'storage', key);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`附件存储目录不存在：${directory}。请确认 Zotero 数据目录（dataDir）指向 Zotero 的 data 目录，当前为 ${dataDir}。`);
    }
    const filename = rawFilename || (storageRelative.length > 0 ? path.basename(storageRelative) : '');
    if (filename.length > 0) {
      const candidate = path.join(directory, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
    let visibleFiles = [];
    try {
      visibleFiles = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch (error) {
      throw new Error(`无法读取附件目录 ${directory}：${errorMessage(error)}`);
    }
    const pdfFiles = visibleFiles.filter((name) => name.toLowerCase().endsWith('.pdf'));
    if (pdfFiles.length === 1) return path.join(directory, pdfFiles[0]);
    if (visibleFiles.length === 1) return path.join(directory, visibleFiles[0]);
    if (visibleFiles.length === 0) {
      throw new Error(`附件目录为空：${directory}。文件可能尚未同步。`);
    }
    throw new Error(
      `附件目录中有多个文件，无法确定要使用哪一个：${directory}（${visibleFiles.slice(0, 6).join(', ')}${visibleFiles.length > 6 ? ', …' : ''}）。请同步 Zotero 或传入包含 filename 字段的附件条目。`,
    );
  }

  /**
   * Collect items for generated BibTeX export.
   * @param {{collection?: string, itemKeys?: string[], limit?: number}} options
   * @returns {Promise<any[]>}
   */
  async function itemsForExport(options) {
    const limit = clampInteger(options.limit, 100, 1, 500);
    if (Array.isArray(options.itemKeys) && options.itemKeys.length > 0) {
      const items = [];
      for (const key of options.itemKeys.slice(0, limit)) {
        if (typeof key !== 'string' || key.trim().length === 0) continue;
        try {
          items.push(await getItem(key.trim()));
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) continue;
          throw error;
        }
      }
      return items;
    }
    if (typeof options.collection === 'string' && options.collection.length > 0) {
      const raw = await paginate(`/collections/${encodeURIComponent(options.collection)}/items`, { format: 'json' }, { maxItems: Math.max(limit, 100) });
      return topLevelItems(raw).slice(0, limit);
    }
    const raw = await paginate('/items', { format: 'json' }, { maxItems: Math.max(limit, 100) });
    return topLevelItems(raw).slice(0, limit);
  }

  /**
   * Export BibTeX/BibLaTeX.
   *
   * First tries the local API's `format=bibtex` (which works with Zotero's
   * built-in exporters). Explicit `itemKeys` are fetched one item at a time so
   * a single missing key cannot silently drop the whole request. When the
   * exporter is unavailable, entries are generated from item metadata with
   * `buildBibFromItems`.
   *
   * @param {{collection?: string, itemKeys?: string[], limit?: number}} [input]
   * @returns {Promise<{text: string, source: 'local-api' | 'generated', count: number, notes: string[]}>}
   */
  async function exportBibtex(input = {}) {
    const notes = [];
    let localError;
    const exportLimit = clampInteger(input.limit, 100, 1, 100);
    const itemKeys = Array.isArray(input.itemKeys)
      ? input.itemKeys.filter((key) => typeof key === 'string' && key.trim().length > 0).map((key) => key.trim())
      : [];
    const resolvedCollection = await resolveCollection(input.collection);
    if (resolvedCollection.note) notes.push(resolvedCollection.note);
    const collection = resolvedCollection.key;
    try {
      if (itemKeys.length > 0) {
        const chunks = [];
        const missingKeys = [];
        for (const key of itemKeys.slice(0, exportLimit)) {
          try {
            const text = await localRequest(`/items/${encodeURIComponent(key)}`, {
              queryParams: { format: 'bibtex' },
              expect: 'text',
            });
            if (looksLikeBibtex(text)) chunks.push(String(text).trim());
            else throw new Error('本地 API 未返回 BibTeX 文本（format=bibtex 可能不受支持）');
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
              missingKeys.push(key);
              continue;
            }
            throw error;
          }
        }
        if (chunks.length > 0) {
          if (missingKeys.length > 0) notes.push(`本地 API 未找到 ${missingKeys.length} 个条目：${missingKeys.slice(0, 5).join(', ')}`);
          return { text: chunks.join('\n\n'), source: 'local-api', count: 0, notes };
        }
        localError = new Error(
          missingKeys.length > 0
            ? `本地 API 未找到指定的任何条目（${missingKeys.slice(0, 5).join(', ')}）`
            : '本地 API 返回了空的 BibTeX 内容',
        );
      } else {
        const suffix = collection ? `/collections/${encodeURIComponent(collection)}/items` : '/items';
        const text = await localRequest(suffix, {
          queryParams: { format: 'bibtex', limit: exportLimit },
          expect: 'text',
        });
        if (typeof text === 'string' && looksLikeBibtex(text)) {
          return { text, source: 'local-api', count: 0, notes };
        }
        localError = new Error(
          typeof text === 'string' && text.trim().length > 0
            ? '本地 API 未返回 BibTeX 文本（format=bibtex 可能不受支持）'
            : '本地 API 返回了空的 BibTeX 内容',
        );
      }
    } catch (error) {
      localError = error;
    }
    let items;
    try {
      items = await itemsForExport({ ...input, collection });
    } catch (fallbackError) {
      throw new Error(
        `BibTeX 导出失败：本地 API 的 format=bibtex 不可用（${errorMessage(localError)}），`
        + `回退到条目元数据生成也失败（${errorMessage(fallbackError)}）。${LOCAL_API_HINT}`,
      );
    }
    const built = buildBibFromItems(items);
    if (built.entries.length === 0) {
      throw new Error(
        `BibTeX 导出失败：本地 API 的 format=bibtex 不可用（${errorMessage(localError)}），`
        + '并且没有可转换的 Zotero 条目。请确认 collection/itemKeys 指向有效的文献条目。',
      );
    }
    notes.push(`本地 API 的 format=bibtex 不可用（${errorMessage(localError)}），已从 ${built.entries.length} 个条目元数据生成 BibLaTeX。`);
    if (built.skipped.length > 0) notes.push(`已跳过 ${built.skipped.length} 个子条目（附件/笔记/批注）。`);
    return { text: serializeBib(built.entries), source: 'generated', count: built.entries.length, notes };
  }

  /**
   * Locate a usable `pdftotext` executable.
   *
   * The DSH Host process does not necessarily inherit the terminal PATH, and the
   * Windows installs this project targets usually carry Poppler inside the
   * dsh-ops bash payload, a Git-for-Windows install, MSYS2, or a winget package.
   * @returns {{command: string, tried: string[]}}
   */
  function findPdftotext() {
    const tried = [];
    if (process.env.INKSTONE_DISABLE_PDFTOTEXT === '1') {
      return { command: path.join(process.cwd(), '__inkstone_pdftotext_disabled__'), tried: ['(disabled by INKSTONE_DISABLE_PDFTOTEXT)'] };
    }
    const candidates = [];
    if (typeof process.env.PDFTOTEXT_PATH === 'string' && process.env.PDFTOTEXT_PATH.length > 0) {
      candidates.push(process.env.PDFTOTEXT_PATH);
    }
    candidates.push('pdftotext');
    const home = os.homedir();
    const profilesDir = path.join(home, '.dsh', 'profiles');
    try {
      for (const profile of fs.readdirSync(profilesDir)) {
        candidates.push(path.join(profilesDir, profile, 'node_modules', '@dsh-ops', 'bash-win32-x64', 'ucrt64', 'bin', 'pdftotext.exe'));
      }
    } catch {
      // no DSH profiles directory
    }
    candidates.push(
      path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'pdftotext.exe'),
      path.join('C:', 'msys64', 'ucrt64', 'bin', 'pdftotext.exe'),
      path.join('C:', 'msys64', 'mingw64', 'bin', 'pdftotext.exe'),
    );
    const winGetPackages = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of fs.readdirSync(winGetPackages)) {
        if (!/poppler/i.test(entry)) continue;
        const packageDir = path.join(winGetPackages, entry);
        for (const child of fs.readdirSync(packageDir)) {
          candidates.push(path.join(packageDir, child, 'bin', 'pdftotext.exe'));
        }
      }
    } catch {
      // no winget packages directory
    }
    for (const candidate of candidates) {
      tried.push(candidate);
      if (candidate === 'pdftotext') {
        const probe = spawnSync('pdftotext', ['-v'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (!probe.error) return { command: 'pdftotext', tried };
        continue;
      }
      if (fs.existsSync(candidate)) {
        const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (!probe.error) return { command: candidate, tried };
      }
    }
    return { command: 'pdftotext', tried };
  }

  /**
   * Extract text from a PDF with `pdftotext`.
   *
   * @param {string} filePath
   * @returns {{text: string | null, method: 'pdftotext' | 'none', note?: string}}
   */
  function readPdfText(filePath) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      return { text: null, method: 'none', note: 'readPdfText: 需要 PDF 文件路径。' };
    }
    if (!fs.existsSync(filePath)) {
      return { text: null, method: 'none', note: `PDF 文件不存在：${filePath}` };
    }
    const found = findPdftotext();
    const result = spawnSync(found.command, ['-layout', filePath, '-'], {
      encoding: 'utf8',
      timeout: Math.min(timeoutMs, 60000),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
      if (code === 'ENOENT') {
        return {
          text: null,
          method: 'none',
          note: `未找到 pdftotext（Poppler）。已尝试：${found.tried.join('; ')}。可安装 Poppler（winget install oschwartz10612.Poppler），或直接打开 PDF 路径阅读。`,
        };
      }
      return { text: null, method: 'none', note: `pdftotext 执行失败：${result.error.message}` };
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim().slice(0, 800);
      return { text: null, method: 'none', note: `pdftotext 退出码 ${result.status}${stderr ? `：${stderr}` : ''}。可能是扫描版或加密 PDF。` };
    }
    const text = String(result.stdout ?? '').replace(/\f/g, '\n').trim();
    if (text.length === 0) {
      return { text: null, method: 'none', note: 'pdftotext 未提取到文本；可能是扫描版 PDF（需要 OCR）。' };
    }
    return { text, method: 'pdftotext' };
  }

  /**
   * Fetch Crossref candidates.
   * @param {{queryText: string, doi: string}} input
   * @returns {Promise<any[]>}
   */
  async function crossrefCandidates(input) {
    const url = input.doi.length > 0
      ? `https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(input.doi))}`
      : `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(input.queryText)}&rows=5`;
    const payload = await httpRequest(url, { headers: ENRICH_HEADERS, timeoutMs: enrichTimeout, expect: 'json' });
    const mapItem = (item) => {
      if (!item || typeof item !== 'object') return null;
      const title = Array.isArray(item.title) ? String(item.title[0] ?? '') : String(item.title ?? '');
      const authors = Array.isArray(item.author)
        ? item.author
          .map((author) => [author?.given, author?.family].filter((part) => typeof part === 'string' && part.length > 0).join(' '))
          .filter((name) => name.length > 0)
        : [];
      const dateParts = item.issued?.['date-parts']?.[0] ?? item.published?.['date-parts']?.[0] ?? [];
      const year = Number.isInteger(dateParts?.[0]) ? dateParts[0] : null;
      const venue = Array.isArray(item['container-title'])
        ? String(item['container-title'][0] ?? '')
        : String(item.publisher ?? '');
      return {
        title: title.trim(),
        authors,
        year,
        doi: typeof item.DOI === 'string' ? item.DOI : null,
        venue: venue.trim().length > 0 ? venue.trim() : null,
        url: typeof item.URL === 'string' ? item.URL : null,
        source: 'crossref',
      };
    };
    if (input.doi.length > 0) {
      const candidate = mapItem(payload?.message);
      return candidate ? [candidate] : [];
    }
    const items = Array.isArray(payload?.message?.items) ? payload.message.items : [];
    return items.map(mapItem).filter(Boolean);
  }

  /**
   * Fetch OpenAlex candidates.
   * @param {{queryText: string, doi: string}} input
   * @returns {Promise<any[]>}
   */
  async function openalexCandidates(input) {
    const url = input.doi.length > 0
      ? `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalizeDoi(input.doi))}`
      : `https://api.openalex.org/works?search=${encodeURIComponent(input.queryText)}&per-page=5`;
    const payload = await httpRequest(url, { headers: ENRICH_HEADERS, timeoutMs: enrichTimeout, expect: 'json' });
    const mapWork = (work) => {
      if (!work || typeof work !== 'object') return null;
      const authors = Array.isArray(work.authorships)
        ? work.authorships
          .map((authorship) => authorship?.author?.display_name)
          .filter((name) => typeof name === 'string' && name.length > 0)
        : [];
      const doi = typeof work.doi === 'string' ? normalizeDoi(work.doi) : null;
      const venue = work.primary_location?.source?.display_name ?? work.host_venue?.display_name ?? null;
      return {
        title: String(work.display_name ?? work.title ?? '').trim(),
        authors,
        year: Number.isInteger(work.publication_year) ? work.publication_year : null,
        doi,
        venue: typeof venue === 'string' && venue.trim().length > 0 ? venue.trim() : null,
        url: typeof work.primary_location?.landing_page_url === 'string' ? work.primary_location.landing_page_url : (doi ? `https://doi.org/${doi}` : null),
        source: 'openalex',
      };
    };
    if (input.doi.length > 0) {
      const candidate = mapWork(payload);
      return candidate ? [candidate] : [];
    }
    const works = Array.isArray(payload?.results) ? payload.results : [];
    return works.map(mapWork).filter(Boolean);
  }

  /**
   * Fetch arXiv candidates from the Atom API.
   * @param {{queryText: string, doi: string}} input
   * @returns {Promise<any[]>}
   */
  async function arxivCandidates(input) {
    if (input.queryText.length === 0) {
      return [];
    }
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${input.queryText}`)}&start=0&max_results=5`;
    const xml = await httpRequest(url, { headers: ENRICH_HEADERS, timeoutMs: enrichTimeout, expect: 'text' });
    const entries = [];
    const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryPattern.exec(String(xml ?? ''))) !== null) {
      const block = match[1];
      const title = cleanAtomText((block.match(/<title[^>]*>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
      const authors = [];
      const authorPattern = /<name>([\s\S]*?)<\/name>/g;
      let authorMatch;
      while ((authorMatch = authorPattern.exec(block)) !== null) {
        const name = cleanAtomText(authorMatch[1]);
        if (name.length > 0) authors.push(name);
      }
      const published = cleanAtomText((block.match(/<published>([\s\S]*?)<\/published>/) ?? [])[1] ?? '');
      const yearMatch = published.match(/(\d{4})/);
      const id = cleanAtomText((block.match(/<id>([\s\S]*?)<\/id>/) ?? [])[1] ?? '');
      const doiMatch = block.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
      entries.push({
        title,
        authors,
        year: yearMatch ? Number(yearMatch[1]) : null,
        doi: doiMatch ? cleanAtomText(doiMatch[1]) : null,
        venue: 'arXiv',
        url: id.length > 0 ? id : null,
        source: 'arxiv',
      });
    }
    return entries;
  }

  /**
   * Collect enrichment candidates with per-source failure notes.
   *
   * @param {{query?: string, doi?: string, title?: string, source?: 'auto'|'crossref'|'openalex'|'arxiv'}} [input]
   * @returns {Promise<{candidates: any[], notes: string[]}>}
   */
  async function enrichDetailed(input = {}) {
    const queryText = String(input.query ?? input.title ?? '').trim();
    const doi = normalizeDoi(String(input.doi ?? ''));
    if (queryText.length === 0 && doi.length === 0) {
      throw new Error('zotero_enrich 需要 query、title 或 doi 中至少一个。');
    }
    const requested = input.source === 'crossref' || input.source === 'openalex' || input.source === 'arxiv'
      ? [input.source]
      : ['crossref', 'openalex', 'arxiv'];
    const notes = [];
    const tasks = requested.map(async (source) => {
      try {
        if (source === 'crossref') return { source, candidates: await crossrefCandidates({ queryText: queryText || doi, doi }) };
        if (source === 'openalex') return { source, candidates: await openalexCandidates({ queryText: queryText || doi, doi }) };
        if (doi.length > 0 && queryText.length === 0) {
          return { source, candidates: [], note: 'arXiv 不支持仅按 DOI 查询，已跳过（可在 query/title 中提供标题后重试）。' };
        }
        return { source, candidates: await arxivCandidates({ queryText: queryText || doi, doi }) };
      } catch (error) {
        return { source, candidates: [], error: errorMessage(error) };
      }
    });
    const settled = await Promise.all(tasks);
    const candidates = [];
    const seen = new Set();
    for (const result of settled) {
      if (result.error) notes.push(`${result.source} 查询失败（已降级忽略）：${result.error}`);
      if (result.note) notes.push(result.note);
      for (const candidate of result.candidates) {
        if (!candidate || typeof candidate.title !== 'string' || candidate.title.length === 0) continue;
        const identity = candidate.doi
          ? `doi:${String(candidate.doi).toLowerCase()}`
          : `title:${candidate.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0 && notes.length === 0) notes.push('在线源没有返回候选；请检查网络或换用其他 source。');
    return { candidates: candidates.slice(0, 5), notes };
  }

  /**
   * Public enrichment API: candidate array (see {@link enrichDetailed} for per-source notes).
   * @param {object} [input]
   * @returns {Promise<any[]>}
   */
  async function enrich(input = {}) {
    const result = await enrichDetailed(input);
    return result.candidates;
  }

  /**
   * Whether the Zotero Web API key is present and accepted.
   * @returns {Promise<boolean>}
   */
  async function webApiAvailable() {
    if (!apiKey) return false;
    try {
      await httpRequest(`${WEB_API_BASE}/users/${encodeURIComponent(userId)}/items?limit=1`, {
        headers: {
          'Zotero-API-Version': '3',
          Authorization: `Zotero-API-Key ${apiKey}`,
        },
        timeoutMs: Math.min(timeoutMs, 5000),
        expect: 'json',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Perform a Web API request (writes included). Requires `ZOTERO_API_KEY`
   * (or a secret file, see `lib/secrets.mjs`).
   *
   * @param {string} requestPath path after `https://api.zotero.org`, e.g. `/users/0/items`
   * @param {{method?: string, headers?: Record<string, string>, body?: any, expect?: 'json'|'text', timeoutMs?: number}} [init]
   * @returns {Promise<any>}
   */
  async function webApiRequest(requestPath, init = {}) {
    if (!apiKey) throw new Error(secretHint('zotero'));
    const url = joinUrl(WEB_API_BASE, String(requestPath ?? '/'));
    const headers = {
      'Zotero-API-Version': '3',
      Authorization: `Zotero-API-Key ${apiKey}`,
      ...(init.headers ?? {}),
    };
    let body;
    if (init.body !== undefined) {
      if (typeof init.body === 'string') {
        body = init.body;
        if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      } else {
        body = JSON.stringify(init.body);
        if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }
    const expect = init.expect ?? (String(requestPath).includes('format=') ? 'text' : 'json');
    return httpRequest(url, {
      method: init.method ?? 'GET',
      headers,
      body,
      timeoutMs: init.timeoutMs ?? timeoutMs,
      expect,
    });
  }

  /**
   * Check whether the local API is reachable.
   * @returns {Promise<{localApi: boolean, zoteroRunning: boolean, error?: string}>}
   */
  async function health() {
    try {
      await localRequest('/items', { queryParams: { limit: 1 }, timeoutMs: Math.min(timeoutMs, 5000) });
      return { localApi: true, zoteroRunning: true };
    } catch (error) {
      return { localApi: false, zoteroRunning: false, error: errorMessage(error) };
    }
  }

  return {
    search,
    getItem,
    getChildren,
    listCollections,
    getAttachmentPath,
    exportBibtex,
    readPdfText,
    enrich,
    enrichDetailed,
    webApiAvailable,
    webApiRequest,
    health,
  };
}
