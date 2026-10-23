/**
 * ETAPI (External Trilium API) client for the dsh-inkstone Trilium plugin.
 *
 * Pure Node ESM: only `node:` built-ins and relative imports. The client is
 * used by the `trilium-paper` Host plugin and by `scripts/test-trilium.mjs`.
 *
 * Authentication (ETAPI convention, verified against Trilium 0.106.0):
 * `Authorization: <token>` — the raw token, NOT `Bearer <token>` (the official
 * MCP endpoint uses Bearer; ETAPI does not). Tokens are created in
 * Trilium Options -> ETAPI.
 *
 * ## Verified against Trilium 0.106.0
 *
 * The endpoint table below was checked against the OpenAPI document bundled in
 * the Trilium desktop installation (`resources/app.asar` ->
 * `assets/etapi.openapi.yaml`). Notable facts that differ from older ETAPI
 * documentation, and the corresponding client behavior:
 *
 * 1. There is **no** `GET /notes/{id}/children` route in 0.106.0.
 *    `getChildren()` resolves `childNoteIds` from the note object and fetches
 *    those notes. As a defensive fallback it tries the historical children
 *    route and then a subtree search. (Uncertain: whether a future ETAPI adds
 *    the route back; the fallback covers that case.)
 * 2. `GET /notes/{id}/export` returns a **ZIP archive** (`application/zip`),
 *    for html/markdown/share alike — not a text body. `exportNote()` parses the
 *    ZIP and returns the primary `.md`/`.html` entry as text.
 * 3. Attachments are created in **two steps**: `POST /attachments` with a JSON
 *    body (`ownerId`, `role`, `mime`, `title`) and then
 *    `PUT /attachments/{id}/content` with the bytes. There is no multipart
 *    upload endpoint (the CONTRACT draft assumed multipart).
 * 4. Deleted notes are restored with `POST /notes/{id}/undelete` (there is no
 *    `/restore` route).
 * 5. Note attributes are returned inline on the note object (and written
 *    through `POST /attributes`); there is no `GET /notes/{id}/attributes`
 *    route in 0.106.0.
 * 6. `GET /app-info` calls the current timestamp field `utcDateTime`; this
 *    client also exposes it as `utcDate` for the CONTRACT shape.
 *
 * Other limits recorded here instead of silently degrading:
 * - Protected notes cannot be opened through ETAPI; titles/content come back
 *   as `[protected]` and writes are rejected by the server.
 * - Content is served with the note MIME type; binary notes (image/file) should
 *   not be read as UTF-8 text (the plugin skips them).
 * - `PATCH /notes/{id}` only accepts writable fields (title, type, mime,
 *   utcDateModified); `dateModified` is read-only.
 * - The ZIP extraction understands stored (method 0) and deflate (method 8)
 *   entries, which covers Trilium exports; ZIP64 is not supported.
 *
 * @module dsh-inkstone/lib/trilium-client
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { httpRequest, joinUrl, query as buildQuery } from './http.mjs';

/** Default Trilium instance address. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** Path prefix shared by every ETAPI route. */
const ETAPI_PREFIX = '/etapi';

/**
 * Exact actionable error used whenever no ETAPI token can be resolved.
 * The wording is part of the CONTRACT (§2).
 */
export const MISSING_TOKEN_MESSAGE =
  'TRILIUM_ETAPI_TOKEN is not set. Create a token in Trilium Options → ETAPI and set it as an environment variable.';

/**
 * ETAPI route table (verified against the 0.106.0 OpenAPI document).
 * Keep every route here so a future ETAPI change is a single-file fix.
 */
