/**
 * Declarative step engine for the inkstone pipeline.
 *
 * A recipe is a JSON document (see `recipes/*.json`) with typed inputs and an
 * ordered list of steps. Each step has a type (`uses`) implemented by a handler
 * in `lib/pipeline-steps.mjs`; arguments support `${inputs.x}`, `${run.dir}` and
 * `${steps.<id>.<field>}` placeholders. A `checkpoint` step pauses the run so the
 * agent can write content, then the same run is resumed.
 *
 * @module dsh-inkstone/lib/pipeline-engine
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from './tool-kit.mjs';
import { readJson } from './paths.mjs';
import {
  createRun,
  saveRun,
  loadRun,
  writeReport,
  runDirOf,
  artifactsDirOf,
} from './run-store.mjs';

/** Absolute package root (this file lives in `lib/`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Placeholder syntax: `${a.b.c}`. */
const PLACEHOLDER = /\$\{([^}]+)\}/g;

/** Step types accepted in recipes. Handlers must exist for each one. */
export const STEP_TYPES = [
  'zotero.select',
  'zotero.bib.export',
  'zotero.bib.index',
  'files.copy',
  'typst.scaffold',
  'typst.build',
  'typst.export',
  'trilium.publish',
  'checkpoint',
  'litreview.compose',
  'report.write',
];

/**
 * @returns {string} package root directory
 */
export function packageRoot() {
  return PACKAGE_ROOT;
}

/**
 * Read every `*.json` recipe in a directory.
 * @param {string | undefined} dir
 * @returns {object[]}
 */
function readRecipeDir(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const recipes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const recipe = readJson(path.join(dir, entry.name), null);
    if (recipe && typeof recipe.id === 'string' && Array.isArray(recipe.steps)) recipes.push(recipe);
  }
  return recipes;
}

/**
 * All recipes visible from a project: package recipes first, project recipes
 * override by id.
 * @param {{projectDir?: string, recipesDir?: string | null}} [options]
 * @returns {object[]}
 */
export function listRecipes(options = {}) {
  const builtin = readRecipeDir(path.join(PACKAGE_ROOT, 'recipes'));
  const projectDir = options.projectDir;
  const projectRecipes = [];
  if (projectDir) projectRecipes.push(...readRecipeDir(path.join(projectDir, '.inkstone', 'recipes')));
  if (options.recipesDir) {
    const dir = path.isAbsolute(options.recipesDir) ? options.recipesDir : path.join(projectDir ?? process.cwd(), options.recipesDir);
    projectRecipes.push(...readRecipeDir(dir));
  }
  const byId = new Map();
  for (const recipe of [...builtin, ...projectRecipes]) byId.set(recipe.id, recipe);
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Find a recipe by id, title, or file path.
 * @param {string} name
 * @param {{projectDir?: string, recipesDir?: string | null}} [options]
 * @returns {object | null}
 */
export function findRecipe(name, options = {}) {
  if (!name) return null;
  const raw = String(name);
  if (raw.endsWith('.json') || raw.includes('/') || raw.includes('\\')) {
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(options.projectDir ?? process.cwd(), raw);
    const recipe = readJson(candidate, null);
    return recipe && Array.isArray(recipe.steps) ? recipe : null;
  }
  const recipes = listRecipes(options);
  return recipes.find((recipe) => recipe.id === raw || recipe.title === raw) ?? null;
}

/**
 * Static recipe validation.
 * @param {object} recipe
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== 'object') return { ok: false, errors: ['recipe must be an object'] };
  if (typeof recipe.id !== 'string' || recipe.id.trim().length === 0) errors.push('recipe.id must be a non-empty string');
  if (typeof recipe.title !== 'string' || recipe.title.trim().length === 0) errors.push('recipe.title must be a non-empty string');
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) errors.push('recipe.steps must be a non-empty array');
  const seen = new Set();
  for (const [index, step] of (recipe.steps ?? []).entries()) {
    if (!step || typeof step !== 'object') { errors.push(`steps[${index}] must be an object`); continue; }
    if (typeof step.id !== 'string' || step.id.trim().length === 0) errors.push(`steps[${index}].id must be a non-empty string`);
    else if (seen.has(step.id)) errors.push(`duplicate step id "${step.id}"`);
    else seen.add(step.id);
    if (typeof step.uses !== 'string' || !STEP_TYPES.includes(step.uses)) {
      errors.push(`steps[${index}].uses must be one of: ${STEP_TYPES.join(', ')}`);
    }
    if (step.optional !== undefined && typeof step.optional !== 'boolean') errors.push(`steps[${index}].optional must be a boolean`);
  }
  for (const [key, spec] of Object.entries(recipe.inputs ?? {})) {
    if (!spec || typeof spec !== 'object') errors.push(`inputs.${key} must be an object`);
    else if (spec.type !== undefined && !['string', 'number', 'boolean', 'array'].includes(spec.type)) {
      errors.push(`inputs.${key}.type must be string|number|boolean|array`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate and normalize run inputs against the recipe's input contract.
 * @param {object} recipe
 * @param {Record<string, any>} provided
 * @returns {{ok: boolean, errors: string[], values: Record<string, any>}}
 */
export function prepareInputs(recipe, provided = {}) {
  const errors = [];
  const values = provided !== null && typeof provided === 'object' && !Array.isArray(provided) ? { ...provided } : {};
  for (const [key, spec] of Object.entries(recipe.inputs ?? {})) {
    let value = values[key];
    if ((value === undefined || value === null || value === '') && spec.default !== undefined) {
      value = spec.default;
      values[key] = value;
    }
    const required = spec.required === true;
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`缺少必填输入 "${key}"${spec.description ? `：${spec.description}` : ''}`);
      continue;
    }
    const type = spec.type ?? 'string';
    if (type === 'array' && !Array.isArray(value)) {
      if (typeof value === 'string') {
        values[key] = value.split(',').map((item) => item.trim()).filter(Boolean);
      } else {
        errors.push(`输入 "${key}" 必须是数组`);
      }
    } else if (type === 'number' && typeof value !== 'number') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) values[key] = numeric;
      else errors.push(`输入 "${key}" 必须是数字`);
    } else if (type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`输入 "${key}" 必须是布尔值`);
    } else if (type === 'string' && typeof value !== 'string') {
      errors.push(`输入 "${key}" 必须是字符串`);
    }
  }
  return { ok: errors.length === 0, errors, values };
}

