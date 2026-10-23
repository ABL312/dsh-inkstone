/**
 * Typst CLI runner: binary detection, compilation, page export, human-format
 * diagnostic parsing and environment probing.
 *
 * Node built-ins only. No DSH imports, no third-party packages.
 *
 * In-process behaviour notes / known limitations
 * ----------------------------------------------
 * - Typst 0.15 has no JSON diagnostic format; `compile` uses the default
 *   human format (`error:`/`warning:` + `┌─ file:line:col`). `parseDiagnostics`
 *   accepts both the human block format and `--diagnostic-format short` lines.
 * - Binary detection order: config `binaryPath` (or `TYPST_BIN`) -> `PATH` ->
 *   WinGet Links -> WinGet Packages (wildcard) -> cargo bin -> scoop shims.
 *   The first candidate that answers `--version` wins; the result is cached for
 *   the lifetime of the process (keyed by the relevant environment variables).
 * - `compile` never heals; the rule-based self-healing pass lives in
 *   `lib/heal.mjs` and is orchestrated by the plugin tool layer.
 * - The binary cannot be detected -> we throw an actionable error listing every
 *   attempted location and the `winget install` command; callers (tools) turn
 *   that into a tool-level error instead of a silent empty result.
 * - All subprocesses are spawned with `shell: false` and argument arrays.
 *
 * @module dsh-inkstone/lib/typst-runner
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Default compile timeout (CONTRACT §0.7: Typst 120s). */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** WinGet install command quoted in detection failures. */
export const WINGET_INSTALL_COMMAND = 'winget install --id Typst.Typst -e';

/** Matches `typst 0.15.1 (9dfd3a08)` (also tolerates prerelease suffixes). */
const VERSION_RE = /typst\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i;

/** CJK font family heuristic (CONTRACT §4). */
const CJK_FONT_RE = /YaHei|SimSun|Song|Hei|Kai|FangSong|Noto.*CJK|Source Han|思源|DengXian|Songti|Heiti|Kaiti/i;

/** Cache of successful detections, keyed by the inputs that affect them. */
const detectionCache = new Map();

/** @returns {boolean} */
function isWindows() {
  return process.platform === 'win32';
}

/** @returns {string} platform-specific typst executable file name */
function binaryName() {
  return isWindows() ? 'typst.exe' : 'typst';
}

/**
 * Read an environment variable case-insensitively (plain objects passed in by
 * tests may use `Path` instead of `PATH`).
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function envGet(env, name) {
  if (!env) return undefined;
  if (typeof env[name] === 'string') return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower && typeof env[key] === 'string') return env[key];
  }
  return undefined;
}

/**
 * Run a binary synchronously and capture `--version` output.
 * @param {string} binary
 * @param {Record<string, string | undefined>} env
 * @returns {{version: string, raw: string} | null}
 */
function readVersionSync(binary, env) {
  try {
    const result = spawnSync(binary, ['--version'], {
      env: /** @type {NodeJS.ProcessEnv} */ (env),
      shell: false,
      windowsHide: true,
      timeout: 20_000,
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) return null;
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const match = raw.match(VERSION_RE);
    if (!match) return null;
    return { version: match[1], raw };
  } catch {
    return null;
  }
}

/**
 * Test one candidate file; returns a detection or null.
 * @param {string} candidate
 * @param {'config'|'path'|'winget-link'|'winget-package'|'cargo'|'scoop'} source
 * @param {Record<string, string | undefined>} env
 * @param {string[]} attempted
 * @returns {{path: string, version: string, source: string} | null}
 */
function tryCandidate(candidate, source, env, attempted) {
  const resolved = path.resolve(candidate);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    attempted.push(`${source}: ${resolved} (not found)`);
    return null;
  }
  if (!stat.isFile()) {
    attempted.push(`${source}: ${resolved} (not a file)`);
    return null;
  }
  const version = readVersionSync(resolved, env);
  if (!version) {
    attempted.push(`${source}: ${resolved} (exists but does not answer --version)`);
    return null;
  }
  return { path: resolved, version: version.version, source };
}

