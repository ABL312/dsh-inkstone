/**
 * Step handlers for the inkstone pipeline.
 *
 * Service modules (`zotero-client`, `bib`, `typst-runner`, `heal`,
 * `typst-scaffold`, `trilium-client`) are imported lazily so that recipe
 * listing/validation and unrelated steps keep working even if one integration
 * is unavailable; a step that needs a missing module fails with a clear error.
 *
 * @module dsh-inkstone/lib/pipeline-steps
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from './tool-kit.mjs';
import { ensureDir, listFiles, readTextBounded } from './paths.mjs';
import { writeReport, saveRun } from './run-store.mjs';
import { secretHint, triliumToken } from './secrets.mjs';

/** @type {Record<string, Promise<any>> | undefined} */
let moduleCache;

/**
 * Lazily import one service module.
 * @param {'zotero-client' | 'bib' | 'typst-runner' | 'heal' | 'typst-scaffold' | 'trilium-client'} name
 * @returns {Promise<any>}
 */
async function service(name) {
  moduleCache ??= {};
  if (!moduleCache[name]) {
    moduleCache[name] = import(`./${name}.mjs`).catch((error) => {
      delete moduleCache[name];
      throw new Error(`service module "${name}" is unavailable: ${errorMessage(error)}`);
    });
  }
  return moduleCache[name];
}

/**
 * Resolve a path argument against the project directory.
 * @param {string | undefined} value
 * @param {object} context
 * @returns {string | undefined}
 */
function resolveAgainstProject(value, context) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(context.projectDir, value);
}

/**
 * Environment plus flow-config settings for the Zotero integration.
 * @param {Record<string, any>} config
 * @returns {{localApiUrl: string, dataDir: string}}
 */
function zoteroSettings(config) {
  return {
    localApiUrl: process.env.ZOTERO_LOCAL_API_URL || config.zoteroLocalApiUrl || 'http://127.0.0.1:23119',
    dataDir: process.env.ZOTERO_DATA_DIR || config.zoteroDataDir || path.join(os.homedir(), 'Zotero'),
  };
}

/**
 * Environment plus flow-config settings for the Trilium integration.
 * @param {Record<string, any>} config
 * @returns {{baseUrl: string, token: string | undefined}}
 */
function triliumSettings(config) {
  return {
    baseUrl: process.env.TRILIUM_ETAPI_URL || config.triliumBaseUrl || 'http://127.0.0.1:8080',
    token: triliumToken(config),
  };
}

/**
 * Minimal Markdown-to-HTML conversion for publishing notes. It intentionally
 * handles only the constructs the pipeline emits (headings, lists, emphasis,
 * code, links, paragraphs) and escapes raw HTML.
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToHtml(markdown) {
  const escape = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const inline = (text) => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = String(markdown ?? '').split(/\r?\n/);
  const html = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? ordered)[1]);
      continue;
    }
    if (trimmed.startsWith('```')) {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return html.join('\n');
}

/**
 * Read a text document for publishing, converting Markdown to HTML.
 * @param {string} file
 * @returns {string}
 */
function readDocumentForPublish(file) {
  const text = readTextBounded(file);
  return file.toLowerCase().endsWith('.md') ? markdownToHtml(text) : text;
}

/**
 * Build the attachment file list for a publish step.
 * @param {unknown} attach
 * @returns {string[]}
 */
function attachmentList(attach) {
  if (Array.isArray(attach)) return attach.filter((item) => typeof item === 'string' && item.length > 0);
  if (typeof attach === 'string' && attach.length > 0) return [attach];
  return [];
}

/**
 * Build the HTML body for a published pipeline note from the run record.
 *
 * Publishing happens before the final `report.write` step, so using the run
 * report file directly would show a stale "running" snapshot with pending
 * steps. A purpose-built body describes the delivery instead.
 * @param {object} run
 * @param {string} title
 * @returns {string}
 */