const ENDPOINTS = {
  appInfo: '/app-info',
  notes: '/notes',
  createNote: '/create-note',
  note: (noteId) => `/notes/${encodeURIComponent(noteId)}`,
  noteContent: (noteId) => `/notes/${encodeURIComponent(noteId)}/content`,
  /** Not present in the 0.106.0 route table; kept for the defensive fallback. */
  noteChildren: (noteId) => `/notes/${encodeURIComponent(noteId)}/children`,
  noteExport: (noteId) => `/notes/${encodeURIComponent(noteId)}/export`,
  noteAttachments: (noteId) => `/notes/${encodeURIComponent(noteId)}/attachments`,
  noteRevisions: (noteId) => `/notes/${encodeURIComponent(noteId)}/revisions`,
  noteRevision: (noteId) => `/notes/${encodeURIComponent(noteId)}/revision`,
  noteUndelete: (noteId) => `/notes/${encodeURIComponent(noteId)}/undelete`,
  revisions: (revisionId) => `/revisions/${encodeURIComponent(revisionId)}`,
  revisionContent: (revisionId) => `/revisions/${encodeURIComponent(revisionId)}/content`,
  attachments: '/attachments',
  attachment: (attachmentId) => `/attachments/${encodeURIComponent(attachmentId)}`,
  attachmentContent: (attachmentId) => `/attachments/${encodeURIComponent(attachmentId)}/content`,
  attributes: '/attributes',
  attribute: (attributeId) => `/attributes/${encodeURIComponent(attributeId)}`,
};

/** Export formats accepted by `GET /notes/{id}/export`. */
export const EXPORT_FORMATS = ['html', 'markdown', 'share'];

/** Attachment roles that make sense for paper publishing. */
const ATTACHMENT_ROLES = ['file', 'image'];

