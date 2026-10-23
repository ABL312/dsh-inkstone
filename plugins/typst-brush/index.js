/**
 * 笔 · Typst 排版 (typst-brush) — Host tool plugin.
 *
 * Default tools:
 *   - typst_build  自愈编译（默认 heal=true），输出轮数/修复列表/产物路径
 *   - typst_export 多页 SVG / PNG 导出（页码模板自动处理）
 *   - typst_probe  探测二进制、版本、CJK 字体与模板列表
 * Advanced tools (`config.advancedTools: true`):
 *   - typst_compile_raw  不自动修复的原始编译
 *   - typst_clean        清理 .inkstone/backups 与指定导出目录
 *
 * Node built-ins + relative imports only. All relative paths are resolved
 * against the invoking session working directory (`sessionCwd(exec)`).
 *
 * @module dsh-inkstone/plugins/typst-brush
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  errorMessage,
  normalizeConfig,
  optionalInteger,
  optionalString,
  renderSummary,
  requireString,
  sessionCwd,
  configured,
} from '../../lib/tool-kit.mjs';
import { backupsRoot, displayPath, isInside, resolveProjectDir } from '../../lib/paths.mjs';
import { compile, exportPages, probe } from '../../lib/typst-runner.mjs';
import { healCompile } from '../../lib/heal.mjs';
import { listTemplates } from '../../lib/typst-scaffold.mjs';

export const name = 'typst-brush';
export const inject = ['tools'];

const DEFAULT_HEAL_ROUNDS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/* ------------------------------------------------------------------ *
 * Config + argument helpers
 * ------------------------------------------------------------------ */

/**
 * Normalize plugin config into concrete settings.
 * @param {unknown} config
 * @returns {{ binaryPath?: string, fontPaths: string[], maxHealRounds: number, timeoutMs: number, advancedTools: boolean }}
 */
function settings(config) {
  const cfg = normalizeConfig(config);
  const maxHealRounds = optionalInteger(cfg, 'maxHealRounds', DEFAULT_HEAL_ROUNDS, 10);
  const timeoutRaw = cfg.timeoutMs;
  const timeoutMs =
    Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  return {
    binaryPath: configured(cfg, 'binaryPath', 'TYPST_BIN', undefined),
    fontPaths: Array.isArray(cfg.fontPaths)
      ? cfg.fontPaths.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
      : [],
    maxHealRounds,
    timeoutMs,
    advancedTools: cfg.advancedTools === true,
  };
}

/**
 * Merge config/argument font paths and resolve them against the session cwd.
 * @param {{ fontPaths: string[] }} cfg
 * @param {Record<string, any>} args
 * @param {string} cwd
 * @returns {string[]}
 */
function resolveFontPaths(cfg, args, cwd) {
  const fromArgs = Array.isArray(args.fontPaths) ? args.fontPaths : [];
  const merged = [...cfg.fontPaths, ...fromArgs].filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
  const resolved = merged.map((entry) => (path.isAbsolute(entry.trim()) ? path.resolve(entry.trim()) : path.resolve(cwd, entry.trim())));
  return [...new Set(resolved)];
}

/**
 * Validate an optional ppi argument.
 * @param {Record<string, any>} args
 * @param {string} toolName
 * @returns {number | undefined}
 */
function optionalPpi(args) {
  const value = args.ppi;
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 2400) {
    throw new Error('invalid arguments: "ppi" must be an integer between 1 and 2400');
  }
  return value;
}

/**
 * Resolve input/root/output for a build-like call.
 * @param {Record<string, any>} args
 * @param {string} cwd
 * @returns {{ inputAbs: string, projectDir: string, outputAbs: string | undefined }}
 */
function resolveBuildPaths(args, cwd) {
  const inputArg = requireString(args, 'input');
  const inputAbs = path.resolve(cwd, inputArg);
  if (!fs.existsSync(inputAbs)) {
    throw new Error(`input file not found: ${inputAbs} (paths are resolved against the session working directory: ${cwd})`);
  }
  const projectDir = args.root ? resolveProjectDir(requireString(args, 'root'), cwd) : path.dirname(inputAbs);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`project root not found: ${projectDir}`);
  }
  const outputAbs = optionalString(args, 'output') ? path.resolve(cwd, optionalString(args, 'output')) : undefined;
  if (outputAbs && !isInside(outputAbs, projectDir)) {
    throw new Error(
      `refusing to write outside the project root: ${outputAbs} is not inside ${projectDir}. Typst requires --root to contain the input and output.`,
    );
  }
  return { inputAbs, projectDir, outputAbs };
}

