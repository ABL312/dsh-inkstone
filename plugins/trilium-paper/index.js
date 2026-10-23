/**
 * 纸 · Trilium Notes — Host tools over the ETAPI client.
 *
 * Registers task-level tools for searching/reading/writing Trilium notes,
 * attaching workspace files, and inspecting history/export. With
 * `advancedTools: true` two fine-grained tools are added (attributes and
 * trash/restore).
 *
 * Credentials are resolved **at tool-call time** via `lib/secrets.mjs`
 * (`triliumToken`): explicit config -> environment -> `~/.dsh-inkstone/
 * trilium-etapi-token.txt`. The Host process environment is fixed at launch, so
 * a secret file is the only way a token added later becomes visible without a
 * restart. Nothing is cached at module load.
 *
 * Known limitations (also surfaced in tool output where relevant):
 * - ETAPI cannot read protected notes; their title/content come back as
 *   `[protected]`.
 * - ETAPI 0.106.0 has no children route; child notes are resolved from the
 *   parent note's `childNoteIds` (see lib/trilium-client.mjs).
 * - ETAPI export returns a ZIP archive; `trilium_history` extracts the primary
 *   Markdown/HTML entry from it.
 * - `path` arguments resolve against the session working directory; absolute
 *   paths are accepted as-is.
 *
 * @module dsh-inkstone/plugins/trilium-paper
 */

import fs from 'node:fs';
import path from 'node:path';

import { createTriliumClient } from '../../lib/trilium-client.mjs';
import {
  defineTool,
  envValue,
  normalizeConfig,
  optionalInteger,
  optionalString,
  renderSummary,
  requireString,
  sessionCwd,
  textBlocks,
  truncate,
} from '../../lib/tool-kit.mjs';
import { displayPath, ensureDir } from '../../lib/paths.mjs';
import { secretHint, triliumToken } from '../../lib/secrets.mjs';
import { looksLikeMarkdown, markdownToHtml } from './markdown.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'trilium-paper';

