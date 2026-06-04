'use strict';
// operation-watch.js テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const ow  = require('../bot/utils/operation-watch');
const wsm = require('../bot/utils/worker-status');
const ib  = require('../bot/utils/inbox-bridge');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function cleanWorkerStatus() { wsm._save({}); }
function cleanOutbox() {
  for (const w of ib.VALID_WORKERS) {
    try { const p = ib._workerOutboxPath(w); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    try { const p = ib._workerInboxPath(w);  if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

// ─────────────────────────────────────────────────────
// 1. runWatch — 全体動作
// ─────────────────────────────────────────────────────
console.log('\n[1. runWatch — 全体動作]');

test('1a. runWatch が ok:true を返す', () => {
  const r = ow.runWatch();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 0);
  assert.ok(typeof r.totalFindings === 'number');
});

test('1b. 出力に必須セクションが含まれる', () => {
  const r = ow.runWatch();
  assert.ok(r.text.includes('Operation Watch'), 'タイトルがない');
  assert.ok(r.text.includes('黒川は「検出まで」'), '禁止事項注記がない');
});

// ─────────────────────────────────────────────────────
// 2. 停止社員検出
// ─────────────────────────────────────────────────────
console.log('\n[2. 停止社員検出]');

test('2a. ブロック中の社員を検出する', () => {
  cleanWorkerStatus();
  wsm.updateStatus('miyagi', 'blocked', { taskId: 'task_xxx', note: 'テストブロック' });

  const findings = ow._checkStuckWorkers();
  const blocked  = findings.filter(f => f.severity === 'high');
  assert.ok(blocked.length > 0, 'ブロック社員が検出されない');
  assert.ok(blocked[0].finding.includes('宮城'), '宮城が含まれていない');
  cleanWorkerStatus();
});

test('2b. 正常な社員はエラーとして検出されない', () => {
  cleanWorkerStatus();
  wsm.updateStatus('miyagi', 'idle');
  const findings = ow._checkStuckWorkers();
  const miyagiHighIssues = findings.filter(f => f.severity === 'high' && f.finding.includes('宮城'));
  assert.strictEqual(miyagiHighIssues.length, 0, 'idle 社員が high として検出された');
  cleanWorkerStatus();
});

// ─────────────────────────────────────────────────────
// 3. 未確認 inbox 検出
// ─────────────────────────────────────────────────────
console.log('\n[3. 未確認 inbox 検出]');

test('3a. 内容のある inbox を検出する', () => {
  cleanOutbox();
  // miyagi の inbox にメッセージを書く
  const inPath = ib._workerInboxPath('miyagi');
  const dir    = path.dirname(inPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(inPath, '作業完了しました。'.repeat(5), 'utf8');

  const findings = ow._checkUnreadInbox();
  const miyagiIn = findings.filter(f => f.finding.includes('宮城') && f.category === '未確認inbox');
  assert.ok(miyagiIn.length > 0, '宮城の未確認 inbox が検出されない');
  cleanOutbox();
});

test('3b. 空の inbox はスキップされる', () => {
  cleanOutbox();
  const findings = ow._checkUnreadInbox();
  // outbox/inbox が全部空 → inbox関連の findings はなし
  const inboxFindings = findings.filter(f => f.category === '未確認inbox');
  assert.strictEqual(inboxFindings.length, 0, '空 inbox が誤検出された');
});

// ─────────────────────────────────────────────────────
// 4. 長期未更新 Decision 検出
// ─────────────────────────────────────────────────────
console.log('\n[4. 長期未更新 Decision 検出]');

test('4a. 90日以上前の Decision を検出する', () => {
  const dl = require('../bot/utils/decision-log');
  const orig = dl._load();

  // 古い Decision を一時注入
  const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const tmpList = [{
    id: 'dec_old_test', type: 'DECISION', createdAt: oldDate,
    title: '古いテスト Decision', status: 'active', severity: 'LOW',
    summary: '', refs: [], tags: [], data: {}, supersededBy: null, category: null,
  }];
  dl._save([...orig, ...tmpList]);

  const findings = ow._checkStaleDecisions();
  assert.ok(findings.length > 0, '古い Decision が検出されない');
  assert.ok(findings[0].severity === 'low', '重要度が違う');

  // 後処理
  dl._save(orig);
});

// ─────────────────────────────────────────────────────
// 5. 機能使用状況
// ─────────────────────────────────────────────────────
console.log('\n[5. 機能使用状況]');

test('5a. _checkUnusedFeatures が配列を返す', () => {
  const findings = ow._checkUnusedFeatures();
  assert.ok(Array.isArray(findings), '配列でない');
});

// ─────────────────────────────────────────────────────
// 6. Lesson 未登録候補
// ─────────────────────────────────────────────────────
console.log('\n[6. Lesson 未登録候補]');

test('6a. 対応内容なし RESOLVED Incident を検出する', () => {
  const im   = require('../bot/utils/incident-manager');
  const orig = im._load();

  // 対応内容なし RESOLVED を一時注入
  const tmpInc = [{
    id: 'inc_test_lesson', type: 'INCIDENT', createdAt: new Date().toISOString(),
    title: 'Lesson未登録テスト', status: 'RESOLVED',
    summary: '', refs: [], tags: [], severity: 'MEDIUM', projectId: 'test',
    data: { detectedAt: null, resolvedAt: new Date().toISOString(),
            rootCause: '', mitigation: '', prevention: '', affectedArea: [] },
  }];
  im._save([...orig, ...tmpInc]);

  const findings = ow._checkMissingLessons();
  assert.ok(findings.length > 0, 'Lesson未登録が検出されない');

  im._save(orig);
});

// ─────────────────────────────────────────────────────
// 7. 禁止事項の確認
// ─────────────────────────────────────────────────────
console.log('\n[7. 禁止事項確認]');

test('7a. operation-watch.js に eval / exec がない', () => {
  const watchSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operation-watch.js'), 'utf8'
  );
  const code = watchSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('eval('),    'eval が含まれている');
  assert.ok(!code.includes('execSync('),'execSync が含まれている');
});

test('7b. 削除・変更・承認コードがない', () => {
  const watchSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'operation-watch.js'), 'utf8'
  );
  const code = watchSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('fs.unlinkSync('),    '削除コードがある');
  assert.ok(!code.includes('createTask('),       'createTask が呼ばれている');
  assert.ok(!code.includes('updateState('),      'updateState が呼ばれている');
  assert.ok(!code.includes('archiveDecision('),  'archiveDecision が呼ばれている');
});

test('7c. 出力に「黒川は検出まで」の注意書きがある', () => {
  const r = ow.runWatch();
  assert.ok(r.text.includes('黒川は「検出まで」'), '注意書きがない');
});

// ─────────────────────────────────────────────────────
// 8. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[8. index.js 統合確認]');

test("8a. !kurokawa watch が実装されている", () => {
  assert.ok(src.includes("kurSub === 'watch'"), '!kurokawa watch がない');
});

test('8b. operation-watch.js を require している', () => {
  const idx  = src.indexOf("kurSub === 'watch'");
  const area = src.slice(idx, idx + 200);
  assert.ok(area.includes("require('./utils/operation-watch')"), 'require がない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanWorkerStatus();
cleanOutbox();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