function buildPublishBody(run, title) {
  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const lines = [`<h1>${escape(title)}</h1>`];
  lines.push(`<p>由 inkstone-flow 交付 · 运行 <code>${escape(run.runId)}</code> · 配方 ${escape(run.recipeId)}</p>`);
  lines.push('<h2>步骤</h2>', '<ul>');
  for (const step of run.steps ?? []) {
    lines.push(`<li><code>${escape(step.id)}</code> · ${escape(step.uses)} · ${escape(step.status)}</li>`);
  }
  lines.push('</ul>', '<h2>产物</h2>', '<ul>');
  for (const artifact of run.artifacts ?? []) {
    lines.push(`<li>${escape(artifact.label)}：<code>${escape(artifact.path)}</code></li>`);
  }
  lines.push('</ul>');
  if (run.reportPath) lines.push(`<p>运行记录：<code>${escape(run.reportPath)}</code></p>`);
  return lines.join('\n');
}

/**
 * Create the step handler map for one flow configuration.
 * @param {Record<string, any>} config
 * @returns {Record<string, (args: Record<string, any>, context: object) => Promise<any>>}
 */
export function createHandlers(config = {}) {
  return {
    /**
     * Search Zotero and return a compact list of items.
     */
    async 'zotero.select'(args, context) {
      const { createZoteroClient } = await service('zotero-client');
      const settings = zoteroSettings(config);
      const client = createZoteroClient(settings);
      const items = await client.search({
        q: args.q,
        collection: args.collection,
        tag: args.tag,
        itemType: args.itemType,
        limit: args.limit ?? 25,
        sort: args.sort,
        direction: args.direction,
      });
      const compact = (items ?? []).map((item) => {
        const data = item.data ?? item;
        const creators = Array.isArray(data.creators) ? data.creators : [];
        const authors = creators
          .filter((creator) => creator.creatorType === 'author' || creator.creatorType === 'editor')
          .map((creator) => creator.lastName || creator.name || '')
          .filter(Boolean);
        return {
          key: item.key ?? data.key,
          title: data.title ?? '',
          itemType: data.itemType ?? '',
          year: String(data.date ?? '').slice(0, 4),
          authors,
          doi: data.DOI,
          url: data.url,
        };
      });
      return { output: { count: compact.length, items: compact, keys: compact.map((item) => item.key) } };
    },

    /**
     * Export a BibTeX/BibLaTeX file from Zotero or the configured library.
     */
    async 'zotero.bib.export'(args, context) {
      const { createZoteroClient } = await service('zotero-client');
      const settings = zoteroSettings(config);
      const client = createZoteroClient(settings);
      const result = await client.exportBibtex({
        collection: args.collection,
        itemKeys: args.itemKeys,
        limit: args.limit,
      });
      const outPath = resolveAgainstProject(args.outPath ?? 'refs.bib', context);
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, result.text, 'utf8');
      const citekeys = [];
      const { parseBib } = await service('bib');
      const parsed = parseBib(result.text);
      for (const entry of parsed.entries) citekeys.push(entry.key);
      return {
        output: {
          path: outPath,
          count: parsed.entries.length,
          citekeys,
          source: result.source,
          bytes: Buffer.byteLength(result.text, 'utf8'),
        },
        artifacts: [{ path: outPath, kind: 'bib', label: 'referenced bibliography' }],
      };
    },

    /**
     * Parse `.bib` files and report entry/duplicate/missing-field statistics.
     */
    async 'zotero.bib.index'(args, context) {
      const { loadBibFiles, findMissingFields } = await service('bib');
      const paths = [];
      for (const value of args.paths ?? []) {
        const resolved = resolveAgainstProject(value, context);
        if (resolved) paths.push(resolved);
      }
      if (paths.length === 0) {
        paths.push(...listFiles(context.projectDir, { extensions: ['.bib'], limit: 30 }));
      }
      const loaded = loadBibFiles(paths);
      const missing = [];
      for (const entry of loaded.entries) {
        const fields = findMissingFields(entry);
        if (fields.length > 0) missing.push({ key: entry.key, fields });
      }
      return {
        output: {
          files: loaded.files ?? paths,
          count: loaded.entries.length,
          duplicates: loaded.duplicates ?? [],
          errors: loaded.errors ?? [],
          missingFields: missing,
        },
      };
    },

    /**
     * Copy one file inside the project (used to adopt a user-provided .bib).
     */
    async 'files.copy'(args, context) {
      const from = resolveAgainstProject(args.from, context);
      const to = resolveAgainstProject(args.to, context);
      if (!from) throw new Error('files.copy: "from" is required');
      if (!to) throw new Error('files.copy: "to" is required');
      if (!fs.existsSync(from)) throw new Error(`files.copy: source not found: ${from}`);
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
      return { output: { path: to, bytes: fs.statSync(to).size } };
    },

    /**
     * Scaffold a Typst project from a bundled template.
     */
    async 'typst.scaffold'(args, context) {
      const { scaffoldProject } = await service('typst-scaffold');
      const targetDir = resolveAgainstProject(args.targetDir ?? context.runDir, context);
      const result = scaffoldProject({
        targetDir,
        template: args.template ?? 'paper-zh',
        title: args.title ?? context.run.recipeTitle,
        authors: args.authors ?? [],
        abstract: args.abstract ?? '',
        bibPath: args.bibPath ?? 'refs.bib',
        citationStyle: args.citationStyle ?? 'gb-7714-2015-numeric',
        force: args.force === true,
        metadata: { runId: context.run.runId, recipeId: context.run.recipeId },
      });
      return {
        output: {
          targetDir,
          mainFile: result.mainFile,
          files: result.files,
          template: args.template ?? 'paper-zh',
        },
        artifacts: [{ path: result.mainFile, kind: 'typst', label: 'main document' }],
      };
    },

    /**
     * Compile a Typst document, optionally running the rule-based healer.
     */
    async 'typst.build'(args, context) {
      const runner = await service('typst-runner');
      const input = resolveAgainstProject(args.input, context);
      if (!input) throw new Error('typst.build: "input" is required');
      if (!fs.existsSync(input)) throw new Error(`typst.build: input not found: ${input}`);
      const root = resolveAgainstProject(args.root ?? context.projectDir, context);
      const outputPath = args.output
        ? resolveAgainstProject(args.output, context)
        : input.replace(/\.typ$/i, '.pdf');
      const heal = args.heal !== false && context.run.options?.heal !== false;
      const compileOptions = {
        input,
        output: outputPath,
        root,
        fontPaths: args.fontPaths ?? [],
        ppi: args.ppi ?? 144,
        timeoutMs: args.timeoutMs ?? config.timeoutMs ?? 120000,
        signal: context.signal,
        binaryPath: args.binaryPath ?? config.typstBinaryPath,
      };
      let result;
      if (heal) {
        const healing = await service('heal');
        result = await healing.healCompile({
          projectDir: context.projectDir,
          input,
          compileOptions,
          maxRounds: args.maxRounds ?? config.maxHealRounds ?? 3,
          bibFiles: args.bibFiles ?? listFiles(context.projectDir, { extensions: ['.bib'], limit: 30 }),
          signal: context.signal,
          fontFallbacks: config.fontFallbacks,
          backupRoot: path.join(context.projectDir, '.inkstone', 'backups'),
        });
      } else {
        const compiled = await runner.compile(compileOptions);
        result = {
          ok: compiled.ok,
          rounds: 1,
          fixes: [],
          finalDiagnostics: compiled.diagnostics ?? [],
          outputPath: compiled.outputPath ?? outputPath,
          stderr: compiled.stderr ?? '',
        };
      }
      const diagnosticFile = path.join(context.runDir, `typst-diagnostics-${context.step.id}.json`);
      try {
        ensureDir(context.runDir);
        fs.writeFileSync(diagnosticFile, JSON.stringify({
          ok: result.ok,
          rounds: result.rounds,
          fixes: result.fixes,
          diagnostics: result.finalDiagnostics,
        }, null, 2), 'utf8');
      } catch {
        // diagnostics file is best effort
      }
      if (!result.ok) {
        const first = (result.finalDiagnostics ?? []).slice(0, 5).map((item) => {
          const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '';
          return `- ${location ? `${location}: ` : ''}${item.message}`;
        }).join('\n');
        const fixes = (result.fixes ?? []).slice(0, 5).map((fix) => `- ${fix.rule}: ${fix.message}`).join('\n');
        throw new Error(
          `typst build failed after ${Math.max(1, result.rounds ?? 1)} round(s).\n`
          + `${first || (result.stderr ? String(result.stderr).slice(0, 1200) : 'no diagnostics')}\n`
          + (fixes ? `已尝试修复:\n${fixes}\n` : '')
          + `诊断详情：${diagnosticFile}\n`
          + '修复文档后再次调用 pipeline_run(runId=...) 从该步骤继续。',
        );
      }
      return {
        output: {
          ok: true,
          outputPath: result.outputPath ?? outputPath,
          rounds: Math.max(1, result.rounds ?? 1),
          fixes: (result.fixes ?? []).map((fix) => ({ rule: fix.rule, file: fix.file, message: fix.message })),
          summary: `compiled ${path.basename(input)} → ${path.basename(result.outputPath ?? outputPath)} in ${Math.max(1, result.rounds ?? 1)} round(s)`,
          diagnosticsFile: diagnosticFile,
        },
        artifacts: [
          { path: result.outputPath ?? outputPath, kind: 'pdf', label: path.basename(result.outputPath ?? outputPath) },
        ],
      };
    },

    /**
     * Export SVG or PNG pages.
     */
    async 'typst.export'(args, context) {
      const runner = await service('typst-runner');
      const input = resolveAgainstProject(args.input, context);
      if (!input) throw new Error('typst.export: "input" is required');
      const format = args.format === 'png' ? 'png' : 'svg';
      const outDir = resolveAgainstProject(args.outDir ?? path.join(context.runDir, 'preview'), context);
      const result = await runner.exportPages({
        input,
        format,
        outDir,
        pages: args.pages,
        ppi: args.ppi ?? 144,
        root: resolveAgainstProject(args.root ?? context.projectDir, context),
        fontPaths: args.fontPaths ?? [],
        timeoutMs: args.timeoutMs ?? config.timeoutMs ?? 120000,
        signal: context.signal,
        binaryPath: args.binaryPath ?? config.typstBinaryPath,
      });
      if (!result.ok) {
        const detail = (result.diagnostics ?? []).slice(0, 5).map((item) => item.message).join('; ');
        throw new Error(`typst export (${format}) failed: ${detail || 'see stderr'}`);
      }
      return {
        output: { format, outDir, files: result.files, count: result.files.length },
        artifacts: result.files.slice(0, 6).map((file) => ({ path: file, kind: format, label: path.basename(file) })),
      };
    },

    /**
     * Publish a note (and attachments) to Trilium.
     */
    async 'trilium.publish'(args, context) {
      if (config.publish === false || context.run.options?.publish === false) {
        return { output: { skipped: true, reason: 'trilium publishing is disabled in the run/flow config' } };
      }
      const { createTriliumClient } = await service('trilium-client');
      const settings = triliumSettings(config);
      if (!settings.token) {
        throw new Error(secretHint('trilium'));
      }
      const client = createTriliumClient({ baseUrl: settings.baseUrl, token: settings.token });
      const parentNoteId = args.parentNoteId ?? config.defaultParentNoteId ?? undefined;
      const title = args.title ?? context.run.recipeTitle;
      const body = args.contentFile
        ? readDocumentForPublish(resolveAgainstProject(args.contentFile, context))
        : (args.content ?? buildPublishBody(context.run, title));
      let noteId = args.noteId;
      if (noteId) {
        await client.updateNote(noteId, { title });
        await client.setContent(noteId, body);
      } else {
        if (!parentNoteId) {
          throw new Error('trilium.publish needs "noteId" to update or "parentNoteId" to create a note');
        }
        const note = await client.createNote({ parentNoteId, title, type: 'text', content: body });
        noteId = note.noteId;
      }
      const attachments = [];
      for (const file of attachmentList(args.attach)) {
        const absolute = resolveAgainstProject(file, context);
        if (!absolute || !fs.existsSync(absolute)) continue;
        const attachment = await client.uploadAttachment({
          noteId,
          filePath: absolute,
          title: path.basename(absolute),
          role: 'file',
        });
        attachments.push({ attachmentId: attachment.attachmentId, title: path.basename(absolute) });
      }
      const labels = ['inkstone/pipeline'];
      if (args.tags) labels.push(...args.tags);
      for (const name of labels) {
        try {
          await client.setAttribute({ noteId, type: 'label', name, value: '' });
        } catch {
          // labels are best effort
        }
      }
      return {
        output: {
          noteId,
          title,
          parentNoteId: parentNoteId ?? null,
          attachments,
          labels,
          url: `${settings.baseUrl.replace(/\/$/, '')}/#root/${noteId}`,
        },
        artifacts: [{ path: `${settings.baseUrl}/#root/${noteId}`, kind: 'trilium-note', label: `Trilium: ${title}` }],
      };
    },

    /**
     * Pause the run so the agent can write or review content.
     */
    async checkpoint(args, context) {
      const message = String(args.message ?? '请完成本步骤需要的人工/模型创作后，用同一 runId 继续运行。');
      return {
        awaiting: true,
        message,
        output: {
          message,
          hint: args.hint ?? null,
          files: args.files ?? [path.join(context.runDir, 'main.typ')],
          resumeWith: `pipeline_run { runId: "${context.run.runId}" }`,
        },
      };
    },

    /**
     * Compose a Markdown literature-review note from selected Zotero items.
     */
    async 'litreview.compose'(args, context) {
      const items = Array.isArray(args.items) ? args.items : [];
      const topic = args.topic ?? context.run.inputs?.topic ?? context.run.recipeTitle;
      const lines = [];
      lines.push(`# ${topic}`, '');
      lines.push(`> 由 inkstone-flow 生成 · ${new Date().toISOString()} · 运行 ${context.run.runId}`, '');
      lines.push('## 文献清单', '');
      if (items.length === 0) lines.push('（未获取到文献；请配置 Zotero 本地 API 或提供 bib 文件）');
      items.forEach((item, index) => {
        lines.push(`### ${index + 1}. ${item.title ?? '(untitled)'}`);
        if (item.authors?.length) lines.push(`- 作者：${item.authors.join(', ')}`);
        if (item.year) lines.push(`- 年份：${item.year}`);
        if (item.itemType) lines.push(`- 类型：${item.itemType}`);
        if (item.doi) lines.push(`- DOI：${item.doi}`);
        if (item.url) lines.push(`- 链接：${item.url}`);
        lines.push('');
      });
      if (typeof args.notes === 'string' && args.notes.trim().length > 0) {
        lines.push('## 综述笔记', '', args.notes.trim(), '');
      }
      const outPath = resolveAgainstProject(args.outPath ?? path.join(context.runDir, 'review.md'), context);
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
      return {
        output: { path: outPath, count: items.length, topic },
        artifacts: [{ path: outPath, kind: 'markdown', label: 'literature review notes' }],
      };
    },

    /**
     * Regenerate the run's Markdown report.
     */
    async 'report.write'(_args, context) {
      const reportPath = writeReport(context.projectDir, context.run);
      saveRun(context.projectDir, context.run);
      return {
        output: { reportPath },
        artifacts: [{ path: reportPath, kind: 'markdown', label: 'run report' }],
      };
    },
  };
}
