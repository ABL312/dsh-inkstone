/**
 * BibTeX / BibLaTeX parsing and bibliography-project helpers for the
 * `zotero-ink` plugin.
 *
 * The parser intentionally targets the subset produced by Zotero, Better
 * BibTeX and hand-maintained `.bib` files: `@type{key, field = {value}}`,
 * quoted values, brace nesting, `#` concatenation, `%` comments, `@comment`,
 * `@preamble`, `@string` macros, UTF-8 and unknown fields (BBT's `tex.*`
 * fields are preserved verbatim). It is not a byte-for-byte BibTeX clone.
 *
 * Known limitations (documented instead of silently dropping data):
 * - No LaTeX-to-Unicode conversion: values are kept as written.
 * - Entries are de-duplicated by citekey case-insensitively; the first
 *   occurrence wins.
 * - `@string` macros are expanded while parsing (built-in month macros are
 *   expanded silently); warnings are reported for user-defined macros.
 * - Date fields are not normalized; `year` and `date` are treated as aliases
 *   for validation purposes only.
 *
 * All functions are pure except the filesystem readers (`loadBibFiles`), and
 * the module only imports Node built-ins plus `./paths.mjs`.
 *
 * @module dsh-inkstone/lib/bib
 */

import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readTextBounded } from './paths.mjs';

/** Standard BibTeX month macros, expanded silently. */
const MONTH_MACROS = new Map([
  ['jan', 'January'],
  ['feb', 'February'],
  ['mar', 'March'],
  ['apr', 'April'],
  ['may', 'May'],
  ['jun', 'June'],
  ['jul', 'July'],
  ['aug', 'August'],
  ['sep', 'September'],
  ['oct', 'October'],
  ['nov', 'November'],
  ['dec', 'December'],
]);

/** Words ignored when deriving a citekey from a title. */
const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'of',
  'for',
  'and',
  'to',
  'in',
  'with',
  'from',
  'at',
  'by',
  'via',
  'toward',
  'towards',
  'using',
  'into',
  'about',
  'is',
  'are',
]);

/** Canonical serialization order; unknown fields follow alphabetically. */
const FIELD_ORDER = [
  'author',
  'editor',
  'translator',
  'title',
  'subtitle',
  'journal',
  'journaltitle',
  'shortjournal',
  'booktitle',
  'maintitle',
  'series',
  'edition',
  'volume',
  'number',
  'issue',
  'pages',
  'publisher',
  'school',
  'institution',
  'organization',
  'address',
  'location',
  'year',
  'date',
  'month',
  'doi',
  'url',
  'urldate',
  'isbn',
  'issn',
  'eprint',
  'eprinttype',
  'eventtitle',
  'venue',
  'language',
  'abstract',
  'keywords',
  'note',
  'crossref',
];

/**
 * Required-field rules per entry type. Each rule is a set of aliases: any one
 * of them satisfies the requirement, and the missing label is the joined list.
 * @type {Record<string, string[][]>}
 */
const REQUIRED_FIELDS = {
  article: [['author'], ['title'], ['journal', 'journaltitle'], ['year', 'date']],
  book: [['author', 'editor'], ['title'], ['publisher'], ['year', 'date']],
  booklet: [['title']],
  inbook: [['author', 'editor'], ['title'], ['publisher'], ['year', 'date']],
  incollection: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  inproceedings: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  conference: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  manual: [['title']],
  mastersthesis: [['author'], ['title'], ['school'], ['year', 'date']],
  misc: [['title']],
  online: [['title'], ['url']],
  patent: [['author', 'title'], ['number'], ['year', 'date']],
  phdthesis: [['author'], ['title'], ['school'], ['year', 'date']],
  proceedings: [['title'], ['year', 'date']],
  report: [['author'], ['title'], ['institution'], ['year', 'date']],
  techreport: [['author'], ['title'], ['institution'], ['year', 'date']],
  thesis: [['author'], ['title'], ['school'], ['year', 'date']],
  unpublished: [['author'], ['title'], ['note']],
  preprint: [['author'], ['title'], ['year', 'date']],
};

/**
 * Zotero item type → BibLaTeX entry type.
 * @type {Record<string, string>}
 */
const ZOTERO_TO_BIB_TYPE = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'incollection',
  conferencePaper: 'inproceedings',
  thesis: 'thesis',
  report: 'techreport',
  webpage: 'online',
  blogPost: 'online',
  forumPost: 'online',
  encyclopediaArticle: 'incollection',
  dictionaryEntry: 'incollection',
  preprint: 'preprint',
  manuscript: 'unpublished',
  document: 'misc',
  computerProgram: 'misc',
  dataset: 'misc',
  presentation: 'misc',
  patent: 'misc',
  standard: 'misc',
  artwork: 'misc',
  film: 'misc',
  videoRecording: 'misc',
  audioRecording: 'misc',
  interview: 'misc',
  letter: 'misc',
  email: 'misc',
  map: 'misc',
  podcast: 'misc',
  radioBroadcast: 'misc',
  tvBroadcast: 'misc',
  statute: 'misc',
  case: 'misc',
  hearing: 'misc',
  bill: 'misc',
  attachment: 'misc',
  note: 'misc',
  annotation: 'misc',
};

