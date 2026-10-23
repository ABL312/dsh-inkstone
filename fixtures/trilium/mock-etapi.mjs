/**
 * Mock ETAPI server used by `scripts/test-trilium.mjs`.
 *
 * Speaks the real ETAPI 0.106.0 route shapes (verified against the OpenAPI
 * document bundled in the Trilium desktop installation) so the client and the
 * `trilium-paper` tools are exercised without a live Trilium instance:
 *
 * - `Authorization: <token>` only (raw token, no Bearer prefix) -> otherwise 401
 * - `GET /etapi/notes?search=...` -> `{ results: Note[] }`
 * - `GET /etapi/notes/{id}` -> Note (attributes/childNoteIds inline)
 * - `GET /etapi/notes/{id}/children` -> 404, mirroring 0.106.0 (no such route)
 * - `GET /etapi/notes/{id}/export?format=...` -> ZIP archive
 * - attachments: POST /attachments (JSON) + PUT /attachments/{id}/content
 * - revisions: GET /notes/{id}/revisions, POST /notes/{id}/revision,
 *   GET /revisions/{id}[/content]
 * - attributes: POST /attributes, GET/PATCH/DELETE /attributes/{id}
 * - notes: POST /create-note, PATCH/DELETE /notes/{id}, POST /notes/{id}/undelete
 *
 * Every request is recorded (method, path, query, headers, raw body, parsed
 * JSON) so tests can assert both protocol details and tool behavior.
 *
 * @module dsh-inkstone/fixtures/trilium/mock-etapi
 */

import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';

const DATA_DIR = new URL('./data/', import.meta.url);

const NOW_LOCAL = '2026-10-23 21:30:00.000+0800';
const NOW_UTC = '2026-10-23 13:30:00.000Z';

/**
 * Read one fixture JSON file.
 * @param {string} name
 * @returns {any}
 */
function loadJson(name) {
  return JSON.parse(fs.readFileSync(new URL(name, DATA_DIR), 'utf8'));
}

/**
 * Build a ZIP archive with deflate-compressed entries. The mock does not bother
 * with CRC values because the client only needs names, sizes and payloads.
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBuffer, compressed);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const localBuffer = Buffer.concat(localParts);
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localBuffer.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

/**
 * Read a request body into a Buffer.
 * @param {http.IncomingMessage} request
 * @returns {Promise<Buffer>}
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * Start the mock ETAPI server on an ephemeral 127.0.0.1 port.
 * @param {{tokens?: string[]}} [options]
 * @returns {Promise<{baseUrl: string, port: number, tokens: string[], requests: object[], state: object, close: () => Promise<void>}>}
 */