/**
 * Candidate executables found by scanning `PATH`.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function pathCandidates(env) {
  const pathValue = envGet(env, 'PATH') ?? '';
  const dirs = pathValue
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0 && !dir.startsWith('"'));
  const names = [binaryName(), 'typst'];
  const out = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) out.push(full);
    }
  }
  return out;
}

/**
 * WinGet installed-package typst binaries:
 * `%LOCALAPPDATA%/Microsoft/WinGet/Packages/Typst.Typst_<id>/typst-<version>/typst.exe`.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function wingetPackageCandidates(env) {
  const localAppData = envGet(env, 'LOCALAPPDATA');
  if (!localAppData) return [];
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  let packageDirs;
  try {
    packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of packageDirs) {
    if (!entry.isDirectory() || !/^Typst\.Typst/i.test(entry.name)) continue;
    const packageDir = path.join(packagesDir, entry.name);
    let inner;
    try {
      inner = fs.readdirSync(packageDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of inner) {
      if (!child.isDirectory() || !/^typst/i.test(child.name)) continue;
      const binary = path.join(packageDir, child.name, binaryName());
      if (fs.existsSync(binary)) out.push(binary);
    }
    // Some installer layouts put the binary directly in the package directory.
    const direct = path.join(packageDir, binaryName());
    if (fs.existsSync(direct)) out.push(direct);
  }
  return out;
}

/**
 * WinGet Links shim: `LOCALAPPDATA/Microsoft/WinGet/Links/typst.exe`.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function wingetLinkCandidates(env) {
  const localAppData = envGet(env, 'LOCALAPPDATA');
  if (!localAppData) return [];
  return [path.join(localAppData, 'Microsoft', 'WinGet', 'Links', binaryName())];
}

/**
 * cargo / scoop shim candidates.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function toolManagerCandidates(env) {
  const out = [];
  const home = envGet(env, 'USERPROFILE') ?? envGet(env, 'HOME');
  const cargoHome = envGet(env, 'CARGO_HOME') ?? (home ? path.join(home, '.cargo') : undefined);
  if (cargoHome) out.push(path.join(cargoHome, 'bin', binaryName()));
  const scoopRoot = envGet(env, 'SCOOP') ?? (home ? path.join(home, 'scoop') : undefined);
  if (scoopRoot) out.push(path.join(scoopRoot, 'shims', binaryName()));
  if (isWindows()) out.push(path.join('C:\\', 'ProgramData', 'scoop', 'shims', binaryName()));
  return out;
}

/**
 * Cache key: everything that can change detection for the default environment.
 * @param {string | undefined} explicit
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function detectionKey(explicit, env) {
  return JSON.stringify([
    explicit ?? '',
    envGet(env, 'PATH') ?? '',
    envGet(env, 'PATHEXT') ?? '',
    envGet(env, 'LOCALAPPDATA') ?? '',
    envGet(env, 'USERPROFILE') ?? '',
    envGet(env, 'HOME') ?? '',
    envGet(env, 'CARGO_HOME') ?? '',
    envGet(env, 'SCOOP') ?? '',
  ]);
}

/**
 * Locate the Typst executable.
 *
 * Detection order (CONTRACT §4): config `binaryPath` / `TYPST_BIN` -> `PATH` ->
 * WinGet Links -> WinGet Packages -> cargo `.cargo/bin` -> scoop shims.
 *
 * @param {{ binaryPath?: string, env?: Record<string, string | undefined>, cache?: boolean }} [options]
 * @returns {{ path: string, version: string, source: 'config'|'path'|'winget-link'|'winget-package'|'cargo'|'scoop' }}
 * @throws {Error} when no working binary is found; message lists attempted
 *   locations plus the WinGet install command.
 */
