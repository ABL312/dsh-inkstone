/**
 * Rule-based self-healing for Typst projects.
 *
 * Whitelist rules (CONTRACT §4):
 *   1. `unknown-font`    - an unknown font family referenced by `#set text(font: ...)`
 *                          is replaced by a configured fallback family.
 *   2. `missing-bib-key` - `@citedkey` that does not exist in the bibliography is
 *                          replaced by the unique bib key that is equal modulo
 *                          case or within an edit distance of 2.
 *   3. `missing-file`    - a missing image / data file is rewritten to the unique
 *                          file with that basename inside the project.
 *   4. `missing-bib`     - a missing `.bib` path is rewritten to the unique
 *                          configured bibliography file (or a unique basename match).
 *   5. `missing-include` - a missing `#include`/`#import` target is rewritten to
 *                          the unique file with that basename inside the project.
 *
 * Safety rules enforced here:
 *   - Only text files inside `projectDir` are ever modified (anything else is
 *     reported in `notes` and skipped).
 *   - Every file is backed up to `<project>/.inkstone/backups/` before an edit.
 *   - Each applied fix records its intent, so the driver loop can stop on no
 *     progress (`healCompile` compares diagnostics before/after a round).
 *
 * Known limitations:
 *   - Bib keys are extracted with a pragmatic regex; `@string` macro expansion,
 *     `crossref` inheritance and brace-nested values are not interpreted.
 *   - Only quoted path literals (`#image("...")`, `#include "..."`, ...) are
 *     rewritten; computed paths cannot be healed.
 *   - The edit-distance replacement refuses ambiguous matches (several equally
 *     close keys); such cases surface as diagnostics plus a `notes` entry.
 *
 * @module dsh-inkstone/lib/heal
 */

import fs from 'node:fs';
import path from 'node:path';
import { backupsRoot, displayPath, findByName, isInside, listFiles, stamp } from './paths.mjs';
import { compile } from './typst-runner.mjs';

/** Default font fallback map (CONTRACT §4 rule 1). */
const DEFAULT_FONT_FALLBACKS = {
  SimSun: 'Microsoft YaHei',
  宋体: 'Microsoft YaHei',
};

/** File extensions we are willing to rewrite. */
const EDITABLE_EXTENSIONS = new Set(['.typ']);

/**
 * Normalize a user-supplied path list into existing absolute files.
 * @param {string} projectAbs
 * @param {string[]} files
 * @returns {string[]}
 */
function resolveExistingFiles(projectAbs, files) {
  const out = [];
  if (!Array.isArray(files)) return out;
  for (const value of files) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const raw = value.trim();
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectAbs, raw);
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch {
      /* skip missing */
    }
  }
  return [...new Set(out)];
}

/**
 * Resolve the bibliography files participating in healing: explicit paths,
 * else every `.bib` file inside the project.
 * @param {string} projectAbs
 * @param {string[]} bibFiles
 * @returns {string[]}
 */
function resolveBibFiles(projectAbs, bibFiles) {
  const explicit = resolveExistingFiles(projectAbs, bibFiles);
  if (explicit.length > 0) return explicit;
  return listFiles(projectAbs, { extensions: ['.bib'], recursive: true, limit: 50 });
}

/**
 * Extract citation keys from BibTeX/BibLaTeX files.
 * @param {string[]} bibFilePaths
 * @returns {{ key: string, file: string }[]}
 */
function buildBibIndex(bibFilePaths) {
  const index = [];
  const seen = new Set();
  for (const file of bibFilePaths) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const re = /@([A-Za-z][A-Za-z0-9_-]*)\s*[{(]\s*([^,\s)}]+)\s*,/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const type = match[1].toLowerCase();
      if (type === 'string' || type === 'preamble' || type === 'comment') continue;
      const key = match[2].trim();
      if (key.length === 0 || seen.has(`${file}\u0000${key}`)) continue;
      seen.add(`${file}\u0000${key}`);
      index.push({ key, file });
    }
  }
  return index;
}