/**
 * Character type allowed in field/macro names.
 * @param {string} character
 * @returns {boolean}
 */
function isNameCharacter(character) {
  return /[A-Za-z0-9_.:-]/.test(character);
}

/**
 * Byte offsets of every line start, for O(log n) line lookups.
 * @param {string} text
 * @returns {number[]}
 */
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/**
 * 1-based line number for a byte offset.
 * @param {number[]} starts
 * @param {number} offset
 * @returns {number}
 */
function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Skip one `{...}` group; returns the index just after the closing brace or
 * `-1` when the group is unterminated. Backslash escapes the next character.
 * @param {string} text
 * @param {number} start index of the opening brace
 * @returns {number}
 */
function skipBraceGroup(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Skip one `"..."` value; returns the index just after the closing quote or
 * `-1`. Braces inside the quote protect the value (BibTeX semantics).
 * @param {string} text
 * @param {number} start index of the opening quote
 * @returns {number}
 */
function skipQuotedValue(text, start) {
  let depth = 0;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      if (depth > 0) depth -= 1;
    } else if (character === '"' && depth === 0) return index + 1;
  }
  return -1;
}

/**
 * Parse a `.bib` text.
 *
 * @param {string} text
 * @returns {{
 *   entries: Array<{type: string, key: string, fields: Record<string, string>, raw: string, line: number}>,
 *   errors: string[],
 *   warnings: string[],
 * }}
 */