/** Services required by the Trilium tool suite. */
export const inject = ['tools'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CHARS = 20000;
const HARD_MAX_CHARS = 30000;
const DEFAULT_LIMIT = 20;
const HARD_LIMIT = 100;

const WRITE_ACTIONS = ['create', 'append', 'replace', 'title'];
const ATTACH_ACTIONS = ['upload', 'list', 'download'];
const HISTORY_ACTIONS = ['revisions', 'export'];
const ATTRIBUTE_ACTIONS = ['get', 'set', 'delete'];
const DELETE_ACTIONS = ['trash', 'restore'];

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalize the Loader-provided config once per `apply` call. The raw config is
 * kept so credentials can be resolved per tool call (see module header).
 * @param {unknown} config
 * @returns {{raw: Record<string, any>, baseUrl: string, defaultParentNoteId: string | undefined, allowWrites: boolean, advancedTools: boolean, timeoutMs: number}}
 */
function resolveConfig(config) {
  const raw = normalizeConfig(config);
  const configuredBaseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim().length > 0 ? raw.baseUrl.trim() : undefined;
  return {
    raw,
    baseUrl: (configuredBaseUrl ?? envValue('TRILIUM_ETAPI_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    defaultParentNoteId:
      typeof raw.defaultParentNoteId === 'string' && raw.defaultParentNoteId.trim().length > 0
        ? raw.defaultParentNoteId.trim()
        : undefined,
    allowWrites: raw.allowWrites !== false,
    advancedTools: raw.advancedTools === true,
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? Math.floor(raw.timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Resolve the ETAPI token at call time and build a client.
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {{allowWrites?: boolean}} [overrides]
 * @returns {ReturnType<typeof createTriliumClient>}
 */
function clientFor(config, overrides = {}) {
  const token = triliumToken(config.raw);
  if (!token) throw new Error(secretHint('trilium'));
  return createTriliumClient({
    baseUrl: config.baseUrl,
    token,
    timeoutMs: config.timeoutMs,
    allowWrites: overrides.allowWrites ?? config.allowWrites,
  });
}

/**
 * Reject a mutating tool when the plugin is configured read-only.
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {string} action
 */
function requireWrites(config, action) {
  if (config.allowWrites) return;
  throw new Error(
    `Trilium writes are disabled (allowWrites: false), so "${action}" cannot run. ` +
      'Set allowWrites: true in the inkstone-trilium config row of your DSH profile patch to enable writes.',
  );
}

/* -------------------------------------------------------------------------- */
/* Argument helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Cap for `maxChars` arguments.
 * @param {Record<string, any>} args
 * @returns {number}
 */
function maxCharsArg(args) {
  return Math.min(optionalInteger(args, 'maxChars', DEFAULT_MAX_CHARS), HARD_MAX_CHARS);
}

/**
 * Cap for `limit` arguments.
 * @param {Record<string, any>} args
 * @returns {number}
 */
function limitArg(args) {
  return Math.min(optionalInteger(args, 'limit', DEFAULT_LIMIT), HARD_LIMIT);
}

/**
 * Resolve a workspace-relative or absolute path against the session cwd.
 * @param {any} exec tool execution context
 * @param {string} input path argument
 * @param {string} label error label
 * @returns {{absolute: string, display: string}}
 */
function workspacePath(exec, input, label) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} requires a non-empty path.`);
  }
  const cwd = sessionCwd(exec);
  const value = input.trim();
  const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
  return { absolute, display: displayPath(cwd, absolute) };
}

/**
 * Normalize content per the `format` argument.
 * @param {string} rawContent
 * @param {'auto'|'html'|'markdown'} format
 * @returns {{html: string, converted: boolean}}
 */
function renderContent(rawContent, format) {
  const value = String(rawContent ?? '');
  if (format === 'html') return { html: value, converted: false };
  if (format === 'markdown') return { html: markdownToHtml(value), converted: true };
  if (looksLikeMarkdown(value)) return { html: markdownToHtml(value), converted: true };
  return { html: value, converted: false };
}

/**
 * Validate/normalize the `format` argument.
 * @param {unknown} value
 * @returns {'auto'|'html'|'markdown'}
 */
function resolveFormat(value) {
  return value === 'html' || value === 'markdown' ? value : 'auto';
}

/**
 * Cooperative tool budget: a tool may issue several sequential ETAPI requests,
 * each individually bounded by `config.timeoutMs`, so the tool-level budget is
 * twice the per-request timeout.
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {number}
 */
function toolTimeoutMs(config) {
  return Math.max(Math.floor(config.timeoutMs * 2), 20000);
}

/* -------------------------------------------------------------------------- */
/* Compact JSON shapes (must satisfy the declared output schemas)              */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} note
 * @returns {{noteId: string, title: string, type: string, dateModified: string}}
 */
function noteRef(note) {
  return {
    noteId: String(note?.noteId ?? ''),
    title: String(note?.title ?? ''),
    type: String(note?.type ?? ''),
    dateModified: String(note?.dateModified ?? ''),
  };
}

/**
 * @param {any} attachment
 * @returns {{attachmentId: string, title: string, role: string, mime: string, contentLength?: number}}
 */
function attachmentRef(attachment) {
  const record = {
    attachmentId: String(attachment?.attachmentId ?? ''),
    title: String(attachment?.title ?? ''),
    role: String(attachment?.role ?? ''),
    mime: String(attachment?.mime ?? ''),
  };
  if (Number.isInteger(attachment?.contentLength)) record.contentLength = attachment.contentLength;
  return record;
}

/**
 * @param {any} attribute
 * @returns {{attributeId: string, type: string, name: string, value: string, isInheritable: boolean}}
 */
function attributeRef(attribute) {
  return {
    attributeId: String(attribute?.attributeId ?? ''),
    type: attribute?.type === 'relation' ? 'relation' : 'label',
    name: String(attribute?.name ?? ''),
    value: String(attribute?.value ?? ''),
    isInheritable: attribute?.isInheritable === true,
  };
}

/* -------------------------------------------------------------------------- */
/* Output schemas (supported JSON-Schema subset only)                          */
/* -------------------------------------------------------------------------- */

const NOTE_REF_SCHEMA = {
  type: 'object',
  properties: {
    noteId: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string' },
    dateModified: { type: 'string' },
  },
  required: ['noteId', 'title', 'type', 'dateModified'],
  additionalProperties: false,
};

const ATTACHMENT_REF_SCHEMA = {
  type: 'object',
  properties: {
    attachmentId: { type: 'string' },
    title: { type: 'string' },
    role: { type: 'string' },
    mime: { type: 'string' },
    contentLength: { type: 'integer' },
  },
  required: ['attachmentId', 'title', 'role', 'mime'],
  additionalProperties: false,
};

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    value: { type: 'string' },
  },
  required: ['name', 'value'],
  additionalProperties: false,
};

const ATTRIBUTE_SCHEMA = {
  type: 'object',
  properties: {
    attributeId: { type: 'string' },
    type: { type: 'string', enum: ['label', 'relation'] },
    name: { type: 'string' },
    value: { type: 'string' },
    isInheritable: { type: 'boolean' },
  },
  required: ['attributeId', 'type', 'name', 'value', 'isInheritable'],
  additionalProperties: false,
};

const REVISION_REF_SCHEMA = {
  type: 'object',
  properties: {
    revisionId: { type: 'string' },
    dateLastEdited: { type: 'string' },
    title: { type: 'string' },
    contentLength: { type: 'integer' },
  },
  required: ['revisionId', 'dateLastEdited', 'title'],
  additionalProperties: false,
};

const NOTES_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } };

const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Trilium search query: keywords, "exact phrase", #label, or #label = value.',
    },
    ancestorNoteId: {
      type: 'string',
      description: 'Limit the search to the subtree of this note id.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of results to return (default 20, max 100).',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const SEARCH_OUTPUT = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    count: { type: 'integer' },
    results: { type: 'array', items: NOTE_REF_SCHEMA },
  },
  required: ['query', 'count', 'results'],
  additionalProperties: false,
};

const READ_PARAMETERS = {
  type: 'object',
  properties: {
    noteId: { type: 'string', description: 'Id of the Trilium note to read.' },
    includeChildren: { type: 'boolean', description: 'Also return direct child notes (default false).' },
    includeAttachments: { type: 'boolean', description: 'Also return the note attachments (default false).' },
    maxChars: {
      type: 'integer',
      description: 'Maximum content characters to return (default 20000, max 30000).',
    },
  },
  required: ['noteId'],
  additionalProperties: false,
};

const READ_OUTPUT = {
  type: 'object',
  properties: {
    noteId: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string' },
    path: { type: 'array', items: { type: 'string' } },
    labels: { type: 'array', items: LABEL_SCHEMA },
    content: { type: 'string' },
    contentTruncated: { type: 'boolean' },
    children: { type: 'array', items: NOTE_REF_SCHEMA },
    attachments: { type: 'array', items: ATTACHMENT_REF_SCHEMA },
    notes: NOTES_ARRAY_SCHEMA,
  },
  required: ['noteId', 'title', 'type', 'path', 'labels', 'content', 'contentTruncated', 'notes'],
  additionalProperties: false,
};

const WRITE_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: WRITE_ACTIONS,
      description: 'create a new note, append to existing content, replace content, or change the title.',
    },
    parentNoteId: {
      type: 'string',
      description: 'Parent note id for action "create"; falls back to the plugin defaultParentNoteId.',
    },
    noteId: { type: 'string', description: 'Existing note id for actions append/replace/title.' },
    title: { type: 'string', description: 'Note title for actions create/title.' },
    content: { type: 'string', description: 'Note content for actions create/append/replace.' },
    format: {
      type: 'string',
      enum: ['auto', 'html', 'markdown'],
      description: 'Content interpretation: html writes unchanged, markdown is converted, auto detects (default auto).',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const WRITE_OUTPUT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: WRITE_ACTIONS },
    noteId: { type: 'string' },
    title: { type: 'string' },
    parentNoteId: { type: 'string' },
    path: { type: 'array', items: { type: 'string' } },
    htmlLength: { type: 'integer' },
    notes: NOTES_ARRAY_SCHEMA,
  },
  required: ['action', 'noteId', 'title', 'notes'],
  additionalProperties: false,
};

const ATTACH_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ATTACH_ACTIONS,
      description: 'upload a workspace file, list a note attachments, or download an attachment.',
    },
    noteId: { type: 'string', description: 'Target note for "upload"; owning note for "list".' },
    path: {
      type: 'string',
      description: 'Source file for "upload" or destination file for "download", relative to the session working directory.',
    },
    attachmentId: { type: 'string', description: 'Attachment id for "download".' },
    title: { type: 'string', description: 'Attachment title for "upload" (defaults to the source file name).' },
    role: {
      type: 'string',
      enum: ['file', 'image'],
      description: 'Trilium attachment role (default file).',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const ATTACH_OUTPUT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ATTACH_ACTIONS },
    attachmentId: { type: 'string' },
    noteId: { type: 'string' },
    title: { type: 'string' },
    role: { type: 'string' },
    mime: { type: 'string' },
    bytes: { type: 'integer' },
    path: { type: 'string' },
    attachments: { type: 'array', items: ATTACHMENT_REF_SCHEMA },
    notes: NOTES_ARRAY_SCHEMA,
  },
  required: ['action', 'notes'],
  additionalProperties: false,
};

const HISTORY_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: HISTORY_ACTIONS,
      description: 'revisions lists saved note revisions; export returns the note subtree as text.',
    },
    noteId: { type: 'string', description: 'Id of the note to inspect.' },
    format: {
      type: 'string',
      enum: ['markdown', 'html'],
      description: 'Export format (default markdown).',
    },
    outputPath: {
      type: 'string',
      description: 'Write the export to this workspace path; when omitted the text is returned inline (truncated).',
    },
    limit: { type: 'integer', description: 'Maximum revisions to list (default 20, max 100).' },
  },
  required: ['action', 'noteId'],
  additionalProperties: false,
};

const HISTORY_OUTPUT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: HISTORY_ACTIONS },
    noteId: { type: 'string' },
    format: { type: 'string', enum: ['markdown', 'html'] },
    revisions: { type: 'array', items: REVISION_REF_SCHEMA },
    outputPath: { type: 'string' },
    chars: { type: 'integer' },
    content: { type: 'string' },
    contentTruncated: { type: 'boolean' },
    notes: NOTES_ARRAY_SCHEMA,
  },
  required: ['action', 'noteId', 'notes'],
  additionalProperties: false,
};

const ATTRIBUTES_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ATTRIBUTE_ACTIONS,
      description: 'get lists attributes; set creates a label/relation; delete removes an attribute.',
    },
    noteId: { type: 'string', description: 'Owning note id for get/set.' },
    attributeId: { type: 'string', description: 'Attribute id for delete.' },
    type: { type: 'string', enum: ['label', 'relation'], description: 'Attribute type for set (default label).' },
    name: { type: 'string', description: 'Attribute name for set, e.g. inkstone/status.' },
    value: { type: 'string', description: 'Attribute value for set (default empty).' },
    isInheritable: { type: 'boolean', description: 'Whether the attribute is inheritable by descendants (default false).' },
  },
  required: ['action'],
  additionalProperties: false,
};

const ATTRIBUTES_OUTPUT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ATTRIBUTE_ACTIONS },
    noteId: { type: 'string' },
    attributeId: { type: 'string' },
    attribute: ATTRIBUTE_SCHEMA,
    attributes: { type: 'array', items: ATTRIBUTE_SCHEMA },
    notes: NOTES_ARRAY_SCHEMA,
  },
  required: ['action', 'notes'],
  additionalProperties: false,
};

const DELETE_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: DELETE_ACTIONS, description: 'trash moves the note to the Trash; restore undeletes it.' },
    noteId: { type: 'string', description: 'Id of the note to trash or restore.' },
  },
  required: ['action', 'noteId'],
  additionalProperties: false,
};

const DELETE_OUTPUT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: DELETE_ACTIONS },
    noteId: { type: 'string' },
    success: { type: 'boolean' },
    notes: NOTES_ARRAY_SCHEMA,
  },
  required: ['action', 'noteId', 'success', 'notes'],
  additionalProperties: false,
};

/* -------------------------------------------------------------------------- */
/* Default tools                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the five default task-level tools.
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {object[]}
 */
function buildDefaultTools(config) {
  return [
    defineTool({
      name: 'trilium_search',
      description:
        'Search Trilium Notes with Trilium search syntax (keywords, "exact phrase", #label, #label = value). ' +
        'Returns note ids, titles and modified dates; use trilium_read to read a result.',
      parameters: SEARCH_PARAMETERS,
      schema: SEARCH_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        const lines = [`${value.count} note(s) matched ${JSON.stringify(value.query)}`];
        for (const item of value.results) lines.push(`- ${item.noteId} | ${item.title} | ${item.dateModified}`);
        if (value.results.length === 0) {
          lines.push('No notes matched; try broader keywords or drop the ancestorNoteId filter.');
        }
        return renderSummary(lines.join('\n'));
      },
      async execute(args) {
        const query = requireString(args, 'query');
        const ancestorNoteId = optionalString(args, 'ancestorNoteId');
        const client = clientFor(config);
        const results = await client.search({ query, ancestorNoteId, limit: limitArg(args) });
        return { query, count: results.length, results: results.map(noteRef) };
      },
    }),

    defineTool({
      name: 'trilium_read',
      description:
        'Read one Trilium note: title, tree path, labels, content, and optionally direct children and ' +
        'attachments. Content is Trilium HTML and is truncated to maxChars.',
      parameters: READ_PARAMETERS,
      schema: READ_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        const lines = [
          `# ${value.title}`,
          `noteId: ${value.noteId}  type: ${value.type}`,
          `path: ${value.path.join(' / ')}`,
        ];
        if (value.labels.length > 0) {
          lines.push(`labels: ${value.labels.map((label) => (label.value ? `${label.name} = ${label.value}` : label.name)).join(', ')}`);
        }
        if (Array.isArray(value.children)) {
          lines.push(`children (${value.children.length}): ${value.children.map((child) => `${child.noteId} ${child.title}`).join('; ') || '-'}`);
        }
        if (Array.isArray(value.attachments)) {
          lines.push(
            `attachments (${value.attachments.length}): ${value.attachments.map((item) => `${item.attachmentId} ${item.title} [${item.mime}]`).join('; ') || '-'}`,
          );
        }
        if (value.notes.length > 0) lines.push(`notes: ${value.notes.join(' ')}`);
        lines.push('', value.content.length > 0 ? value.content : '[no text content]');
        return textBlocks(truncate(lines.join('\n'), HARD_MAX_CHARS));
      },
      async execute(args, exec) {
        const noteId = requireString(args, 'noteId');
        const maxChars = maxCharsArg(args);
        const client = clientFor(config);
        const note = await client.getNote(noteId);
        const pathInfo = await client.getPath(noteId);
        const attributes = Array.isArray(note.attributes) ? note.attributes : [];
        const labels = attributes
          .filter((attribute) => attribute?.type === 'label')
          .map((attribute) => ({ name: String(attribute.name ?? ''), value: String(attribute.value ?? '') }));
        const notes = [];
        if (note.isProtected === true) {
          notes.push('This note is protected: ETAPI returns "[protected]" and cannot read protected content.');
        }
        let content = '';
        if (note.type === 'image' || note.type === 'file') {
          notes.push(`Note type "${note.type}" stores binary content; content is not returned as text.`);
        } else {
          content = await client.getContent(noteId);
        }
        const contentTruncated = content.length > maxChars;
        const data = {
          noteId: String(note.noteId ?? noteId),
          title: String(note.title ?? ''),
          type: String(note.type ?? ''),
          path: Array.isArray(pathInfo.path) ? pathInfo.path.map(String) : [],
          labels,
          content: contentTruncated ? truncate(content, maxChars) : content,
          contentTruncated,
          notes,
        };
        if (args.includeChildren === true) data.children = (await client.getChildren(noteId)).map(noteRef);
        if (args.includeAttachments === true) data.attachments = (await client.getAttachments(noteId)).map(attachmentRef);
        return data;
      },
    }),

    defineTool({
      name: 'trilium_write',
      description:
        'Create a Trilium note or update its content/title. Rejected when the plugin is configured with ' +
        'allowWrites: false. Content format html is written unchanged; markdown is converted to a safe HTML ' +
        'subset; auto detects Markdown-looking input.',
      parameters: WRITE_PARAMETERS,
      schema: WRITE_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        const summary =
          value.action === 'create'
            ? `Created note "${value.title}" (${value.noteId}) under ${value.parentNoteId ?? '(unknown parent)'}.`
            : value.action === 'title'
              ? `Renamed note ${value.noteId} to "${value.title}".`
              : `${value.action === 'append' ? 'Appended to' : 'Replaced content of'} note ${value.noteId} ("${value.title}").`;
        return renderSummary(summary, value.notes.length > 0 ? { notes: value.notes } : undefined);
      },
      async execute(args) {
        requireWrites(config, 'trilium_write');
        const action = requireString(args, 'action');
        if (!WRITE_ACTIONS.includes(action)) {
          throw new Error(`trilium_write action must be one of ${WRITE_ACTIONS.join(', ')} (got "${action}").`);
        }
        const format = resolveFormat(args.format);
        const client = clientFor(config);

        if (action === 'create') {
          const parentNoteId = optionalString(args, 'parentNoteId') ?? config.defaultParentNoteId;
          if (!parentNoteId) {
            throw new Error(
              'trilium_write create requires "parentNoteId" (or a defaultParentNoteId in the inkstone-trilium plugin config).',
            );
          }
          const title = requireString(args, 'title');
          const rawContent = optionalString(args, 'content') ?? '';
          const { html, converted } = renderContent(rawContent, format);
          const created = await client.createNote({ parentNoteId, title, type: 'text', content: html });
          const noteId = String(created?.noteId ?? '');
          if (!noteId) throw new Error('Trilium created a note but did not return its noteId.');
          const notes = [];
          if (converted) notes.push('Markdown content was converted to a safe HTML subset.');
          const data = { action, noteId, title, parentNoteId, htmlLength: html.length, notes };
          try {
            const pathInfo = await client.getPath(noteId);
            if (Array.isArray(pathInfo.path)) data.path = pathInfo.path.map(String);
          } catch {
            // Path lookup is best effort; the note itself was created.
          }
          return data;
        }

        const noteId = requireString(args, 'noteId');
        if (action === 'title') {
          const title = requireString(args, 'title');
          const updated = await client.updateNote(noteId, { title });
          return { action, noteId, title: String(updated?.title ?? title), notes: ['Note title updated.'] };
        }

        const rawContent = optionalString(args, 'content');
        if (rawContent === undefined) {
          throw new Error(`trilium_write ${action} requires a non-empty "content" string.`);
        }
        const { html, converted } = renderContent(rawContent, format);
        if (action === 'append') {
          const existing = await client.getContent(noteId);
          const combined = existing.length > 0 ? `${existing}\n${html}` : html;
          await client.setContent(noteId, combined);
          const note = await client.getNote(noteId);
          return {
            action,
            noteId,
            title: String(note?.title ?? ''),
            htmlLength: html.length,
            notes: [converted ? 'Markdown content was converted to HTML before appending.' : 'HTML content appended.'],
          };
        }
        await client.setContent(noteId, html);
        const note = await client.getNote(noteId);
        return {
          action,
          noteId,
          title: String(note?.title ?? ''),
          htmlLength: html.length,
          notes: [converted ? 'Markdown content was converted to HTML.' : 'Note content replaced.'],
        };
      },
    }),

    defineTool({
      name: 'trilium_attach',
      description:
        'Upload a workspace file as a Trilium attachment, list a note attachments, or download an attachment ' +
        'to the workspace. Uploads are rejected when the plugin is configured with allowWrites: false.',
      parameters: ATTACH_PARAMETERS,
      schema: ATTACH_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        let summary;
        if (value.action === 'upload') {
          summary = `Uploaded attachment ${value.attachmentId} ("${value.title}", ${value.bytes ?? 0} bytes) to note ${value.noteId}.`;
        } else if (value.action === 'list') {
          summary = `${value.attachments?.length ?? 0} attachment(s) on note ${value.noteId}.`;
        } else {
          summary = `Downloaded attachment ${value.attachmentId} to ${value.path} (${value.bytes ?? 0} bytes).`;
        }
        const lines = [summary, ...value.notes];
        if (value.action === 'list') {
          for (const item of value.attachments ?? []) lines.push(`- ${item.attachmentId} | ${item.title} | ${item.role} | ${item.mime}`);
        }
        return renderSummary(lines.join('\n'));
      },
      async execute(args, exec) {
        const action = requireString(args, 'action');
        if (!ATTACH_ACTIONS.includes(action)) {
          throw new Error(`trilium_attach action must be one of ${ATTACH_ACTIONS.join(', ')} (got "${action}").`);
        }
        if (action === 'upload') {
          requireWrites(config, 'trilium_attach upload');
          const noteId = requireString(args, 'noteId');
          const { absolute, display } = workspacePath(exec, requireString(args, 'path'), 'trilium_attach upload');
          let stat;
          try {
            stat = fs.statSync(absolute);
          } catch (error) {
            if (error && error.code === 'ENOENT') {
              throw new Error(`File not found for attachment upload: ${display} (resolved to ${absolute}).`);
            }
            throw error;
          }
          if (!stat.isFile()) throw new Error(`Attachment source is not a regular file: ${display}.`);
          const role = args.role === 'image' ? 'image' : 'file';
          const title = optionalString(args, 'title') ?? path.basename(absolute);
          const client = clientFor(config);
          const attachment = await client.uploadAttachment({ noteId, filePath: absolute, title, role });
          return {
            action,
            attachmentId: String(attachment.attachmentId ?? ''),
            noteId,
            title: String(attachment.title ?? title),
            role: String(attachment.role ?? role),
            mime: String(attachment.mime ?? ''),
            bytes: Number.isInteger(attachment.bytes) ? attachment.bytes : stat.size,
            notes: [`Source file: ${display}.`],
          };
        }
        if (action === 'list') {
          const noteId = requireString(args, 'noteId');
          const client = clientFor(config);
          const attachments = (await client.getAttachments(noteId)).map(attachmentRef);
          return {
            action,
            noteId,
            attachments,
            notes: attachments.length === 0 ? [`Note ${noteId} has no attachments.`] : [],
          };
        }
        const attachmentId = requireString(args, 'attachmentId');
        const { absolute, display } = workspacePath(exec, requireString(args, 'path'), 'trilium_attach download');
        const client = clientFor(config);
        const result = await client.downloadAttachment(attachmentId, absolute);
        return {
          action,
          attachmentId,
          path: display,
          bytes: Number.isInteger(result.bytes) ? result.bytes : 0,
          notes: [`Saved to ${display}.`],
        };
      },
    }),

    defineTool({
      name: 'trilium_history',
      description:
        'Inspect a Trilium note revision history, or export the note subtree as Markdown/HTML text. Export can ' +
        'save the text under the session working directory.',
      parameters: HISTORY_PARAMETERS,
      schema: HISTORY_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        if (value.action === 'export') {
          const lines = [`Exported note ${value.noteId} as ${value.format} (${value.chars ?? 0} chars).`];
          if (value.outputPath) lines.push(`Saved to: ${value.outputPath}`);
          if (typeof value.content === 'string') {
            lines.push('', value.content);
            if (value.contentTruncated === true) lines.push('', '[export text truncated; pass outputPath to save the full text]');
          }
          if (value.notes.length > 0) lines.push('', ...value.notes);
          return textBlocks(truncate(lines.join('\n'), HARD_MAX_CHARS));
        }
        const lines = [`${value.revisions?.length ?? 0} revision(s) for note ${value.noteId}`];
        for (const revision of value.revisions ?? []) {
          lines.push(
            `- ${revision.revisionId} | ${revision.dateLastEdited} | ${revision.title}` +
              (Number.isInteger(revision.contentLength) ? ` | ${revision.contentLength} chars` : ''),
          );
        }
        if (value.notes.length > 0) lines.push('', ...value.notes);
        return renderSummary(lines.join('\n'));
      },
      async execute(args, exec) {
        const action = requireString(args, 'action');
        if (!HISTORY_ACTIONS.includes(action)) {
          throw new Error(`trilium_history action must be one of ${HISTORY_ACTIONS.join(', ')} (got "${action}").`);
        }
        const noteId = requireString(args, 'noteId');
        const client = clientFor(config);
        if (action === 'revisions') {
          const revisions = (await client.getRevisions(noteId))
            .slice()
            .sort((left, right) => String(right?.dateLastEdited ?? '').localeCompare(String(left?.dateLastEdited ?? '')))
            .slice(0, limitArg(args))
            .map((revision) => {
              const item = {
                revisionId: String(revision.revisionId ?? ''),
                dateLastEdited: String(revision.dateLastEdited ?? ''),
                title: String(revision.title ?? ''),
              };
              if (Number.isInteger(revision.contentLength)) item.contentLength = revision.contentLength;
              return item;
            });
          return {
            action,
            noteId,
            revisions,
            notes: revisions.length === 0 ? ['No revisions recorded for this note.'] : [],
          };
        }
        const format = args.format === 'html' ? 'html' : 'markdown';
        const text = await client.exportNote(noteId, format);
        const notes = ['ETAPI export returns a ZIP archive; the plugin extracted its primary text entry.'];
        const outputPath = optionalString(args, 'outputPath');
        if (outputPath) {
          const { absolute, display } = workspacePath(exec, outputPath, 'trilium_history export');
          ensureDir(path.dirname(absolute));
          fs.writeFileSync(absolute, text, 'utf8');
          return { action, noteId, format, outputPath: display, chars: text.length, notes: [...notes, `Text saved to ${display}.`] };
        }
        const inlineLimit = 25000;
        const contentTruncated = text.length > inlineLimit;
        return {
          action,
          noteId,
          format,
          chars: text.length,
          content: contentTruncated ? truncate(text, inlineLimit) : text,
          contentTruncated,
          notes: contentTruncated ? [...notes, 'Pass outputPath to receive the full export text.'] : notes,
        };
      },
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Advanced tools                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the tools enabled by `config.advancedTools`.
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {object[]}
 */
function buildAdvancedTools(config) {
  return [
    defineTool({
      name: 'trilium_attributes',
      description:
        'Read, create or delete Trilium labels/relations on a note. Mutations are rejected when the plugin is ' +
        'configured with allowWrites: false.',
      parameters: ATTRIBUTES_PARAMETERS,
      schema: ATTRIBUTES_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        if (value.action === 'get') {
          const lines = [`${value.attributes?.length ?? 0} attribute(s) on note ${value.noteId}`];
          for (const attribute of value.attributes ?? []) {
            lines.push(
              `- ${attribute.attributeId} | ${attribute.type} | ${attribute.name}` +
                (attribute.value ? ` = ${attribute.value}` : '') +
                (attribute.isInheritable ? ' (inheritable)' : ''),
            );
          }
          return renderSummary(lines.join('\n'));
        }
        if (value.action === 'set') {
          return renderSummary(
            `Created ${value.attribute?.type ?? 'label'} "${value.attribute?.name ?? ''}" (${value.attributeId}) on note ${value.noteId}.`,
          );
        }
        return renderSummary(`Deleted attribute ${value.attributeId}.`);
      },
      async execute(args) {
        const action = requireString(args, 'action');
        if (!ATTRIBUTE_ACTIONS.includes(action)) {
          throw new Error(`trilium_attributes action must be one of ${ATTRIBUTE_ACTIONS.join(', ')} (got "${action}").`);
        }
        const client = clientFor(config);
        if (action === 'get') {
          const noteId = requireString(args, 'noteId');
          const attributes = (await client.getAttributes(noteId)).map(attributeRef);
          return { action, noteId, attributes, notes: [] };
        }
        requireWrites(config, `trilium_attributes ${action}`);
        if (action === 'set') {
          const noteId = requireString(args, 'noteId');
          const name = requireString(args, 'name');
          const type = args.type === 'relation' ? 'relation' : 'label';
          const value = optionalString(args, 'value') ?? '';
          const isInheritable = args.isInheritable === true;
          const created = await client.setAttribute({ noteId, type, name, value, isInheritable });
          return {
            action,
            noteId,
            attributeId: String(created.attributeId ?? ''),
            attribute: attributeRef({ ...created, type: created.type ?? type, name: created.name ?? name, value: created.value ?? value, isInheritable: created.isInheritable ?? isInheritable }),
            notes: [],
          };
        }
        const attributeId = requireString(args, 'attributeId');
        await client.deleteAttribute(attributeId);
        return { action, attributeId, notes: [] };
      },
    }),

    defineTool({
      name: 'trilium_delete',
      description:
        'Move a Trilium note to the Trash or restore it. Rejected when the plugin is configured with allowWrites: false.',
      parameters: DELETE_PARAMETERS,
      schema: DELETE_OUTPUT,
      timeoutMs: toolTimeoutMs(config),
      render(_args, value) {
        return renderSummary(
          value.action === 'trash'
            ? `Note ${value.noteId} moved to the Trilium Trash (recoverable with action "restore").`
            : `Note ${value.noteId} restored from the Trilium Trash.`,
          value.notes.length > 0 ? { notes: value.notes } : undefined,
        );
      },
      async execute(args) {
        const action = requireString(args, 'action');
        if (!DELETE_ACTIONS.includes(action)) {
          throw new Error(`trilium_delete action must be one of ${DELETE_ACTIONS.join(', ')} (got "${action}").`);
        }
        requireWrites(config, `trilium_delete ${action}`);
        const noteId = requireString(args, 'noteId');
        const client = clientFor(config);
        if (action === 'trash') {
          await client.deleteNote(noteId);
          return {
            action,
            noteId,
            success: true,
            notes: ['Note moved to the Trilium Trash; it can be restored with action "restore".'],
          };
        }
        const result = await client.restoreNote(noteId);
        return {
          action,
          noteId,
          success: result.restored !== false,
          notes: ['The note must have at least one undeleted parent to be restored.'],
        };
      },
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register the Trilium tools. Registrations are Cordis fiber-scoped effects, so
 * no manual teardown is needed on dispose.
 * @param {any} ctx Cordis plugin context with `tools`
 * @param {unknown} config Loader-provided plugin config
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const tools = buildDefaultTools(resolved);
  if (resolved.advancedTools) tools.push(...buildAdvancedTools(resolved));
  for (const tool of tools) ctx.tools.register(tool);
}