/**
 * Levenshtein edit distance (iterative, two rows).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/**
 * Find the unique bib key matching a missing citation key.
 * @param {string} missing
 * @param {{ key: string, file: string }[]} index
 * @returns {{ key: string, file: string, reason: 'case-insensitive'|'edit-distance' } | { candidates: string[] } | null}
 */
function matchCitationKey(missing, index) {
  const lower = missing.toLowerCase();
  const exact = index.filter((entry) => entry.key.toLowerCase() === lower);
  if (exact.length === 1) return { ...exact[0], reason: 'case-insensitive' };
  if (exact.length > 1) return { candidates: exact.map((entry) => entry.key) };
  if (index.length === 0) return null;
  const near = index.filter((entry) => editDistance(lower, entry.key.toLowerCase()) <= 2);
  if (near.length === 1) return { ...near[0], reason: 'edit-distance' };
  if (near.length > 1) return { candidates: near.map((entry) => entry.key) };
  return null;
}

/**
 * Basename helper that accepts both `/` and `\` separators.
 * @param {string} value
 * @returns {string}
 */
function basenameAny(value) {
  const parts = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Convert an absolute path to a forward-slash relative path (Typst accepts `/`
 * on every platform).
 * @param {string} fromDir
 * @param {string} target
 * @returns {string}
 */
function relativePosix(fromDir, target) {
  return path.relative(fromDir, target).split(path.sep).join('/');
}

/**
 * Escape a literal for use inside a regular expression.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a diagnostic's `file` field to an absolute path.
 * @param {string} projectAbs
 * @param {string | undefined} file
 * @returns {string | undefined}
 */
function resolveDiagnosticFile(projectAbs, file) {
  if (typeof file !== 'string' || file.trim().length === 0) return undefined;
  const cleaned = file.trim().replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(projectAbs, cleaned);
}

/**
 * Make a unique timestamped backup directory below `.inkstone/backups` (or a
 * caller-supplied backup root that must live inside the project).
 * @param {string} projectAbs
 * @param {string} [backupRoot]
 * @returns {string}
 */
function uniqueBackupDir(projectAbs, backupRoot) {
  const root = backupRoot ? path.resolve(backupRoot) : backupsRoot(projectAbs);
  if (!isInside(root, projectAbs)) {
    throw new Error(`backupFile: backup root must be inside the project directory: ${root}`);
  }
  fs.mkdirSync(root, { recursive: true });
  const base = stamp();
  let candidate = path.join(root, base);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${counter}`);
    counter += 1;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

/**
 * Back up one project file before it is edited.
 *
 * @param {string} projectDir project directory the file belongs to
 * @param {string} file file to back up (absolute or relative to projectDir)
 * @param {{ backupRoot?: string }} [options] optional custom backup root (must be
 *   inside `projectDir`); defaults to `<project>/.inkstone/backups/`.
 * @returns {string} absolute path of the backup copy
 */
export function backupFile(projectDir, file, options = {}) {
  const projectAbs = path.resolve(projectDir);
  const fileAbs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(projectAbs, file);
  if (!isInside(fileAbs, projectAbs)) {
    throw new Error(`backupFile: refusing to back up a file outside the project directory: ${fileAbs}`);
  }
  let stat;
  try {
    stat = fs.statSync(fileAbs);
  } catch {
    throw new Error(`backupFile: file not found: ${fileAbs}`);
  }
  if (!stat.isFile()) throw new Error(`backupFile: not a regular file: ${fileAbs}`);
  const backupDir = uniqueBackupDir(projectAbs, options.backupRoot);
  const target = path.join(backupDir, path.relative(projectAbs, fileAbs));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fileAbs, target);
  return target;
}

/**
 * Read a project text file, verifying it is editable and inside the project.
 * @param {string} projectAbs
 * @param {string} fileAbs
 * @param {string[]} notes
 * @returns {string | null}
 */
function readEditable(projectAbs, fileAbs, notes) {
  if (!fileAbs) {
    notes.push('skip: diagnostic carries no source file location');
    return null;
  }
  if (!isInside(fileAbs, projectAbs)) {
    notes.push(`skip: ${fileAbs} is outside the project directory ${projectAbs}`);
    return null;
  }
  if (!EDITABLE_EXTENSIONS.has(path.extname(fileAbs).toLowerCase())) {
    notes.push(`skip: ${displayPath(projectAbs, fileAbs)} is not a text file this healer may edit`);
    return null;
  }
  try {
    return fs.readFileSync(fileAbs, 'utf8');
  } catch (error) {
    notes.push(`skip: cannot read ${displayPath(projectAbs, fileAbs)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Apply one text edit, backing the file up first.
 * @param {string} projectAbs
 * @param {string} fileAbs
 * @param {string} before
 * @param {string} after
 * @param {{ backupRoot?: string }} [backupOptions]
 * @returns {boolean} whether the file changed
 */
function writeEditable(projectAbs, fileAbs, before, after, backupOptions = {}) {
  if (before === after) return false;
  backupFile(projectAbs, fileAbs, backupOptions);
  fs.writeFileSync(fileAbs, after, 'utf8');
  return true;
}

/**
 * Extract the missing path from a `file not found (searched at ...)` message.
 * @param {string} message
 * @returns {string | undefined}
 */
function missingPathFromMessage(message) {
  const match = message.match(/searched at\s+(.+?)\)?\s*$/i);
  if (!match) return undefined;
  let value = match[1].trim();
  // The non-greedy capture may keep one trailing parenthesis of the wrapper.
  while (value.endsWith(')')) value = value.slice(0, -1).trim();
  value = value.replace(/^`+/, '').replace(/`+$/, '');
  // Typst prints Windows paths in verbatim (`\\?\`) form; strip it for display
  // so diagnostics and fix messages read like normal paths.
  value = value.replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
  return value.length > 0 ? value : undefined;
}

/**
 * Extract the missing path from the source line pointed at by the diagnostic.
 * @param {string} source
 * @param {number | undefined} line
 * @param {number | undefined} column
 * @returns {string | undefined}
 */
function quotedPathFromSource(source, line, column) {
  if (!Number.isInteger(line) || line < 1) return undefined;
  const lines = source.split(/\r?\n/);
  const text = lines[line - 1];
  if (typeof text !== 'string') return undefined;
  const quoted = [];
  const re = /"([^"\n]+)"/g;
  let match;
  while ((match = re.exec(text)) !== null) quoted.push({ value: match[1], index: match.index });
  if (quoted.length === 0) return undefined;
  if (quoted.length === 1) return quoted[0].value;
  if (Number.isInteger(column)) {
    quoted.sort((a, b) => Math.abs(a.index - column) - Math.abs(b.index - column));
    return quoted[0].value;
  }
  return undefined;
}