export function parseBib(text) {
  const source = String(text ?? '');
  const length = source.length;
  const starts = lineStarts(source);
  const entries = [];
  const errors = [];
  const warnings = [];
  const macros = new Map(MONTH_MACROS);
  const seenKeys = new Map();
  const where = (offset) => `line ${lineAt(starts, offset)}`;
  let position = 0;

  /** Parse one value expression (`{...}`, `"..."`, bare token, `#` chains). */
  const readValue = (start) => {
    const parts = [];
    let index = start;
    let sawAtom = false;
    for (;;) {
      while (index < length && /\s/.test(source[index])) index += 1;
      if (index >= length) return { value: parts.join(''), end: -1 };
      const character = source[index];
      if (character === '{') {
        const end = skipBraceGroup(source, index);
        if (end === -1) return { value: parts.join(''), end: -1 };
        parts.push(source.slice(index + 1, end - 1));
        index = end;
        sawAtom = true;
      } else if (character === '"') {
        const end = skipQuotedValue(source, index);
        if (end === -1) return { value: parts.join(''), end: -1 };
        parts.push(source.slice(index + 1, end - 1));
        index = end;
        sawAtom = true;
      } else if (character === '#' && sawAtom) {
        index += 1;
        continue;
      } else {
        const tokenStart = index;
        while (index < length && !/[\s,#{}()="]/.test(source[index])) index += 1;
        const token = source.slice(tokenStart, index);
        if (token.length === 0) return { value: parts.join(''), end: -1 };
        if (/^-?\d+$/.test(token)) {
          parts.push(token);
        } else {
          const macro = macros.get(token.toLowerCase());
          if (macro !== undefined) {
            parts.push(macro);
          } else {
            warnings.push(`${where(tokenStart)}: 未定义的 BibTeX 宏 "${token}"，按字面保留`);
            parts.push(token);
          }
        }
        sawAtom = true;
      }
      while (index < length && /\s/.test(source[index])) index += 1;
      if (index < length && source[index] === '#') {
        index += 1;
        continue;
      }
      return { value: parts.join(''), end: index };
    }
  };

  while (position < length) {
    const character = source[position];
    if (character === '%') {
      while (position < length && source[position] !== '\n') position += 1;
      continue;
    }
    if (character !== '@') {
      position += 1;
      continue;
    }
    const entryStart = position;
    position += 1;
    const typeStart = position;
    while (position < length && /[A-Za-z]/.test(source[position])) position += 1;
    const type = source.slice(typeStart, position).toLowerCase();
    if (type.length === 0) {
      // A stray '@' in running text: not an entry, keep scanning.
      continue;
    }
    while (position < length && /\s/.test(source[position])) position += 1;

    if (type === 'comment' || type === 'preamble') {
      const opener = source[position];
      if (opener === '{' || opener === '(') {
        const end = opener === '{'
          ? skipBraceGroup(source, position)
          : skipParenthesisGroup(source, position);
        if (end === -1) {
          errors.push(`${where(entryStart)}: @${type} 块未正确闭合`);
          position = length;
        } else {
          position = end;
        }
      } else {
        while (position < length && source[position] !== '\n') position += 1;
      }
      continue;
    }

    if (type === 'string') {
      const opener = source[position];
      if (opener !== '{' && opener !== '(') {
        errors.push(`${where(position)}: @string 缺少 '{' 或 '('，已跳过`);
        while (position < length && source[position] !== '\n') position += 1;
        continue;
      }
      const closer = opener === '{' ? '}' : ')';
      position += 1;
      let defined = 0;
      while (position < length) {
        while (position < length && (/\s/.test(source[position]) || source[position] === ',')) position += 1;
        if (position >= length) break;
        if (source[position] === closer) {
          position += 1;
          break;
        }
        const nameStart = position;
        while (position < length && isNameCharacter(source[position])) position += 1;
        const macroName = source.slice(nameStart, position).toLowerCase();
        while (position < length && /\s/.test(source[position])) position += 1;
        if (macroName.length === 0 || source[position] !== '=') {
          errors.push(`${where(nameStart)}: @string 定义缺少 '='，已跳过该项`);
          while (position < length && source[position] !== closer && source[position] !== ',') position += 1;
          if (position < length && source[position] === ',') position += 1;
          continue;
        }
        position += 1;
        const parsed = readValue(position);
        if (parsed.end === -1) {
          errors.push(`${where(nameStart)}: @string 宏 "${macroName}" 的值未闭合`);
          position = length;
          break;
        }
        position = parsed.end;
        macros.set(macroName, parsed.value);
        warnings.push(`${where(entryStart)}: @string 宏 "${macroName}" 已在解析时展开`);
        defined += 1;
        while (position < length && /\s/.test(source[position])) position += 1;
        if (position < length && source[position] === ',') position += 1;
      }
      if (defined === 0) warnings.push(`${where(entryStart)}: @string 块没有有效定义`);
      continue;
    }

    // Regular bibliography entry.
    const opener = source[position];
    if (opener !== '{' && opener !== '(') {
      errors.push(`${where(entryStart)}: 条目 @${type} 缺少 '{' 或 '('，已跳过`);
      while (position < length && source[position] !== '@' && source[position] !== '\n') position += 1;
      continue;
    }
    const closer = opener === '{' ? '}' : ')';
    position += 1;
    const keyStart = position;
    while (position < length && source[position] !== ',' && source[position] !== closer) position += 1;
    const key = source.slice(keyStart, position).trim();
    const fields = {};
    let closed = false;
    if (position >= length) {
      errors.push(`${where(entryStart)}: 条目 @${type}{${key}} 未正确闭合（文件意外结束）`);
    } else if (source[position] === closer) {
      position += 1;
      closed = true;
    } else {
      position += 1; // consume ','
      while (position < length) {
        while (position < length && (/\s/.test(source[position]) || source[position] === ',')) position += 1;
        if (position < length && source[position] === '%') {
          while (position < length && source[position] !== '\n') position += 1;
          continue;
        }
        if (position >= length) break;
        if (source[position] === closer) {
          position += 1;
          closed = true;
          break;
        }
        const fieldStart = position;
        while (position < length && isNameCharacter(source[position])) position += 1;
        const fieldName = source.slice(fieldStart, position).trim().toLowerCase();
        while (position < length && /\s/.test(source[position])) position += 1;
        if (fieldName.length === 0 || source[position] !== '=') {
          errors.push(`${where(fieldStart)}: 条目 "${key}" 的字段缺少 '='，已跳过该字段`);
          while (position < length && source[position] !== ',' && source[position] !== closer) {
            if (source[position] === '{') {
              const end = skipBraceGroup(source, position);
              position = end === -1 ? length : end;
            } else if (source[position] === '"') {
              const end = skipQuotedValue(source, position);
              position = end === -1 ? length : end;
            } else {
              position += 1;
            }
          }
          if (position < length && source[position] === ',') {
            position += 1;
            continue;
          }
          if (position < length && source[position] === closer) {
            position += 1;
            closed = true;
          }
          break;
        }
        position += 1; // consume '='
        const parsed = readValue(position);
        if (parsed.end === -1) {
          errors.push(`${where(fieldStart)}: 条目 "${key}" 字段 "${fieldName}" 的值未闭合（文件意外结束）`);
          position = length;
          break;
        }
        position = parsed.end;
        if (Object.hasOwn(fields, fieldName)) {
          errors.push(`${where(fieldStart)}: 条目 "${key}" 重复字段 "${fieldName}"，保留首次出现的值`);
        } else {
          fields[fieldName] = parsed.value;
        }
        while (position < length && /\s/.test(source[position])) position += 1;
        if (position < length && source[position] === ',') {
          position += 1;
          continue;
        }
        if (position < length && source[position] === closer) {
          position += 1;
          closed = true;
          break;
        }
        if (position < length) {
          errors.push(`${where(position)}: 条目 "${key}" 字段 "${fieldName}" 后缺少 ',' 或 '${closer}'`);
          while (position < length && source[position] !== ',' && source[position] !== closer) position += 1;
          if (position < length && source[position] === ',') {
            position += 1;
            continue;
          }
          if (position < length && source[position] === closer) {
            position += 1;
            closed = true;
          }
          break;
        }
      }
      if (!closed) errors.push(`${where(entryStart)}: 条目 @${type}{${key}} 未正确闭合（文件意外结束）`);
    }
    if (key.length === 0) errors.push(`${where(entryStart)}: @${type} 条目缺少 citekey`);
    const duplicateLine = seenKeys.get(key.toLowerCase());
    if (duplicateLine !== undefined) {
      errors.push(`${where(entryStart)}: 重复 citekey "${key}"（首次出现在 line ${duplicateLine}）`);
    } else if (key.length > 0) {
      seenKeys.set(key.toLowerCase(), lineAt(starts, entryStart));
    }
    entries.push({
      type,
      key,
      fields,
      raw: source.slice(entryStart, position),
      line: lineAt(starts, entryStart),
    });
  }

  return { entries, errors, warnings };
}

/**
 * Skip one `(...)`-delimited group (only used for `@comment`/`@preamble`).
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function skipParenthesisGroup(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Escape unmatched braces so a value can be wrapped in `{...}` again.
 * @param {string} value
 * @returns {string}
 */
function sanitizeBibValue(value) {
  const text = String(value ?? '');
  let depth = 0;
  let balanced = true;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth < 0) {
        balanced = false;
        depth = 0;
      }
    }
  }
  if (balanced && depth === 0) return text;
  return text.replace(/(?<!\\)([{}])/g, (match) => (match === '{' ? '\\{' : '\\}'));
}

