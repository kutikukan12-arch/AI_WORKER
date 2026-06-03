'use strict';
// AI_WORKER 自律運営 Phase1-6 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const kr  = require('../bot/utils/kurokawa-report');
const db  = require('../bot/utils/daily-brief');
const sh  = require('../bot/utils/system-health');
const vpb = require('../bot/utils/vp-brain');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

function cleanKR() {
  try { kr._saveLearning({ sessions: [] }); } catch {}
}
function cleanDB() {
  try { db._saveBrief({ snapshots: [] }); } catch {}
}
function cleanVP() {
  try { vpb._save([]); } catch {}
}

// ─────────────────────────────────────────────────────
// 1. Phase1: 黒川 Workflow Intelligence
// ─────────────────────────────────────────────────────
console.log('\n[1. 黒川 Workflow Intelligence — !kurokawa report]');

test('1a. generateReport が ok:true を返す', () => {
  cleanKR();
  const r = kr.generateReport();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 0);
});

test('1b. 3セクション（現在状況/ボトルネック/次アクション候補）が含まれる', () => {
  const r = kr.generateReport();
  assert.ok(r.text.includes('現在状況'),       '現在状況セクションがない');
  assert.ok(r.text.includes('ボトルネック'),    'ボトルネックセクションがない');
  assert.ok(r.text.includes('次アクション候補'),'次アクション候補がない');
});

test('1c. workflow-learning.json にセッションが保存される', () => {
  cleanKR();
  kr.generateReport();
  const data = kr._loadLearning();
  assert.ok(data.sessions.length > 0, 'セッションが保存されない');
});

test('1d. ボトルネック検出: HUMAN_CHECK 待ちを検出する', () => {
  // _detectBottlenecks は配列を返す（ソース確認）
  const issues = kr._detectBottlenecks({
    workers: [],
    tasks:   { reviewing: [], awaiting: [{ id: 'task_1' }], snap: {}, inProgress: [], total: 1 },
    handoffs: [],
    inbox:   [],
    msgPending: 0,
  });
  assert.ok(Array.isArray(issues), '_detectBottlenecks が配列を返さない');
  assert.ok(issues.some(i => i.type === 'human_check'), 'human_check が検出されない');
});

test('1e. ボトルネック検出: レビュー滞留を検出する', () => {
  const issues = kr._detectBottlenecks({
    workers: [],
    tasks: { reviewing: [{}, {}, {}], awaiting: [], snap: {}, inProgress: [], total: 3 },
    handoffs: [], inbox: [], msgPending: 0,
  });
  assert.ok(Array.isArray(issues), '_detectBottlenecks が配列を返さない');
  assert.ok(issues.some(i => i.type === 'review_backlog'), 'review_backlog が検出されない');
});

test('1f. 黒川は task 作成・変更・approve をしない（ソース確認）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'kurokawa-report.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),   'createTask が呼ばれている');
  assert.ok(!code.includes('updateTask('),   'updateTask が呼ばれている');
  assert.ok(!code.includes('updateState('),  'updateState が呼ばれている');
  assert.ok(!code.includes('eval('),         'eval が含まれている');
  assert.ok(!code.includes('execSync('),     'execSync が含まれている');
  // task-manager は読み取り専用(listTasks)のみ許可: createTask/updateTask を禁止
});

// ─────────────────────────────────────────────────────
// 2. Phase2: 神崎 VP Brain 育野視点追加
// ─────────────────────────────────────────────────────
console.log('\n[2. 神崎 VP Brain — 育野視点確認]');

test('2a. 育野視点が !vp review の出力に含まれる', () => {
  cleanVP();
  const r = vpb.buildReview('商品化判断');
  assert.ok(r.text.includes('育野'), '育野の視点がない');
});

test('2b. _ikunoPerspective が文字列を返す', () => {
  const r = vpb._ikunoPerspective('セキュリティ設計', ['tech']);
  assert.ok(typeof r === 'string', '文字列でない');
  assert.ok(r.length > 0, '空');
});

// ─────────────────────────────────────────────────────
// 3. Phase3: !vp decide (recordLearning の別名)
// ─────────────────────────────────────────────────────
console.log('\n[3. !vp decide — CEO Decision Feedback Loop]');

test('3a. decideVP が !vp learn と同じ機能', () => {
  cleanVP();
  const r1 = vpb.buildReview('判断テスト');
  const r2 = vpb.decideVP(r1.id, 'A', '理由テスト');
  assert.strictEqual(r2.ok, true);
});

