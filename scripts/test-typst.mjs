#!/usr/bin/env node
/**
 * dsh-inkstone · typst-brush 集成测试（真实 Typst 0.15+）。
 *
 * 覆盖：
 *   - 二进制探测（config / PATH / WinGet Packages 通配 / 失败提示）
 *   - 中文 PDF 编译、真实诊断解析（human + short）
 *   - SVG / PNG 多页导出（页码模板、--pages、ppi）
 *   - 5 条自愈规则（unknown-font / missing-bib-key / missing-file / missing-bib /
 *     missing-include）+ 备份 + 无进展停止
 *   - 4 个模板脚手架与真实编译（slides 16:9、poster 竖版）
 *   - 插件工具注册（假 ctx）与 schema 校验、typst_clean 安全边界
 *
 * 运行：node scripts/test-typst.mjs
 * 退出码：0 通过；1 失败。
 * 临时产物写入 fixtures/typst/_tmp/，测试结束自动清理；设置 KEEP_TMP=1 可保留现场。
 *
 * 不依赖任何第三方包，仅 node: 内置模块与包内相对导入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectTypstBinary,
  runTypst,
  parseDiagnostics,
  compile,
  exportPages,
  probe,
  WINGET_INSTALL_COMMAND,
} from '../lib/typst-runner.mjs';
import { backupFile, healCompile, healRound } from '../lib/heal.mjs';
import { listTemplates, scaffoldProject } from '../lib/typst-scaffold.mjs';
import { apply as applyTypstBrush } from '../plugins/typst-brush/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'typst');
const TMP = path.join(FIXTURES, '_tmp');
const KEEP_TMP = process.env.KEEP_TMP === '1';

const stats = { passed: 0, failed: 0, skipped: 0, failures: [] };

/* ------------------------------------------------------------------ *
 * Tiny test harness
 * ------------------------------------------------------------------ */

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

async function test(name, fn) {
  try {
    await fn();
    stats.passed += 1;
    log(`✓ ${name}`);
  } catch (error) {
    stats.failed += 1;
    stats.failures.push({ name, error });
    log(`✗ ${name}`);
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    log(
      String(detail)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );
  }
}

