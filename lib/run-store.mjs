/**
 * Durable run records for the inkstone pipeline.
 *
 * One directory per run under `<project>/.inkstone/runs/<runId>/`:
 *   run.json      machine-readable record (status, steps, artifacts)
 *   report.md     human-readable report, regenerated as steps finish
 *   artifacts/    step outputs that should be kept together
 *
 * @module dsh-inkstone/lib/run-store
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson, runsRoot, stamp, displayPath } from './paths.mjs';

/**
 * Absolute directory for one run.
 * @param {string} projectDir
 * @param {string} runId
 * @returns {string}
 */
export function runDirOf(projectDir, runId) {
  return path.join(runsRoot(projectDir), runId);
}

/**
 * Artifacts directory for one run.
 * @param {string} projectDir
 * @param {string} runId
 * @returns {string}
 */
export function artifactsDirOf(projectDir, runId) {
  return path.join(runDirOf(projectDir, runId), 'artifacts');
}

/**
 * Allocate a unique run id: `<timestamp>-<recipeId>[-N]`.
 * @param {string} projectDir
 * @param {string} recipeId
 * @returns {string}
 */
export function allocateRunId(projectDir, recipeId) {
  const base = `${stamp()}-${String(recipeId).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  let candidate = base;
  let counter = 2;
  while (fs.existsSync(path.join(runsRoot(projectDir), candidate))) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Create and persist a new run record.
 * @param {object} options
 * @param {string} options.projectDir
 * @param {object} options.recipe resolved recipe definition
 * @param {Record<string, any>} options.inputs validated inputs
 * @param {Record<string, any>} options.options run options
 * @returns {object} run record
 */
export function createRun({ projectDir, recipe, inputs, options = {} }) {
  const runId = allocateRunId(projectDir, recipe.id);
  const run = {
    runId,
    recipeId: recipe.id,
    recipeTitle: recipe.title ?? recipe.id,
    status: 'running',
    projectDir,
    inputs,
    options,
    cursor: 0,
    steps: (recipe.steps ?? []).map((step) => ({
      id: step.id,
      uses: step.uses,
      status: 'pending',
      startedAt: null,
      endedAt: null,
      output: null,
      error: null,
    })),
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reportPath: null,
  };
  ensureDir(runDirOf(projectDir, runId));
  ensureDir(artifactsDirOf(projectDir, runId));
  saveRun(projectDir, run);
  return run;
}

/**
 * Persist a run record.
 * @param {string} projectDir
 * @param {object} run
 * @returns {object} the same record
 */
export function saveRun(projectDir, run) {
  run.updatedAt = new Date().toISOString();
  writeJson(path.join(runDirOf(projectDir, run.runId), 'run.json'), run);
  return run;
}

/**
 * Load a run record.
 * @param {string} projectDir
 * @param {string} runId
 * @returns {object | null}
 */
export function loadRun(projectDir, runId) {
  if (!runId) return null;
  return readJson(path.join(runDirOf(projectDir, runId), 'run.json'), null);
}

/**
 * List run records, newest first.
 * @param {string} projectDir
 * @param {number} [limit]
 * @returns {object[]}
 */
export function listRuns(projectDir, limit = 10) {
  const root = runsRoot(projectDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = readJson(path.join(root, entry.name, 'run.json'), null);
    if (run && typeof run.runId === 'string') runs.push(run);
  }
  runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return runs.slice(0, limit);
}

/**
 * Add one artifact entry unless the same path is already recorded.
 * @param {object} run
 * @param {{path: string, kind?: string, label?: string}} artifact
 */
export function addArtifact(run, artifact) {
  if (!artifact?.path) return;
  const exists = run.artifacts.some((entry) => entry.path === artifact.path);
  if (exists) return;
  run.artifacts.push({ kind: artifact.kind ?? 'file', label: artifact.label ?? path.basename(artifact.path), path: artifact.path });
}

/**
 * Format a step output for the report table, keeping it short.
 * @param {unknown} output
 * @returns {string}
 */
function summarizeOutput(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output.replace(/\s+/g, ' ').slice(0, 160);
  try {
    const text = JSON.stringify(output);
    return text.replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return String(output).slice(0, 160);
  }
}

/**
 * Rewrite `report.md` for one run.
 * @param {string} projectDir
 * @param {object} run
 * @returns {string} absolute report path
 */
export function writeReport(projectDir, run) {
  const lines = [];
  lines.push(`# ${run.recipeTitle} — ${run.runId}`, '');
  lines.push(`- 状态：**${run.status}**`);
  lines.push(`- 配方：\`${run.recipeId}\``);
  lines.push(`- 项目：\`${run.projectDir}\``);
  lines.push(`- 创建：${run.createdAt}`);
  lines.push(`- 更新：${run.updatedAt}`);
  lines.push('');
  lines.push('## 输入', '');
  const inputs = Object.entries(run.inputs ?? {});
  if (inputs.length === 0) lines.push('（无）');
  for (const [key, value] of inputs) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`- \`${key}\`：${String(text).slice(0, 300)}`);
  }
  lines.push('', '## 步骤', '');
  lines.push('| # | 步骤 | 类型 | 状态 | 耗时 | 摘要 |');
  lines.push('|---|---|---|---|---|---|');
  run.steps.forEach((step, index) => {
    const duration = step.startedAt && step.endedAt
      ? `${Math.max(0, Math.round((Date.parse(step.endedAt) - Date.parse(step.startedAt)) / 1000))}s`
      : '';
    lines.push(`| ${index + 1} | ${step.id} | ${step.uses} | ${step.status} | ${duration} | ${summarizeOutput(step.output).replace(/\|/g, '\\|')} |`);
  });
  const failed = run.steps.filter((step) => step.status === 'failed' && step.error);
  const skipped = run.steps.filter((step) => step.status === 'skipped' && step.error);
  if (failed.length > 0) {
    lines.push('', '## 错误', '');
    for (const step of failed) lines.push(`- \`${step.id}\`：${step.error}`);
  }
  if (skipped.length > 0) {
    lines.push('', '## 跳过', '');
    for (const step of skipped) lines.push(`- \`${step.id}\`：${step.error}`);
  }
  lines.push('', '## 产物', '');
  if ((run.artifacts ?? []).length === 0) lines.push('（无）');
  for (const artifact of run.artifacts ?? []) {
    const shown = artifact.path.startsWith(run.projectDir)
      ? displayPath(run.projectDir, artifact.path)
      : artifact.path;
    lines.push(`- [${artifact.label}](${String(shown).replace(/\\/g, '/')})`);
  }
  lines.push('');
  const reportPath = path.join(runDirOf(projectDir, run.runId), 'report.md');
  ensureDir(path.dirname(reportPath));
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  run.reportPath = reportPath;
  return reportPath;
}

/**
 * Compact view handed to the model / tools.
 * @param {object} run
 * @returns {object}
 */
export function runView(run) {
  return {
    runId: run.runId,
    recipeId: run.recipeId,
    recipeTitle: run.recipeTitle,
    status: run.status,
    projectDir: run.projectDir,
    cursor: run.cursor,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    reportPath: run.reportPath ?? null,
    steps: run.steps.map((step) => {
      const view = {
        id: step.id,
        uses: step.uses,
        status: step.status,
      };
      const summary = summarizeOutput(step.output);
      if (summary) view.summary = summary;
      if (step.error) view.error = step.error;
      return view;
    }),
    artifacts: run.artifacts,
  };
}

/**
 * Display path of an artifact relative to the project.
 * @param {object} run
 * @param {string} artifactPath
 * @returns {string}
 */
export function artifactDisplayPath(run, artifactPath) {
  return displayPath(run.projectDir, artifactPath);
}
