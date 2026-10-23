/**
 * inkstone-flow — the joint engineering pipeline plugin.
 *
 * It owns the declarative recipe engine tools and the short agent skill section
 * that explains when to use a pipeline instead of calling the three integration
 * plugins directly. All heavy lifting lives in `lib/pipeline-engine.mjs`,
 * `lib/pipeline-steps.mjs` and `lib/run-store.mjs`.
 *
 * @module dsh-inkstone/plugins/inkstone-flow
 */

import {
  defineTool,
  normalizeConfig,
  optionalString,
  sessionCwd,
  truncate,
  textBlocks,
} from '../../lib/tool-kit.mjs';
import { resolveProjectDir } from '../../lib/paths.mjs';
import {
  findRecipe,
  listRecipes,
  prepareInputs,
  startRun,
  resumeRun,
  validateRecipe,
} from '../../lib/pipeline-engine.mjs';
import { loadRun, listRuns, runView } from '../../lib/run-store.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'inkstone-flow';

/** Services required by this plugin. */
export const inject = ['tools', 'systemPrompt'];

/** Common output contract: pipeline payloads are already summarized by render. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

/**
 * Resolve the plugin configuration with defaults.
 * @param {unknown} config
 * @returns {object}
 */
function resolveConfig(config) {
  const raw = normalizeConfig(config);
  return {
    projectDir: typeof raw.projectDir === 'string' && raw.projectDir.length > 0 ? raw.projectDir : undefined,
    recipesDir: typeof raw.recipesDir === 'string' && raw.recipesDir.length > 0 ? raw.recipesDir : null,
    defaultParentNoteId: typeof raw.defaultParentNoteId === 'string' ? raw.defaultParentNoteId : null,
    publish: raw.publish !== false,
    advancedTools: raw.advancedTools === true,
    maxHealRounds: Number.isInteger(raw.maxHealRounds) ? raw.maxHealRounds : 3,
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 120000,
  };
}

/**
 * Resolve the project directory from tool args, plugin config, env, or session.
 * @param {Record<string, any>} args
 * @param {object} config resolved plugin config
 * @param {any} exec tool execution context
 * @returns {string}
 */
function resolveProject(args, config, exec) {
  const explicit = optionalString(args, 'projectDir')
    ?? config.projectDir
    ?? process.env.INKSTONE_PROJECT_DIR;
  return resolveProjectDir(explicit, sessionCwd(exec));
}

/**
 * Normalize the `options` object of pipeline_run.
 * @param {unknown} value
 * @returns {object}
 */
function resolveOptions(value) {
  const raw = normalizeConfig(value);
  const options = {};
  if (raw.dryRun === true) options.dryRun = true;
  if (raw.heal === false) options.heal = false;
  if (raw.publish === false) options.publish = false;
  if (typeof raw.fromStep === 'string') options.fromStep = raw.fromStep;
  if (Number.isInteger(raw.maxSteps)) options.maxSteps = raw.maxSteps;
  return options;
}

/**
 * Build the tool-facing view of a run, including checkpoint guidance.
 * @param {object} run
 * @param {{stepId: string, message: string} | undefined} awaiting
 * @returns {object}
 */
function buildRunOutput(run, awaiting) {
  const view = runView(run);
  view.awaiting = awaiting ?? null;
  if (awaiting) {
    view.message = `运行暂停在检查点 "${awaiting.stepId}"。${awaiting.message} 完成后调用 pipeline_run { runId: "${run.runId}" } 继续；不要新建 run。`;
  } else if (run.status === 'failed') {
    view.message = '运行失败。按步骤错误修复文件或环境后，用同一 runId 调用 pipeline_run 从失败步骤继续；不要新建 run。';
  } else if (run.status === 'completed') {
    view.message = '运行完成；产物与报告路径见下。';
  }
  return view;
}

/**
 * Render a pipeline run as model-facing text.
 * @param {object} view
 * @returns {{type: 'text', text: string}[]}
 */
function renderRun(view) {
  const marks = { completed: '✓', failed: '✗', skipped: '∅', awaiting: '⏸', running: '…', pending: '·' };
  const lines = [`pipeline ${view.status} · ${view.runId} · ${view.recipeTitle ?? view.recipeId}`];
  const completed = view.steps.filter((step) => step.status === 'completed').length;
  const skipped = view.steps.filter((step) => step.status === 'skipped').length;
  lines.push(`步骤：${completed}/${view.steps.length} 完成${skipped > 0 ? `，${skipped} 跳过` : ''}`);
  for (const step of view.steps) {
    const mark = marks[step.status] ?? '·';
    const error = step.error ? ` — ${step.error}` : '';
    const summary = step.summary ? ` — ${step.summary}` : '';
    lines.push(`${mark} ${step.id} (${step.uses}) ${step.status}${summary}${error}`);
  }
  if (view.awaiting) lines.push('', `等待：${view.awaiting.message}`);
  if (view.message) lines.push('', `下一步：${view.message}`);
  if ((view.artifacts ?? []).length > 0) {
    lines.push('', '产物：');
    for (const artifact of view.artifacts.slice(0, 10)) lines.push(`- ${artifact.label}: ${artifact.path}`);
  }
  if (view.reportPath) lines.push('', `报告：${view.reportPath}`);
  return textBlocks(truncate(lines.join('\n')));
}