export async function startMockEtapi(options = {}) {
  const tokens = Array.isArray(options.tokens) && options.tokens.length > 0 ? options.tokens.slice() : ['test-token'];

  const notesFixture = loadJson('notes.json');
  const contentsFixture = loadJson('contents.json');
  const revisionsFixture = loadJson('revisions.json');
  const revisionContentsFixture = loadJson('revision-contents.json');
  const attachmentsFixture = loadJson('attachments.json');
  const attachmentContentsFixture = loadJson('attachment-contents.json');
  const exportFixture = loadJson('export.json');
  const appInfo = loadJson('app-info.json');

  /** @type {Record<string, any>} */
  const state = {
    notes: structuredClone(notesFixture),
    contents: structuredClone(contentsFixture),
    revisions: structuredClone(revisionsFixture),
    revisionContents: structuredClone(revisionContentsFixture),
    attachments: structuredClone(attachmentsFixture),
    /** @type {Record<string, {mime: string, buffer: Buffer}>} */
    attachmentContents: Object.fromEntries(
      Object.entries(attachmentContentsFixture).map(([attachmentId, value]) => [
        attachmentId,
        { mime: String(value.mime), buffer: Buffer.from(String(value.base64), 'base64') },
      ]),
    ),
    exportText: structuredClone(exportFixture),
    // `noteTrashed` models a note already in the Trilium Trash: it is hidden
    // from search, still addressable by id, and restorable.
    trashed: new Set(['noteTrashed']),
  };

  const requests = [];
  let attachmentCounter = 0;
  let attributeCounter = 0;
  let noteCounter = 0;

  /** @param {string} attachmentId */
  const findAttachment = (attachmentId) => {
    for (const list of Object.values(state.attachments)) {
      const found = list.find((item) => item.attachmentId === attachmentId);
      if (found) return found;
    }
    return undefined;
  };

  /** @param {string} attributeId */
  const findAttribute = (attributeId) => {
    for (const note of Object.values(state.notes)) {
      const found = (note.attributes ?? []).find((item) => item.attributeId === attributeId);
      if (found) return { note, attribute: found };
    }
    return undefined;
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mock.local');
    const bodyBuffer = await readBody(request);
    const contentType = String(request.headers['content-type'] ?? '');
    let json;
    if (bodyBuffer.length > 0 && contentType.includes('application/json')) {
      try {
        json = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        json = undefined;
      }
    }
    requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...request.headers },
      body: bodyBuffer,
      text: bodyBuffer.toString('utf8'),
      json,
    });

    const sendJson = (status, value) => {
      const text = JSON.stringify(value);
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
      response.end(text);
    };
    const sendText = (status, text, type = 'text/html; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
      response.end(text);
    };
    const sendBuffer = (status, buffer, type = 'application/octet-stream') => {
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': buffer.length });
      response.end(buffer);
    };
    const noContent = () => {
      response.writeHead(204);
      response.end();
    };
    const routerNotFound = () =>
      sendJson(404, {
        status: 404,
        code: 'ROUTER_NOT_FOUND',
        message: `Router not found for request ${request.method} ${url.pathname}`,
      });

    if (!url.pathname.startsWith('/etapi')) return routerNotFound();
    const suffix = url.pathname.slice('/etapi'.length) || '/';

    if (suffix === '/auth/login') {
      return sendJson(201, { authToken: 'mock-auth-token' });
    }

    const authorization = String(request.headers.authorization ?? '').trim();
    if (!authorization || !tokens.includes(authorization)) {
      return sendJson(401, { status: 401, code: 'NOT_AUTHENTICATED', message: 'Not authenticated' });
    }

    const method = request.method ?? 'GET';
    let match;

    if (method === 'GET' && suffix === '/app-info') return sendJson(200, appInfo);

    if (method === 'GET' && suffix === '/notes') {
      const search = String(url.searchParams.get('search') ?? '').trim();
      if (!search) {
        return sendJson(400, { status: 400, code: 'SEARCH_QUERY_MISSING', message: 'Search query is required' });
      }
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const orderBy = url.searchParams.get('orderBy') ?? 'dateModified';
      const orderDirection = url.searchParams.get('orderDirection') ?? 'asc';
      const ancestorNoteId = url.searchParams.get('ancestorNoteId');
      let results = Object.values(state.notes).filter(
        (note) => note.noteId !== 'root' && !state.trashed.has(note.noteId),
      );
      if (ancestorNoteId) {
        results = results.filter((note) => Array.isArray(note.parentNoteIds) && note.parentNoteIds.includes(ancestorNoteId));
      } else if (search !== '*') {
        const needle = search.toLowerCase();
        results = results.filter((note) => {
          const haystacks = [String(note.title ?? '').toLowerCase(), String(state.contents[note.noteId] ?? '').toLowerCase()];
          return haystacks.some((value) => value.includes(needle));
        });
      }
      results.sort((left, right) => {
        const leftValue = String(left[orderBy] ?? '');
        const rightValue = String(right[orderBy] ?? '');
        return orderDirection === 'asc' ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
      });
      if (Number.isInteger(limit) && limit > 0) results = results.slice(0, limit);
      return sendJson(200, { results });
    }

    if (method === 'POST' && suffix === '/create-note') {
      if (!json || typeof json !== 'object') {
        return sendJson(400, { status: 400, code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' });
      }
      const parentNoteId = String(json.parentNoteId ?? '');
      const parent = state.notes[parentNoteId];
      if (!parent) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${parentNoteId}' not found` });
      }
      noteCounter += 1;
      const noteId = `createdNote${noteCounter}`;
      const note = {
        noteId,
        title: String(json.title ?? ''),
        type: String(json.type ?? 'text'),
        mime: json.type === 'text' ? 'text/html' : 'application/octet-stream',
        isProtected: false,
        blobId: `blob${noteId}`,
        attributes: [],
        parentNoteIds: [parentNoteId],
        childNoteIds: [],
        parentBranchIds: [`branch${noteId}`],
        childBranchIds: [],
        dateCreated: NOW_LOCAL,
        dateModified: NOW_LOCAL,
        utcDateCreated: NOW_UTC,
        utcDateModified: NOW_UTC,
      };
      state.notes[noteId] = note;
      state.contents[noteId] = String(json.content ?? '');
      if (!Array.isArray(parent.childNoteIds)) parent.childNoteIds = [];
      parent.childNoteIds.push(noteId);
      return sendJson(201, {
        note,
        branch: {
          branchId: `branch${noteId}`,
          noteId,
          parentNoteId,
          prefix: '',
          notePosition: 10,
          isExpanded: false,
          utcDateModified: NOW_UTC,
        },
      });
    }

    match = suffix.match(/^\/notes\/([^/]+)$/);
    if (match) {
      const noteId = decodeURIComponent(match[1]);
      const note = state.notes[noteId];
      if (!note) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      if (method === 'GET') return sendJson(200, note);
      if (method === 'PATCH') {
        if (!json || typeof json !== 'object') {
          return sendJson(400, { status: 400, code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' });
        }
        for (const key of ['title', 'type', 'mime']) {
          if (typeof json[key] === 'string') note[key] = json[key];
        }
        note.dateModified = NOW_LOCAL;
        note.utcDateModified = NOW_UTC;
        return sendJson(200, note);
      }
      if (method === 'DELETE') {
        state.trashed.add(noteId);
        return noContent();
      }
      return routerNotFound();
    }

    match = suffix.match(/^\/notes\/([^/]+)\/content$/);
    if (match) {
      const noteId = decodeURIComponent(match[1]);
      if (!state.notes[noteId]) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      if (method === 'GET') return sendText(200, String(state.contents[noteId] ?? ''));
      if (method === 'PUT') {
        state.contents[noteId] = bodyBuffer.toString('utf8');
        return noContent();
      }
      return routerNotFound();
    }

    match = suffix.match(/^\/notes\/([^/]+)\/export$/);
    if (match) {
      const noteId = decodeURIComponent(match[1]);
      const note = state.notes[noteId];
      if (!note) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      const format = url.searchParams.get('format') ?? 'html';
      const key = format === 'markdown' ? 'markdown' : 'html';
      const text =
        state.exportText[noteId]?.[key] ??
        (key === 'markdown' ? `# ${note.title}\n` : `<h1>${note.title}</h1>\n`);
      const archive = buildZip([
        { name: key === 'markdown' ? `${noteId}.md` : `${noteId}.html`, data: Buffer.from(text, 'utf8') },
      ]);
      return sendBuffer(200, archive, 'application/zip');
    }

    match = suffix.match(/^\/notes\/([^/]+)\/revisions$/);
    if (match) {
      const noteId = decodeURIComponent(match[1]);
      if (!state.notes[noteId]) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      if (method === 'GET') return sendJson(200, state.revisions[noteId] ?? []);
      return routerNotFound();
    }

    match = suffix.match(/^\/notes\/([^/]+)\/revision$/);
    if (match) {
      if (method === 'POST') return noContent();
      return routerNotFound();
    }

    match = suffix.match(/^\/notes\/([^/]+)\/attachments$/);
    if (match) {
      const noteId = decodeURIComponent(match[1]);
      if (!state.notes[noteId]) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      if (method === 'GET') return sendJson(200, state.attachments[noteId] ?? []);
      return routerNotFound();
    }

    match = suffix.match(/^\/notes\/([^/]+)\/undelete$/);
    if (match) {
      const noteId = decodeURIComponent(match[1]);
      if (!state.notes[noteId]) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      if (method === 'POST') {
        state.trashed.delete(noteId);
        return sendJson(200, { success: true });
      }
      return routerNotFound();
    }

    // 0.106.0 does not expose a children route; mirror that so the client's
    // childNoteIds-based strategy is what gets exercised.
    match = suffix.match(/^\/notes\/([^/]+)\/children$/);
    if (match) return routerNotFound();

    match = suffix.match(/^\/revisions\/([^/]+)\/content$/);
    if (match) {
      const revisionId = decodeURIComponent(match[1]);
      if (method === 'GET') return sendText(200, String(state.revisionContents[revisionId] ?? ''));
      return routerNotFound();
    }

    match = suffix.match(/^\/revisions\/([^/]+)$/);
    if (match) {
      const revisionId = decodeURIComponent(match[1]);
      for (const list of Object.values(state.revisions)) {
        const found = list.find((item) => item.revisionId === revisionId);
        if (found) return sendJson(200, found);
      }
      return sendJson(404, { status: 404, code: 'REVISION_NOT_FOUND', message: `Revision '${revisionId}' not found` });
    }

    if (method === 'POST' && suffix === '/attachments') {
      if (!json || typeof json !== 'object') {
        return sendJson(400, { status: 400, code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' });
      }
      const ownerId = String(json.ownerId ?? '');
      if (!state.notes[ownerId]) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${ownerId}' not found` });
      }
      attachmentCounter += 1;
      const attachmentId = `attUpload${attachmentCounter}`;
      const attachment = {
        attachmentId,
        ownerId,
        role: String(json.role ?? 'file'),
        mime: String(json.mime ?? 'application/octet-stream'),
        title: String(json.title ?? 'attachment'),
        position: 10,
        blobId: `blob${attachmentId}`,
        dateModified: NOW_LOCAL,
        utcDateModified: NOW_UTC,
        contentLength: 0,
      };
      if (!Array.isArray(state.attachments[ownerId])) state.attachments[ownerId] = [];
      state.attachments[ownerId].push(attachment);
      state.attachmentContents[attachmentId] = { mime: attachment.mime, buffer: Buffer.alloc(0) };
      return sendJson(201, attachment);
    }

    match = suffix.match(/^\/attachments\/([^/]+)\/content$/);
    if (match) {
      const attachmentId = decodeURIComponent(match[1]);
      const meta = findAttachment(attachmentId);
      if (!meta && !state.attachmentContents[attachmentId]) {
        return sendJson(404, { status: 404, code: 'ATTACHMENT_NOT_FOUND', message: `Attachment '${attachmentId}' not found` });
      }
      const stored = state.attachmentContents[attachmentId] ?? { mime: 'application/octet-stream', buffer: Buffer.alloc(0) };
      if (method === 'GET') return sendBuffer(200, stored.buffer, stored.mime);
      if (method === 'PUT') {
        state.attachmentContents[attachmentId] = { mime: stored.mime, buffer: bodyBuffer };
        if (meta) meta.contentLength = bodyBuffer.length;
        return noContent();
      }
      return routerNotFound();
    }

    match = suffix.match(/^\/attachments\/([^/]+)$/);
    if (match) {
      const attachmentId = decodeURIComponent(match[1]);
      const meta = findAttachment(attachmentId);
      if (!meta) {
        return sendJson(404, { status: 404, code: 'ATTACHMENT_NOT_FOUND', message: `Attachment '${attachmentId}' not found` });
      }
      if (method === 'GET') return sendJson(200, meta);
      if (method === 'DELETE') {
        for (const [ownerId, list] of Object.entries(state.attachments)) {
          state.attachments[ownerId] = list.filter((item) => item.attachmentId !== attachmentId);
        }
        delete state.attachmentContents[attachmentId];
        return noContent();
      }
      return routerNotFound();
    }

    if (method === 'POST' && suffix === '/attributes') {
      if (!json || typeof json !== 'object') {
        return sendJson(400, { status: 400, code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' });
      }
      const noteId = String(json.noteId ?? '');
      const note = state.notes[noteId];
      if (!note) {
        return sendJson(404, { status: 404, code: 'NOTE_NOT_FOUND', message: `Note '${noteId}' not found` });
      }
      attributeCounter += 1;
      const attribute = {
        attributeId: `attr${attributeCounter}`,
        noteId,
        type: json.type === 'relation' ? 'relation' : 'label',
        name: String(json.name ?? ''),
        value: String(json.value ?? ''),
        position: 10,
        isInheritable: json.isInheritable === true,
        utcDateModified: NOW_UTC,
      };
      if (!Array.isArray(note.attributes)) note.attributes = [];
      note.attributes.push(attribute);
      return sendJson(201, attribute);
    }

    match = suffix.match(/^\/attributes\/([^/]+)$/);
    if (match) {
      const attributeId = decodeURIComponent(match[1]);
      const found = findAttribute(attributeId);
      if (!found) {
        return sendJson(404, { status: 404, code: 'ATTRIBUTE_NOT_FOUND', message: `Attribute '${attributeId}' not found` });
      }
      if (method === 'GET') return sendJson(200, found.attribute);
      if (method === 'PATCH') {
        if (json && typeof json === 'object') {
          if (typeof json.value === 'string') found.attribute.value = json.value;
          if (typeof json.name === 'string') found.attribute.name = json.name;
        }
        return sendJson(200, found.attribute);
      }
      if (method === 'DELETE') {
        found.note.attributes = found.note.attributes.filter((item) => item.attributeId !== attributeId);
        return noContent();
      }
      return routerNotFound();
    }

    return routerNotFound();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    tokens,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