/**
 * Order key for deterministic entry sorting.
 * @param {{key?: string}} entry
 * @returns {string}
 */
function sortKey(entry) {
  return String(entry?.key ?? '').toLowerCase();
}

/**
 * Deterministic entry comparison: case-insensitive key, then raw key.
 * @param {{key?: string}} a
 * @param {{key?: string}} b
 * @returns {number}
 */
function compareEntries(a, b) {
  const left = sortKey(a);
  const right = sortKey(b);
  if (left < right) return -1;
  if (left > right) return 1;
  const rawLeft = String(a?.key ?? '');
  const rawRight = String(b?.key ?? '');
  if (rawLeft < rawRight) return -1;
  if (rawLeft > rawRight) return 1;
  return 0;
}

/**
 * Canonical field ordering used by {@link serializeBib}.
 * @param {string} name
 * @returns {number}
 */
function fieldRank(name) {
  const index = FIELD_ORDER.indexOf(name.toLowerCase());
  return index === -1 ? FIELD_ORDER.length : index;
}

/**
 * Serialize entries to deterministic BibTeX text.
 *
 * Entries are sorted by citekey; field order is canonical for common fields
 * and alphabetical for the rest (e.g. BBT `tex.*` fields stay at the end).
 * Values keep their brace structure and are re-wrapped in `{...}`.
 *
 * @param {Array<{type: string, key: string, fields: Record<string, string>}>} entries
 * @returns {string}
 */
export function serializeBib(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : [];
  const sorted = list.slice().sort(compareEntries);
  const blocks = sorted.map((entry) => {
    const type = String(entry.type ?? 'misc').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'misc';
    const key = String(entry.key ?? '').trim();
    const fields = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
    const names = Object.keys(fields)
      .filter((name) => name.length > 0)
      .sort((left, right) => {
        const rank = fieldRank(left) - fieldRank(right);
        if (rank !== 0) return rank;
        const loweredLeft = left.toLowerCase();
        const loweredRight = right.toLowerCase();
        if (loweredLeft < loweredRight) return -1;
        if (loweredLeft > loweredRight) return 1;
        return 0;
      });
    const lines = names.map((name) => `  ${name.toLowerCase()} = {${sanitizeBibValue(fields[name])}}`);
    return `@${type}{${key},\n${lines.join(',\n')}\n}`;
  });
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * De-duplicate entries by citekey (case-insensitive, first occurrence wins).
 *
 * @param {Array<{key: string, fields?: Record<string, string>, file?: string}>} entries
 * @returns {{
 *   entries: Array<any>,
 *   duplicates: Array<{key: string, count: number, files: string[]}>,
 * }}
 */
export function dedupeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const firstByKey = new Map();
  const kept = [];
  const duplicateByKey = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.key ?? '').trim();
    const lowered = key.toLowerCase();
    if (!firstByKey.has(lowered)) {
      firstByKey.set(lowered, entry);
      kept.push(entry);
      continue;
    }
    let duplicate = duplicateByKey.get(lowered);
    if (!duplicate) {
      duplicate = { key: firstByKey.get(lowered).key ?? key, count: 1, files: [] };
      duplicateByKey.set(lowered, duplicate);
    }
    duplicate.count += 1;
    if (typeof entry.file === 'string' && entry.file.length > 0 && !duplicate.files.includes(entry.file)) {
      duplicate.files.push(entry.file);
    }
  }
  const duplicates = [...duplicateByKey.values()].map((duplicate) => {
    const first = firstByKey.get(duplicate.key.toLowerCase());
    const files = duplicate.files.slice();
    if (typeof first?.file === 'string' && first.file.length > 0 && !files.includes(first.file)) {
      files.unshift(first.file);
    }
    return { key: duplicate.key, count: duplicate.count, files };
  });
  duplicates.sort((left, right) => compareEntries(left, right));
  return { entries: kept, duplicates };
}