export function detectTypstBinary({ binaryPath, env = process.env, cache = true } = {}) {
  const explicit = typeof binaryPath === 'string' && binaryPath.trim().length > 0 ? binaryPath.trim() : envGet(env, 'TYPST_BIN');
  const key = detectionKey(explicit, env);
  if (cache && detectionCache.has(key)) return detectionCache.get(key);

  /** @type {string[]} */
  const attempted = [];
  const failedExplicit = [];

  // 1. Explicit configuration / TYPST_BIN wins.
  if (explicit) {
    const found = tryCandidate(explicit, 'config', env, attempted);
    if (found) {
      if (cache) detectionCache.set(key, found);
      return found;
    }
    failedExplicit.push(explicit);
  }

  // 2. PATH.
  for (const candidate of pathCandidates(env)) {
    const found = tryCandidate(candidate, 'path', env, attempted);
    if (found) {
      if (cache) detectionCache.set(key, found);
      return found;
    }
  }
  const pathValue = envGet(env, 'PATH');
  attempted.push(`PATH: ${pathValue ? `scanned ${pathValue.split(path.delimiter).filter(Boolean).length} directories` : '(empty)'}`);
  attempted.push(`PATH: expected \`${binaryName()}\` on the PATH`);

  // 3. WinGet Links shim.
  for (const candidate of wingetLinkCandidates(env)) {
    const found = tryCandidate(candidate, 'winget-link', env, attempted);
    if (found) {
      if (cache) detectionCache.set(key, found);
      return found;
    }
  }

  // 4. WinGet Packages wildcard.
  const packageCandidates = wingetPackageCandidates(env);
  if (packageCandidates.length === 0) {
    attempted.push(
      'winget-package: %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\Typst.Typst_*\\typst-*\\typst.exe (no matching package directory)',
    );
  }
  for (const candidate of packageCandidates) {
    const found = tryCandidate(candidate, 'winget-package', env, attempted);
    if (found) {
      if (cache) detectionCache.set(key, found);
      return found;
    }
  }

  // 5 + 6. cargo / scoop (only when their roots exist or a shim is present).
  for (const candidate of toolManagerCandidates(env)) {
    const source = candidate.toLowerCase().includes(`${path.sep}scoop${path.sep}`) ? 'scoop' : 'cargo';
    const found = tryCandidate(candidate, source, env, attempted);
    if (found) {
      if (cache) detectionCache.set(key, found);
      return found;
    }
  }

  const lines = [
    'Typst binary not found: `typst` could not be located or it does not answer `--version`.',
    '',
    'Attempted locations:',
    ...attempted.map((line) => `  - ${line}`),
  ];
  if (failedExplicit.length > 0) {
    lines.push('', `Configured binaryPath/TYPST_BIN was set to: ${failedExplicit.join(', ')}`);
  }
  lines.push(
    '',
    `Install Typst (Windows): ${WINGET_INSTALL_COMMAND}`,
    'Then restart the shell (WinGet Links may require a new process) or set:',
    '  - plugin config `binaryPath` to the absolute `typst.exe` path, or',
    '  - environment variable `TYPST_BIN` to that path.',
    'Alternatively verify the install with: typst --version',
  );
  throw new Error(lines.join('\n'));
}

/**
 * Run the Typst CLI directly.
 *
 * @param {string[]} args CLI arguments *without* the executable.
 * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal, env?: Record<string, string | undefined>, binaryPath?: string, maxBuffer?: number }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, durationMs: number }>}
 */