/**
 * Look up one dotted path inside the placeholder context.
 * @param {Record<string, any>} context
 * @param {string} expression
 * @returns {any}
 */
function lookup(context, expression) {
  const parts = expression.split('.').map((part) => part.trim()).filter(Boolean);
  let current = context;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (current === undefined || current === null || typeof current !== 'object') {
      current = undefined;
      break;
    }
    current = current[part];
  }
  if (current === undefined) {
    if (parts[0] === 'inputs') return undefined;
    throw new Error(`unresolved placeholder: \${${expression}}`);
  }
  return current;
}

/**
 * Substitute placeholders in a recipe argument tree.
 * @param {unknown} value
 * @param {Record<string, any>} context
 * @returns {unknown}
 */
export function resolvePlaceholders(value, context) {
  if (typeof value === 'string') {
    const single = value.match(/^\$\{([^}]+)\}$/);
    if (single) return lookup(context, single[1]);
    return value.replace(PLACEHOLDER, (_match, expression) => {
      const resolved = lookup(context, expression);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, context));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolvePlaceholders(item, context);
    return out;
  }
  return value;
}

/**
 * Build the placeholder context for a run at its current cursor.
 * @param {object} run
 * @returns {Record<string, any>}
 */
export function placeholderContext(run) {
  const steps = {};
  for (const step of run.steps ?? []) {
    if (step.output !== null && step.output !== undefined) steps[step.id] = step.output;
  }
  return {
    inputs: run.inputs ?? {},
    run: {
      id: run.runId,
      dir: runDirOf(run.projectDir, run.runId),
      projectDir: run.projectDir,
    },
    steps,
    env: process.env,
  };
}

/**
 * Default step handlers (implemented in `pipeline-steps.mjs`).
 * @param {Record<string, any>} config
 * @returns {Promise<Record<string, Function>>}
 */
export async function createDefaultHandlers(config = {}) {
  const module = await import('./pipeline-steps.mjs');
  return module.createHandlers(config);
}

/**
 * Execute (or resume) one run until completion, failure, or a checkpoint.
 *
 * @param {object} options
 * @param {object} options.run run record (mutated and persisted)
 * @param {object} options.recipe resolved recipe
 * @param {Record<string, Function>} options.handlers step handler map
 * @param {Record<string, any>} [options.config] flow plugin config
 * @param {AbortSignal} [options.signal]
 * @param {(event: {type: string, stepId?: string, status?: string}) => void} [options.onProgress]
 * @returns {Promise<{run: object, awaiting?: {stepId: string, message: string}}>}
 */
