/**
 * Filesystem helpers shared by the inkstone plugins.
 *
 * All paths are plain host paths. Plugins are Host code with the host user's
 * file permissions; workspace discipline is enforced by the tools themselves
 * (they resolve relative paths against the session working directory), not by
 * a sandbox.
 *
 * @module dsh-inkstone/lib/paths
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directory (relative to a project) that owns run records, backups and caches. */
export const INKSTONE_DIR = '.inkstone';

/**
 * Resolve a project directory from an explicit argument or the session cwd.
 * @param {string | undefined} explicit
 * @param {string} cwd
 * @returns {string} absolute path
 */
export function resolveProjectDir(explicit, cwd) {
  return explicit ? path.resolve(cwd, explicit) : path.resolve(cwd);
}

/**
 * Root of the plugin's per-project state directory.
 * @param {string} projectDir
 * @returns {string}
 */
export function inkstoneRoot(projectDir) {
  return path.join(projectDir, INKSTONE_DIR);
}

/**
 * Directory holding one subdirectory per pipeline run.
 * @param {string} projectDir
 * @returns {string}
 */
export function runsRoot(projectDir) {
  return path.join(inkstoneRoot(projectDir), 'runs');
}

/**
 * Directory holding pre-edit backups for the self-healing compiler.
 * @param {string} projectDir
 * @returns {string}
 */
export function backupsRoot(projectDir) {
  return path.join(inkstoneRoot(projectDir), 'backups');
}

/**
 * Create a directory recursively.
 * @param {string} dir
 * @returns {string} the same directory
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Timestamp usable in directory names: `20261023-214501`.
 * @returns {string}
 */
export function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Read and parse a JSON file.
 * @param {string} file
 * @param {unknown} [fallback]
 * @returns {any}
 */
export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON with a trailing newline, creating parent directories.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Read a bounded UTF-8 text file.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function readTextBounded(file, maxBytes = 2_000_000) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

/**
 * List regular files below a directory.
 * @param {string} dir
 * @param {{extensions?: string[], recursive?: boolean, limit?: number}} [options]
 * @returns {string[]} absolute paths
 */
export function listFiles(dir, options = {}) {
  const extensions = options.extensions ? new Set(options.extensions.map((ext) => ext.toLowerCase())) : undefined;
  const recursive = options.recursive !== false;
  const limit = options.limit ?? 5000;
  const out = [];
  const walk = (current) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile()) {
        if (!extensions || extensions.has(path.extname(entry.name).toLowerCase())) out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Find files (by exact basename, case-insensitive) under a root.
 * @param {string} root
 * @param {string} basename
 * @param {{maxDepth?: number, limit?: number}} [options]
 * @returns {string[]} absolute paths, shallowest first
 */
export function findByName(root, basename, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const limit = options.limit ?? 20;
  const wanted = basename.toLowerCase();
  const out = [];
  const walk = (current, depth) => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === wanted) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Whether `child` is inside (or equal to) `parent`.
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Path relative to a base directory, with forward slashes for display.
 * @param {string} base
 * @param {string} target
 * @returns {string}
 */
export function displayPath(base, target) {
  const relative = path.relative(base, target);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

/**
 * Copy a file, creating parents; returns the destination.
 * @param {string} source
 * @param {string} destination
 * @returns {string}
 */
export function copyFile(source, destination) {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return destination;
}