/**
 * Render recipe metadata.
 * @param {object} recipe
 * @returns {string}
 */
function describeRecipe(recipe) {
  const inputs = Object.entries(recipe.inputs ?? {})
    .map(([key, spec]) => `${key}${spec.required ? '*' : ''}`)
    .join(', ');
  return `- ${recipe.id}「${recipe.title}」：${recipe.description ?? ''}${inputs ? `（输入：${inputs}）` : ''}`;
}

/**
 * The agent skill section: when and how to use the pipeline.
 * @returns {string}
 */
function skillSection() {
  return [
    '## inkstone 工程流水线',
    '当任务属于「文献 → 排版 → 归档」的完整交付时，优先用流水线，而不是手工串联底层工具：',
    '- 先 `pipeline_list` 看内置配方：paper-delivery（期刊/会议论文）、course-report（课程/实验报告）、lit-review（文献综述/读书笔记）、slides-poster（幻灯片/海报）。',
    '- 开始：`pipeline_run { recipe, inputs, projectDir? }`；可先用 `options.dryRun: true` 校验参数与步骤。',
    '- 检查点：运行在 checkpoint 返回 `status: "awaiting"` 与 `runId`。按 message 指引写作/修改（通常是 run 目录下的 main.typ），然后用 `pipeline_run { runId }` 继续；不要新建 run。',
    '- 失败：构建失败会返回失败步骤与诊断摘要（诊断 JSON 在 run 目录）。修复后再次 `pipeline_run { runId }` 从失败步骤继续。',
    '- 自愈：typst.build 默认 heal=true（白名单自动修复，最多 3 轮）；修不好时按错误定位手工修复。',
    '- 凭据：Trilium 发布需要 TRILIUM_ETAPI_TOKEN；Zotero 检索需要 Zotero 运行并开启本地 API。缺失时步骤给出可操作提示。',
    '- 记录：`<project>/.inkstone/runs/<runId>/`（run.json、report.md、artifacts/）；`pipeline_status` 可查历史。',
    '- 流水线之外的细粒度操作直接调用 trilium_* / zotero_* / typst_* 工具。',
  ].join('\n');
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const engineConfig = {
    ...resolved,
    projectDir: resolved.projectDir,
    recipesDir: resolved.recipesDir,
  };

  /** @type {Map<string, object>} command registry for renderers */
  ctx.tools.register(defineTool({
    name: 'pipeline_list',
    description: 'List built-in and project pipeline recipes plus recent runs. Use before pipeline_run to pick a recipe and see its inputs.',
    parameters: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Project directory (defaults to the session working directory).' },
        includeRuns: { type: 'boolean', description: 'Include recent runs (default true).' },
      },
      additionalProperties: false,
    },
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      const lines = ['## 流水线配方'];
      for (const recipe of value.recipes ?? []) lines.push(describeRecipe(recipe));
      if ((value.runs ?? []).length > 0) {
        lines.push('', '## 最近运行');
        for (const run of value.runs) {
          lines.push(`- ${run.runId} · ${run.recipeId} · ${run.status} · 更新 ${run.updatedAt}`);
        }
      }
      lines.push('', `项目目录：${value.projectDir}`);
      return textBlocks(truncate(lines.join('\n')));
    },
    async execute(args, exec) {
      const projectDir = resolveProject(args, resolved, exec);
      const recipes = listRecipes({ projectDir, recipesDir: resolved.recipesDir }).map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        scenario: recipe.scenario,
        inputs: recipe.inputs ?? {},
        steps: (recipe.steps ?? []).map((step) => ({ id: step.id, uses: step.uses, optional: step.optional === true })),
      }));
      const runs = args.includeRuns === false
        ? []
        : listRuns(projectDir, 8).map((run) => ({
          runId: run.runId,
          recipeId: run.recipeId,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        }));
      return { projectDir, recipes, runs };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pipeline_run',
    description: 'Start a pipeline recipe, or resume an existing run by runId. Returns step status, artifacts and, at a checkpoint, the runId to resume with.',
    parameters: {
      type: 'object',
      properties: {
        recipe: { type: 'string', description: 'Recipe id (e.g. paper-delivery) or path to a recipe JSON file.' },
        runId: { type: 'string', description: 'Existing run id to resume (mutually exclusive with recipe).' },
        projectDir: { type: 'string', description: 'Project directory (defaults to the session working directory).' },
        inputs: {
          type: 'object',
          description: 'Recipe inputs, e.g. { topic, collection, bibPath, template, parentNoteId }.',
          additionalProperties: true,
        },
        options: {
          type: 'object',
          description: 'Run options: { dryRun, heal, publish }.',
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
    schema: OUTPUT_SCHEMA,
    timeoutMs: 600000,
    render: (_args, value) => {
      if (value.dryRun) {
        const lines = [`dry-run：配方 ${value.recipe.id}「${value.recipe.title}」可执行`, `项目：${value.projectDir}`, '步骤：'];
        for (const step of value.recipe.steps) lines.push(`- ${step.id} (${step.uses})${step.optional ? ' [optional]' : ''}`);
        lines.push('', '输入：');
        for (const [key, input] of Object.entries(value.inputs ?? {})) lines.push(`- ${key}: ${JSON.stringify(input)}`);
        return textBlocks(lines.join('\n'));
      }
      return renderRun(value);
    },
    async execute(args, exec) {
      const projectDir = resolveProject(args, resolved, exec);
      const options = resolveOptions(args.options);
      if (typeof args.runId === 'string' && args.runId.length > 0) {
        const { run, awaiting } = await resumeRun({
          projectDir,
          runId: args.runId,
          config: engineConfig,
          signal: exec?.signal,
          optionOverrides: options,
        });
        return buildRunOutput(run, awaiting);
      }
      const recipeName = optionalString(args, 'recipe');
      if (!recipeName) throw new Error('pipeline_run needs "recipe" to start a new run or "runId" to resume');
      const recipe = findRecipe(recipeName, { projectDir, recipesDir: resolved.recipesDir });
      if (!recipe) {
        const available = listRecipes({ projectDir, recipesDir: resolved.recipesDir }).map((item) => item.id).join(', ');
        throw new Error(`unknown pipeline recipe "${recipeName}". Available: ${available}`);
      }
      const validation = validateRecipe(recipe);
      if (!validation.ok) throw new Error(`invalid recipe "${recipe.id}": ${validation.errors.join('; ')}`);
      const prepared = prepareInputs(recipe, normalizeConfig(args.inputs));
      if (!prepared.ok) throw new Error(prepared.errors.join('; '));
      if (options.dryRun) {
        return {
          dryRun: true,
          projectDir,
          recipe: {
            id: recipe.id,
            title: recipe.title,
            steps: (recipe.steps ?? []).map((step) => ({ id: step.id, uses: step.uses, optional: step.optional === true })),
          },
          inputs: prepared.values,
        };
      }
      const { run, awaiting } = await startRun({
        projectDir,
        recipe,
        inputs: prepared.values,
        options,
        config: engineConfig,
        signal: exec?.signal,
      });
      return buildRunOutput(run, awaiting);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pipeline_status',
    description: 'Read one pipeline run by runId, or list recent runs for the project.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id to read.' },
        projectDir: { type: 'string', description: 'Project directory (defaults to the session working directory).' },
        limit: { type: 'integer', description: 'Number of recent runs to list (default 10).' },
      },
      additionalProperties: false,
    },
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      if (value.run) return renderRun(value.run);
      const lines = [`项目：${value.projectDir}`, '最近运行：'];
      if ((value.runs ?? []).length === 0) lines.push('（无）');
      for (const run of value.runs ?? []) {
        const steps = run.steps ?? [];
        const done = steps.filter((step) => step.status === 'completed').length;
        lines.push(`- ${run.runId} · ${run.recipeId} · ${run.status} · ${done}/${steps.length} 步 · ${run.updatedAt}`);
      }
      return textBlocks(lines.join('\n'));
    },
    async execute(args, exec) {
      const projectDir = resolveProject(args, resolved, exec);
      const runId = optionalString(args, 'runId');
      if (runId) {
        const run = loadRun(projectDir, runId);
        if (!run) throw new Error(`run not found: ${runId} (project ${projectDir})`);
        return { projectDir, run: runView(run), runs: [] };
      }
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 10;
      const runs = listRuns(projectDir, limit).map((run) => ({
        runId: run.runId,
        recipeId: run.recipeId,
        recipeTitle: run.recipeTitle,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        steps: run.steps.map((step) => ({ id: step.id, uses: step.uses, status: step.status })),
      }));
      return { projectDir, runs };
    },
  }));

  if (resolved.advancedTools) {
    ctx.tools.register(defineTool({
      name: 'pipeline_validate',
      description: 'Validate a pipeline recipe (static checks) without running it.',
      parameters: {
        type: 'object',
        properties: {
          recipe: { type: 'string', description: 'Recipe id or path to a recipe JSON file.' },
          projectDir: { type: 'string', description: 'Project directory (defaults to the session working directory).' },
        },
        required: ['recipe'],
        additionalProperties: false,
      },
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(value.ok ? `recipe ${value.recipeId} 校验通过（${value.stepCount} 步）` : `recipe ${value.recipeId} 校验失败：\n${value.errors.join('\n')}`),
      async execute(args, exec) {
        const projectDir = resolveProject(args, resolved, exec);
        const recipe = findRecipe(String(args.recipe), { projectDir, recipesDir: resolved.recipesDir });
        if (!recipe) throw new Error(`unknown pipeline recipe "${args.recipe}"`);
        const validation = validateRecipe(recipe);
        return { recipeId: recipe.id, ok: validation.ok, errors: validation.errors, stepCount: (recipe.steps ?? []).length };
      },
    }));
  }

  ctx.systemPrompt.section({
    name: 'inkstone-pipeline',
    order: 800,
    text: skillSection(),
  });
}