/**
 * Load and parse one or more `.bib` files or directories.
 *
 * Directories are searched recursively for `*.bib`. Errors and parser
 * warnings are prefixed with the file path; cross-file duplicates are
 * de-duplicated (first occurrence wins) and reported.
 *
 * @param {string[]} files absolute, relative, or mixed paths
 * @returns {{
 *   entries: Array<any>,
 *   files: string[],
 *   errors: string[],
 *   warnings: string[],
 *   duplicates: Array<{key: string, count: number, files: string[]}>,
 * }}
 */
export function loadBibFiles(files) {
  const requested = Array.isArray(files) ? files : files === undefined || files === null ? [] : [files];
  const discovered = [];
  const errors = [];
  const warnings = [];
  for (const value of requested) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      warnings.push('loadBibFiles: 忽略了空路径');
      continue;
    }
    const resolved = path.resolve(value.trim());
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      errors.push(`${resolved}: 文件或目录不存在`);
      continue;
    }
    if (stat.isDirectory()) {
      const found = listFiles(resolved, { extensions: ['.bib'], recursive: true });
      if (found.length === 0) warnings.push(`${resolved}: 目录中没有 .bib 文件`);
      for (const file of found) if (!discovered.includes(file)) discovered.push(file);
    } else if (stat.isFile()) {
      if (!discovered.includes(resolved)) discovered.push(resolved);
    }
  }
  const parsedEntries = [];
  for (const file of discovered) {
    let text;
    try {
      text = readTextBounded(file, 8_000_000);
    } catch (error) {
      errors.push(`${file}: 读取失败：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parseBib(text);
    for (const message of parsed.errors) errors.push(`${file}: ${message}`);
    for (const message of parsed.warnings) warnings.push(`${file}: ${message}`);
    for (const entry of parsed.entries) parsedEntries.push({ ...entry, file });
  }
  const deduped = dedupeEntries(parsedEntries);
  return {
    entries: deduped.entries,
    files: discovered,
    errors,
    warnings,
    duplicates: deduped.duplicates,
  };
}

/**
 * Build a case-insensitive citekey index.
 *
 * Lookup keys are lowercased; use `entry.key` for the original spelling.
 *
 * @param {Array<{key: string}>} entries
 * @returns {Map<string, any>}
 */
export function indexByCitekey(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.key ?? '').trim();
    if (key.length === 0) continue;
    index.set(key.toLowerCase(), entry);
  }
  return index;
}

/**
 * Missing required fields for one entry, using the rules documented in
 * CONTRACT §3. Alternate names are returned as `"author|editor"` labels.
 *
 * @param {{type?: string, fields?: Record<string, string>}} entry
 * @returns {string[]}
 */
export function findMissingFields(entry) {
  const type = String(entry?.type ?? '').toLowerCase();
  const rules = REQUIRED_FIELDS[type] ?? [['title']];
  const fields = entry?.fields && typeof entry.fields === 'object' ? entry.fields : {};
  const missing = [];
  for (const alternatives of rules) {
    const present = alternatives.some((name) => {
      const value = fields[name];
      return value !== undefined && value !== null && String(value).trim().length > 0;
    });
    if (!present) missing.push(alternatives.join('|'));
  }
  return missing;
}

/**
 * Merge `extra` entries into `base` entries by citekey.
 *
 * - New keys are appended (`added`).
 * - Existing keys gain non-empty fields from `extra` when `base` lacks them
 *   (`updated`); conflicting non-empty values are reported in `conflicts` and
 *   the `base` value is kept.
 * - `duplicates` reports keys that occurred in both inputs.
 *
 * @param {Array<any>} base
 * @param {Array<any>} extra
 * @returns {{
 *   entries: Array<any>,
 *   added: string[],
 *   updated: string[],
 *   duplicates: Array<{key: string, count: number}>,
 *   conflicts: Array<{key: string, field: string, base: string, extra: string}>,
 * }}
 */
export function mergeEntries(base, extra) {
  const merged = (Array.isArray(base) ? base : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ ...entry, fields: { ...(entry.fields ?? {}) } }));
  const positionByKey = new Map();
  merged.forEach((entry, index) => positionByKey.set(String(entry.key ?? '').toLowerCase(), index));
  const added = [];
  const updated = [];
  const conflicts = [];
  const duplicateCounts = new Map();
  const duplicateKeys = new Map();
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.key ?? '').trim();
    const lowered = key.toLowerCase();
    if (key.length === 0) continue;
    if (!positionByKey.has(lowered)) {
      const clone = { ...entry, fields: { ...(entry.fields ?? {}) } };
      positionByKey.set(lowered, merged.length);
      merged.push(clone);
      added.push(key);
      continue;
    }
    duplicateCounts.set(lowered, (duplicateCounts.get(lowered) ?? 1) + 1);
    duplicateKeys.set(lowered, merged[positionByKey.get(lowered)].key);
    const target = merged[positionByKey.get(lowered)];
    let changed = false;
    for (const [field, value] of Object.entries(entry.fields ?? {})) {
      const current = target.fields[field];
      if (current === undefined || current === null || String(current).trim().length === 0) {
        target.fields[field] = value;
        changed = true;
      } else if (String(current) !== String(value)) {
        conflicts.push({
          key: target.key,
          field: field.toLowerCase(),
          base: String(current),
          extra: String(value),
        });
      }
    }
    if (changed && !updated.includes(target.key)) updated.push(target.key);
  }
  merged.sort(compareEntries);
  const duplicates = [...duplicateCounts.entries()].map(([lowered, count]) => ({
    key: duplicateKeys.get(lowered) ?? lowered,
    count,
  }));
  duplicates.sort((left, right) => compareEntries(left, right));
  return { entries: merged, added, updated, duplicates, conflicts };
}

/**
 * Extract the first author family name from a BibTeX name list.
 * @param {string} value
 * @returns {string}
 */
function firstAuthorFamily(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return '';
  const first = text.split(/\s+and\s+/i)[0] ?? '';
  const withoutBraces = first.replace(/[{}]/g, '').trim();
  if (withoutBraces.length === 0) return '';
  if (withoutBraces.includes(',')) return withoutBraces.slice(0, withoutBraces.indexOf(',')).trim();
  const tokens = withoutBraces.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > 0 ? tokens[tokens.length - 1] : '';
}

/**
 * Strip diacritics and non-ASCII characters for citekey fragments.
 * @param {string} value
 * @returns {string}
 */
function asciiFragment(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

/**
 * First meaningful word of a title for citekey derivation.
 * @param {string} value
 * @returns {string}
 */
function firstSignificantWord(value) {
  const cleaned = String(value ?? '')
    .replace(/\\[A-Za-z]+/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/[^A-Za-z0-9\u00c0-\u024f\u4e00-\u9fff\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
  for (const word of cleaned) {
    const lowered = word.toLowerCase();
    if (!TITLE_STOPWORDS.has(lowered)) return lowered;
  }
  return cleaned.length > 0 ? cleaned[0].toLowerCase() : '';
}

/**
 * Derive or return a stable citekey for an entry.
 *
 * The existing `entry.key` wins; then BBT `citationKey`/`citekey`/`tex.ids`
 * fields; then a `family + year + title-word` derivation.
 *
 * @param {{key?: string, type?: string, fields?: Record<string, string>}} entry
 * @returns {string}
 */
export function citekeyOf(entry) {
  if (!entry || typeof entry !== 'object') return 'entry';
  const explicit = typeof entry.key === 'string' ? entry.key.trim() : '';
  if (explicit.length > 0) return explicit;
  const fields = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
  for (const name of ['citationkey', 'citekey', 'tex.ids']) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      const candidate = asciiFragment(value.trim().split(/\s+/)[0]);
      if (candidate.length > 0) return candidate;
    }
  }
  const family = asciiFragment(firstAuthorFamily(fields.author ?? fields.editor ?? '')).toLowerCase();
  const yearMatch = String(fields.year ?? fields.date ?? '').match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : '';
  const word = asciiFragment(firstSignificantWord(fields.title ?? '')).toLowerCase();
  const key = `${family}${year}${word}`;
  return key.length > 0 ? key : 'entry';
}

/**
 * Format Zotero creators as a BibTeX name list (`Family, Given and ...`).
 * Single-field names are wrapped in braces so BibTeX keeps them whole.
 *
 * @param {Array<{firstName?: string, lastName?: string, name?: string}>} creators
 * @returns {string}
 */
export function formatAuthors(creators) {
  if (!Array.isArray(creators)) return '';
  const names = [];
  for (const creator of creators) {
    if (typeof creator === 'string') {
      const value = creator.trim();
      if (value.length > 0) names.push(value);
      continue;
    }
    if (!creator || typeof creator !== 'object') continue;
    const firstName = typeof creator.firstName === 'string' ? creator.firstName.trim() : '';
    const lastName = typeof creator.lastName === 'string' ? creator.lastName.trim() : '';
    const single = typeof creator.name === 'string' ? creator.name.trim() : '';
    if (lastName.length === 0 && single.length > 0) {
      names.push(`{${single}}`);
    } else if (lastName.length === 0) {
      if (firstName.length > 0) names.push(firstName);
    } else if (firstName.length > 0) {
      names.push(`${lastName}, ${firstName}`);
    } else {
      names.push(lastName);
    }
  }
  return names.join(' and ');
}

/**
 * Read the non-empty string fields of a Zotero item record.
 * @param {any} item
 * @returns {Record<string, any> | null}
 */
function itemRecord(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.data && typeof item.data === 'object') return item.data;
  return item;
}

/**
 * Read the BBT citation key from Zotero item data.
 * @param {Record<string, any>} record
 * @returns {string}
 */
function bbtCitationKey(record) {
  if (typeof record.citationKey === 'string' && record.citationKey.trim().length > 0) {
    return record.citationKey.trim();
  }
  const extra = typeof record.extra === 'string' ? record.extra : '';
  const match = extra.match(/^(?:citation\s*key|citekey)\s*[:=]\s*(\S+)\s*$/im);
  return match && typeof match[1] === 'string' ? match[1] : '';
}

/**
 * Copy a trimmed string field when present.
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @param {string} targetName
 * @param {string} sourceName
 */
function copyStringField(target, source, targetName, sourceName) {
  const value = source[sourceName];
  if (typeof value === 'string' && value.trim().length > 0) target[targetName] = value.trim();
}

/**
 * Tags of a Zotero item as plain strings.
 * @param {any} tags
 * @returns {string[]}
 */
function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  const names = [];
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.trim().length > 0) names.push(tag.trim());
    else if (tag && typeof tag === 'object' && typeof tag.tag === 'string' && tag.tag.trim().length > 0) {
      names.push(tag.tag.trim());
    }
  }
  return names;
}

/**
 * Derive a year string from a Zotero date string.
 * @param {string} value
 * @returns {string}
 */
function yearOfDate(value) {
  const match = String(value ?? '').match(/(\d{4})/);
  return match ? match[1] : '';
}

/**
 * Convert one Zotero item into a BibLaTeX entry and derived fields.
 * @param {Record<string, any>} record
 * @returns {{type: string, fields: Record<string, string>}}
 */
function entryFieldsFromItem(record) {
  const zoteroType = typeof record.itemType === 'string' ? record.itemType : 'document';
  const type = ZOTERO_TO_BIB_TYPE[zoteroType] ?? 'misc';
  const fields = {};
  const creators = Array.isArray(record.creators) ? record.creators : [];
  const authors = creators.filter((creator) => creator && creator.creatorType !== 'editor');
  const editors = creators.filter((creator) => creator && creator.creatorType === 'editor');
  const authorText = formatAuthors(authors);
  if (authorText.length > 0) fields.author = authorText;
  const editorText = formatAuthors(editors);
  if (editorText.length > 0) fields.editor = editorText;

  copyStringField(fields, record, 'title', 'title');
  if (typeof record.shortTitle === 'string' && record.shortTitle.trim().length > 0) {
    fields.shorttitle = record.shortTitle.trim();
  }
  copyStringField(fields, record, 'date', 'date');
  copyStringField(fields, record, 'url', 'url');
  copyStringField(fields, record, 'doi', 'DOI');
  copyStringField(fields, record, 'abstract', 'abstractNote');
  copyStringField(fields, record, 'language', 'language');
  copyStringField(fields, record, 'publisher', 'publisher');
  copyStringField(fields, record, 'location', 'place');
  copyStringField(fields, record, 'edition', 'edition');
  copyStringField(fields, record, 'series', 'series');
  copyStringField(fields, record, 'volume', 'volume');
  copyStringField(fields, record, 'pages', 'pages');
  copyStringField(fields, record, 'isbn', 'ISBN');
  copyStringField(fields, record, 'issn', 'ISSN');
  copyStringField(fields, record, 'note', 'note');
  if (typeof record.pages === 'string' && record.pages.length > 0 && fields.pages === undefined) {
    fields.pages = record.pages;
  }
  const keywords = tagNames(record.tags);
  if (keywords.length > 0) fields.keywords = keywords.join(', ');
  if (typeof record.accessDate === 'string' && record.accessDate.length >= 10) {
    fields.urldate = record.accessDate.slice(0, 10);
  }

  if (zoteroType === 'journalArticle' || zoteroType === 'magazineArticle' || zoteroType === 'newspaperArticle') {
    copyStringField(fields, record, 'journaltitle', 'publicationTitle');
    copyStringField(fields, record, 'shortjournal', 'journalAbbreviation');
    if (typeof record.issue === 'string' && record.issue.trim().length > 0) fields.number = record.issue.trim();
  } else if (zoteroType === 'bookSection') {
    copyStringField(fields, record, 'booktitle', 'bookTitle');
    copyStringField(fields, record, 'bookauthor', 'bookAuthor');
  } else if (zoteroType === 'conferencePaper') {
    const proceedings = typeof record.proceedingsTitle === 'string' && record.proceedingsTitle.trim().length > 0
      ? record.proceedingsTitle.trim()
      : '';
    const conference = typeof record.conferenceName === 'string' ? record.conferenceName.trim() : '';
    if (proceedings.length > 0) fields.booktitle = proceedings;
    else if (conference.length > 0) fields.booktitle = conference;
    if (conference.length > 0) fields.eventtitle = conference;
  } else if (zoteroType === 'thesis') {
    copyStringField(fields, record, 'school', 'university');
    copyStringField(fields, record, 'type', 'thesisType');
  } else if (zoteroType === 'report') {
    copyStringField(fields, record, 'institution', 'institution');
    copyStringField(fields, record, 'type', 'reportType');
    if (typeof record.reportNumber === 'string' && record.reportNumber.trim().length > 0) {
      fields.number = record.reportNumber.trim();
    }
  } else if (zoteroType === 'preprint') {
    copyStringField(fields, record, 'eprinttype', 'repository');
    copyStringField(fields, record, 'eprint', 'archiveID');
  } else if (zoteroType === 'webpage' || zoteroType === 'blogPost') {
    copyStringField(fields, record, 'organization', 'websiteTitle');
  } else if (zoteroType === 'patent') {
    copyStringField(fields, record, 'number', 'patentNumber');
    copyStringField(fields, record, 'holder', 'assignee');
  }
  return { type, fields };
}

/**
 * Convert Zotero items (API envelopes or plain data records) to BibLaTeX
 * entries. Attachment/note/annotation items and trashed/child items are
 * skipped and reported.
 *
 * @param {Array<any>} items
 * @returns {{
 *   entries: Array<{type: string, key: string, fields: Record<string, string>}>,
 *   skipped: Array<{key: string, itemType: string, reason: string}>,
 * }}
 */
export function buildBibFromItems(items) {
  const list = Array.isArray(items) ? items : [];
  const entries = [];
  const skipped = [];
  const usedKeys = new Set();
  const uniquify = (base) => {
    let candidate = base.length > 0 ? base : 'entry';
    if (!usedKeys.has(candidate.toLowerCase())) {
      usedKeys.add(candidate.toLowerCase());
      return candidate;
    }
    for (let index = 0; index < 1000; index += 1) {
      const suffix = String.fromCharCode(97 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : '');
      const next = `${candidate}${suffix}`;
      if (!usedKeys.has(next.toLowerCase())) {
        usedKeys.add(next.toLowerCase());
        return next;
      }
    }
    usedKeys.add(`${candidate}duplicate`);
    return `${candidate}duplicate`;
  };
  for (const item of list) {
    const record = itemRecord(item);
    if (!record) {
      skipped.push({ key: '', itemType: '', reason: '不是有效的 Zotero item' });
      continue;
    }
    const itemType = typeof record.itemType === 'string' ? record.itemType : '';
    const itemKey = typeof record.key === 'string' ? record.key : (typeof item?.key === 'string' ? item.key : '');
    if (record.deleted === true) {
      skipped.push({ key: itemKey, itemType, reason: '条目在回收站中' });
      continue;
    }
    if (itemType === 'attachment' || itemType === 'note' || itemType === 'annotation') {
      skipped.push({ key: itemKey, itemType, reason: `子条目类型 ${itemType} 不进入参考文献表` });
      continue;
    }
    if (typeof record.parentItem === 'string' && record.parentItem.length > 0) {
      skipped.push({ key: itemKey, itemType, reason: '子条目（有 parentItem）不进入参考文献表' });
      continue;
    }
    const converted = entryFieldsFromItem(record);
    if (Object.keys(converted.fields).length === 0) {
      skipped.push({ key: itemKey, itemType, reason: '条目没有可导出的字段' });
      continue;
    }
    const baseKey = bbtCitationKey(record) || citekeyOf({ type: converted.type, key: '', fields: converted.fields });
    entries.push({ type: converted.type, key: uniquify(baseKey), fields: converted.fields });
  }
  entries.sort(compareEntries);
  return { entries, skipped };
}
