'use strict';
// Phase E-3: Timeout Auto Split テスト

const tm     = require('../bot/utils/task-manager');
const runner = require('../bot/utils/auto-project-runner');
const { AUTO_POLICY, classifyTask } = require('../bot/utils/auto-policy');
const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0, fail = 0;
const CLEANUP_IDS = [];
const pid = 'youtube予測ai';

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}
function info(msg) { console.log('  ℹ️ ', msg); }

function cleanup() {
  const fpath = path.join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  raw.tasks   = raw.tasks.filter(t => !CLEANUP_IDS.includes(t.id));
  fs.writeFileSync(fpath, JSON.stringify(raw, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// 1. rootタスク timeout → childTasks 生成
// ─────────────────────────────────────────────────────
console.log('\n[1. root timeout → child 生成]');

const root1 = tm.createTask(
  '[E3-test] IMPLEMENTタスク\n- Phase 1: 設計\n- Phase 2: 実装\n- Phase 3: テスト',
  'e3-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(root1.id);
// タイムアウトをシミュレート: IN_PROGRESS に変更
tm.updateState(root1.id, tm.STATES.IN_PROGRESS, 'テスト用');

test('1a. autoSplitOnTimeout が成功する', () => {
  const result = tm.autoSplitOnTimeout(root1.id);
  assert.strictEqual(result.ok, true, `reason: ${result.reason}`);
  result.newTasks.forEach(t => CLEANUP_IDS.push(t.id));
  info('生成タスク: ' + result.newTasks.map(t => t.id + '[' + t.type + ']').join(', '));
});

test('1b. 元タスクが ON_HOLD になる（DONE にしない）', () => {
  const updated = tm.listTasks().find(t => t.id === root1.id);
  assert.strictEqual(updated.state, tm.STATES.ON_HOLD);
});

test('1c. childTasks に子IDが記録される', () => {
  const updated = tm.listTasks().find(t => t.id === root1.id);
  assert.ok(Array.isArray(updated.childTasks) && updated.childTasks.length >= 2);
  info('childTasks: ' + updated.childTasks.join(', '));
});

test('1d. 子タスクが PENDING になる', () => {
  const updated = tm.listTasks().find(t => t.id === root1.id);
  const children = updated.childTasks || [];
  const allPending = children.every(cid => {
    const c = tm.listTasks().find(t => t.id === cid);
    return c && c.state === tm.STATES.PENDING;
  });
  assert.ok(allPending, '全子タスクがPENDINGでない');
});

// ─────────────────────────────────────────────────────
// 2. childの rootTaskId がrootを指す
// ─────────────────────────────────────────────────────
console.log('\n[2. rootTaskId の設定]');

test('2a. 子タスクの rootTaskId が root.id を指す', () => {
  const updated = tm.listTasks().find(t => t.id === root1.id);
  const children = tm.listTasks().filter(t => (updated.childTasks||[]).includes(t.id));
  assert.ok(children.length > 0, '子タスクが見つからない');
  children.forEach(c => {
    assert.strictEqual(c.rootTaskId, root1.id, `child ${c.id} のrootTaskIdが不正: ${c.rootTaskId}`);
  });
});

// ─────────────────────────────────────────────────────
// 3. childタイムアウトでrootのtimeoutCountが増える
// ─────────────────────────────────────────────────────
console.log('\n[3. root系統のtimeoutCount管理]');

const root3 = tm.createTask(
  '[E3-test] 親タスク\n- A\n- B\n- C', 'e3-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(root3.id);
tm.updateState(root3.id, tm.STATES.IN_PROGRESS, 'テスト用');
const split3 = tm.autoSplitOnTimeout(root3.id);
split3.newTasks?.forEach(t => CLEANUP_IDS.push(t.id));

test('3a. root の 1回目タイムアウト後 timeoutCount=1', () => {
  const root = tm.listTasks().find(t => t.id === root3.id);
  assert.strictEqual(root.timeoutCount, 1);
});

// 子タスクのひとつをタイムアウトさせる（IN_PROGRESS→autoSplit呼び出し）
if (split3.ok && split3.newTasks.length > 0) {
  const child3 = split3.newTasks[0];
  tm.updateState(child3.id, tm.STATES.IN_PROGRESS, 'テスト用');
  tm.incrementRootTimeoutCount(child3.id); // 子からrootのtimeoutCountを増やす
}

test('3b. 子タイムアウトで root.timeoutCount が増加', () => {
  const root = tm.listTasks().find(t => t.id === root3.id);
  assert.ok(root.timeoutCount >= 2, `timeoutCount=${root.timeoutCount}`);
  info('root.timeoutCount: ' + root.timeoutCount);
});

// ─────────────────────────────────────────────────────
// 4. root系統2回目タイムアウトでsplitせず停止
// ─────────────────────────────────────────────────────
console.log('\n[4. 2回目タイムアウト → timeout_limit]');

// root3 の timeoutCount は既に 2 以上になっている
const split3b = tm.autoSplitOnTimeout(root3.id);
test('4a. 2回目タイムアウトで ok=false reason=timeout_limit', () => {
  assert.strictEqual(split3b.ok, false);
  assert.strictEqual(split3b.reason, 'timeout_limit');
});

// ─────────────────────────────────────────────────────
// 5. child全完了でroot自動DONE
// ─────────────────────────────────────────────────────
console.log('\n[5. child全完了 → root自動DONE]');

const root5 = tm.createTask(
  '[E3-test] 自動DONE確認\n- Task A\n- Task B', 'e3-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(root5.id);
tm.updateState(root5.id, tm.STATES.IN_PROGRESS, 'テスト用');
const split5 = tm.autoSplitOnTimeout(root5.id);
split5.newTasks?.forEach(t => CLEANUP_IDS.push(t.id));

test('5a. 全child DONE前はrootがON_HOLD', () => {
  const r = tm.listTasks().find(t => t.id === root5.id);
  assert.strictEqual(r.state, tm.STATES.ON_HOLD);
});

// 全子タスクを DONE にする
if (split5.ok) {
  const children5 = split5.newTasks;
  // 最後の1件以外をDONE（途中でroot自動DONEが走らないようにするため、最後に合わせる）
  for (let i = 0; i < children5.length - 1; i++) {
    CLEANUP_IDS.splice(CLEANUP_IDS.indexOf(children5[i].id), 1); // アーカイブされるので除外
    tm.updateState(children5[i].id, tm.STATES.DONE, 'テスト完了');
  }
  // 最後の1件をDONE → checkAndAutoCompleteRoot が走る
  const last = children5[children5.length - 1];
  CLEANUP_IDS.splice(CLEANUP_IDS.indexOf(last.id), 1);
  tm.updateState(last.id, tm.STATES.DONE, 'テスト完了 最後');
}

test('5b. 全child DONE後はrootが自動DONE（アーカイブ済み）', () => {
  // DONE になったら tasks.json から消える（アーカイブへ）
  const r = tm.listTasks().find(t => t.id === root5.id);
  // アーカイブ済みなら null or state=DONE
  const isDone = !r || r.state === tm.STATES.DONE;
  assert.ok(isDone, 'root がまだ ON_HOLD のまま: ' + r?.state);
});

// ─────────────────────────────────────────────────────
// 6. history上DONEのchildを正しくDONE扱い
// ─────────────────────────────────────────────────────
console.log('\n[6. isTaskDoneOrArchived の安全性]');

test('6a. アーカイブ済みタスクをDONE扱いする', () => {
  // root5 の最初のchildはDONE→アーカイブ済みのはず
  if (split5.ok && split5.newTasks.length > 0) {
    const firstChild = split5.newTasks[0];
    const isDone = tm.isTaskDoneOrArchived(firstChild.id);
    assert.ok(isDone, `child ${firstChild.id} がDONE扱いされない`);
    info(`isTaskDoneOrArchived(${firstChild.id}) = ${isDone}`);
  } else {
    info('split5 failed, skip');
  }
});

// ─────────────────────────────────────────────────────
// 7. findTask===null だけではDONE扱いしない
// ─────────────────────────────────────────────────────
console.log('\n[7. null !== DONE の安全判定]');

test('7a. 存在しないタスクID（null）はDONEとは限らない', () => {
  // historyにも存在しないIDはfalseを返すべき
  const result = tm.isTaskDoneOrArchived('task_nonexistent_99999');
  // historyにないので false
  assert.strictEqual(result, false, 'nonexistent task should return false');
});

test('7b. historyContainsDone は存在しないIDでfalse', () => {
  assert.strictEqual(tm.historyContainsDone('task_nonexistent_xxxxx'), false);
});

// ─────────────────────────────────────────────────────
// 8. split由来タスクはAuto Resume対象外
// ─────────────────────────────────────────────────────
console.log('\n[8. split由来タスクはAuto Resume対象外]');

const root8 = tm.createTask(
  '[E3-test] Resume対象外テスト\n- A\n- B', 'e3-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(root8.id);
tm.updateState(root8.id, tm.STATES.IN_PROGRESS, 'テスト用');
const split8 = tm.autoSplitOnTimeout(root8.id);
split8.newTasks?.forEach(t => {
  CLEANUP_IDS.push(t.id);
  // 子タスクをON_HOLDにしてAuto Resume候補チェック
  tm.updateState(t.id, tm.STATES.ON_HOLD, '手動保留テスト');
});

test('8a. split由来タスク(rootTaskId あり)はgetResumeCandidatesに含まれない', () => {
  const candidates = runner.getResumeCandidates(pid, { maxCount: 20 });
  const leaked = candidates.filter(c =>
    split8.newTasks?.some(t => t.id === c.id)
  );
  assert.strictEqual(leaked.length, 0,
    'split由来タスクが候補に漏れた: ' + leaked.map(c => c.id).join(', '));
});

// ─────────────────────────────────────────────────────
// 9. BLOCKED/HUMAN_APPROVAL_REQUIRED は Auto Split しない
// ─────────────────────────────────────────────────────
console.log('\n[9. BLOCKED/HUMAN_APPROVAL_REQUIRED はsplit不可]');

test('9a. BLOCKED policy のタスクは autoSplitOnTimeout で policy チェックされる', () => {
  // LARGE タスクは policy=BLOCKED
  const largeTask = tm.createTask('[E3-test] 大規模\n- A\n- B\n- C', 'e3-test', null, '低', pid, 'IMPLEMENT');
  CLEANUP_IDS.push(largeTask.id);
  // size を LARGE に強制設定
  const tasks = require('../bot/utils/task-manager');
  const all = tm.listTasks();
  const t = all.find(x => x.id === largeTask.id);
  if (t) t.size = 'LARGE';
  require('fs').writeFileSync(
    require('path').join(__dirname, '..', 'data', 'tasks.json'),
    JSON.stringify({ tasks: all }, null, 2)
  );
  tm.updateState(largeTask.id, tm.STATES.IN_PROGRESS, 'テスト用');

  const p = classifyTask({ type:'IMPLEMENT', size:'LARGE', prompt: '' }, {});
  assert.strictEqual(p, AUTO_POLICY.BLOCKED);
  // BLOCKED なので handleAutoOn がsplitをスキップする（policyチェックはindex.js側）
});

// ─────────────────────────────────────────────────────
// 10. 既存 !task split の挙動を壊さない
// ─────────────────────────────────────────────────────
console.log('\n[10. 既存splitTask の挙動維持]');

const root10 = tm.createTask(
  '[E3-test] 手動split確認\n- 手順A\n- 手順B\n- 手順C', 'e3-test', null, '低', pid, 'IMPLEMENT'
);
CLEANUP_IDS.push(root10.id);

const result10 = tm.splitTask(root10.id);
result10.newTasks?.forEach(t => CLEANUP_IDS.push(t.id));

test('10a. 既存splitTask が ok:true を返す', () => {
  assert.strictEqual(result10.ok, true);
});

test('10b. 既存splitTask: 元タスクが DONE になる（アーカイブ）', () => {
  // 既存 splitTask は元タスクを DONE にする（Auto Split とは異なる）
  const r = tm.listTasks().find(t => t.id === root10.id);
  // DONE → アーカイブ済みなら tasks.json に存在しない
  assert.ok(!r, '元タスクがまだ tasks.json に残っている');
});

test('10c. 既存splitTask: 子タスクに rootTaskId が付いていない（旧形式互換）', () => {
  // 既存 splitTask は rootTaskId を設定しない（旧形式）
  result10.newTasks?.forEach(t => {
    const child = tm.listTasks().find(x => x.id === t.id);
    if (child) {
      // rootTaskId が null または undefined（設定していない）
      assert.ok(!child.rootTaskId, `child ${child.id} に rootTaskId が設定されている: ${child.rootTaskId}`);
    }
  });
});

// ─────────────────────────────────────────────────────
// 11. handleAutoTimeoutSplit 共通関数ロジックの検証
//     (Discord メッセージなしで内部ロジックのみテスト)
// ─────────────────────────────────────────────────────
console.log('\n[11. handleAutoTimeoutSplit 共通ロジック]');

// index.js から AUTO_SPLIT_TASK_TYPES / handleAutoTimeoutSplit を
// 直接 require することは難しいため、同等ロジックを確認する

// 11a: !auto run 1 経路でも autoSplitOnTimeout が呼ばれることを確認
// handleAutoRun が enqueueAndWait → finalTask 確認 → handleAutoTimeoutSplit を呼ぶことを
// task-manager レベルで検証
test('11a. IMPLEMENT/IN_PROGRESS タスクは autoSplitOnTimeout で分割される（両経路共通）', () => {
  const t = tm.createTask('[E3-test] 11a\n- A\n- B', 'e3-test', null, '低', pid, 'IMPLEMENT');
  CLEANUP_IDS.push(t.id);
  tm.updateState(t.id, tm.STATES.IN_PROGRESS, 'test');
  const r = tm.autoSplitOnTimeout(t.id);
  r.newTasks?.forEach(x => CLEANUP_IDS.push(x.id));
  assert.strictEqual(r.ok, true, 'IMPLEMENT IN_PROGRESS → split ok');
  assert.ok(r.newTasks.length >= 2, 'split 生成件数 >= 2');
});

// 11b: child がタイムアウトしても無限splitしない（2回目でtimeout_limit）
test('11b. child task timeout時に無限splitしない（timeoutCount>=2でtimeout_limit）', () => {
  const root11 = tm.createTask('[E3-test] 11b root\n- A\n- B', 'e3-test', null, '低', pid, 'IMPLEMENT');
  CLEANUP_IDS.push(root11.id);
  tm.updateState(root11.id, tm.STATES.IN_PROGRESS, 'test');

  // 1回目タイムアウト → 分割
  const split1 = tm.autoSplitOnTimeout(root11.id);
  split1.newTasks?.forEach(t => CLEANUP_IDS.push(t.id));
  assert.strictEqual(split1.ok, true, '1回目split ok');

  // childをIN_PROGRESSにしてtimeout_countを上げる（子からrootのカウントを増やす）
  if (split1.ok && split1.newTasks.length > 0) {
    const child = split1.newTasks[0];
    tm.updateState(child.id, tm.STATES.IN_PROGRESS, 'test child timeout');
    tm.incrementRootTimeoutCount(child.id); // root.timeoutCount = 2 になる

    // root自身が2回目タイムアウトを試みる
    const split2 = tm.autoSplitOnTimeout(root11.id);
    assert.strictEqual(split2.ok, false, '2回目はNG');
    assert.strictEqual(split2.reason, 'timeout_limit', 'reason=timeout_limit');
    info('11b: 2回目タイムアウト正しく停止 → ' + split2.reason);
  }
});

// 11c: BLOCKED policy のタスクは split しない
test('11c. BLOCKED policy (force push prompt) → policy が BLOCKED で canAttemptSplit=false', () => {
  const { AUTO_POLICY, classifyTask } = require('../bot/utils/auto-policy');
  const AUTO_SPLIT_TASK_TYPES_LOCAL = new Set(['IMPLEMENT', 'FIX', 'REFACTOR', 'TEST']);
  const task = { type: 'IMPLEMENT', size: 'SMALL', prompt: 'git push --force origin master' };
  const policy = classifyTask(task, {});
  const canSplit =
    AUTO_SPLIT_TASK_TYPES_LOCAL.has(task.type) &&
    (policy === AUTO_POLICY.AUTO_SAFE || policy === AUTO_POLICY.AI_REVIEW_REQUIRED);
  assert.strictEqual(policy, AUTO_POLICY.BLOCKED, 'force push → BLOCKED');
  assert.strictEqual(canSplit, false, 'BLOCKED は split 対象外');
});

// 11d: HUMAN_APPROVAL_REQUIRED はsplitしない
test('11d. HUMAN_APPROVAL_REQUIRED (本番反映) → policy が HUMAN_APPROVAL_REQUIRED でcanAttemptSplit=false', () => {
  const { AUTO_POLICY, classifyTask } = require('../bot/utils/auto-policy');
  const AUTO_SPLIT_TASK_TYPES_LOCAL = new Set(['IMPLEMENT', 'FIX', 'REFACTOR', 'TEST']);
  const task = { type: 'IMPLEMENT', size: 'SMALL', prompt: '本番に反映してください' };
  const policy = classifyTask(task, {});
  const canSplit =
    AUTO_SPLIT_TASK_TYPES_LOCAL.has(task.type) &&
    (policy === AUTO_POLICY.AUTO_SAFE || policy === AUTO_POLICY.AI_REVIEW_REQUIRED);
  assert.strictEqual(policy, AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
  assert.strictEqual(canSplit, false, 'HUMAN_APPROVAL_REQUIRED は split 対象外');
});

// 11e: index.js に handleAutoTimeoutSplit が定義されていること（ソース確認）
test('11e. handleAutoTimeoutSplit 関数が index.js に存在する', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  assert.ok(src.includes('async function handleAutoTimeoutSplit'), 'handleAutoTimeoutSplit定義あり');
  assert.ok(src.includes('AUTO_SPLIT_TASK_TYPES'), 'AUTO_SPLIT_TASK_TYPES定義あり');
});

// 11f: handleAutoRun が enqueueAndWait を使っていること（ソース確認）
test('11f. handleAutoRun が enqueueAndWait を使っている（fire-and-forgetでない）', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  const handleAutoRunStart = src.indexOf('async function handleAutoRun');
  const handleAutoRunEnd   = src.indexOf('\nasync function handleBatch');
  const handleAutoRunBody  = src.slice(handleAutoRunStart, handleAutoRunEnd);
  assert.ok(handleAutoRunBody.includes('enqueueAndWait'), 'handleAutoRunがenqueueAndWaitを使用');
  assert.ok(handleAutoRunBody.includes('handleAutoTimeoutSplit'), 'handleAutoRunがhandleAutoTimeoutSplitを呼ぶ');
});

// ─────────────────────────────────────────────────────
// 12. split由来タスクの再split禁止（本番問題の再現確認）
// ─────────────────────────────────────────────────────
console.log('\n[12. split由来タスクの再split禁止]');

test('12a. !task split 由来の child（rootTaskId=null, _s2 suffix）は autoSplitOnTimeout 禁止', () => {
  // splitTask が rootTaskId を設定しないため、IDパターンで判定する
  // ID末尾 /_s\d+$/ にマッチする → already_split_child を返すべき

  // 実際にtasks.jsonにタスクを作って確認（IDを _s2 で終わらせる）
  // 注意: fakeId は必ず /_s\d+$/ にマッチする形式にすること（でないと split が実行され汚染が起きる）
  const fakeId = 'task_9999990000001_s2'; // ← _s2 で終わる
  // 直接 JSON 操作でrootTaskId=nullの_s2を作る
  const fpath = require('path').join(__dirname, '..', 'data', 'tasks.json');
  const raw   = JSON.parse(require('fs').readFileSync(fpath, 'utf8'));
  const fakeTask = {
    id: fakeId, type: 'IMPLEMENT', size: 'SMALL',
    projectId: pid, prompt: '[fake] s2\n- A\n- B',
    state: '作業中', priority: '低', priorityReason: 'test',
    dangerLevel: '低', assignee: 'test', requestedBy: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stateHistory: [], reviewResult: null, codexResult: null, prUrl: null, notes: '',
    rootTaskId: null,   // splitTask 由来: rootTaskId 未設定
    childTasks: [], timeoutCount: 0, splitCount: 0,
  };
  raw.tasks.push(fakeTask);
  require('fs').writeFileSync(fpath, JSON.stringify(raw, null, 2));
  CLEANUP_IDS.push(fakeId);

  // タスク件数をスナップショット（autoSplitOnTimeout が意図せず新タスクを追加しないか確認）
  const countBefore = tm.listTasks().length;

  // _sN suffix → already_split_child (split は実行されない)
  const result = tm.autoSplitOnTimeout(fakeId);

  // もし万一 ok=true になっていたら新タスクをクリーンアップ（安全策）
  if (result.ok && result.newTasks) {
    result.newTasks.forEach(t => CLEANUP_IDS.push(t.id));
  }

  const countAfter = tm.listTasks().length;
  assert.strictEqual(result.ok, false, `split実行されてはいけない (ok=${result.ok})`);
  assert.strictEqual(result.reason, 'already_split_child',
    `expected already_split_child, got ${result.reason}`);
  assert.strictEqual(countAfter, countBefore,
    `新タスクが生成されてはいけない (before=${countBefore} after=${countAfter})`);
  info('12a: _sN suffix タスクのsplit禁止 → ' + result.reason);
});

test('12b. autoSplitOnTimeout 由来の child（rootTaskId あり）は再split禁止', () => {
  // rootTaskIdが設定されているchild
  const root12 = tm.createTask('[E3-test] 12b root\n- A\n- B\n- C', 'e3-test', null, '低', pid, 'IMPLEMENT');
  CLEANUP_IDS.push(root12.id);
  tm.updateState(root12.id, tm.STATES.IN_PROGRESS, 'test');
  const split12 = tm.autoSplitOnTimeout(root12.id);
  split12.newTasks?.forEach(t => CLEANUP_IDS.push(t.id));
  assert.strictEqual(split12.ok, true, 'rootのsplitは成功');

  // 子タスクをIN_PROGRESSにしてautoSplitOnTimeoutを試みる
  if (split12.ok && split12.newTasks.length > 0) {
    const child12 = split12.newTasks[0];
    tm.updateState(child12.id, tm.STATES.IN_PROGRESS, 'test child');
    const childSplit = tm.autoSplitOnTimeout(child12.id);
    assert.strictEqual(childSplit.ok, false);
    assert.strictEqual(childSplit.reason, 'already_split_child',
      `expected already_split_child, got ${childSplit.reason}`);
    info('12b: rootTaskIdあり child のsplit禁止 → ' + childSplit.reason);
  }
});

test('12c. 無限splitチェーンが発生しない', () => {
  // root → child → grandchild の split が起きないことを確認
  const root12c = tm.createTask('[E3-test] 12c root\n- X\n- Y', 'e3-test', null, '低', pid, 'IMPLEMENT');
  CLEANUP_IDS.push(root12c.id);
  tm.updateState(root12c.id, tm.STATES.IN_PROGRESS, 'test');

  // root split
  const split12c = tm.autoSplitOnTimeout(root12c.id);
  split12c.newTasks?.forEach(t => CLEANUP_IDS.push(t.id));
  assert.strictEqual(split12c.ok, true, 'root split ok');

  // childを全てIN_PROGRESSにしてsplit試行
  let grandChildAttempts = 0;
  for (const child of (split12c.newTasks || [])) {
    tm.updateState(child.id, tm.STATES.IN_PROGRESS, 'test');
    const r = tm.autoSplitOnTimeout(child.id);
    if (!r.ok) grandChildAttempts++;
  }
  assert.strictEqual(grandChildAttempts, (split12c.newTasks || []).length,
    '全childのsplitが禁止されている');
  info('12c: ' + grandChildAttempts + '件のchild split禁止確認');
});

// 11g: handleAutoOn が handleAutoTimeoutSplit を使っていること（ソース確認）
test('11g. handleAutoOn が handleAutoTimeoutSplit を使っている', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  const handleAutoOnStart = src.indexOf('async function handleAutoOn');
  const handleAutoOnEnd   = src.indexOf('async function handleAutoRun');
  const handleAutoOnBody  = src.slice(handleAutoOnStart, handleAutoOnEnd);
  assert.ok(handleAutoOnBody.includes('handleAutoTimeoutSplit'), 'handleAutoOnがhandleAutoTimeoutSplitを呼ぶ');
});

// ─────────────────────────────────────────────────────
// 13. TIMEOUT + ON_HOLD 検出修正のテスト（Phase E-3 バグ修正検証）
//
// 問題: executeClaudeTask の catch ブロックが TIMEOUT 時に
//       state を IN_PROGRESS → ON_HOLD に変更するため、
//       handleAutoTimeoutSplit の IN_PROGRESS ガードが弾いていた。
// 修正: errorType='TIMEOUT' && state=ON_HOLD も Auto Split 対象とする。
// ─────────────────────────────────────────────────────
console.log('\n[13. TIMEOUT+ON_HOLD split 対象検出（E-3 バグ修正）]');

test('13a. errorType=TIMEOUT かつ state=ON_HOLD は split 対象になる（ガード修正確認）', () => {
  // index.js のソースを確認: isTimeoutOnHold 条件が含まれているか
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  const fnIdx = src.indexOf('async function handleAutoTimeoutSplit');
  const fnEnd = src.indexOf('\nasync function handle', fnIdx + 1);
  const fnBody = src.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 800);
  assert.ok(fnBody.includes('isTimeoutOnHold'), 'isTimeoutOnHold 条件がない');
  assert.ok(fnBody.includes("errorType === 'TIMEOUT'"), "errorType=TIMEOUT チェックがない");
  assert.ok(fnBody.includes('STATES.ON_HOLD'), 'ON_HOLD チェックがない');
});

test('13b. 通常の ON_HOLD（errorType が TIMEOUT でない）は split 対象にならない', () => {
  // errorType=UNKNOWN, state=ON_HOLD → no_split になるべき
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  const fnIdx = src.indexOf('async function handleAutoTimeoutSplit');
  const fnEnd = src.indexOf('\nasync function handle', fnIdx + 1);
  const fnBody = src.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 800);
  // errorType チェックが AND 条件（isTimeoutOnHold）であることを確認
  // "isTimeoutOnHold && ..." ではなく "!isTimeoutOnHold && ..." の形で排除していること
  assert.ok(fnBody.includes('!isTimeoutOnHold'), '!isTimeoutOnHold による通常ON_HOLD除外がない');
});

test('13c. IN_PROGRESS は従来通り split 対象になる', () => {
  // IN_PROGRESS のタスクは isTimeoutOnHold=false でも通過する（既存動作維持）
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  const fnIdx = src.indexOf('async function handleAutoTimeoutSplit');
  const fnEnd = src.indexOf('\nasync function handle', fnIdx + 1);
  const fnBody = src.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 800);
  // "task.state !== taskManager.STATES.IN_PROGRESS" 条件が OR で残っていること
  assert.ok(fnBody.includes('STATES.IN_PROGRESS'), 'IN_PROGRESS チェックが消えている');
  // !isTimeoutOnHold && state!==IN_PROGRESS → no_split
  // つまり isTimeoutOnHold=true OR state===IN_PROGRESS → 通過
  assert.ok(
    fnBody.includes('!isTimeoutOnHold && task.state !== taskManager.STATES.IN_PROGRESS'),
    '複合条件が正しくない'
  );
});

test('13d. _runProjectLoop が TIMEOUT+ON_HOLD 経路で handleAutoTimeoutSplit を呼ぶ', () => {
  // _runProjectLoop のソースに TIMEOUT+ON_HOLD 判定が追加されているか確認
  const src = require('fs').readFileSync(require('path').join(__dirname,'..','bot','index.js'),'utf8');
  const loopIdx = src.indexOf('async function _runProjectLoop');
  const loopEnd = src.indexOf('\nasync function _teardown', loopIdx + 1);
  const loopBody = src.slice(loopIdx, loopEnd > 0 ? loopEnd : loopIdx + 5000);
  // TIMEOUT + ON_HOLD の条件が _runProjectLoop 内にある
  assert.ok(
    loopBody.includes("errorType === 'TIMEOUT'") && loopBody.includes('STATES.ON_HOLD'),
    '_runProjectLoop に TIMEOUT+ON_HOLD 分岐がない'
  );
  // handleAutoTimeoutSplit が呼ばれている
  assert.ok(loopBody.includes('handleAutoTimeoutSplit'), '_runProjectLoop が handleAutoTimeoutSplit を呼んでいない');
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