/**
 * Extract the missing citation key from a diagnostic message.
 * Supports `unknown citation key` / `citation key ... not found` /
 * `label \`<key>\` does not exist in the document`.
 * @param {string} message
 * @returns {string | undefined}
 */
function citationKeyFromMessage(message) {
  let match = message.match(/label\s+`?<([^>]+)>`?\s+does not exist/i);
  if (match) return match[1];
  match = message.match(/(?:unknown citation key|citation key)\s*:?\s*[`'"<]?([A-Za-z0-9_:.\-]+)/i);
  if (match) return match[1];
  match = message.match(/key\s+[`'"]?([A-Za-z0-9_:.\-]+)[`'"]?\s+(?:not found|does not exist)/i);
  return match ? match[1] : undefined;
}

/**
 * Apply the whitelist healing rules to one batch of diagnostics.
 *
 * @param {{ projectDir: string, input: string, diagnostics: object[], bibFiles?: string[], options?: { fontFallbacks?: Record<string, string>, backupRoot?: string } }} params
 * @returns {{ applied: { rule: string, file: string, message: string, before: string, after: string }[], changed: boolean, notes: string[] }}
 */
export function healRound({ projectDir, input, diagnostics, bibFiles = [], options = {} } = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('healRound: "projectDir" is required');
  }
  const projectAbs = path.resolve(projectDir);
  const inputAbs = path.resolve(projectAbs, String(input ?? 'main.typ'));
  const fontFallbacks = { ...DEFAULT_FONT_FALLBACKS, ...(options.fontFallbacks ?? {}) };
  const backupOptions = options.backupRoot ? { backupRoot: options.backupRoot } : {};
  const bibFilePaths = resolveBibFiles(projectAbs, bibFiles);
  const bibIndex = buildBibIndex(bibFilePaths);
  const applied = [];
  const notes = [];
  const seen = new Set();

  const markSeen = (rule, fileAbs, detail) => {
    const key = `${rule}\u0000${fileAbs ?? ''}\u0000${detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const fontFallbackFor = (family) => {
    const lower = String(family).toLowerCase();
    for (const [from, to] of Object.entries(fontFallbacks)) {
      if (from.toLowerCase() === lower) return to;
    }
    return undefined;
  };

  for (const diagnostic of diagnostics ?? []) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const message = String(diagnostic.message ?? '');
    const fileAbs = resolveDiagnosticFile(projectAbs, diagnostic.file);

    // 1. Unknown font family (Typst 0.15 emits this as a warning).
    if (/unknown font family/i.test(message)) {
      const nameMatch = message.match(/unknown font family:\s*(.+)$/i);
      const family = nameMatch ? nameMatch[1].trim() : '';
      const fallback = family ? fontFallbackFor(family) : undefined;
      if (!family) {
        notes.push('skip unknown-font: diagnostic carries no font family name');
        continue;
      }
      if (!fallback) {
        notes.push(`skip unknown-font: no fallback configured for "${family}" (add options.fontFallbacks)`);
        continue;
      }
      if (fallback.toLowerCase() === family.toLowerCase()) {
        notes.push(`skip unknown-font: fallback for "${family}" is the same family`);
        continue;
      }
      const source = readEditable(projectAbs, fileAbs, notes);
      if (source === null) continue;
      const re = new RegExp(`"${escapeRegExp(family)}"`, 'gi');
      if (!re.test(source)) {
        notes.push(`skip unknown-font: no quoted "${family}" reference in ${displayPath(projectAbs, fileAbs)}`);
        continue;
      }
      re.lastIndex = 0;
      const after = source.replace(re, `"${fallback}"`);
      if (!markSeen('unknown-font', fileAbs, family)) continue;
      if (!writeEditable(projectAbs, fileAbs, source, after, backupOptions)) continue;
      applied.push({
        rule: 'unknown-font',
        file: displayPath(projectAbs, fileAbs),
        message: `unknown font family "${family}" -> fallback "${fallback}"`,
        before: `"${family}"`,
        after: `"${fallback}"`,
      });
      continue;
    }

    // 2. Missing citation key.
    if (/unknown citation key|does not exist in the document|citation key .*not found/i.test(message)) {
      const missingKey = citationKeyFromMessage(message);
      if (!missingKey) {
        notes.push(`skip missing-bib-key: cannot extract citation key from "${message}"`);
        continue;
      }
      const match = matchCitationKey(missingKey, bibIndex);
      if (!match) {
        notes.push(`skip missing-bib-key: no bib key close to "@${missingKey}" in ${bibFilePaths.length} bibliography file(s)`);
        continue;
      }
      if ('candidates' in match) {
        notes.push(`skip missing-bib-key: "@${missingKey}" is ambiguous (${match.candidates.slice(0, 5).join(', ')})`);
        continue;
      }
      const source = readEditable(projectAbs, fileAbs, notes);
      if (source === null) continue;
      const citationRe = new RegExp(`@${escapeRegExp(missingKey)}(?![\\w:\\-.])`, 'g');
      if (!citationRe.test(source)) {
        notes.push(`skip missing-bib-key: "@${missingKey}" not found in ${displayPath(projectAbs, fileAbs)}`);
        continue;
      }
      citationRe.lastIndex = 0;
      const after = source.replace(citationRe, `@${match.key}`);
      if (!markSeen('missing-bib-key', fileAbs, missingKey)) continue;
      if (!writeEditable(projectAbs, fileAbs, source, after, backupOptions)) continue;
      applied.push({
        rule: 'missing-bib-key',
        file: displayPath(projectAbs, fileAbs),
        message: `@${missingKey} -> @${match.key} (${match.reason})`,
        before: `@${missingKey}`,
        after: `@${match.key}`,
      });
      continue;
    }

    // 3/4/5. Missing file, bibliography or include target.
    if (/file not found|failed to load/i.test(message)) {
      const searched = missingPathFromMessage(message);
      let missingPath = searched;
      let source = fileAbs ? readEditable(projectAbs, fileAbs, []) : null;
      if (!missingPath && source !== null) {
        missingPath = quotedPathFromSource(source, diagnostic.line, diagnostic.column);
      }
      if (!missingPath) {
        notes.push(`skip missing-file: cannot determine the missing path from "${message}"`);
        continue;
      }
      if (source === null) {
        // readEditable already pushed a note; retry with notes collection so we
        // do not silently stop after locating the path.
        source = readEditable(projectAbs, fileAbs, notes);
        if (source === null) continue;
      }
      const missingBasename = basenameAny(missingPath);
      if (!missingBasename) {
        notes.push(`skip missing-file: cannot determine a basename for "${missingPath}"`);
        continue;
      }
      const extension = path.extname(missingBasename).toLowerCase();
      const sourceLine = Number.isInteger(diagnostic.line) ? source.split(/\r?\n/)[diagnostic.line - 1] ?? '' : '';
      const isInclude = /#(?:include|import)\b/.test(sourceLine);

      let rule;
      let candidates = [];
      if (extension === '.bib') {
        rule = 'missing-bib';
        const explicitBibs = resolveExistingFiles(projectAbs, bibFiles);
        const byName = explicitBibs.filter((file) => path.basename(file).toLowerCase() === missingBasename.toLowerCase());
        if (byName.length === 1) candidates = byName;
        else if (byName.length === 0 && explicitBibs.length === 1) candidates = explicitBibs;
        if (candidates.length === 0) {
          candidates = findByName(projectAbs, missingBasename, { maxDepth: 10, limit: 20 });
        }
        if (candidates.length === 0) {
          notes.push(`skip missing-bib: no ${missingBasename} among bibFiles (${explicitBibs.length} configured) or in the project`);
          continue;
        }
      } else {
        rule = extension === '.typ' && isInclude ? 'missing-include' : 'missing-file';
        candidates = findByName(projectAbs, missingBasename, { maxDepth: 10, limit: 20 });
        if (candidates.length === 0) {
          notes.push(`skip ${rule}: no "${missingBasename}" inside the project directory`);
          continue;
        }
      }
      if (candidates.length > 1) {
        notes.push(
          `skip ${rule}: "${missingBasename}" is ambiguous; candidates: ${candidates
            .slice(0, 5)
            .map((candidate) => displayPath(projectAbs, candidate))
            .join(', ')}`,
        );
        continue;
      }
      const target = candidates[0];
      const replacement = relativePosix(path.dirname(fileAbs), target);
      if (replacement === missingPath) continue;
      const quotedRe = /"([^"\n]+)"/g;
      let changed = false;
      let originalQuoted = '';
      const after = source.replace(quotedRe, (full, value) => {
        if (basenameAny(value).toLowerCase() !== missingBasename.toLowerCase()) return full;
        if (!changed) originalQuoted = value;
        changed = true;
        return `"${replacement}"`;
      });
      if (!changed) {
        notes.push(`skip ${rule}: no quoted reference to "${missingBasename}" in ${displayPath(projectAbs, fileAbs)}`);
        continue;
      }
      if (!markSeen(rule, fileAbs, missingBasename)) continue;
      if (!writeEditable(projectAbs, fileAbs, source, after, backupOptions)) continue;
      applied.push({
        rule,
        file: displayPath(projectAbs, fileAbs),
        message: `missing "${missingPath}" -> "${replacement}"`,
        before: `"${originalQuoted}"`,
        after: `"${replacement}"`,
      });
    }
  }

  return { applied, changed: applied.length > 0, notes };
}

/**
 * Compile with up to `maxRounds` whitelist healing rounds.
 *
 * `fontFallbacks` and `backupRoot` are also accepted at the top level for
 * integration with the pipeline engine (which passes them like compile
 * options); `options.fontFallbacks` takes precedence when both are present.
 *
 * @param {{ projectDir: string, input: string, compileOptions?: object, maxRounds?: number, bibFiles?: string[], signal?: AbortSignal, fontFallbacks?: Record<string, string>, backupRoot?: string, options?: { fontFallbacks?: Record<string, string>, backupRoot?: string } }} params
 * @returns {Promise<{ ok: boolean, rounds: number, compiles: number, fixes: object[], finalDiagnostics: object[], outputPath: string, stderr: string, notes: string[], timedOut: boolean }>}
 */
export async function healCompile({
  projectDir,
  input,
  compileOptions = {},
  maxRounds = 3,
  bibFiles = [],
  signal,
  fontFallbacks,
  backupRoot,
  options = {},
} = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('healCompile: "projectDir" is required');
  }
  const projectAbs = path.resolve(projectDir);
  const inputAbs = path.resolve(projectAbs, String(input ?? 'main.typ'));
  if (!fs.existsSync(inputAbs)) {
    throw new Error(`healCompile: input file not found: ${inputAbs}`);
  }
  const roundLimit = Number.isInteger(maxRounds) && maxRounds > 0 ? Math.min(maxRounds, 10) : 3;
  const resolvedBibFiles = resolveBibFiles(projectAbs, bibFiles);
  const healOptions = {
    ...options,
    fontFallbacks: {
      ...(fontFallbacks && typeof fontFallbacks === 'object' ? fontFallbacks : {}),
      ...(options.fontFallbacks && typeof options.fontFallbacks === 'object' ? options.fontFallbacks : {}),
    },
    ...(backupRoot ?? options.backupRoot ? { backupRoot: backupRoot ?? options.backupRoot } : {}),
  };
  const fixes = [];
  const notes = [];
  let rounds = 0;
  let compiles = 0;

  const diagnosticsSignature = (list) =>
    (list ?? []).map((item) => `${item.severity}|${item.file ?? ''}|${item.line ?? ''}|${item.column ?? ''}|${item.message ?? ''}`).join('\n');

  let last = await compile({ input: inputAbs, root: projectAbs, ...compileOptions, signal });
  compiles += 1;

  while (rounds < roundLimit) {
    if (signal?.aborted) throw new Error('healCompile: aborted');
    if (!Array.isArray(last.diagnostics) || last.diagnostics.length === 0) break;
    const beforeSignature = diagnosticsSignature(last.diagnostics);
    const result = healRound({
      projectDir: projectAbs,
      input: inputAbs,
      diagnostics: last.diagnostics,
      bibFiles: resolvedBibFiles,
      options: healOptions,
    });
    notes.push(...result.notes);
    if (!result.changed) break;
    rounds += 1;
    fixes.push(...result.applied);
    last = await compile({ input: inputAbs, root: projectAbs, ...compileOptions, signal });
    compiles += 1;
    if (diagnosticsSignature(last.diagnostics) === beforeSignature) {
      notes.push(`no progress after heal round ${rounds}; stopping before the round limit`);
      break;
    }
  }

  return {
    ok: last.ok,
    rounds,
    compiles,
    fixes,
    finalDiagnostics: last.diagnostics ?? [],
    outputPath: last.outputPath,
    stderr: last.stderr ?? '',
    notes,
    timedOut: Boolean(last.timedOut),
  };
}