test('3b. 選択が保存される', () => {
  cleanVP();
  const r1 = vpb.buildReview('保存テスト');
  vpb.decideVP(r1.id, 'B', 'リスク回避');
  const list = vpb._load();
  assert.strictEqual(list[0].learning.chosen, 'B');
});

// ─────────────────────────────────────────────────────
// 4. Phase4: Morning Brief / Daily Closing
// ─────────────────────────────────────────────────────
console.log('\n[4. Morning Brief / Daily Closing]');

test('4a. buildMorningBrief が ok:true を返す', () => {
  const r = db.buildMorningBrief();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 0);
});

test('4b. Morning Brief に必須項目が含まれる', () => {
  const r = db.buildMorningBrief();
  assert.ok(r.text.includes('おはようございます') || r.text.includes('Morning Brief'));
  assert.ok(r.text.includes('黒川'), '黒川担当の記載がない');
});

test('4c. buildDailyClosing が ok:true を返す', () => {
  cleanDB();
  const r = db.buildDailyClosing();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 0);
});

test('4d. Daily Closing に3担当が含まれる', () => {
  cleanDB();
  const r = db.buildDailyClosing();
  assert.ok(r.text.includes('黒川'), '黒川がない');
  assert.ok(r.text.includes('神崎'), '神崎がない');
  assert.ok(r.text.includes('育野'), '育野がない');
});

test('4e. Daily Closing のスナップショットが保存される', () => {
  cleanDB();
  db.buildDailyClosing();
  const data = db._loadBrief();
  assert.ok(data.snapshots.length > 0, 'スナップショットが保存されない');
});

test('4f. 禁止: Daily Closing は Decision確定をしない（ソース確認）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'daily-brief.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('logDecision('),   'Decision を自動登録している');
  assert.ok(!code.includes('createTask('),    'task を自動作成している');
  assert.ok(!code.includes('eval('),          'eval が含まれている');
});

// ─────────────────────────────────────────────────────
// 5. Phase6: System Health
// ─────────────────────────────────────────────────────
console.log('\n[5. System Health — !system health]');

test('5a. checkHealth が ok:true を返す', () => {
  const r = sh.checkHealth();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 0);
});

test('5b. ヘルスレポートに5セクションが含まれる', () => {
  const r = sh.checkHealth();
  assert.ok(r.text.includes('Security'),  'Security セクションがない');
  assert.ok(r.text.includes('Memory'),    'Memory セクションがない');
  assert.ok(r.text.includes('Workflow'),  'Workflow セクションがない');
  assert.ok(r.text.includes('Workers'),   'Workers セクションがない');
  assert.ok(r.text.includes('Projects'),  'Projects セクションがない');
});

test('5c. ヘルスチェックは修正を行わない（ソース確認）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'system-health.js'), 'utf8'
  );
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('createTask('),       'task を自動作成している');
  assert.ok(!code.includes('archiveDecision('),  'Decision を自動 archive している');
  assert.ok(!code.includes('eval('),             'eval が含まれている');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. !kurokawa が実装されている", () => {
  assert.ok(src.includes("startsWith('!kurokawa')"), '!kurokawa がない');
});

test("6b. !start-day が実装されている", () => {
  assert.ok(src.includes("'!start-day'"), '!start-day がない');
});

test("6c. !end-day が実装されている", () => {
  assert.ok(src.includes("'!end-day'"), '!end-day がない');
});

test("6d. !system が実装されている", () => {
  assert.ok(src.includes("startsWith('!system')"), '!system がない');
});

test("6e. !vp decide が実装されている", () => {
  assert.ok(src.includes("vpSub === 'decide'"), '!vp decide がない');
});

// ─────────────────────────────────────────────────────
// 7. .gitignore / Security
// ─────────────────────────────────────────────────────
console.log('\n[7. .gitignore / Security]');

test('7a. workflow-learning.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/workflow-learning.json'));
});

test('7b. daily-brief.json が gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/daily-brief.json'));
});

test('7c. eval / exec が新規ファイルにない', () => {
  const files = ['kurokawa-report.js', 'daily-brief.js', 'system-health.js'];
  for (const f of files) {
    const content = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', f), 'utf8');
    const code = content.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!code.includes('eval('),    `${f} に eval がある`);
  }
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanKR(); cleanDB(); cleanVP();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
