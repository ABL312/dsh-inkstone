/**
 * Project scaffolding for the bundled Typst templates.
 *
 * Copies a self-contained template from `templates/<template>/` into a target
 * directory, performs simple `{{placeholder}}` substitution in text files and
 * writes a `metadata.json` describing the generated project.
 *
 * Guarantees:
 *   - Templates ship inside this package and never import network packages
 *     (`@preview/...`); they only use system fonts (Microsoft YaHei / SimSun
 *     family fallback chains).
 *   - An existing `main.typ` is never overwritten unless `force: true`; other
 *     existing files are also left untouched and reported in `skipped`.
 *   - Placeholders are only substituted inside text files copied from the
 *     template; values are escaped for Typst string literals.
 *   - When a real bibliography already exists in `targetDir` (pipeline order:
 *     Zotero export -> scaffold), template demo citations whose keys are absent
 *     from that bibliography are removed so the fresh project still compiles;
 *     the removals are reported in `notes`.
 *
 * Known limitations:
 *   - Substitution is literal (`{{name}}`), not a template language; unknown
 *     placeholders stay verbatim so nothing silently disappears.
 *   - The healer does not back up scaffolded files (scaffolding is treated as
 *     project creation, and `force` documents the overwrite).
 *   - Demo-citation cleanup only inspects the template's own `refs.bib` keys;
 *     citations the model/user writes later are never touched.
 *
 * @module dsh-inkstone/lib/typst-scaffold
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INKSTONE_VERSION } from './tool-kit.mjs';
import { displayPath, writeJson } from './paths.mjs';

/** Absolute path of the bundled `templates/` directory. */
export const TEMPLATES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** Extensions that receive `{{placeholder}}` substitution. */
const TEXT_EXTENSIONS = new Set(['.typ', '.bib', '.txt', '.md', '.json', '.yaml', '.yml', '.svg']);

/**
 * Escape a value for inclusion inside a Typst string literal.
 * @param {unknown} value
 * @returns {string}
 */
function typstStringValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\\n');
}

/**
 * List the bundled templates (directories containing a `main.typ`).
 * @returns {string[]} template ids, sorted
 */
