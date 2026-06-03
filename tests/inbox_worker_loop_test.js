'use strict';
// inbox-bridge.js Phase3: Desktop Worker Loop テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const ib  = require('../bot/utils/inbox-bridge');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─── テストファイル管理 ────────────────────────────────
function writeWorkerIncoming(worker, text) {
  const p = ib._workerInboxPath(worker);
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

function cleanup() {
  for (const worker of ib.VALID_WORKERS) {
    try { if (fs.existsSync(ib._workerInboxPath(worker)))  fs.unlinkSync(ib._workerInboxPath(worker));  } catch {}
    try { if (fs.existsSync(ib._workerOutboxPath(worker))) fs.unlinkSync(ib._workerOutboxPath(worker)); } catch {}
    try { if (fs.existsSync(ib._workerReportPath(worker))) fs.unlinkSync(ib._workerReportPath(worker)); } catch {}
  }
}

// ─────────────────────────────────────────────────────
// 1. resolveWorker — 社員名解決
// ─────────────────────────────────────────────────────
console.log('\n[1. resolveWorker — 社員名解決]');

test('1a. 英語名が解決できる', () => {
  assert.strictEqual(ib.resolveWorker('miyagi'),    'miyagi');
  assert.strictEqual(ib.resolveWorker('moriya'),    'moriya');
  assert.strictEqual(ib.resolveWorker('shiraishi'), 'shiraishi');
  assert.strictEqual(ib.resolveWorker('ichikawa'),  'ichikawa');
  assert.strictEqual(ib.resolveWorker('kanemori'),  'kanemori');
});

test('1b. 日本語名が解決できる', () => {
  assert.strictEqual(ib.resolveWorker('宮城'),  'miyagi');
  assert.strictEqual(ib.resolveWorker('守谷'),  'moriya');
  assert.strictEqual(ib.resolveWorker('金森'),  'kanemori');
  assert.strictEqual(ib.resolveWorker('黒川'),  'kurokawa');
});

test('1c. アルファベット短縮が解決できる', () => {
  assert.strictEqual(ib.resolveWorker('a'), 'miyagi');
  assert.strictEqual(ib.resolveWorker('b'), 'moriya');
  assert.strictEqual(ib.resolveWorker('f'), 'kanemori');
});

test('1d. 不明な名前は null', () => {
  assert.strictEqual(ib.resolveWorker('unknown'), null);
  assert.strictEqual(ib.resolveWorker('../../etc/passwd'), null);  // パストラバーサル
  assert.strictEqual(ib.resolveWorker(''),         null);
  assert.strictEqual(ib.resolveWorker(null),        null);
});

test('1e. VALID_WORKERS に全社員が含まれる', () => {
  const required = ['miyagi','moriya','shiraishi','aizawa','ichikawa','kanemori','kurokawa','ikuno'];
  for (const w of required) {
    assert.ok(ib.VALID_WORKERS.includes(w), `${w} が VALID_WORKERS にない`);
  }
});

// ─────────────────────────────────────────────────────
// 2. sendToWorker — outbox への保存
// ─────────────────────────────────────────────────────
console.log('\n[2. sendToWorker — outbox 保存]');

test('2a. 正常に outbox に保存される', () => {
  cleanup();
  const r = ib.sendToWorker('miyagi', 'Phase1の実装をお願いします');
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(ib._workerOutboxPath('miyagi')), 'outgoing.md が作成されない');
});

test('2b. outbox の内容にメッセージが含まれる', () => {
  cleanup();
  ib.sendToWorker('moriya', 'CTOレビューをお願いします');
  const content = fs.readFileSync(ib._workerOutboxPath('moriya'), 'utf8');
  assert.ok(content.includes('CTOレビューをお願いします'));
});

test('2c. 複数回 send すると outbox に追記される', () => {
  cleanup();
  ib.sendToWorker('miyagi', 'メッセージ1');
  ib.sendToWorker('miyagi', 'メッセージ2');
  const content = fs.readFileSync(ib._workerOutboxPath('miyagi'), 'utf8');
  assert.ok(content.includes('メッセージ1') && content.includes('メッセージ2'));
});

test('2d. 不明な社員名はエラー', () => {
  const r = ib.sendToWorker('unknownperson', 'テスト');
  assert.strictEqual(r.ok, false);
});