export async function runTypst(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('runTypst: args must be an array of strings');
  }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const env = /** @type {NodeJS.ProcessEnv} */ (options.env ?? process.env);
  const binary = options.binaryPath ?? detectTypstBinary({ env }).path;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  const started = Date.now();

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`Failed to start Typst (${binary}): ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let aborted = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const killChild = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      aborted = true;
      killChild();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        killChild();
        fail(new Error('Typst command aborted before it started'));
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      fail(new Error(`Failed to run Typst (${binary}): ${error.message}`));
    });
    child.on('close', (code) => {
      if (aborted) {
        fail(new Error('Typst command was aborted'));
        return;
      }
      finish({
        exitCode: typeof code === 'number' ? code : timedOut ? 124 : 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Strip Typst's verbatim Windows path prefix and normalize separators.
 * @param {string} file
 * @returns {string}
 */
function cleanDiagnosticPath(file) {
  let value = String(file ?? '').trim();
  if (value.startsWith('\\\\?\\')) value = value.slice(4);
  else if (value.startsWith('//?/')) value = value.slice(4);
  // Strip surrounding backticks/quotes if the location form quoted the path.
  value = value.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '');
  return value;
}

/** Human-format header: `error: ...` / `warning: ...` (hint lines stay in `raw`). */
const DIAGNOSTIC_HEADER_RE = /^(error|warning):\s?(.*)$/i;
/** Short format: `path:line:col: error: message`. */
const SHORT_DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+):\s*(error|warning):\s?(.*)$/i;
/** Human-format location line: `  ┌─ C:\path\main.typ:3:5`. */
const DIAGNOSTIC_LOCATION_RE = /[┌╭]─\s*(.*):(\d+):(\d+)\s*$/;

/**
 * Parse Typst stderr diagnostics.
 *
 * Supports the default human block format:
 *   error: unknown variable: foo
 *     ┌─ C:\proj\main.typ:3:5
 * and `--diagnostic-format short`:
 *   C:\proj\main.typ:3:5: error: unknown variable: foo
 *
 * @param {string} stderr
 * @returns {{ severity: 'error'|'warning', message: string, file?: string, line?: number, column?: number, raw: string }[]}
 */
export function parseDiagnostics(stderr) {
  const text = String(stderr ?? '');
  if (text.trim().length === 0) return [];
  /** @type {{ severity: 'error'|'warning', message: string, file?: string, line?: number, column?: number, raw: string }[]} */
  const diagnostics = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const rawLines = current.rawLines;
    while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
    diagnostics.push({
      severity: current.severity,
      message: current.message,
      ...(current.file !== undefined ? { file: current.file } : {}),
      ...(current.line !== undefined ? { line: current.line } : {}),
      ...(current.column !== undefined ? { column: current.column } : {}),
      raw: rawLines.join('\n'),
    });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    // Short format: single-line, must start at column 0 (human format location
    // lines are indented and never start with the severity suffix).
    const short = !/^\s/.test(line) ? line.match(SHORT_DIAGNOSTIC_RE) : null;
    if (short) {
      flush();
      diagnostics.push({
        severity: short[4].toLowerCase() === 'warning' ? 'warning' : 'error',
        message: short[5].trim(),
        file: cleanDiagnosticPath(short[1]),
        line: Number(short[2]),
        column: Number(short[3]),
        raw: line,
      });
      continue;
    }

    const header = line.match(DIAGNOSTIC_HEADER_RE);
    if (header) {
      flush();
      current = {
        severity: header[1].toLowerCase() === 'warning' ? 'warning' : 'error',
        message: header[2].trim(),
        rawLines: [line],
      };
      continue;
    }

    if (current) {
      current.rawLines.push(line);
      if (current.file === undefined) {
        const location = line.match(DIAGNOSTIC_LOCATION_RE);
        if (location) {
          current.file = cleanDiagnosticPath(location[1]);
          current.line = Number(location[2]);
          current.column = Number(location[3]);
        }
      }
    }
  }
  flush();
  return diagnostics;
}

/**
 * Resolve an output path against a project root.
 * @param {string} root
 * @param {string} value
 * @returns {string}
 */
function resolveAgainst(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

/**
 * Build `--font-path` arguments (one joined value; Typst splits on the
 * platform path delimiter).
 * @param {string[] | undefined} fontPaths
 * @param {string} root
 * @returns {string[]}
 */
function fontPathArgs(fontPaths, root) {
  if (!Array.isArray(fontPaths)) return [];
  const dirs = fontPaths
    .filter((dir) => typeof dir === 'string' && dir.trim().length > 0)
    .map((dir) => resolveAgainst(root, dir.trim()));
  if (dirs.length === 0) return [];
  return ['--font-path', dirs.join(path.delimiter)];
}

/**
 * Default PDF output path for an input file.
 * @param {string} inputAbs
 * @returns {string}
 */
function defaultOutputPath(inputAbs) {
  const ext = path.extname(inputAbs);
  const base = path.basename(inputAbs, ext);
  return path.join(path.dirname(inputAbs), `${base}.pdf`);
}

/**
 * Compile one Typst document to PDF (or the format inferred from `output`).
 *
 * No self-healing happens here — use `lib/heal.mjs`'s `healCompile` for that.
 *
 * @param {{ input: string, output?: string, root?: string, fontPaths?: string[], ppi?: number, timeoutMs?: number, signal?: AbortSignal, binaryPath?: string, env?: Record<string, string | undefined>, maxBuffer?: number }} options
 * @returns {Promise<{ ok: boolean, outputPath: string, exitCode: number, stderr: string, stdout: string, diagnostics: object[], durationMs: number, timedOut: boolean }>}
 */
export async function compile(options = {}) {
  if (typeof options.input !== 'string' || options.input.trim().length === 0) {
    throw new Error('compile: "input" must be a non-empty path to a .typ file');
  }
  const inputAbs = path.resolve(options.input.trim());
  if (!fs.existsSync(inputAbs)) {
    throw new Error(`compile: input file not found: ${inputAbs}`);
  }
  const root = path.resolve(options.root ?? path.dirname(inputAbs));
  if (!fs.existsSync(root)) {
    throw new Error(`compile: project root not found: ${root}`);
  }
  const outputAbs = options.output ? resolveAgainst(root, options.output) : defaultOutputPath(inputAbs);
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });

  const args = ['--color', 'never', 'compile', inputAbs, outputAbs, '--root', root, ...fontPathArgs(options.fontPaths, root)];
  if (Number.isInteger(options.ppi) && options.ppi > 0 && path.extname(outputAbs).toLowerCase() === '.png') {
    args.push('--ppi', String(options.ppi));
  }
  const result = await runTypst(args, {
    cwd: root,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    env: options.env,
    binaryPath: options.binaryPath,
    maxBuffer: options.maxBuffer,
  });
  const diagnostics = parseDiagnostics(result.stderr);
  return {
    ok: result.exitCode === 0,
    outputPath: outputAbs,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
    diagnostics,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}

/**
 * Normalize a `pages` argument into Typst's `--pages` syntax.
 * @param {number | string | number[] | undefined} pages
 * @returns {string | undefined}
 */
function normalizePages(pages) {
  if (pages === undefined || pages === null || pages === '') return undefined;
  let value;
  if (Array.isArray(pages)) value = pages.join(',');
  else value = String(pages);
  value = value.replace(/\s+/g, '');
  if (value.length === 0) return undefined;
  if (!/^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/.test(value)) {
    throw new Error(`invalid "pages": ${JSON.stringify(pages)}; expected e.g. "1,3-5" or [1, 3]`);
  }
  return value;
}

/**
 * Export one page per file (SVG or PNG). Multiple pages require a page-number
 * template; a fixed template (`page-{0p}.svg`) is used here.
 *
 * @param {{ input: string, format: 'svg'|'png', outDir?: string, pages?: number|string|number[], ppi?: number, root?: string, fontPaths?: string[], timeoutMs?: number, signal?: AbortSignal, binaryPath?: string, env?: Record<string, string | undefined>, prefix?: string }} options
 * @returns {Promise<{ ok: boolean, files: string[], diagnostics: object[], exitCode: number, stderr: string, outDir: string, durationMs: number }>}
 */
export async function exportPages(options = {}) {
  const format = options.format;
  if (format !== 'svg' && format !== 'png') {
    throw new Error('exportPages: "format" must be "svg" or "png"');
  }
  if (typeof options.input !== 'string' || options.input.trim().length === 0) {
    throw new Error('exportPages: "input" must be a non-empty path to a .typ file');
  }
  const inputAbs = path.resolve(options.input.trim());
  if (!fs.existsSync(inputAbs)) {
    throw new Error(`exportPages: input file not found: ${inputAbs}`);
  }
  const root = path.resolve(options.root ?? path.dirname(inputAbs));
  const outDir = options.outDir ? resolveAgainst(root, options.outDir) : path.join(path.dirname(inputAbs), 'typst-export');
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = typeof options.prefix === 'string' && options.prefix.trim().length > 0 ? options.prefix.trim() : 'page';
  const templateName = `${prefix}-{0p}.${format}`;
  const outputTemplate = path.join(outDir, templateName);

  const args = [
    '--color',
    'never',
    'compile',
    inputAbs,
    outputTemplate,
    '--root',
    root,
    ...fontPathArgs(options.fontPaths, root),
  ];
  const pages = normalizePages(options.pages);
  if (pages) args.push('--pages', pages);
  if (format === 'png' && Number.isInteger(options.ppi) && options.ppi > 0) {
    args.push('--ppi', String(options.ppi));
  }

  const result = await runTypst(args, {
    cwd: root,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    env: options.env,
    binaryPath: options.binaryPath,
  });
  const diagnostics = parseDiagnostics(result.stderr);

  let files = [];
  try {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fileRe = new RegExp(`^${escapedPrefix}-(\\d+)\\.${format}$`, 'i');
    files = fs
      .readdirSync(outDir)
      .map((name) => ({ name, match: name.match(fileRe) }))
      .filter((entry) => entry.match)
      .map((entry) => ({ name: entry.name, page: Number(entry.match[1]) }))
      .sort((a, b) => a.page - b.page)
      .map((entry) => path.join(outDir, entry.name));
  } catch {
    files = [];
  }

  return {
    ok: result.exitCode === 0,
    files,
    diagnostics,
    exitCode: result.exitCode,
    stderr: result.stderr,
    outDir,
    durationMs: result.durationMs,
  };
}

/**
 * Probe the Typst installation: binary, version, fonts and package cache.
 *
 * @param {{ binaryPath?: string, fontPaths?: string[], timeoutMs?: number, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ ok: boolean, binary: string, version: string, source: string, fonts: { total: number, cjkFamilies: string[], error?: string }, packageCache: string | null, diagnosticsFormat: 'human' }>}
 */
export async function probe({ binaryPath, fontPaths, timeoutMs = 60_000, env } = {}) {
  const detected = detectTypstBinary({ binaryPath, env });
  const effectiveEnv = env ?? process.env;
  const args = ['fonts', ...fontPathArgs(fontPaths, process.cwd())];
  const fontsResult = await runTypst(args, { timeoutMs, env: effectiveEnv, binaryPath: detected.path });
  let families = [];
  let fontsError;
  if (fontsResult.exitCode === 0) {
    families = fontsResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } else {
    fontsError = fontsResult.stderr.trim() || `typst fonts exited with code ${fontsResult.exitCode}`;
  }
  const cjkFamilies = [...new Set(families.filter((family) => CJK_FONT_RE.test(family)))].sort((a, b) => a.localeCompare(b));

  let packageCache = null;
  const candidates = [];
  const localAppData = envGet(effectiveEnv, 'LOCALAPPDATA');
  const roamingAppData = envGet(effectiveEnv, 'APPDATA');
  if (localAppData) candidates.push(path.join(localAppData, 'typst', 'packages'));
  if (roamingAppData) candidates.push(path.join(roamingAppData, 'typst', 'packages'));
  if (envGet(effectiveEnv, 'HOME')) candidates.push(path.join(envGet(effectiveEnv, 'HOME'), '.cache', 'typst', 'packages'));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        packageCache = candidate;
        break;
      }
    } catch {
      /* keep looking */
    }
  }

  return {
    ok: true,
    binary: detected.path,
    version: detected.version,
    source: detected.source,
    fonts: { total: families.length, cjkFamilies, ...(fontsError ? { error: fontsError } : {}) },
    packageCache,
    diagnosticsFormat: 'human',
  };
}