export function listTemplates() {
  let entries;
  try {
    entries = fs.readdirSync(TEMPLATES_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => fs.existsSync(path.join(TEMPLATES_ROOT, entry.name, 'main.typ')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Recursively list files below a directory, as paths relative to it.
 * @param {string} root
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listRelativeFiles(root, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listRelativeFiles(root, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/**
 * Today's date as `YYYY-MM-DD`.
 * @returns {string}
 */
function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Build the placeholder replacement table.
 * @param {{ title?: string, authors?: string[], abstract?: string, bibPath?: string, citationStyle?: string, date?: string, metadata?: Record<string, any> }} input
 * @returns {Record<string, string>}
 */
function buildPlaceholders({ title, authors, abstract, bibPath, citationStyle, date, metadata }) {
  const authorText = Array.isArray(authors)
    ? authors
        .map((author) => String(author ?? '').trim())
        .filter((author) => author.length > 0)
        .join('、')
    : String(authors ?? '');
  const values = {
    title: typstStringValue(title ?? ''),
    authors: typstStringValue(authorText),
    abstract: typstStringValue(abstract ?? ''),
    bibPath: typstStringValue(bibPath ?? 'refs.bib'),
    citationStyle: typstStringValue(citationStyle ?? 'gb-7714-2015-numeric'),
    date: typstStringValue(date ?? today()),
  };
  // Extra placeholders can be supplied through `metadata.placeholders` for
  // downstream customisation without changing the package templates.
  const extra = metadata && typeof metadata.placeholders === 'object' && metadata.placeholders !== null ? metadata.placeholders : {};
  for (const [key, value] of Object.entries(extra)) {
    values[key] = typstStringValue(value);
  }
  return values;
}

/**
 * Replace `{{key}}` placeholders in a string.
 * @param {string} content
 * @param {Record<string, string>} placeholders
 * @returns {string}
 */
function substitute(content, placeholders) {
  let result = content;
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

/**
 * Extract citation keys from a BibTeX/BibLaTeX file.
 * @param {string} content
 * @returns {string[]}
 */
function extractBibKeys(content) {
  const keys = [];
  const re = /@([A-Za-z][A-Za-z0-9_-]*)\s*[{(]\s*([^,\s)}]+)\s*,/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const type = match[1].toLowerCase();
    if (type === 'string' || type === 'preamble' || type === 'comment') continue;
    keys.push(match[2].trim());
  }
  return [...new Set(keys)];
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
 * Create a Typst project from a bundled template.
 *
 * @param {{
 *   targetDir: string,
 *   template?: string,
 *   title?: string,
 *   authors?: string[],
 *   abstract?: string,
 *   bibPath?: string,
 *   citationStyle?: string,
 *   metadata?: Record<string, any>,
 *   force?: boolean,
 * }} params
 * @returns {{ mainFile: string, files: string[], skipped: string[], notes: string[], template: string, metadataFile: string, filesRelative: string[] }}
 * @throws {Error} when `targetDir` is missing or the template does not exist.
 */
export function scaffoldProject(params = {}) {
  const template = typeof params.template === 'string' && params.template.trim().length > 0 ? params.template.trim() : 'paper-zh';
  if (typeof params.targetDir !== 'string' || params.targetDir.trim().length === 0) {
    throw new Error('scaffoldProject: "targetDir" is required');
  }
  const targetAbs = path.resolve(params.targetDir.trim());
  const templates = listTemplates();
  if (!templates.includes(template)) {
    throw new Error(
      `scaffoldProject: unknown template "${template}". Available templates: ${templates.length > 0 ? templates.join(', ') : '(none found)'}`,
    );
  }
  const templateDir = path.join(TEMPLATES_ROOT, template);
  const force = params.force === true;
  fs.mkdirSync(targetAbs, { recursive: true });

  const placeholders = buildPlaceholders({
    title: params.title,
    authors: params.authors,
    abstract: params.abstract,
    bibPath: params.bibPath,
    citationStyle: params.citationStyle,
    date: params.metadata?.date,
    metadata: params.metadata,
  });

  const files = [];
  const skipped = [];
  const notes = [];
  const relativeFiles = listRelativeFiles(templateDir);
  for (const relative of relativeFiles) {
    const source = path.join(templateDir, relative);
    const destination = path.join(targetAbs, relative);
    if (fs.existsSync(destination) && !force) {
      skipped.push(relative.split(path.sep).join('/'));
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const extension = path.extname(relative).toLowerCase();
    if (TEXT_EXTENSIONS.has(extension)) {
      const raw = fs.readFileSync(source, 'utf8');
      fs.writeFileSync(destination, substitute(raw, placeholders), 'utf8');
    } else {
      fs.copyFileSync(source, destination);
    }
    files.push(destination);
  }

  // Pipeline safety net: a recipe may export a real bibliography into the
  // target before scaffolding (e.g. Zotero export -> refs.bib -> scaffold). In
  // that case the template's demo `refs.bib` is skipped, so the template's demo
  // citations would dangle. Drop only the template's own demo citations when
  // the effective bibliography exists but lacks those keys, so the freshly
  // scaffolded project still compiles before real citations are written.
  const mainFile = path.join(targetAbs, 'main.typ');
  const templateBibFile = path.join(templateDir, 'refs.bib');
  const effectiveBib = path.resolve(targetAbs, params.bibPath ?? 'refs.bib');
  if (files.includes(mainFile) && fs.existsSync(templateBibFile) && fs.existsSync(effectiveBib)) {
    try {
      if (fs.statSync(effectiveBib).isFile()) {
        const templateKeys = extractBibKeys(fs.readFileSync(templateBibFile, 'utf8'));
        const effectiveKeys = new Set(extractBibKeys(fs.readFileSync(effectiveBib, 'utf8')));
        const dangling = templateKeys.filter((key) => !effectiveKeys.has(key));
        if (dangling.length > 0) {
          let content = fs.readFileSync(mainFile, 'utf8');
          const removed = [];
          for (const key of dangling) {
            const citationRe = new RegExp(`[ \\t]*@${escapeRegExp(key)}(?![\\w:.\\-])`, 'g');
            if (citationRe.test(content)) {
              removed.push(key);
              content = content.replace(citationRe, '');
            }
          }
          if (removed.length > 0) {
            fs.writeFileSync(mainFile, content, 'utf8');
            notes.push(
              `removed template demo citation(s) not present in ${displayPath(targetAbs, effectiveBib)}: ${removed.map((key) => `@${key}`).join(', ')}`,
            );
          }
        }
      }
    } catch {
      notes.push('could not inspect the existing bibliography for dangling demo citations; left main.typ untouched');
    }
  }

  const metadata = {
    template,
    title: params.title ?? '',
    authors: Array.isArray(params.authors) ? params.authors : [],
    abstract: params.abstract ?? '',
    bibPath: params.bibPath ?? 'refs.bib',
    citationStyle: params.citationStyle ?? 'gb-7714-2015-numeric',
    date: params.metadata?.date ?? today(),
    generator: 'dsh-inkstone/typst-brush',
    version: INKSTONE_VERSION,
    createdAt: new Date().toISOString(),
    ...(params.metadata ?? {}),
  };
  const metadataFile = path.join(targetAbs, 'metadata.json');
  writeJson(metadataFile, metadata);
  files.push(metadataFile);

  if (!fs.existsSync(mainFile)) {
    throw new Error(`scaffoldProject: template "${template}" did not produce main.typ in ${targetAbs}; package templates/ is corrupted`);
  }

  return {
    mainFile,
    files,
    skipped,
    notes,
    template,
    metadataFile,
    filesRelative: files.map((file) => displayPath(targetAbs, file)),
  };
}