export async function executeRun({ run, recipe, handlers, config = {}, signal, onProgress }) {
  const projectDir = run.projectDir;
  const steps = recipe.steps ?? [];
  let index = Number.isInteger(run.cursor) ? run.cursor : 0;
  run.status = 'running';
  // A checkpoint record stays "awaiting" while the run is paused; once the run
  // resumes past it, the checkpoint itself is satisfied.
  for (let prior = 0; prior < index; prior += 1) {
    const record = run.steps[prior];
    if (record.status === 'awaiting') {
      record.status = 'completed';
      record.endedAt = record.endedAt ?? new Date().toISOString();
    }
  }

  while (index < steps.length) {
    const step = steps[index];
    const record = run.steps[index];
    if (record.status === 'completed' || record.status === 'skipped') {
      index += 1;
      run.cursor = index;
      continue;
    }
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    record.endedAt = null;
    record.error = null;
    run.cursor = index;
    saveRun(projectDir, run);
    onProgress?.({ type: 'step-start', stepId: step.id });

    const handler = handlers[step.uses];
    let args;
    try {
      args = resolvePlaceholders(step.args ?? {}, placeholderContext(run));
    } catch (error) {
      record.endedAt = new Date().toISOString();
      record.error = errorMessage(error);
      if (step.optional === true) {
        record.status = 'skipped';
        saveRun(projectDir, run);
        writeReport(projectDir, run);
        onProgress?.({ type: 'step-end', stepId: step.id, status: 'skipped' });
        index += 1;
        continue;
      }
      record.status = 'failed';
      run.status = 'failed';
      saveRun(projectDir, run);
      writeReport(projectDir, run);
      return { run };
    }
    if (typeof handler !== 'function') {
      record.status = 'failed';
      record.endedAt = new Date().toISOString();
      record.error = `no handler registered for step type "${step.uses}"`;
      run.status = 'failed';
      saveRun(projectDir, run);
      writeReport(projectDir, run);
      return { run };
    }

    const context = {
      run,
      recipe,
      step,
      stepIndex: index,
      projectDir,
      runDir: runDirOf(projectDir, run.runId),
      artifactsDir: artifactsDirOf(projectDir, run.runId),
      config,
      signal,
      placeholders: placeholderContext(run),
    };

    try {
      const result = (await handler(args, context)) ?? {};
      record.endedAt = new Date().toISOString();
      if (result.awaiting) {
        record.status = 'awaiting';
        record.output = result.output ?? { message: result.message ?? '等待下一步输入' };
        run.cursor = index + 1;
        run.status = 'awaiting';
        saveRun(projectDir, run);
        writeReport(projectDir, run);
        onProgress?.({ type: 'step-awaiting', stepId: step.id });
        return {
          run,
          awaiting: {
            stepId: step.id,
            message: String(result.message ?? result.output?.message ?? '等待下一步输入'),
          },
        };
      }
      record.status = 'completed';
      record.output = result.output ?? null;
      for (const artifact of result.artifacts ?? []) {
        if (!artifact?.path) continue;
        if (!run.artifacts.some((entry) => entry.path === artifact.path)) {
          run.artifacts.push({
            kind: artifact.kind ?? 'file',
            label: artifact.label ?? path.basename(artifact.path),
            path: artifact.path,
          });
        }
      }
      run.cursor = index + 1;
      saveRun(projectDir, run);
      writeReport(projectDir, run);
      onProgress?.({ type: 'step-end', stepId: step.id, status: 'completed' });
    } catch (error) {
      record.endedAt = new Date().toISOString();
      record.error = errorMessage(error);
      if (step.optional === true) {
        record.status = 'skipped';
        saveRun(projectDir, run);
        writeReport(projectDir, run);
        onProgress?.({ type: 'step-end', stepId: step.id, status: 'skipped' });
      } else {
        record.status = 'failed';
        run.status = 'failed';
        saveRun(projectDir, run);
        writeReport(projectDir, run);
        onProgress?.({ type: 'step-end', stepId: step.id, status: 'failed' });
        return { run };
      }
    }
    index += 1;
  }

  run.status = 'completed';
  saveRun(projectDir, run);
  writeReport(projectDir, run);
  return { run };
}

/**
 * Create and start a new run.
 * @param {object} options
 * @returns {Promise<{run: object, awaiting?: object}>}
 */
export async function startRun({ projectDir, recipe, inputs, options = {}, config = {}, handlers, signal, onProgress }) {
  const validation = validateRecipe(recipe);
  if (!validation.ok) throw new Error(`invalid recipe "${recipe?.id ?? '?'}": ${validation.errors.join('; ')}`);
  const prepared = prepareInputs(recipe, inputs);
  if (!prepared.ok) throw new Error(prepared.errors.join('; '));
  const run = createRun({ projectDir, recipe, inputs: prepared.values, options });
  const map = handlers ?? (await createDefaultHandlers(config));
  return executeRun({ run, recipe, handlers: map, config, signal, onProgress });
}

/**
 * Resume an existing run.
 * @param {object} options
 * @returns {Promise<{run: object, awaiting?: object}>}
 */
export async function resumeRun({ projectDir, runId, config = {}, handlers, signal, onProgress, optionOverrides = {} }) {
  const run = loadRun(projectDir, runId);
  if (!run) throw new Error(`run not found: ${runId} (project ${projectDir})`);
  if (run.status === 'completed') throw new Error(`run ${runId} is already completed`);
  const recipe = findRecipe(run.recipeId, { projectDir, recipesDir: config.recipesDir ?? null });
  if (!recipe) throw new Error(`recipe "${run.recipeId}" for run ${runId} is no longer available`);
  run.options = { ...run.options, ...optionOverrides };
  const map = handlers ?? (await createDefaultHandlers(config));
  return executeRun({ run, recipe, handlers: map, config, signal, onProgress });
}