/**
 * Count diagnostics by severity.
 * @param {{ severity?: string }[]} diagnostics
 * @returns {{ errors: number, warnings: number }}
 */
function countDiagnostics(diagnostics) {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics ?? []) {
    if (diagnostic?.severity === 'warning') warnings += 1;
    else errors += 1;
  }
  return { errors, warnings };
}

/**
 * Format one diagnostic for the human summary.
 * @param {any} diagnostic
 * @returns {string}
 */
function formatDiagnostic(diagnostic) {
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}${diagnostic.column ? `:${diagnostic.column}` : ''}`
    : '?';
  return `${diagnostic.severity}: ${diagnostic.message} (${location})`;
}

/**
 * Render the human summary plus the structured result (minus the internal
 * summary field). The harness only passes the validated value to `render`, so
 * the tool layer keeps the summary on the value under `__summary`.
 * @param {any} value
 * @returns {{type: 'text', text: string}[]}
 */
function toolRender(value) {
  const { __summary, ...data } = value ?? {};
  return renderSummary(__summary ?? '', data);
}

/* ------------------------------------------------------------------ *
 * Output schemas (supported JSON Schema subset only)
 * ------------------------------------------------------------------ */

const DIAGNOSTIC_SCHEMA = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['error', 'warning'] },
    message: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    column: { type: 'integer' },
    raw: { type: 'string' },
  },
  required: ['severity', 'message'],
  additionalProperties: true,
};

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    rule: {
      type: 'string',
      enum: ['unknown-font', 'missing-bib-key', 'missing-file', 'missing-bib', 'missing-include'],
    },
    file: { type: 'string' },
    message: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
  },
  required: ['rule', 'file', 'message'],
  additionalProperties: true,
};

const BUILD_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    input: { type: 'string' },
    projectDir: { type: 'string' },
    outputPath: { type: 'string' },
    rounds: { type: 'integer' },
    compiles: { type: 'integer' },
    fixes: { type: 'array', items: FIX_SCHEMA },
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
    notes: { type: 'array', items: { type: 'string' } },
    stderr: { type: 'string' },
    binaryPath: { type: 'string' },
  },
  required: ['ok', 'input', 'projectDir', 'outputPath', 'rounds', 'fixes', 'diagnostics'],
  additionalProperties: true,
};

const EXPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    format: { type: 'string', enum: ['svg', 'png'] },
    input: { type: 'string' },
    outDir: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'integer' },
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
    stderr: { type: 'string' },
  },
  required: ['ok', 'format', 'input', 'outDir', 'files', 'diagnostics'],
  additionalProperties: true,
};

const PROBE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    binary: { type: 'string' },
    version: { type: 'string' },
    source: { type: 'string' },
    fonts: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        cjkFamilies: { type: 'array', items: { type: 'string' } },
      },
      required: ['total', 'cjkFamilies'],
      additionalProperties: true,
    },
    packageCache: { type: 'string' },
    templates: { type: 'array', items: { type: 'string' } },
    advancedTools: { type: 'boolean' },
    config: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
    hint: { type: 'string' },
  },
  required: ['ok', 'templates'],
  additionalProperties: true,
};

const CLEAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    projectDir: { type: 'string' },
    removed: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'projectDir', 'removed'],
  additionalProperties: true,
};

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

/**
 * @param {{ binaryPath?: string, fontPaths: string[], maxHealRounds: number, timeoutMs: number, advancedTools: boolean }} cfg
 */
function buildTool(cfg) {
  return {
    name: 'typst_build',
    description:
      '编译 Typst 文档为 PDF（默认先自愈）：白名单修复未知字体族、缺失引用键、缺失图片/bib/include 路径，改前备份到 .inkstone/backups/，最多 maxRounds 轮。' +
      '返回是否成功、自愈轮数、修复列表、结构化诊断与产物路径。修复不了时 ok=false 并返回文件/行/列级诊断。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Typst 源文件路径（.typ），相对会话工作目录' },
        root: { type: 'string', description: '项目根目录（默认 input 所在目录），作为 --root 与自愈边界' },
        output: { type: 'string', description: 'PDF 输出路径（默认与 input 同目录同名 .pdf）' },
        heal: { type: 'boolean', description: '是否启用规则化自愈，默认 true' },
        maxRounds: { type: 'integer', description: `自愈轮数上限，默认 ${DEFAULT_HEAL_ROUNDS}` },
        fontPaths: { type: 'array', items: { type: 'string' }, description: '额外字体目录（--font-path）' },
        ppi: { type: 'integer', description: '仅当输出为 PNG 时的分辨率，默认 Typst 值' },
        timeoutMs: { type: 'integer', description: `编译超时毫秒，默认 ${DEFAULT_TIMEOUT_MS}` },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: { schema: BUILD_OUTPUT_SCHEMA },
    timeoutMs: MAX_TIMEOUT_MS,
    async execute(args = {}, exec) {
      const cwd = sessionCwd(exec);
      const { inputAbs, projectDir, outputAbs } = resolveBuildPaths(args, cwd);
      const heal = args.heal !== false;
      const maxRounds = optionalInteger(args, 'maxRounds', cfg.maxHealRounds, 10);
      const timeoutMs = optionalInteger(args, 'timeoutMs', cfg.timeoutMs, MAX_TIMEOUT_MS);
      const fontPaths = resolveFontPaths(cfg, args, cwd);
      const ppi = optionalPpi(args);
      const compileOptions = {
        binaryPath: cfg.binaryPath,
        fontPaths,
        ppi,
        timeoutMs,
        ...(outputAbs ? { output: outputAbs } : {}),
      };

      let result;
      if (heal) {
        result = await healCompile({
          projectDir,
          input: inputAbs,
          compileOptions,
          maxRounds,
        });
      } else {
        const raw = await compile({ input: inputAbs, root: projectDir, ...compileOptions });
        result = {
          ok: raw.ok,
          rounds: 0,
          compiles: 1,
          fixes: [],
          finalDiagnostics: raw.diagnostics,
          outputPath: raw.outputPath,
          stderr: raw.stderr,
          notes: ['heal=false: raw compile only'],
          timedOut: raw.timedOut,
        };
      }

      const diagnostics = result.finalDiagnostics ?? [];
      const { errors, warnings } = countDiagnostics(diagnostics);
      const outputPath = result.outputPath ?? '';
      const lines = [
        `${result.ok ? '编译成功' : '编译失败'}：${displayPath(cwd, inputAbs)}`,
        heal
          ? `自愈轮数：${result.rounds}（编译 ${result.compiles} 次）；修复：${result.fixes.length}；剩余诊断：${errors} 错误 / ${warnings} 警告`
          : `原始编译；诊断：${errors} 错误 / ${warnings} 警告`,
        ...result.fixes.map((fix) => `修复 [${fix.rule}] ${fix.file}：${fix.message}`),
        ...(diagnostics.length > 0
          ? ['诊断：', ...diagnostics.slice(0, 20).map((diagnostic) => `  - ${formatDiagnostic(diagnostic)}`)]
          : []),
        ...(result.notes?.length ? ['备注：', ...result.notes.slice(0, 10).map((note) => `  - ${note}`)] : []),
        `输出：${outputPath || '(无)'}`,
        ...(result.timedOut ? ['警告：编译超时被终止'] : []),
      ];
      const summary = lines.join('\n');
      const value = {
        ok: Boolean(result.ok),
        input: displayPath(cwd, inputAbs),
        projectDir: displayPath(cwd, projectDir),
        outputPath,
        rounds: result.rounds,
        compiles: result.compiles,
        fixes: result.fixes,
        diagnostics,
        notes: result.notes ?? [],
        stderr: String(result.stderr ?? '').slice(-4000),
        binaryPath: cfg.binaryPath ?? '',
      };
      return { value, summary };
    },
    render(_args, value) {
      return toolRender(value);
    },
  };
}

/**
 * Register all tools for this plugin instance.
 * @param {any} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const cfg = settings(config);
  const templates = listTemplates();
  const register = (tool) => {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: tool.output.schema,
        render: tool.render,
      },
      ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
      async execute(args, exec) {
        const { value, summary } = await tool.execute(args, exec);
        const enriched = { ...value, __summary: summary };
        return enriched;
      },
    });
  };

  register(buildTool(cfg));
  register(exportTool(cfg));
  register(probeTool(cfg, templates));
  if (cfg.advancedTools) {
    register(compileRawTool(cfg));
    register(cleanTool(cfg));
  }
}

/**
 * @param {{ binaryPath?: string, fontPaths: string[], maxHealRounds: number, timeoutMs: number }} cfg
 */
function exportTool(cfg) {
  return {
    name: 'typst_export',
    description:
      '把 Typst 文档导出为多页 SVG 或 PNG（每页一个文件）。自动使用 page-{0p} 页码模板（多页必需），可指定 pages 范围与 PNG 分辨率，输出到 outDir。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Typst 源文件路径（.typ），相对会话工作目录' },
        format: { type: 'string', enum: ['svg', 'png'], description: '导出格式' },
        outDir: { type: 'string', description: '输出目录（默认 <项目>/typst-export）' },
        pages: { type: 'string', description: '页码范围，如 "1,3-5"；省略表示全部页' },
        ppi: { type: 'integer', description: 'PNG 分辨率（ppi），仅 format=png 时生效' },
        root: { type: 'string', description: '项目根目录（默认 input 所在目录）' },
        fontPaths: { type: 'array', items: { type: 'string' }, description: '额外字体目录' },
        timeoutMs: { type: 'integer', description: '超时毫秒' },
      },
      required: ['input', 'format'],
      additionalProperties: false,
    },
    output: { schema: EXPORT_OUTPUT_SCHEMA },
    timeoutMs: MAX_TIMEOUT_MS,
    async execute(args = {}, exec) {
      const cwd = sessionCwd(exec);
      const inputArg = requireString(args, 'input');
      const inputAbs = path.resolve(cwd, inputArg);
      if (!fs.existsSync(inputAbs)) throw new Error(`input file not found: ${inputAbs}`);
      const format = requireString(args, 'format');
      if (format !== 'svg' && format !== 'png') throw new Error('invalid arguments: "format" must be "svg" or "png"');
      const projectDir = args.root ? resolveProjectDir(requireString(args, 'root'), cwd) : path.dirname(inputAbs);
      const outDir = args.outDir ? path.resolve(cwd, requireString(args, 'outDir')) : path.join(projectDir, 'typst-export');
      const fontPaths = resolveFontPaths(cfg, args, cwd);
      const ppi = optionalPpi(args);
      const timeoutMs = optionalInteger(args, 'timeoutMs', cfg.timeoutMs, MAX_TIMEOUT_MS);
      const result = await exportPages({
        input: inputAbs,
        format,
        outDir,
        pages: optionalString(args, 'pages'),
        ppi,
        root: projectDir,
        fontPaths,
        timeoutMs,
        binaryPath: cfg.binaryPath,
      });
      const { errors, warnings } = countDiagnostics(result.diagnostics);
      const lines = [
        `${result.ok ? '导出成功' : '导出失败'}：${format.toUpperCase()}，${result.files.length} 个文件`,
        `输出目录：${displayPath(cwd, outDir)}`,
        ...result.files.slice(0, 50).map((file) => `  - ${displayPath(cwd, file)}`),
        ...(errors + warnings > 0
          ? ['诊断：', ...result.diagnostics.slice(0, 10).map((diagnostic) => `  - ${formatDiagnostic(diagnostic)}`)]
          : []),
      ];
      return {
        value: {
          ok: result.ok,
          format,
          input: displayPath(cwd, inputAbs),
          outDir: displayPath(cwd, outDir),
          files: result.files.map((file) => displayPath(cwd, file)),
          exitCode: result.exitCode,
          diagnostics: result.diagnostics,
          stderr: String(result.stderr ?? '').slice(-4000),
          __summary: lines.join('\n'),
        },
        summary: lines.join('\n'),
      };
    },
    render(_args, value) {
      return toolRender(value);
    },
  };
}

/**
 * @param {{ binaryPath?: string, fontPaths: string[], advancedTools: boolean }} cfg
 * @param {string[]} templates
 */
function probeTool(cfg, templates) {
  return {
    name: 'typst_probe',
    description:
      '探测 Typst 环境：可执行文件路径/版本/探测来源、CJK 字体族、包缓存目录、可用模板列表。二进制不可用时返回 ok=false 与已尝试位置及 winget 安装命令。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: PROBE_OUTPUT_SCHEMA },
    timeoutMs: 60_000,
    async execute(_args = {}, exec) {
      const cwd = sessionCwd(exec);
      try {
        const info = await probe({ binaryPath: cfg.binaryPath, fontPaths: cfg.fontPaths });
        const cjk = info.fonts.cjkFamilies;
        const lines = [
          `Typst ${info.version}（${info.source}）：${info.binary}`,
          `字体：共 ${info.fonts.total} 个字体族，其中 CJK 候选 ${cjk.length} 个：${cjk.slice(0, 12).join('、') || '(无)'}`,
          `模板：${templates.join(', ') || '(无)'}`,
          `包缓存：${info.packageCache ?? '(未初始化)'}`,
        ];
        return {
          value: {
            ok: true,
            binary: info.binary,
            version: info.version,
            source: info.source,
            fonts: info.fonts,
            packageCache: info.packageCache ?? '',
            templates,
            advancedTools: cfg.advancedTools,
            config: { binaryPath: cfg.binaryPath ?? '', fontPaths: cfg.fontPaths },
            __summary: lines.join('\n'),
          },
          summary: lines.join('\n'),
        };
      } catch (error) {
        const message = errorMessage(error);
        return {
          value: {
            ok: false,
            templates,
            advancedTools: cfg.advancedTools,
            config: { binaryPath: cfg.binaryPath ?? '', fontPaths: cfg.fontPaths },
            error: message,
            hint: '安装 Typst：winget install --id Typst.Typst -e；或把 typst.exe 绝对路径写入插件配置 binaryPath / 环境变量 TYPST_BIN。',
            __summary: `Typst 不可用：${message.split('\n')[0]}\n模板：${templates.join(', ') || '(无)'}`,
          },
          summary: `Typst 不可用：${message.split('\n')[0]}`,
        };
      }
    },
    render(_args, value) {
      return toolRender(value);
    },
  };
}

/**
 * @param {{ binaryPath?: string, fontPaths: string[], timeoutMs: number }} cfg
 */
function compileRawTool(cfg) {
  return {
    name: 'typst_compile_raw',
    description:
      '高级：直接调用 Typst 编译/导出，不做任何自愈（适合排查模板本身的问题）。format=pdf 时走 compile，format=svg/png 时走多页导出。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Typst 源文件路径（.typ）' },
        format: { type: 'string', enum: ['pdf', 'svg', 'png'], description: '产物格式，默认 pdf' },
        root: { type: 'string', description: '项目根目录' },
        output: { type: 'string', description: 'PDF 输出路径（format=pdf）' },
        outDir: { type: 'string', description: '图片输出目录（format=svg/png）' },
        pages: { type: 'string', description: '页码范围，如 "1,3-5"' },
        ppi: { type: 'integer', description: 'PNG 分辨率' },
        fontPaths: { type: 'array', items: { type: 'string' }, description: '额外字体目录' },
        timeoutMs: { type: 'integer', description: '超时毫秒' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: { schema: BUILD_OUTPUT_SCHEMA },
    timeoutMs: MAX_TIMEOUT_MS,
    async execute(args = {}, exec) {
      const cwd = sessionCwd(exec);
      const inputArg = requireString(args, 'input');
      const inputAbs = path.resolve(cwd, inputArg);
      if (!fs.existsSync(inputAbs)) throw new Error(`input file not found: ${inputAbs}`);
      const format = optionalString(args, 'format') ?? 'pdf';
      if (!['pdf', 'svg', 'png'].includes(format)) throw new Error('invalid arguments: "format" must be pdf, svg or png');
      const projectDir = args.root ? resolveProjectDir(requireString(args, 'root'), cwd) : path.dirname(inputAbs);
      const fontPaths = resolveFontPaths(cfg, args, cwd);
      const timeoutMs = optionalInteger(args, 'timeoutMs', cfg.timeoutMs, MAX_TIMEOUT_MS);
      if (format === 'pdf') {
        const outputAbs = optionalString(args, 'output') ? path.resolve(cwd, optionalString(args, 'output')) : undefined;
        const raw = await compile({ input: inputAbs, output: outputAbs, root: projectDir, fontPaths, timeoutMs, binaryPath: cfg.binaryPath });
        const { errors, warnings } = countDiagnostics(raw.diagnostics);
        const summary = [
          `${raw.ok ? '编译成功' : '编译失败'}（raw）：${displayPath(cwd, inputAbs)}`,
          `诊断：${errors} 错误 / ${warnings} 警告`,
          ...raw.diagnostics.slice(0, 20).map((diagnostic) => `  - ${formatDiagnostic(diagnostic)}`),
          `输出：${raw.outputPath}`,
        ].join('\n');
        return {
          value: {
            ok: raw.ok,
            input: displayPath(cwd, inputAbs),
            projectDir: displayPath(cwd, projectDir),
            outputPath: raw.outputPath,
            rounds: 0,
            compiles: 1,
            fixes: [],
            diagnostics: raw.diagnostics,
            notes: ['raw compile (no healing)'],
            stderr: String(raw.stderr ?? '').slice(-4000),
            binaryPath: cfg.binaryPath ?? '',
            __summary: summary,
          },
          summary,
        };
      }
      const outDir = args.outDir ? path.resolve(cwd, requireString(args, 'outDir')) : path.join(projectDir, 'typst-export');
      const raw = await exportPages({
        input: inputAbs,
        format,
        outDir,
        pages: optionalString(args, 'pages'),
        ppi: optionalPpi(args),
        root: projectDir,
        fontPaths,
        timeoutMs,
        binaryPath: cfg.binaryPath,
      });
      const { errors, warnings } = countDiagnostics(raw.diagnostics);
      const summary = [
        `${raw.ok ? '导出成功' : '导出失败'}（raw）：${format.toUpperCase()}，${raw.files.length} 个文件`,
        `诊断：${errors} 错误 / ${warnings} 警告`,
        `输出目录：${displayPath(cwd, outDir)}`,
      ].join('\n');
      return {
        value: {
          ok: raw.ok,
          input: displayPath(cwd, inputAbs),
          projectDir: displayPath(cwd, projectDir),
          outputPath: raw.files[0] ?? '',
          rounds: 0,
          compiles: 1,
          fixes: [],
          diagnostics: raw.diagnostics,
          notes: raw.files.map((file) => displayPath(cwd, file)),
          stderr: String(raw.stderr ?? '').slice(-4000),
          binaryPath: cfg.binaryPath ?? '',
          __summary: summary,
        },
        summary,
      };
    },
    render(_args, value) {
      return toolRender(value);
    },
  };
}

/**
 * @param {{}} _cfg
 */
function cleanTool(_cfg) {
  return {
    name: 'typst_clean',
    description:
      '高级：清理项目的 .inkstone/backups 备份目录与显式指定的导出目录（只允许项目目录内部）。用于回收磁盘空间；源文件不会被删除。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '项目根目录（默认会话工作目录）' },
        exportDirs: { type: 'array', items: { type: 'string' }, description: '要删除的导出目录（必须位于项目根目录内）' },
        backups: { type: 'boolean', description: '是否删除 .inkstone/backups，默认 true' },
      },
      additionalProperties: false,
    },
    output: { schema: CLEAN_OUTPUT_SCHEMA },
    async execute(args = {}, exec) {
      const cwd = sessionCwd(exec);
      const projectDir = args.root ? resolveProjectDir(requireString(args, 'root'), cwd) : path.resolve(cwd);
      if (!fs.existsSync(projectDir)) throw new Error(`project root not found: ${projectDir}`);
      const removed = [];
      const skipped = [];

      // Validate every export directory first so a rejected call has no side
      // effects (the backups deletion below must not run on invalid input).
      const dirs = Array.isArray(args.exportDirs) ? args.exportDirs : [];
      const exportTargets = [];
      for (const entry of dirs) {
        if (typeof entry !== 'string' || entry.trim().length === 0) continue;
        const target = path.resolve(cwd, entry.trim());
        if (!isInside(target, projectDir) || target === projectDir) {
          throw new Error(`refusing to delete "${target}": it is not inside the project root ${projectDir}`);
        }
        exportTargets.push(target);
      }

      if (args.backups !== false) {
        const target = backupsRoot(projectDir);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          removed.push(displayPath(cwd, target));
        } else {
          skipped.push('.inkstone/backups (不存在)');
        }
      }
      for (const target of exportTargets) {
        if (!fs.existsSync(target)) {
          skipped.push(`${displayPath(cwd, target)} (不存在)`);
          continue;
        }
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(displayPath(cwd, target));
      }
      const summary = [
        `清理完成：删除 ${removed.length} 项`,
        ...removed.map((item) => `  - ${item}`),
        ...skipped.map((item) => `  - 跳过 ${item}`),
      ].join('\n');
      return {
        value: { ok: true, projectDir: displayPath(cwd, projectDir), removed, skipped, __summary: summary },
        summary,
      };
    },
    render(_args, value) {
      return toolRender(value);
    },
  };
}