function skip(name, reason) {
  stats.skipped += 1;
  log(`- SKIP ${name} (${reason})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'assertEqual failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatch(value, pattern, message) {
  if (!pattern.test(String(value))) {
    throw new Error(`${message ?? 'assertMatch failed'}: ${JSON.stringify(String(value))} does not match ${pattern}`);
  }
}

async function assertRejects(fn, pattern, message) {
  try {
    await fn();
  } catch (error) {
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      throw new Error(`${message ?? 'rejection message mismatch'}: ${error?.message ?? error}`);
    }
    return error;
  }
  throw new Error(`${message ?? 'expected the call to throw, but it resolved'}`);
}

/* ------------------------------------------------------------------ *
 * Paths / fixtures helpers
 * ------------------------------------------------------------------ */

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function copyFixture(name, destination) {
  const source = path.join(FIXTURES, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
  return destination;
}

function fixtureProject(name, destination) {
  copyFixture(name, destination);
  return destination;
}

function magic(buffer, length = 5) {
  return Buffer.from(buffer).subarray(0, length).toString('binary');
}

function exists(file) {
  return fs.existsSync(file);
}

/**
 * 删除目录；Windows 上刚被终止的 typst 进程/杀毒扫描可能短暂持有句柄，
 * 因此使用 Node 自带的重试参数，保证连续运行测试时不会残留 _tmp。
 * @param {string} dir
 */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function listBackups(projectDir) {
  const root = path.join(projectDir, '.inkstone', 'backups');
  if (!exists(root)) return [];
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const files = [];
  for (const dir of dirs) {
    const fullDir = path.join(root, dir.name);
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(fullDir);
  }
  return files;
}

/**
 * 极小的 JSON Schema 校验器（与 harness 支持子集一致：type/properties/required/
 * additionalProperties/items/enum/oneOf）。仅测试用。
 */
function validateSchema(value, schema, at = '$') {
  if (!schema) return;
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`schema ${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateSchema(value, candidate, at);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw new Error(`schema ${at}: oneOf matched ${matches.length} branches`);
    return;
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`schema ${at}: expected object, got ${typeof value}`);
      }
      const properties = schema.properties ?? {};
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) throw new Error(`schema ${at}: unexpected property "${key}"`);
        }
      }
      for (const key of schema.required ?? []) {
        if (!(key in value) || value[key] === undefined) throw new Error(`schema ${at}: missing required property "${key}"`);
      }
      for (const [key, childSchema] of Object.entries(properties)) {
        if (value[key] !== undefined) validateSchema(value[key], childSchema, `${at}.${key}`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`schema ${at}: expected array`);
      if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${at}[${index}]`));
      return;
    }
    case 'string':
      if (typeof value !== 'string') throw new Error(`schema ${at}: expected string, got ${typeof value}`);
      return;
    case 'integer':
      if (!Number.isInteger(value)) throw new Error(`schema ${at}: expected integer, got ${JSON.stringify(value)}`);
      return;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`schema ${at}: expected number`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`schema ${at}: expected boolean`);
      return;
    case undefined:
      return;
    default:
      throw new Error(`schema ${at}: unsupported type "${schema.type}"`);
  }
}

const EXEC = Object.freeze({ agent: { session: { header: { cwd: ROOT } } } });

function fakeCtx() {
  const registered = new Map();
  return {
    registered,
    ctx: {
      tools: {
        register(definition) {
          if (registered.has(definition.name)) throw new Error(`tool "${definition.name}" registered twice`);
          registered.set(definition.name, definition);
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Test cases
 * ------------------------------------------------------------------ */

async function main() {
  log('dsh-inkstone · typst-brush 集成测试');
  log(`仓库：${ROOT}`);
  log('');

  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fs.mkdirSync(TMP, { recursive: true });

  const detected = detectTypstBinary();
  log(`Typst：${detected.version}（${detected.source}）${detected.path}`);
  log('');

  /* ---------------- 探测器 ---------------- */

  await test('detect: 找到 typst 并解析版本/来源', () => {
    assert(exists(detected.path), `detectTypstBinary 返回的路径不存在：${detected.path}`);
    assertMatch(detected.version, /^\d+\.\d+\.\d+/, '版本号格式');
    assert(
      ['config', 'path', 'winget-link', 'winget-package', 'cargo', 'scoop'].includes(detected.source),
      `未知 source：${detected.source}`,
    );
  });

  await test('detect: config.binaryPath 显式路径优先', () => {
    const info = detectTypstBinary({ binaryPath: detected.path });
    assertEqual(info.source, 'config', 'source');
    assertEqual(info.path, path.resolve(detected.path), 'path');
    assertEqual(info.version, detected.version, 'version');
  });

  await test('detect: PATH 探测', () => {
    const env = { ...process.env, TYPST_BIN: '', PATH: `${path.dirname(detected.path)}${path.delimiter}${process.env.PATH ?? ''}` };
    const info = detectTypstBinary({ env });
    assertEqual(info.source, 'path', 'source');
    assertEqual(path.resolve(info.path), path.resolve(detected.path), 'path');
  });

  if (process.platform === 'win32') {
    await test('detect: WinGet Links/Packages 探测（PATH 为空时）', () => {
      const emptyHome = path.join(TMP, 'winget-empty-home');
      fs.mkdirSync(emptyHome, { recursive: true });
      const env = {
        ...process.env,
        PATH: '',
        PATHEXT: process.env.PATHEXT ?? '.EXE;.CMD;.BAT',
        TYPST_BIN: '',
        USERPROFILE: emptyHome,
        APPDATA: path.join(emptyHome, 'AppData'),
        LOCALAPPDATA: process.env.LOCALAPPDATA,
      };
      const info = detectTypstBinary({ env });
      assert(['winget-link', 'winget-package'].includes(info.source), `source 应为 winget-*，实际 ${info.source}`);
      assertMatch(info.path, /WinGet/i, '路径应位于 WinGet 目录');
      assert(exists(info.path), '探测到的路径不存在');
    });
  } else {
    skip('detect: WinGet Links/Packages 探测（PATH 为空时）', '非 Windows 平台');
  }

  await test('detect: 都找不到时报错并列出位置与 winget 命令', async () => {
    const emptyHome = path.join(TMP, 'empty-home');
    const emptyLocal = path.join(TMP, 'empty-local');
    fs.mkdirSync(emptyHome, { recursive: true });
    fs.mkdirSync(emptyLocal, { recursive: true });
    const env = {
      PATH: '',
      PATHEXT: '.EXE;.CMD;.BAT',
      TYPST_BIN: '',
      USERPROFILE: emptyHome,
      LOCALAPPDATA: emptyLocal,
      APPDATA: path.join(emptyHome, 'AppData'),
    };
    const error = await assertRejects(() => detectTypstBinary({ env }), /winget install --id Typst\.Typst -e/i, '缺少安装命令');
    assertMatch(error.message, /Attempted locations/i, '缺少已尝试位置列表');
    assertMatch(error.message, /PATH/i, '缺少 PATH 说明');
    assertMatch(error.message, /winget-package|WinGet/i, '缺少 WinGet 说明');
    assertMatch(error.message, /binaryPath|TYPST_BIN/i, '缺少配置提示');
    assert(error.message.includes(WINGET_INSTALL_COMMAND), '错误信息应包含 WINGET_INSTALL_COMMAND 常量');
  });

  /* ---------------- 诊断解析 ---------------- */

  await test('parseDiagnostics: human 格式（error + warning + 包含上下文）', () => {
    const raw = read(path.join(FIXTURES, 'diagnostics-human.txt'));
    const diagnostics = parseDiagnostics(raw);
    assertEqual(diagnostics.length, 2, '诊断数量');
    const [error, warning] = diagnostics;
    assertEqual(error.severity, 'error', 'severity');
    assertMatch(error.message, /file not found/, 'message');
    assertEqual(error.line, 3, 'line');
    assertEqual(error.column, 7, 'column');
    assert(!error.file.startsWith('\\\\?\\'), `file 应去掉 verbatim 前缀，实际 ${error.file}`);
    assertMatch(error.file, /main\.typ$/, 'file');
    assertMatch(error.raw, /while including/, 'raw 应包含包含链上下文');
    assertEqual(warning.severity, 'warning', 'warning severity');
    assertMatch(warning.message, /unknown font family: nofontc/, 'warning message');
    assertEqual(warning.line, 1, 'warning line');
    assertEqual(warning.column, 16, 'warning column');
  });

  await test('parseDiagnostics: short 格式', () => {
    const raw = read(path.join(FIXTURES, 'diagnostics-short.txt'));
    const diagnostics = parseDiagnostics(raw);
    assertEqual(diagnostics.length, 2, '诊断数量');
    assertEqual(diagnostics[0].severity, 'error', 'severity 0');
    assertEqual(diagnostics[0].line, 2, 'line 0');
    assertEqual(diagnostics[0].column, 7, 'column 0');
    assertMatch(diagnostics[0].file, /main\.typ$/, 'file 0');
    assertEqual(diagnostics[1].severity, 'warning', 'severity 1');
    assertMatch(diagnostics[1].message, /unknown font family/, 'message 1');
  });

  await test('parseDiagnostics: 空输入/普通输出返回空数组', () => {
    assertEqual(parseDiagnostics('').length, 0, '空字符串');
    assertEqual(parseDiagnostics('compiled 1 page\n').length, 0, '普通输出');
  });

  await test('parseDiagnostics: 真实 typst 错误输出', async () => {
    const project = path.join(TMP, 'diag-real');
    fs.mkdirSync(project, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'bad-variable.typ'), path.join(project, 'bad-variable.typ'));
    const result = await compile({ input: path.join(project, 'bad-variable.typ') });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.exitCode, 1, 'exitCode');
    assert(result.diagnostics.length >= 1, '应有诊断');
    const diagnostic = result.diagnostics[0];
    assertEqual(diagnostic.severity, 'error', 'severity');
    assertMatch(diagnostic.message, /unknown variable: undefinedThing/, 'message');
    assertMatch(diagnostic.file, /bad-variable\.typ$/, 'file');
    assertEqual(diagnostic.line, 5, 'line');
    assertEqual(diagnostic.column, 1, 'column');
  });

  /* ---------------- 编译与导出 ---------------- */

  await test('runTypst: --version', async () => {
    const result = await runTypst(['--version']);
    assertEqual(result.exitCode, 0, 'exitCode');
    assertEqual(result.timedOut, false, 'timedOut');
    assertMatch(result.stdout, /typst\s+\d+\.\d+\.\d+/, 'stdout');
    assert(result.durationMs >= 0, 'durationMs');
  });

  await test('runTypst: 超时终止（watch）', async () => {
    const project = path.join(TMP, 'watch-timeout');
    fs.mkdirSync(project, { recursive: true });
    const input = path.join(project, 'main.typ');
    write(input, '#set text(font: ("Microsoft YaHei", "SimSun"))\n= 超时测试\n');
    const result = await runTypst(['watch', input, '--root', project], { timeoutMs: 1200 });
    assertEqual(result.timedOut, true, 'timedOut');
  });

  await test('compile: 中文 PDF + PNG 图片', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'chinese'));
    const result = await compile({ input: path.join(project, 'main.typ') });
    assertEqual(result.ok, true, `编译应成功，诊断：${JSON.stringify(result.diagnostics)}`);
    assertEqual(result.exitCode, 0, 'exitCode');
    assertEqual(result.diagnostics.length, 0, 'diagnostics');
    assert(result.outputPath.endsWith('.pdf'), `outputPath：${result.outputPath}`);
    assert(exists(result.outputPath), 'PDF 未生成');
    const head = fs.readFileSync(result.outputPath).subarray(0, 5).toString('utf8');
    assertEqual(head, '%PDF-', 'PDF magic');
    assert(fs.statSync(result.outputPath).size > 1000, 'PDF 过小');
  });

  await test('compile: 自定义 output 路径与 root', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'chinese-output'));
    const result = await compile({
      input: path.join(project, 'main.typ'),
      output: 'build/out.pdf',
      root: project,
    });
    assertEqual(result.ok, true, 'ok');
    assertEqual(result.outputPath, path.join(project, 'build', 'out.pdf'), 'outputPath');
    assert(exists(result.outputPath), '自定义输出不存在');
  });

  await test('compile: 输入不存在时报可操作错误', async () => {
    await assertRejects(
      () => compile({ input: path.join(TMP, 'no-such-project', 'main.typ') }),
      /input file not found/i,
      '缺失输入',
    );
  });

  await test('exportPages: SVG 多页 + 自动页码模板', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'multipage-svg'));
    const outDir = path.join(project, 'svg-out');
    const result = await exportPages({ input: path.join(project, 'multipage.typ'), format: 'svg', outDir });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.diagnostics)}`);
    assertEqual(result.files.length, 3, '页数');
    result.files.forEach((file, index) => {
      assertEqual(path.basename(file), `page-${index + 1}.svg`, `第 ${index + 1} 个文件名`);
      assert(read(file).includes('<svg'), `${file} 不是 SVG`);
    });
  });

  await test('exportPages: PNG 指定页码 + ppi', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'multipage-png'));
    const outDir = path.join(project, 'png-out');
    const result = await exportPages({
      input: path.join(project, 'multipage.typ'),
      format: 'png',
      outDir,
      pages: '2-3',
      ppi: 96,
    });
    assertEqual(result.ok, true, 'ok');
    assertEqual(result.files.length, 2, '页数');
    assertEqual(path.basename(result.files[0]), 'page-2.png', '第一页文件名');
    assertEqual(path.basename(result.files[1]), 'page-3.png', '第二页文件名');
    for (const file of result.files) {
      const buffer = fs.readFileSync(file);
      assertEqual(buffer.subarray(1, 4).toString('ascii'), 'PNG', `${file} 不是 PNG`);
      assert(buffer.length > 100, `${file} 过小`);
    }
  });

  await test('exportPages: 参数校验', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'multipage-bad'));
    await assertRejects(
      () => exportPages({ input: path.join(project, 'main.typ'), format: 'pdf' }),
      /format.*svg.*png|must be "svg"/i,
      '非法 format',
    );
    await assertRejects(
      () => exportPages({ input: path.join(project, 'multipage.typ'), format: 'svg', outDir: path.join(project, 'x'), pages: 'a-b' }),
      /invalid "pages"/i,
      '非法 pages',
    );
  });

  /* ---------------- 自愈规则 ---------------- */

  await test('heal: unknown-font（宋体 → Microsoft YaHei，含备份）', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'heal-font'));
    const input = path.join(project, 'main.typ');
    const result = await healCompile({ projectDir: project, input });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.finalDiagnostics)}`);
    assert(result.rounds >= 1, `rounds=${result.rounds}`);
    assertEqual(result.fixes.length, 1, '修复数量');
    assertEqual(result.fixes[0].rule, 'unknown-font', '规则');
    assertMatch(result.fixes[0].message, /Microsoft YaHei/, '修复说明');
    const content = read(input);
    assertMatch(content, /font:\s*"Microsoft YaHei"/, '应替换字体族');
    assert(!content.includes('font: "宋体"'), '旧的字体赋值应消失');
    const backups = listBackups(project);
    assert(backups.length >= 1, '应产生备份');
    assert(read(backups[0]).includes('宋体'), '备份应保留修复前内容');
    assertEqual(result.finalDiagnostics.length, 0, '最终诊断');
  });

  await test('heal: missing-bib-key（编辑距离 ≤2 唯一匹配）', async () => {
    const project = fixtureProject('bad-cite', path.join(TMP, 'heal-cite'));
    const input = path.join(project, 'main.typ');
    const result = await healCompile({ projectDir: project, input, bibFiles: ['refs.bib'] });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.finalDiagnostics)}`);
    assertEqual(result.fixes.length, 1, '修复数量');
    assertEqual(result.fixes[0].rule, 'missing-bib-key', '规则');
    assertMatch(result.fixes[0].message, /@zhang2023types -> @zhang2023typst/, '修复说明');
    const content = read(input);
    assert(!content.includes('@zhang2023types'), '旧引用键应消失');
    assert(content.includes('@zhang2023typst'), '应替换为正确引用键');
  });

  await test('heal: missing-file（图片路径按 basename 唯一改写）', async () => {
    const project = fixtureProject('bad-image', path.join(TMP, 'heal-image'));
    const input = path.join(project, 'main.typ');
    const result = await healCompile({ projectDir: project, input });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.finalDiagnostics)}`);
    assertEqual(result.fixes.length, 1, '修复数量');
    assertEqual(result.fixes[0].rule, 'missing-file', '规则');
    const content = read(input);
    assert(content.includes('image("assets/diagram.svg"'), `应改写为相对路径，实际：${content}`);
    assert(!content.includes('image("images/diagram.svg"'), '旧的图片引用路径应消失');
  });

  await test('heal: missing-bib（优先配置的 bib 文件）', async () => {
    const project = fixtureProject('bad-bib', path.join(TMP, 'heal-bib'));
    const input = path.join(project, 'main.typ');
    const result = await healCompile({ projectDir: project, input, bibFiles: ['refs.bib'] });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.finalDiagnostics)}`);
    assertEqual(result.fixes.length, 1, '修复数量');
    assertEqual(result.fixes[0].rule, 'missing-bib', '规则');
    const content = read(input);
    assert(content.includes('bibliography("refs.bib"'), `应改写 bib 路径，实际：${content}`);
  });

  await test('heal: missing-include（唯一 basename 改写）', async () => {
    const project = fixtureProject('bad-include', path.join(TMP, 'heal-include'));
    const input = path.join(project, 'main.typ');
    const result = await healCompile({ projectDir: project, input });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.finalDiagnostics)}`);
    assertEqual(result.fixes.length, 1, '修复数量');
    assertEqual(result.fixes[0].rule, 'missing-include', '规则');
    assert(read(input).includes('include "sections/intro.typ"'), '应改写 include 路径');
  });

  await test('heal: 兼容 pipeline 顶层 fontFallbacks/backupRoot 参数', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'heal-pipeline'));
    const input = path.join(project, 'main.typ');
    const backupRoot = path.join(project, '.inkstone', 'backups');
    const result = await healCompile({
      projectDir: project,
      input,
      // 与 lib/pipeline-steps.mjs 的 typst.build 调用形状保持一致。
      compileOptions: { input, output: path.join(project, 'main.pdf'), root: project, ppi: 144, fontPaths: [] },
      maxRounds: 3,
      bibFiles: [],
      fontFallbacks: { 宋体: 'SimSun' },
      backupRoot,
    });
    assertEqual(result.ok, true, `ok，诊断：${JSON.stringify(result.finalDiagnostics)}`);
    assertMatch(read(input), /font: "SimSun"/, '顶层 fontFallbacks 应覆盖默认映射');
    assert(listBackups(project).length >= 1, '自定义 backupRoot 应产生备份');
    assert(exists(path.join(project, 'main.pdf')), 'compileOptions.output 应生效');
  });

  await test('heal: 项目目录外的 backupRoot 被拒绝', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'heal-bad-backup'));
    const input = path.join(project, 'main.typ');
    await assertRejects(
      () => healCompile({ projectDir: project, input, backupRoot: path.join(TMP, 'outside-backups') }),
      /backup root must be inside the project/i,
      '越界 backupRoot',
    );
    assertMatch(read(input), /font: "宋体"/, '拒绝后不应修改文件');
  });

  await test('heal: 不可自愈错误保持原样并返回结构化诊断', async () => {
    const project = path.join(TMP, 'heal-noop');
    fs.mkdirSync(project, { recursive: true });
    const input = path.join(project, 'bad-variable.typ');
    fs.copyFileSync(path.join(FIXTURES, 'bad-variable.typ'), input);
    const before = read(input);
    const result = await healCompile({ projectDir: project, input });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.rounds, 0, 'rounds');
    assertEqual(result.fixes.length, 0, 'fixes');
    assert(result.finalDiagnostics.length >= 1, '应有最终诊断');
    assertMatch(result.finalDiagnostics[0].message, /unknown variable/, '诊断信息');
    assertEqual(read(input), before, '文件不应被修改');
    assertEqual(listBackups(project).length, 0, '无修复不应产生备份');
  });

  await test('heal: healRound 对无 fallback 的未知字体仅给出 notes', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'heal-notes'));
    const input = path.join(project, 'main.typ');
    const round = healRound({
      projectDir: project,
      input,
      diagnostics: [
        { severity: 'warning', message: 'unknown font family: nosuchfamily', file: input, line: 1, column: 1 },
      ],
      options: { fontFallbacks: {} },
    });
    assertEqual(round.changed, false, 'changed');
    assertEqual(round.applied.length, 0, 'applied');
    assertEqual(round.notes.length, 1, 'notes');
    assertMatch(round.notes[0], /no fallback configured/, 'notes 内容');
  });

  await test('heal: healCompile 缺少输入时报错', async () => {
    await assertRejects(
      () => healCompile({ projectDir: path.join(TMP, 'nothing'), input: 'main.typ' }),
      /input file not found/i,
      '缺失输入',
    );
  });

  await test('backupFile: 拒绝项目目录外的文件', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'backup-guard'));
    await assertRejects(
      () => backupFile(project, path.join(FIXTURES, 'bad-variable.typ')),
      /outside the project/i,
      '越界备份',
    );
  });

  /* ---------------- 模板脚手架 ---------------- */

  const templates = listTemplates();

  await test('templates: 四个模板均存在', () => {
    assertEqual(templates.join(','), 'paper-zh,poster-zh,report-zh,slides-zh', '模板列表');
  });

  for (const template of templates) {
    await test(`scaffold+compile: ${template}`, async () => {
      const target = path.join(TMP, 'scaffold', template);
      const title = `中文排版测试：${template}`;
      const authors = ['张三', '李四'];
      const project = scaffoldProject({
        targetDir: target,
        template,
        title,
        authors,
        abstract: '这是用于验证占位符替换与中文编译的摘要。',
        bibPath: 'refs.bib',
        citationStyle: 'gb-7714-2015-numeric',
        metadata: { course: '排版实验' },
      });
      assert(exists(project.mainFile), 'main.typ 未生成');
      assert(exists(project.metadataFile), 'metadata.json 未生成');
      const metadata = JSON.parse(read(project.metadataFile));
      assertEqual(metadata.template, template, 'metadata.template');
      assertEqual(metadata.title, title, 'metadata.title');
      assertEqual(metadata.authors.length, 2, 'metadata.authors');
      assertEqual(metadata.course, '排版实验', 'metadata 自定义字段');
      const content = read(project.mainFile);
      assert(!content.includes('{{title}}'), 'title 占位符未替换');
      assert(!content.includes('{{authors}}'), 'authors 占位符未替换');
      assert(content.includes(title), 'main.typ 应包含标题');
      assert(content.includes('张三、李四'), 'main.typ 应包含作者');
      assert(exists(path.join(target, 'refs.bib')), 'refs.bib 未复制');
      assert(read(path.join(target, 'refs.bib')).includes('@article'), 'refs.bib 内容');
      assert(content.includes('@example2024'), '模板自带 bib 时示例引用应保留');
      const result = await compile({ input: project.mainFile });
      assertEqual(result.ok, true, `模板编译失败：${JSON.stringify(result.diagnostics)}`);
      assert(exists(result.outputPath), 'PDF 未生成');
      assert(fs.statSync(result.outputPath).size > 1000, 'PDF 过小');

      if (template === 'slides-zh' || template === 'poster-zh') {
        const allPages = await exportPages({
          input: project.mainFile,
          format: 'svg',
          outDir: path.join(target, 'svg-all'),
        });
        assertEqual(allPages.ok, true, 'SVG 全量导出失败');
        if (template === 'slides-zh') {
          assert(allPages.files.length >= 6, `slides 至少 6 页（含参考文献），实际 ${allPages.files.length}`);
        } else {
          assertEqual(allPages.files.length, 1, 'poster 应为一页');
        }
        const svgResult = await exportPages({
          input: project.mainFile,
          format: 'svg',
          outDir: path.join(target, 'svg-check'),
          pages: '1',
        });
        assertEqual(svgResult.ok, true, 'SVG 导出失败');
        assertEqual(svgResult.files.length, 1, 'SVG 页数');
        const svg = read(svgResult.files[0]);
        const match = svg.match(/width="([\d.]+)pt"\s+height="([\d.]+)pt"/);
        assert(match, 'SVG 尺寸属性缺失');
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (template === 'slides-zh') {
          const ratio = width / height;
          assert(Math.abs(ratio - 16 / 9) < 0.01, `slides 应为 16:9，实际 ${ratio.toFixed(3)}`);
        } else {
          assert(height > width, 'poster 应为竖版');

          const expected = 42 / 59.4;
          const ratio = width / height;
          assert(Math.abs(ratio - expected) < 0.01, `poster 应为 42×59.4cm 竖版，实际 ${ratio.toFixed(3)}`);
        }
      }
    });
  }

  await test('scaffold: 默认不覆盖已有 main.typ，force 覆盖', async () => {
    const target = path.join(TMP, 'scaffold-force');
    const first = scaffoldProject({ targetDir: target, template: 'paper-zh', title: '第一版标题' });
    const firstContent = read(first.mainFile);
    assert(firstContent.includes('第一版标题'), '首次标题');
    const second = scaffoldProject({ targetDir: target, template: 'paper-zh', title: '第二版标题' });
    assert(second.skipped.includes('main.typ'), 'skipped 应包含 main.typ');
    assertEqual(read(second.mainFile), firstContent, '未 force 时不应覆盖 main.typ');
    const third = scaffoldProject({ targetDir: target, template: 'paper-zh', title: '第三版标题', force: true });
    assert(read(third.mainFile).includes('第三版标题'), 'force 时应覆盖并替换标题');
  });

  await test('scaffold: 占位符中的引号/换行被正确转义并可编译', async () => {
    const target = path.join(TMP, 'scaffold-escape');
    const title = '含 "双引号" 与\\反斜杠的标题';
    const project = scaffoldProject({ targetDir: target, template: 'report-zh', title });
    const content = read(project.mainFile);
    assert(content.includes('\\"双引号\\"'), '双引号应被转义');
    const result = await compile({ input: project.mainFile });
    assertEqual(result.ok, true, `转义后应可编译：${JSON.stringify(result.diagnostics)}`);
  });

  await test('scaffold: 目标已有真实 refs.bib 时移除模板示例引用（pipeline 顺序兼容）', async () => {
    const target = path.join(TMP, 'scaffold-existing-bib');
    fs.mkdirSync(target, { recursive: true });
    // 模拟 paper-delivery：先导出真实文献到 run.dir/refs.bib，再 scaffold。
    write(
      path.join(target, 'refs.bib'),
      '@article{real2025,\n  author = {真实作者},\n  title = {真实文献},\n  journal = {真实期刊},\n  year = {2025},\n}\n',
    );
    const project = scaffoldProject({
      targetDir: target,
      template: 'paper-zh',
      title: '已有参考文献的论文',
      authors: ['张三'],
    });
    assert(project.skipped.includes('refs.bib'), 'refs.bib 应被跳过（已有真实导出）');
    assert(project.notes.some((note) => note.includes('@example2024')), `notes 应说明移除示例引用：${JSON.stringify(project.notes)}`);
    const content = read(project.mainFile);
    assert(!content.includes('@example2024'), '缺少示例键时应移除模板示例引用');
    const result = await compile({ input: project.mainFile });
    assertEqual(result.ok, true, `已有 bib 场景应可编译：${JSON.stringify(result.diagnostics)}`);
  });

  await test('scaffold: 未知模板报错并列出可用模板', async () => {
    await assertRejects(
      () => scaffoldProject({ targetDir: path.join(TMP, 'scaffold-bad'), template: 'no-such-template' }),
      /unknown template.*paper-zh/is,
      '未知模板',
    );
  });

  /* ---------------- 插件工具层 ---------------- */

  await test('plugin: 默认注册 3 个工具且结构完备', () => {
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, {});
    assertEqual([...registered.keys()].sort().join(','), 'typst_build,typst_export,typst_probe', '默认工具集合');
    for (const [name, definition] of registered) {
      assert(typeof definition.execute === 'function', `${name}.execute`);
      assert(definition.parameters?.type === 'object', `${name}.parameters.type`);
      assert(definition.output?.schema?.type === 'object', `${name}.output.schema.type`);
      assert(typeof definition.output?.render === 'function', `${name}.output.render`);
      assertMatch(name, /^typst_/, '工具名前缀');
    }
  });

  await test('plugin: advancedTools 注册 5 个工具', () => {
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, { advancedTools: true });
    assertEqual(
      [...registered.keys()].sort().join(','),
      'typst_build,typst_clean,typst_compile_raw,typst_export,typst_probe',
      '高级工具集合',
    );
  });

  await test('plugin: typst_probe 输出与 schema', async () => {
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, {});
    const tool = registered.get('typst_probe');
    const value = await tool.execute({}, EXEC);
    validateSchema(value, tool.output.schema);
    assertEqual(value.ok, true, 'ok');
    assertEqual(value.version, detected.version, 'version');
    assertEqual(value.templates.length, 4, 'templates');
    assert(value.fonts.total > 0, '字体数量');
    assert(value.fonts.cjkFamilies.length > 0, 'CJK 字体');
    const rendered = tool.output.render({}, value);
    assert(Array.isArray(rendered) && rendered[0].type === 'text', 'render 输出');
    assertMatch(rendered[0].text, /Typst \d+\.\d+\.\d+/, '摘要内容');
  });

  await test('plugin: typst_build 编译脚手架工程', async () => {
    const target = path.join(TMP, 'plugin-build');
    const project = scaffoldProject({
      targetDir: target,
      template: 'paper-zh',
      title: '插件编译测试',
      authors: ['测试作者'],
      abstract: '插件层集成测试摘要。',
    });
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, {});
    const tool = registered.get('typst_build');
    const value = await tool.execute({ input: project.mainFile }, EXEC);
    validateSchema(value, tool.output.schema);
    assertEqual(value.ok, true, `构建失败：${JSON.stringify(value.diagnostics)}`);
    assertEqual(value.rounds, 0, 'rounds');
    assertEqual(value.compiles, 1, 'compiles');
    assert(exists(value.outputPath), 'PDF 未生成');
    const rendered = tool.output.render({}, value);
    assertMatch(rendered[0].text, /编译成功.*自愈轮数/ms, '摘要应包含轮数');
  });

  await test('plugin: typst_build 自愈坏字体并输出修复列表', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'plugin-heal'));
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, {});
    const tool = registered.get('typst_build');
    const value = await tool.execute({ input: path.join(project, 'main.typ') }, EXEC);
    validateSchema(value, tool.output.schema);
    assertEqual(value.ok, true, `构建失败：${JSON.stringify(value.diagnostics)}`);
    assertEqual(value.fixes.length, 1, '修复数量');
    assertEqual(value.fixes[0].rule, 'unknown-font', '规则');
    const rendered = tool.output.render({}, value);
    assertMatch(rendered[0].text, /修复 \[unknown-font\]/, '摘要应列出修复');
  });

  await test('plugin: typst_build 参数错误可操作', async () => {
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, {});
    const tool = registered.get('typst_build');
    await assertRejects(() => tool.execute({}, EXEC), /"input" must be a non-empty string/, '缺少 input');
    await assertRejects(
      () => tool.execute({ input: path.join(TMP, 'missing.typ') }, EXEC),
      /input file not found/i,
      '输入不存在',
    );
  });

  await test('plugin: typst_export 多页导出', async () => {
    const project = fixtureProject('chinese', path.join(TMP, 'plugin-export'));
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, {});
    const tool = registered.get('typst_export');
    const value = await tool.execute(
      { input: path.join(project, 'multipage.typ'), format: 'svg', outDir: path.join(project, 'exports') },
      EXEC,
    );
    validateSchema(value, tool.output.schema);
    assertEqual(value.ok, true, 'ok');
    assertEqual(value.files.length, 3, '文件数');
    value.files.forEach((file) => assert(exists(path.resolve(ROOT, file)), `文件不存在：${file}`));
  });

  await test('plugin: typst_compile_raw 不做自愈', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'plugin-raw'));
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, { advancedTools: true });
    const tool = registered.get('typst_compile_raw');
    const value = await tool.execute({ input: path.join(project, 'main.typ') }, EXEC);
    validateSchema(value, tool.output.schema);
    assertEqual(value.ok, true, 'ok（字体缺失只是警告）');
    assertEqual(value.rounds, 0, 'rounds');
    assertEqual(value.fixes.length, 0, 'fixes');
    assert(value.diagnostics.length >= 1, '应保留 warning 诊断');
    assertMatch(read(path.join(project, 'main.typ')), /font: "宋体"/, 'raw 模式不应修改文件');
  });

  await test('plugin: typst_clean 清理备份与导出目录，且拒绝项目外路径', async () => {
    const project = fixtureProject('bad-font', path.join(TMP, 'plugin-clean'));
    const exportDir = path.join(project, 'typst-export');
    fs.mkdirSync(exportDir, { recursive: true });
    write(path.join(exportDir, 'page-1.svg'), '<svg/>');
    const { ctx, registered } = fakeCtx();
    applyTypstBrush(ctx, { advancedTools: true });
    const build = registered.get('typst_build');
    await build.execute({ input: path.join(project, 'main.typ') }, EXEC); // 产生备份
    assert(listBackups(project).length >= 1, '前置条件：应有备份');
    const tool = registered.get('typst_clean');
    await assertRejects(
      () => tool.execute({ root: project, exportDirs: [path.join(TMP, 'outside-dir')] }, EXEC),
      /refusing to delete/i,
      '拒绝删除项目外目录',
    );
    const value = await tool.execute({ root: project, exportDirs: [exportDir] }, EXEC);
    validateSchema(value, tool.output.schema);
    assertEqual(value.ok, true, 'ok');
    assert(!exists(path.join(project, '.inkstone', 'backups')), '备份目录应被删除');
    assert(!exists(exportDir), '导出目录应被删除');
    assertEqual(value.removed.length, 2, `removed：${JSON.stringify(value.removed)}`);
  });

  /* ---------------- 汇总 ---------------- */

  log('');
  log(`通过 ${stats.passed}，失败 ${stats.failed}，跳过 ${stats.skipped}`);
  if (stats.failures.length > 0) {
    log('');
    log('失败用例：');
    for (const failure of stats.failures) log(`  - ${failure.name}`);
  }
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

try {
  await main();
} catch (error) {
  stats.failed += 1;
  stats.failures.push({ name: 'fatal', error });
  log('');
  log(`致命错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (!KEEP_TMP) {
    try {
      removeDir(TMP);
    } catch (error) {
      log(`清理临时目录失败：${error}`);
      stats.failed += 1;
    }
  } else {
    log(`KEEP_TMP=1，保留临时目录：${TMP}`);
  }
}

process.exitCode = stats.failed > 0 ? 1 : 0;