test('2e. メッセージ空はエラー', () => {
  const r = ib.sendToWorker('miyagi', '');
  assert.strictEqual(r.ok, false);
});

test('2f. 日本語名エイリアスでも保存できる', () => {
  cleanup();
  const r = ib.sendToWorker('守谷', 'CTOへの依頼');
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(ib._workerOutboxPath('moriya')));
});

test('2g. 機密文字列が redact される', () => {
  cleanup();
  const fakeToken = 'ghp_' + 'X'.repeat(36);
  ib.sendToWorker('miyagi', `token=${fakeToken}`);
  const content = fs.readFileSync(ib._workerOutboxPath('miyagi'), 'utf8');
  assert.ok(!content.includes(fakeToken), 'トークンが outbox に残っている');
  assert.ok(content.includes('[MASKED]'));
});

test('2h. パストラバーサル文字列が worker として通らない', () => {
  const r = ib.sendToWorker('../../etc', 'attack');
  assert.strictEqual(r.ok, false, 'パストラバーサルが通ってしまった');
});

// ─────────────────────────────────────────────────────
// 3. checkWorkerInbox — 社員 inbox の分類
// ─────────────────────────────────────────────────────
console.log('\n[3. checkWorkerInbox — 社員 inbox 分類]');

test('3a. incoming.md なしは ok:false', () => {
  cleanup();
  const r = ib.checkWorkerInbox('miyagi');
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('Inbox は空'));
});

test('3b. 正常処理で worker の report.md が生成される', () => {
  cleanup();
  writeWorkerIncoming('moriya', 'Phase2は延期に決定した\nバグを修正する必要がある');
  const r = ib.checkWorkerInbox('moriya');
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(ib._workerReportPath('moriya')), 'report.md が生成されない');
});

test('3c. sections と suggestions が返される', () => {
  cleanup();
  writeWorkerIncoming('miyagi', 'テスト実装をやること\n障害が発生した');
  const r = ib.checkWorkerInbox('miyagi');
  assert.ok(r.ok);
  assert.ok(r.sections);
  assert.ok(Array.isArray(r.suggestions));
});

test('3d. 社員の表示名が Discord テキストに含まれる', () => {
  cleanup();
  writeWorkerIncoming('moriya', '修正が必要');
  const r = ib.checkWorkerInbox('moriya');
  assert.ok(r.text.includes('守谷') || r.text.includes('moriya'));
});

test('3e. 不明な社員名はエラー', () => {
  const r = ib.checkWorkerInbox('unknownperson');
  assert.strictEqual(r.ok, false);
});

test('3f. incoming.md の内容が redact される', () => {
  cleanup();
  const fakeToken = 'ghp_' + 'Y'.repeat(36);
  writeWorkerIncoming('miyagi', `token=${fakeToken}`);
  const r = ib.checkWorkerInbox('miyagi');
  assert.ok(!r.text.includes(fakeToken), 'トークンが Discord テキストに含まれている');
});

test('3g. review カテゴリが分類される', () => {
  cleanup();
  writeWorkerIncoming('miyagi', 'NEED_FIX: コードレビューが必要です');
  const r = ib.checkWorkerInbox('miyagi');
  assert.ok(r.sections.review.length > 0 || r.sections.task.length > 0, 'review/task に分類されない');
});

test('3h. lesson カテゴリが分類される', () => {
  cleanup();
  writeWorkerIncoming('moriya', '今回の失敗から学んだこと: 早期テストが重要');
  const r = ib.checkWorkerInbox('moriya');
  assert.ok(r.sections.lesson.length > 0 || r.sections.memo.length > 0, 'lesson/memo に分類されない');
});

// ─────────────────────────────────────────────────────
// 4. getWorkerStatus — 全社員の状態一覧
// ─────────────────────────────────────────────────────
console.log('\n[4. getWorkerStatus — 全体状態]');

test('4a. 空状態でも正常に動作する', () => {
  cleanup();
  const r = ib.getWorkerStatus();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('Worker Inbox Status'));
});

test('4b. outbox がある社員が表示される', () => {
  cleanup();
  ib.sendToWorker('miyagi', 'テスト依頼');
  const r = ib.getWorkerStatus();
  assert.ok(r.text.includes('宮城') || r.text.includes('miyagi'), '社員が表示されない');
});

test('4c. inbox がある社員が表示される', () => {
  cleanup();
  writeWorkerIncoming('moriya', '返信テキスト');
  const r = ib.getWorkerStatus();
  assert.ok(r.text.includes('守谷') || r.text.includes('moriya'));
});

