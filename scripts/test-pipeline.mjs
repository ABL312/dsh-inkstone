/**
 * Pipeline engine + inkstone-flow plugin smoke test (no DSH, no live services).
 *
 * Run: node scripts/test-pipeline.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeRun, resolvePlaceholders, prepareInputs, listRecipes, validateRecipe } from '../lib/pipeline-engine.mjs';
import { createRun, loadRun, listRuns } from '../lib/run-store.mjs';
import { apply } from '../plugins/inkstone-flow/index.js';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpRoot = path.join(packageRoot, 'fixtures', 'pipeline', '_tmp');
const projectDir = path.join(tmpRoot, `run-${Date.now()}`);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${message}`);
  }
}

function cleanup() {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function fakeContext() {
  const tools = new Map();
  const sections = [];
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    toolsMap: tools,
    sections,
  };
}

async function main() {
  cleanup();
  fs.mkdirSync(path.join(projectDir, '.inkstone', 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.inkstone', 'recipes', 'smoke.json'), JSON.stringify({
    id: 'smoke',
    title: '冒烟流水线',
    description: 'checkpoint + report only',
    inputs: {
      topic: { type: 'string', required: true },
      rounds: { type: 'number', default: 2 },
    },
    steps: [
      { id: 'write', uses: 'checkpoint', args: { message: '写点东西：${inputs.topic}' } },
      { id: 'report', uses: 'report.write', args: {} },
    ],
  }, null, 2));

  console.log('\n# placeholder resolution');
  const context = {
    inputs: { topic: '论文' },
    run: { id: 'r1', dir: 'D:/tmp/run', projectDir: 'D:/tmp' },
    steps: { build: { outputPath: 'D:/tmp/a.pdf' } },
    env: {},
  };
  assert(resolvePlaceholders('${inputs.topic}', context) === '论文', 'whole-string input placeholder');
  assert(resolvePlaceholders('x-${inputs.topic}-y', context) === 'x-论文-y', 'interpolated input placeholder');
  assert(resolvePlaceholders('${steps.build.outputPath}', context) === 'D:/tmp/a.pdf', 'step output placeholder');
  assert(resolvePlaceholders({ a: ['${run.dir}'], b: '${inputs.topic}' }, context).a[0] === 'D:/tmp/run', 'recursive object/array resolution');
  assert(resolvePlaceholders('${inputs.missing}', context) === undefined, 'whole-string missing input → undefined');
  assert(resolvePlaceholders('a${inputs.missing}b', context) === 'ab', 'missing input inside text → empty string');
  let threw = false;
  try {
    resolvePlaceholders('${steps.missing.output}', context);
  } catch {
    threw = true;
  }
  assert(threw, 'missing step output throws');

  console.log('\n# recipe loading and validation');
  const recipes = listRecipes({ projectDir });
  assert(recipes.some((recipe) => recipe.id === 'smoke'), 'project recipe discovered');
  assert(recipes.some((recipe) => recipe.id === 'paper-delivery'), 'built-in recipes discovered');
  const smoke = recipes.find((recipe) => recipe.id === 'smoke');
  assert(validateRecipe(smoke).ok, 'recipe validates');
  const bad = validateRecipe({ id: 'bad', title: 'x', steps: [{ id: 'a', uses: 'nope' }] });
  assert(!bad.ok && bad.errors.length > 0, 'unknown step type rejected');

  console.log('\n# input preparation');
  const prepared = prepareInputs(smoke, { topic: '测试' });
  assert(prepared.ok && prepared.values.rounds === 2, 'defaults applied');
  const missing = prepareInputs(smoke, {});
  assert(!missing.ok, 'missing required input rejected');

  console.log('\n# engine run → checkpoint → resume');
  const run = createRun({ projectDir, recipe: smoke, inputs: prepared.values, options: {} });
  // report.write needs the handler from pipeline-steps; avoid importing it here
  // (it lazily imports integration modules) and inject a local stand-in.
  const handlers = {
    checkpoint: async (args) => ({ awaiting: true, message: args.message, output: { message: args.message } }),
    'report.write': async (_args, context2) => {
      const reportPath = path.join(context2.runDir, 'report.md');
      fs.writeFileSync(reportPath, '# smoke\n', 'utf8');
      return { output: { reportPath }, artifacts: [{ path: reportPath, kind: 'markdown' }] };
    },
  };
  const engine = await import('../lib/pipeline-engine.mjs');
  const first = await engine.executeRun({ run, recipe: smoke, handlers });
  assert(first.awaiting?.stepId === 'write', 'run pauses at checkpoint');
  assert(first.run.status === 'awaiting', 'run status awaiting');
  assert(fs.existsSync(path.join(first.run.projectDir, '.inkstone', 'runs', first.run.runId, 'report.md')), 'report.md written');
  const resumed = await engine.executeRun({ run: first.run, recipe: smoke, handlers });
  assert(resumed.run.status === 'completed', 'resumed run completes');
  assert(resumed.run.steps.find((step) => step.id === 'write').status === 'completed', 'checkpoint step marked completed after resume');
  assert(resumed.run.artifacts.length === 1, 'artifact recorded');
  const saved = loadRun(projectDir, resumed.run.runId);
  assert(saved.status === 'completed', 'run persisted');

  console.log('\n# optional step with unresolved placeholder');
  const optionalRecipe = {
    id: 'optional-missing',
    title: 'optional placeholder',
    inputs: {},
    steps: [
      { id: 'pause', uses: 'checkpoint', args: { message: 'go' } },
      { id: 'optional', uses: 'report.write', optional: true, args: { value: '${steps.nothere.value}' } },
      { id: 'report', uses: 'report.write', args: {} },
    ],
  };
  const optionalRun = createRun({ projectDir, recipe: optionalRecipe, inputs: {}, options: {} });
  const optionalFirst = await engine.executeRun({ run: optionalRun, recipe: optionalRecipe, handlers });
  const optionalResume = await engine.executeRun({ run: optionalFirst.run, recipe: optionalRecipe, handlers });
  assert(optionalResume.run.status === 'completed', 'optional unresolved placeholder does not fail the run');
  assert(optionalResume.run.steps.find((step) => step.id === 'optional').status === 'skipped', 'optional step skipped on placeholder error');

  console.log('\n# plugin tools');
  const ctx = fakeContext();
  apply(ctx, {
    projectDir,
    advancedTools: true,
    publish: false,
  });
  assert(ctx.toolsMap.has('pipeline_list'), 'pipeline_list registered');
  assert(ctx.toolsMap.has('pipeline_run'), 'pipeline_run registered');
  assert(ctx.toolsMap.has('pipeline_status'), 'pipeline_status registered');
  assert(ctx.toolsMap.has('pipeline_validate'), 'pipeline_validate registered with advancedTools');
  assert(ctx.sections.length === 1 && ctx.sections[0].name === 'inkstone-pipeline', 'system prompt section registered');

  const list = ctx.toolsMap.get('pipeline_list');
  const listResult = await list.execute({}, {});
  assert(listResult.recipes.some((recipe) => recipe.id === 'paper-delivery'), 'pipeline_list sees built-ins');
  const listText = list.output.render({}, listResult);
  assert(Array.isArray(listText) && listText[0].text.includes('paper-delivery'), 'pipeline_list renders text');

  const runTool = ctx.toolsMap.get('pipeline_run');
  const dry = await runTool.execute({ recipe: 'smoke', projectDir, inputs: { topic: 'dry' }, options: { dryRun: true } }, {});
  assert(dry.dryRun === true && dry.recipe.id === 'smoke', 'dryRun returns plan without creating a run');

  const started = await runTool.execute({ recipe: 'smoke', projectDir, inputs: { topic: '端到端' } }, {});
  assert(started.status === 'awaiting' && started.awaiting?.stepId === 'write', 'tool start pauses at checkpoint');
  const rendered = runTool.output.render({}, started);
  assert(rendered[0].text.includes('awaiting'), 'run render mentions awaiting');
  const continued = await runTool.execute({ runId: started.runId, projectDir }, {});
  assert(continued.status === 'completed', 'tool resume completes');

  const statusTool = ctx.toolsMap.get('pipeline_status');
  const status = await statusTool.execute({ projectDir }, {});
  assert(status.runs.length >= 2, 'pipeline_status lists runs');

  const validateTool = ctx.toolsMap.get('pipeline_validate');
  const validated = await validateTool.execute({ recipe: 'smoke', projectDir }, {});
  assert(validated.ok === true, 'pipeline_validate accepts smoke recipe');

  const runs = listRuns(projectDir, 5);
  assert(runs.length >= 2, 'run records on disk');

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