/** Extension -> MIME type map used when uploading workspace files. */
const MIME_BY_EXTENSION = {
  '.bib': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.tex': 'text/plain',
  '.txt': 'text/plain',
  '.typ': 'text/plain',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

/**
 * Infer a MIME type from a file name.
 * @param {string} filePath
 * @returns {string}
 */
export function mimeForPath(filePath) {
  const extension = path.extname(String(filePath)).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Whether an error is an HTTP error carrying a status code.
 * @param {unknown} error
 * @returns {boolean}
 */
function isHttpError(error) {
  return Boolean(error) && typeof error === 'object' && Number.isInteger(error.status);
}

/**
 * Rewrite a lower-level failure into a model-facing, actionable message.
 * @param {unknown} error
 * @param {string} context human description of the failed operation
 * @param {string} baseUrl
 * @returns {Error}
 */
function normalizeError(error, context, baseUrl) {
  const raw = error instanceof Error ? error.message : String(error);
  const status = isHttpError(error) ? error.status : undefined;
  let message;
  if (status === 401) {
    message =
      `${context}: Trilium ETAPI rejected the token (HTTP 401). The token is invalid, ` +
      'expired or was revoked — create a new token in Trilium Options → ETAPI and update ' +
      'TRILIUM_ETAPI_TOKEN.';
  } else if (status === 403) {
    message = `${context}: Trilium ETAPI refused the request (HTTP 403). ${raw}`;
  } else if (status === 404) {
    message =
      `${context}: HTTP 404 — the Trilium note/attachment/entity does not exist or is not ` +
      `accessible through ETAPI. ${raw}`;
  } else if (/cannot reach/i.test(raw)) {
    message =
      `${context}: cannot reach Trilium at ${baseUrl}. Start Trilium Notes and check that ` +
      `Options → ETAPI is enabled and the address is correct. (${raw})`;
  } else {
    message = `${context}: ${raw}`;
  }
  const wrapped = new Error(message);
  if (status !== undefined) wrapped.status = status;
  wrapped.cause = error;
  return wrapped;
}

/**
 * Build the "writes are disabled" error used by write methods.
 * @param {string} action
 * @returns {Error}
 */
function writesDisabledError(action) {
  return new Error(
    `Trilium ETAPI writes are disabled (allowWrites: false), so "${action}" cannot run. ` +
      'Set allowWrites: true in the inkstone-trilium config row of your DSH profile patch to enable writes.',
  );
}

/**
 * Minimal ZIP reader for Trilium export archives.
 *
 * Reads the central directory (which always carries the real sizes) and
 * supports stored and deflate entries. Returns null when the buffer is not a
 * readable ZIP.
 *
 * @param {Buffer} buffer
 * @returns {{name: string, data: Buffer}[] | null}
 */
function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
  // End of central directory record: signature 0x06054b50, variable trailing comment.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= lowest; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > buffer.length) return null;
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) return null;
    const raw = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else {
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Pick the primary text entry out of an export archive.
 * @param {{name: string, data: Buffer}[]} entries
 * @param {'html'|'markdown'|'share'} format
 * @returns {string}
 */
function selectExportText(entries, format) {
  const wantedExtensions = format === 'markdown' ? ['.md', '.markdown'] : ['.html', '.htm'];
  const files = entries.filter((entry) => !entry.name.endsWith('/'));
  const matches = files.filter((entry) => {
    const lower = entry.name.toLowerCase();
    return wantedExtensions.some((extension) => lower.endsWith(extension));
  });
  const preferred = matches.filter((entry) => !/^assets\//i.test(entry.name));
  const chosen = preferred[0] ?? matches[0] ?? files[0];
  if (!chosen) {
    throw new Error(
      'Trilium export returned an empty ZIP archive; the note may have no content or no ' +
        `exportable subtree in "${format}" format.`,
    );
  }
  return chosen.data.toString('utf8');
}

/**
 * Decode an ETAPI export response body into text.
 * @param {Uint8Array} bytes
 * @param {'html'|'markdown'|'share'} format
 * @returns {string}
 */
function decodeExportBody(bytes, format) {
  const buffer = Buffer.from(bytes);
  const entries = readZipEntries(buffer);
  if (entries) return selectExportText(entries, format);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    throw new Error(
      'Trilium export returned a ZIP archive that this client could not read ' +
        '(only stored and deflate ZIP entries are supported).',
    );
  }
  // Defensive: an older/future server may return the text body directly.
  return buffer.toString('utf8');
}

/**
 * Normalize an ETAPI note into the compact search shape from the CONTRACT.
 * @param {any} note
 * @returns {{noteId: string, title: string, type: string, dateModified: string, dateCreated: string, parentNoteIds: string[], labels: {name: string, value: string}[]}}
 */
function noteSummary(note) {
  const attributes = Array.isArray(note?.attributes) ? note.attributes : [];
  return {
    noteId: String(note?.noteId ?? ''),
    title: String(note?.title ?? ''),
    type: String(note?.type ?? ''),
    dateModified: String(note?.dateModified ?? ''),
    dateCreated: String(note?.dateCreated ?? ''),
    parentNoteIds: Array.isArray(note?.parentNoteIds) ? note.parentNoteIds.map(String) : [],
    labels: attributes
      .filter((attribute) => attribute?.type === 'label')
      .map((attribute) => ({ name: String(attribute.name ?? ''), value: String(attribute.value ?? '') })),
  };
}

/**
 * Create an ETAPI client.
 *
 * A missing token is NOT thrown at construction time: the plugin must activate
 * even without credentials and fail with an actionable error only when a tool
 * is actually called. Every method except `health()` therefore throws
 * {@link MISSING_TOKEN_MESSAGE} when no token was provided.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] Trilium instance URL (default http://127.0.0.1:8080)
 * @param {string} [options.token] ETAPI token (raw, no Bearer prefix)
 * @param {number} [options.timeoutMs] per-request timeout (default 15000)
 * @param {boolean} [options.allowWrites] allow mutating ETAPI calls (default true)
 * @returns {object} client with async methods returning JSON
 */
export function createTriliumClient(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const allowWrites = options.allowWrites !== false;

  /**
   * Throw the CONTRACT token error when no token is configured.
   */
  function requireToken() {
    if (!token) throw new Error(MISSING_TOKEN_MESSAGE);
  }

  /**
   * Reject a mutating call when the client is read-only.
   * @param {string} action
   */
  function requireWrites(action) {
    if (!allowWrites) throw writesDisabledError(action);
  }

  /**
   * Perform one ETAPI request.
   * @param {string} suffix route below `/etapi`
   * @param {object} [requestOptions]
   * @returns {Promise<any>}
   */
  async function request(suffix, requestOptions = {}) {
    requireToken();
    const {
      method = 'GET',
      params = undefined,
      body = undefined,
      headers = {},
      expect = 'json',
      context = 'Trilium ETAPI request',
    } = requestOptions;
    const suffixText = String(suffix);
    const search = params ? buildQuery(params) : '';
    const url = `${baseUrl}${ETAPI_PREFIX}${suffixText}${search}`;
    const requestHeaders = { Authorization: token, ...headers };
    if (body !== undefined && headers['Content-Type'] === undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    try {
      return await httpRequest(url, {
        method,
        headers: requestHeaders,
        body,
        timeoutMs,
        expect,
      });
    } catch (error) {
      throw normalizeError(error, context, baseUrl);
    }
  }

  const api = {
    /** @returns {Promise<{appVersion: string, dbVersion: number, syncVersion: number, utcDate: string}>} */
    async appInfo() {
      const data = await request(ENDPOINTS.appInfo, { context: 'read Trilium app info' });
      return {
        appVersion: String(data?.appVersion ?? ''),
        dbVersion: Number.isInteger(data?.dbVersion) ? data.dbVersion : 0,
        syncVersion: Number.isInteger(data?.syncVersion) ? data.syncVersion : 0,
        utcDate: String(data?.utcDateTime ?? data?.utcDate ?? ''),
        buildDate: typeof data?.buildDate === 'string' ? data.buildDate : undefined,
        buildRevision: typeof data?.buildRevision === 'string' ? data.buildRevision : undefined,
        dataDirectory: typeof data?.dataDirectory === 'string' ? data.dataDirectory : undefined,
      };
    },

    /**
     * Search notes (`GET /notes`). Returns the compact CONTRACT shape.
     * @param {{query: string, ancestorNoteId?: string, limit?: number, orderBy?: string, orderDirection?: 'asc'|'desc'}} args
     * @returns {Promise<object[]>}
     */
    async search(args = {}) {
      const queryText = typeof args.query === 'string' ? args.query.trim() : '';
      if (!queryText) throw new Error('Trilium search requires a non-empty query string.');
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 20;
      const orderBy = typeof args.orderBy === 'string' && args.orderBy ? args.orderBy : 'dateModified';
      const orderDirection = args.orderDirection === 'asc' ? 'asc' : 'desc';
      const data = await request(ENDPOINTS.notes, {
        params: {
          search: queryText,
          ancestorNoteId: args.ancestorNoteId,
          limit,
          orderBy,
          orderDirection,
        },
        context: `search Trilium notes for ${JSON.stringify(queryText)}`,
      });
      // 0.106.0 wraps results in { results }; accept a bare array defensively.
      const results = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
      return results.map(noteSummary);
    },

    /**
     * Get one note (`GET /notes/{id}`), including inline attributes and child ids.
     * @param {string} noteId
     * @returns {Promise<any>}
     */
    async getNote(noteId) {
      return request(ENDPOINTS.note(noteId), { context: `get Trilium note "${noteId}"` });
    },

    /**
     * Get note content (`GET /notes/{id}/content`) as text.
     * @param {string} noteId
     * @returns {Promise<string>}
     */
    async getContent(noteId) {
      const text = await request(ENDPOINTS.noteContent(noteId), {
        expect: 'text',
        context: `read content of Trilium note "${noteId}"`,
      });
      return typeof text === 'string' ? text : '';
    },

    /**
     * Resolve the path from the root note to `noteId`.
     * Walks `parentNoteIds[0]` (Trilium notes may have several parents; the
     * first branch is the canonical one). The root note itself yields
     * `path: ['root']`.
     * @param {string} noteId
     * @returns {Promise<{noteId: string, title: string, path: string[]}>}
     */
    async getPath(noteId) {
      const visited = new Set();
      const titles = [];
      let current = String(noteId);
      let firstTitle = '';
      for (let depth = 0; depth < 64; depth += 1) {
        if (visited.has(current)) break;
        visited.add(current);
        let note;
        try {
          note = await api.getNote(current);
        } catch (error) {
          // The requested note must be readable; a missing ancestor only ends
          // the walk (the note may live under a purged parent).
          if (depth === 0) throw error;
          break;
        }
        const title = String(note?.title ?? '');
        if (depth === 0) firstTitle = title;
        titles.push(title);
        const parents = Array.isArray(note?.parentNoteIds) ? note.parentNoteIds : [];
        if (parents.length === 0 || current === 'root') break;
        current = String(parents[0]);
      }
      return { noteId: String(noteId), title: firstTitle, path: titles.reverse() };
    },

    /**
     * List child notes.
     *
     * 0.106.0 has no `GET /notes/{id}/children` route, so children are resolved
     * from the note's `childNoteIds`. The historical route and a subtree search
     * are kept as defensive fallbacks (recorded as known limitation in the
     * module header).
     * @param {string} noteId
     * @returns {Promise<any[]>} raw ETAPI note objects
     */
    async getChildren(noteId) {
      const note = await api.getNote(noteId);
      const childIds = Array.isArray(note?.childNoteIds) ? note.childNoteIds.map(String) : null;
      if (childIds !== null) {
        return Promise.all(childIds.map((childId) => api.getNote(childId)));
      }
      try {
        const data = await request(ENDPOINTS.noteChildren(noteId), {
          context: `list children of Trilium note "${noteId}"`,
        });
        return Array.isArray(data) ? data : [];
      } catch (error) {
        if (!isHttpError(error) || error.status !== 404) throw error;
        const data = await request(ENDPOINTS.notes, {
          params: { search: '*', ancestorNoteId: noteId, ancestorDepth: 'eq1', limit: 100 },
          context: `search children of Trilium note "${noteId}"`,
        });
        const results = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
        return results;
      }
    },

    /**
     * Read the attributes attached to a note.
     * Attributes are inline on the note object in ETAPI 0.106.0.
     * @param {string} noteId
     * @returns {Promise<any[]>}
     */
    async getAttributes(noteId) {
      const note = await api.getNote(noteId);
      return Array.isArray(note?.attributes) ? note.attributes : [];
    },

    /**
     * Create a label/relation attribute (`POST /attributes`).
     * @param {{noteId: string, type?: 'label'|'relation', name: string, value?: string, isInheritable?: boolean}} args
     * @returns {Promise<any>}
     */
    async setAttribute(args = {}) {
      requireWrites('create attribute');
      const noteId = String(args.noteId ?? '').trim();
      const name = String(args.name ?? '').trim();
      const type = args.type === 'relation' ? 'relation' : 'label';
      if (!noteId) throw new Error('setAttribute requires a noteId.');
      if (!name) throw new Error('setAttribute requires a non-empty attribute name.');
      const value = args.value === undefined || args.value === null ? '' : String(args.value);
      return request(ENDPOINTS.attributes, {
        method: 'POST',
        body: JSON.stringify({ noteId, type, name, value, isInheritable: args.isInheritable === true }),
        context: `create ${type} "${name}" on Trilium note "${noteId}"`,
      });
    },

    /**
     * Get one attribute (`GET /attributes/{id}`).
     * @param {string} attributeId
     * @returns {Promise<any>}
     */
    async getAttribute(attributeId) {
      return request(ENDPOINTS.attribute(attributeId), {
        context: `get Trilium attribute "${attributeId}"`,
      });
    },

    /**
     * Delete one attribute (`DELETE /attributes/{id}`).
     * @param {string} attributeId
     * @returns {Promise<{attributeId: string, deleted: true}>}
     */
    async deleteAttribute(attributeId) {
      requireWrites('delete attribute');
      await request(ENDPOINTS.attribute(attributeId), {
        method: 'DELETE',
        context: `delete Trilium attribute "${attributeId}"`,
      });
      return { attributeId: String(attributeId), deleted: true };
    },

    /**
     * Create a note (`POST /create-note`).
     *
     * ETAPI answers `{note, branch}`; the client flattens it to the created
     * note object (so callers can use `created.noteId` directly) and keeps the
     * placement under `created.branch`. This is the shape the pipeline
     * `trilium.publish` step consumes.
     * @param {{parentNoteId: string, title: string, type?: string, content?: string}} args
     * @returns {Promise<any>} created note JSON plus `branch`
     */
    async createNote(args = {}) {
      requireWrites('create note');
      const parentNoteId = String(args.parentNoteId ?? '').trim();
      const title = String(args.title ?? '').trim();
      if (!parentNoteId) throw new Error('createNote requires a parentNoteId.');
      if (!title) throw new Error('createNote requires a non-empty title.');
      const type = typeof args.type === 'string' && args.type ? args.type : 'text';
      const content = args.content === undefined || args.content === null ? '' : String(args.content);
      const created = await request(ENDPOINTS.createNote, {
        method: 'POST',
        body: JSON.stringify({ parentNoteId, title, type, content }),
        context: `create Trilium note "${title}" under "${parentNoteId}"`,
      });
      const note = created && typeof created.note === 'object' && created.note !== null ? created.note : created;
      if (!note || typeof note !== 'object') {
        throw new Error(`Trilium did not return the created note for "${title}".`);
      }
      return { ...note, branch: created?.branch ?? null };
    },

    /**
     * Update a note's writable metadata (`PATCH /notes/{id}`).
     * @param {string} noteId
     * @param {{title?: string, type?: string, mime?: string}} updates
     * @returns {Promise<any>}
     */
    async updateNote(noteId, updates = {}) {
      requireWrites('update note');
      const body = {};
      if (typeof updates.title === 'string' && updates.title.trim()) body.title = updates.title.trim();
      if (typeof updates.type === 'string' && updates.type) body.type = updates.type;
      if (typeof updates.mime === 'string' && updates.mime) body.mime = updates.mime;
      if (Object.keys(body).length === 0) {
        throw new Error('updateNote requires at least one of title, type or mime.');
      }
      return request(ENDPOINTS.note(noteId), {
        method: 'PATCH',
        body: JSON.stringify(body),
        context: `update Trilium note "${noteId}"`,
      });
    },

    /**
     * Replace note content (`PUT /notes/{id}/content`).
     * @param {string} noteId
     * @param {string} content
     * @returns {Promise<{noteId: string, updated: true}>}
     */
    async setContent(noteId, content) {
      requireWrites('set note content');
      await request(ENDPOINTS.noteContent(noteId), {
        method: 'PUT',
        body: String(content ?? ''),
        headers: { 'Content-Type': 'text/plain' },
        expect: 'text',
        context: `write content of Trilium note "${noteId}"`,
      });
      return { noteId: String(noteId), updated: true };
    },

    /**
     * Move a note to the Trash (`DELETE /notes/{id}`).
     * @param {string} noteId
     * @returns {Promise<{noteId: string, trashed: true}>}
     */
    async deleteNote(noteId) {
      requireWrites('delete note');
      await request(ENDPOINTS.note(noteId), {
        method: 'DELETE',
        context: `delete Trilium note "${noteId}"`,
      });
      return { noteId: String(noteId), trashed: true };
    },

    /**
     * Restore a trashed note (`POST /notes/{id}/undelete`).
     * The note must be deleted and have at least one undeleted parent.
     * @param {string} noteId
     * @returns {Promise<{noteId: string, restored: boolean}>}
     */
    async restoreNote(noteId) {
      requireWrites('restore note');
      const data = await request(ENDPOINTS.noteUndelete(noteId), {
        method: 'POST',
        context: `restore Trilium note "${noteId}" from Trash`,
      });
      return { noteId: String(noteId), restored: data?.success !== false };
    },

    /**
     * List a note's attachments (`GET /notes/{id}/attachments`).
     * @param {string} noteId
     * @returns {Promise<any[]>}
     */
    async getAttachments(noteId) {
      const data = await request(ENDPOINTS.noteAttachments(noteId), {
        context: `list attachments of Trilium note "${noteId}"`,
      });
      return Array.isArray(data) ? data : [];
    },

    /**
     * Get one attachment's metadata (`GET /attachments/{id}`).
     * @param {string} attachmentId
     * @returns {Promise<any>}
     */
    async getAttachment(attachmentId) {
      return request(ENDPOINTS.attachment(attachmentId), {
        context: `get Trilium attachment "${attachmentId}"`,
      });
    },

    /**
     * Upload a workspace file as an attachment (two-step ETAPI flow).
     * @param {{noteId: string, filePath: string, title?: string, role?: 'file'|'image', mime?: string}} args
     * @returns {Promise<any>} created attachment metadata plus `bytes`
     */
    async uploadAttachment(args = {}) {
      requireWrites('upload attachment');
      const noteId = String(args.noteId ?? '').trim();
      const filePath = String(args.filePath ?? '').trim();
      if (!noteId) throw new Error('uploadAttachment requires a noteId.');
      if (!filePath) throw new Error('uploadAttachment requires a filePath.');
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new Error(`Attachment source file not found: ${filePath}`);
        }
        throw error;
      }
      if (!stat.isFile()) throw new Error(`Attachment source is not a file: ${filePath}`);
      const buffer = fs.readFileSync(filePath);
      const role = args.role === 'image' ? 'image' : 'file';
      const mime = typeof args.mime === 'string' && args.mime ? args.mime : mimeForPath(filePath);
      const title =
        typeof args.title === 'string' && args.title.trim()
          ? args.title.trim()
          : path.basename(filePath);
      const created = await request(ENDPOINTS.attachments, {
        method: 'POST',
        body: JSON.stringify({ ownerId: noteId, role, mime, title }),
        context: `create attachment "${title}" on Trilium note "${noteId}"`,
      });
      const attachmentId = String(created?.attachmentId ?? '');
      if (!attachmentId) {
        throw new Error(`Trilium did not return an attachmentId while uploading "${title}".`);
      }
      await request(ENDPOINTS.attachmentContent(attachmentId), {
        method: 'PUT',
        body: buffer,
        headers: { 'Content-Type': 'application/octet-stream' },
        expect: 'text',
        context: `upload bytes of Trilium attachment "${attachmentId}"`,
      });
      return { ...created, bytes: buffer.length };
    },

    /**
     * Download an attachment's content into a local file.
     * @param {string} attachmentId
     * @param {string} destPath absolute destination path
     * @returns {Promise<{attachmentId: string, path: string, bytes: number}>}
     */
    async downloadAttachment(attachmentId, destPath) {
      const target = String(destPath ?? '').trim();
      if (!target) throw new Error('downloadAttachment requires a destination path.');
      const bytes = await request(ENDPOINTS.attachmentContent(attachmentId), {
        expect: 'buffer',
        context: `download Trilium attachment "${attachmentId}"`,
      });
      const buffer = Buffer.from(bytes ?? new Uint8Array());
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      return { attachmentId: String(attachmentId), path: target, bytes: buffer.length };
    },

    /**
     * Delete an attachment (`DELETE /attachments/{id}`).
     * @param {string} attachmentId
     * @returns {Promise<{attachmentId: string, deleted: true}>}
     */
    async deleteAttachment(attachmentId) {
      requireWrites('delete attachment');
      await request(ENDPOINTS.attachment(attachmentId), {
        method: 'DELETE',
        context: `delete Trilium attachment "${attachmentId}"`,
      });
      return { attachmentId: String(attachmentId), deleted: true };
    },

    /**
     * List note revisions (`GET /notes/{id}/revisions`).
     * @param {string} noteId
     * @returns {Promise<any[]>}
     */
    async getRevisions(noteId) {
      const data = await request(ENDPOINTS.noteRevisions(noteId), {
        context: `list revisions of Trilium note "${noteId}"`,
      });
      return Array.isArray(data) ? data : [];
    },

    /**
     * Create a manual revision (`POST /notes/{id}/revision`).
     * @param {string} noteId
     * @returns {Promise<{noteId: string, revisionCreated: true}>}
     */
    async createRevision(noteId) {
      requireWrites('create revision');
      await request(ENDPOINTS.noteRevision(noteId), {
        method: 'POST',
        context: `create revision of Trilium note "${noteId}"`,
      });
      return { noteId: String(noteId), revisionCreated: true };
    },

    /**
     * Read one revision's content.
     * @param {string} noteId owning note id (for the error context)
     * @param {string} revisionId
     * @returns {Promise<string>}
     */
    async getRevisionContent(noteId, revisionId) {
      const text = await request(ENDPOINTS.revisionContent(revisionId), {
        expect: 'text',
        context: `read content of revision "${revisionId}" of Trilium note "${noteId}"`,
      });
      return typeof text === 'string' ? text : '';
    },

    /**
     * Export a note subtree and return the primary text entry.
     *
     * ETAPI 0.106.0 returns a ZIP archive for every format; this method extracts
     * the first `.md` (markdown) or `.html` (html/share) entry.
     * @param {string} noteId
     * @param {'html'|'markdown'|'share'} [format]
     * @returns {Promise<string>}
     */
    async exportNote(noteId, format = 'markdown') {
      const safeFormat = EXPORT_FORMATS.includes(format) ? format : 'markdown';
      const bytes = await request(ENDPOINTS.noteExport(noteId), {
        params: { format: safeFormat },
        expect: 'buffer',
        context: `export Trilium note "${noteId}" as ${safeFormat}`,
      });
      return decodeExportBody(bytes ?? new Uint8Array(), safeFormat);
    },

    /**
     * Non-throwing connectivity probe, suitable for tool summaries and tests.
     * @returns {Promise<{connected: boolean, version?: string, error?: string}>}
     */
    async health() {
      if (!token) return { connected: false, error: MISSING_TOKEN_MESSAGE };
      try {
        const info = await api.appInfo();
        return { connected: true, version: info.appVersion };
      } catch (error) {
        return { connected: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  return api;
}