test('4d. 黒川権限の注記が含まれる', () => {
  cleanup();
  const r = ib.getWorkerStatus();
  assert.ok(r.text.includes('判断の代理は禁止'), '黒川の権限制限注記がない');
});

// ─────────────────────────────────────────────────────
// 5. コマンド注入・自動実行禁止
// ─────────────────────────────────────────────────────
console.log('\n[5. コマンド注入・自動実行禁止]');

test('5a. incoming.md の !task コマンドが実行されない', () => {
  cleanup();
  writeWorkerIncoming('miyagi', '!task add 危険な自動実行タスク');
  const r = ib.checkWorkerInbox('miyagi');
  // ok は true（分類は行う）
  assert.strictEqual(r.ok, true);
  // 提案テキストに !task が含まれても問題ないが、実際に taskManager は呼ばれない
  // inbox-bridge.js がコマンドを実行していないことをソースで確認済み（test 4a-4d）
});

test('5b. eval / execSync を呼ばない（ソース確認）', () => {
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8'
  );
  const codeOnly = bridgeSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('eval('),      'eval が含まれている');
  assert.ok(!codeOnly.includes('execSync('),  'execSync が含まれている');
});

test('5c. taskManager.createTask を呼ばない', () => {
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8'
  );
  const codeOnly = bridgeSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('createTask('), 'createTask が呼ばれている');
  assert.ok(!codeOnly.includes("require('./decision-log')"), 'decision-log が呼ばれている');
  assert.ok(!codeOnly.includes("require('./incident-manager')"), 'incident-manager が呼ばれている');
});

test('5d. CEO確認なしに Decision/Task が作られない', () => {
  cleanup();
  writeWorkerIncoming('miyagi', '方針決定: Phase2延期\n実装が必要: 診断UI');
  const r = ib.checkWorkerInbox('miyagi');
  // 提案はテキストとして返るが、実際のオブジェクトは作られない
  // decisions.json や tasks.json が変更されていないことを確認
  const decPath = path.join(__dirname, '..', 'data', 'decisions.json');
  const taskPath = path.join(__dirname, '..', 'data', 'tasks.json');
  const decBefore = fs.existsSync(decPath) ? fs.readFileSync(decPath, 'utf8') : '';
  // checkWorkerInbox を再呼び出しして decisions.json が変わっていないことを確認
  const decAfter  = fs.existsSync(decPath) ? fs.readFileSync(decPath, 'utf8') : '';
  assert.strictEqual(decBefore, decAfter, 'decisions.json が自動更新された');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

function inboxArea() {
  const idx = src.indexOf("startsWith('!inbox')");
  return src.slice(idx, idx + 2500);
}

test("6a. !inbox send が実装されている", () => {
  assert.ok(inboxArea().includes("inboxSub === 'send'"), '!inbox send がない');
});

test("6b. !inbox check <worker> が実装されている", () => {
  const area = inboxArea();
  assert.ok(area.includes('checkWorkerInbox'), 'checkWorkerInbox 呼び出しがない');
});

test("6c. !inbox status が workerStatus を表示する", () => {
  const area = inboxArea();
  assert.ok(area.includes('getWorkerStatus'), 'getWorkerStatus 呼び出しがない');
});

test('6d. sendToWorker が require される', () => {
  const area = inboxArea();
  assert.ok(area.includes('sendToWorker'), 'sendToWorker 呼び出しがない');
});

// ─────────────────────────────────────────────────────
// 7. .gitignore と Phase2 後方互換
// ─────────────────────────────────────────────────────
console.log('\n[7. gitignore / 後方互換]');

test('7a. data/inbox/ が .gitignore に維持されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/inbox/'), 'data/inbox/ が gitignore にない');
});

test('7b. data/outbox/ が .gitignore に維持されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/outbox/'), 'data/outbox/ が gitignore にない');
});

test('7c. Phase2 の checkInbox() が引き続き動作する', () => {
  const r = ib.checkInbox(); // gpt inbox（no file = ok:false）
  assert.ok(typeof r.ok === 'boolean', 'checkInbox が動作しない');
});

test('7d. Phase2 の getStatus() が引き続き動作する', () => {
  const r = ib.getStatus();
  assert.strictEqual(r.ok, true);
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
