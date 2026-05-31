'use strict';
// !project run の最小テスト（index.js のソース確認中心）

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const src = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'index.js'), 'utf8'
);

// handleProjectRun 関数の存在と主要要素
const fnStart = src.indexOf('async function handleProjectRun');
const fnEnd   = src.indexOf('\nasync function handle', fnStart + 1);
const fnBody  = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);

console.log('\n[handleProjectRun 実装確認]');

test('1. handleProjectRun が定義されている', () =>
  assert.ok(fnStart >= 0, 'handleProjectRun が見つからない'));

test('2. activeRuns Map が定義されている', () =>
  assert.ok(src.includes('const activeRuns = new Map()'), 'activeRuns がない'));

test('3. 二重起動チェック（activeRuns.get）がある', () =>
  assert.ok(fnBody.includes('activeRuns.get(projectId)'), '二重起動チェックがない'));

test('4. applyStaffingPlan が呼ばれている', () =>
  assert.ok(fnBody.includes('applyStaffingPlan('), 'applyStaffingPlan がない'));

test('5. enableRunner が呼ばれている', () =>
  assert.ok(fnBody.includes('enableRunner(projectId)'), 'enableRunner がない'));

test('6. setAutoApplyPlanning(true) が呼ばれている', () =>
  assert.ok(fnBody.includes('setAutoApplyPlanning(projectId, true)'), 'setAutoApplyPlanning がない'));

test('7. handleAutoOn が fire-and-forget で呼ばれている（await なし）', () => {
  // "handleAutoOn(message)" が存在し、その前に await がないことを確認
  const idx = fnBody.indexOf('handleAutoOn(message)');
  assert.ok(idx >= 0, 'handleAutoOn(message) がない');
  const before = fnBody.slice(Math.max(0, idx - 20), idx);
  assert.ok(!before.includes('await'), '`await handleAutoOn` になっている（fire-and-forgetでない）');
});

test('8. .catch() で handleAutoOn のエラーを捕捉している', () =>
  assert.ok(fnBody.includes('.catch(err =>') || fnBody.includes('.catch((err'), 'catch がない'));

test('9. activeRuns.delete で実行後クリーンアップされる', () =>
  assert.ok(fnBody.includes('activeRuns.delete(projectId)'), 'activeRuns.delete がない'));

test('10. !project run が handleProject の routing に含まれる', () => {
  const projFnStart = src.indexOf('async function handleProject(');
  const projFnEnd   = src.indexOf('\nasync function ', projFnStart + 1);
  const projBody    = src.slice(projFnStart, projFnEnd > 0 ? projFnEnd : projFnStart + 10000);
  assert.ok(projBody.includes("sub === 'run'"), "sub === 'run' がない");
  assert.ok(projBody.includes('handleProjectRun(message'), 'handleProjectRun の呼び出しがない');
});

test('11. !project stop の TODO コメントが index.js にある', () =>
  assert.ok(src.includes('project stop') && src.includes('TODO'),
    '!project stop のTODOコメントがない'));

test('12. getStaffingReport or applyStaffingPlan が companyManager 経由で呼ばれている', () =>
  assert.ok(fnBody.includes('companyManager.'), 'companyManager が使われていない'));

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
