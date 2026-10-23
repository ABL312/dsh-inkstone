// Sequential test runner used by `npm test` / `node scripts/test-all.mjs`.
import { spawnSync } from 'node:child_process';

const tests = [
  ['trilium', 'scripts/test-trilium.mjs'],
  ['zotero', 'scripts/test-zotero.mjs'],
  ['typst', 'scripts/test-typst.mjs'],
  ['pipeline', 'scripts/test-pipeline.mjs'],
];

const failures = [];
for (const [name, file] of tests) {
  console.log(`\n===== ${name} =====`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: process.cwd() });
  if (result.status !== 0) failures.push({ name, status: result.status });
}

console.log('\n===== summary =====');
if (failures.length === 0) {
  console.log('all test suites passed');
  process.exit(0);
}
for (const failure of failures) console.log(`FAIL ${failure.name} (exit ${failure.status})`);
process.exit(1);
