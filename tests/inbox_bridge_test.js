'use strict';
// inbox-bridge.js テスト + !inbox コマンド統合確認

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

// テスト用ファイル操作
function writeIncoming(text) {
  if (!fs.existsSync(ib.INBOX_DIR)) fs.mkdirSync(ib.INBOX_DIR, { recursive: true });
  fs.writeFileSync(ib.INCOMING, text, 'utf8');
}

function cleanup() {
  try { if (fs.existsSync(ib.INCOMING)) fs.unlinkSync(ib.INCOMING); } catch {}
  try { if (fs.existsSync(ib.REPORT))   fs.unlinkSync(ib.REPORT);   } catch {}
}

// ─────────────────────────────────────────────────────
// 1. parseIncoming — ファイル読み込みと分類
// ─────────────────────────────────────────────────────
console.log('\n[1. parseIncoming — ファイル読み込みと分類]');

test('1a. incoming.md がない場合は ok:false reason:no_file', () => {
  cleanup();
  const r = ib.parseIncoming();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_file');
});

test('1b. 空ファイルは ok:false reason:empty', () => {
  writeIncoming('');
  const r = ib.parseIncoming();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty');
});

test('1c. 正常なテキストは ok:true', () => {
  writeIncoming('YouTube診断AIの方針を決定した\nバグを修正する必要がある');
  const r = ib.parseIncoming();
  assert.strictEqual(r.ok, true);
  assert.ok(r.sections, 'sections がない');
});

test('1d. decision キーワードが decision に分類される', () => {
  writeIncoming('YouTube診断AIのPhase2は延期に決定した');
  const r = ib.parseIncoming();
  assert.ok(r.sections.decision.length > 0, 'decision に分類されない');
});

test('1e. task キーワードが task に分類される', () => {
  writeIncoming('診断UIを実装する必要がある\nタイトル長さの修正をやること');
  const r = ib.parseIncoming();
  assert.ok(r.sections.task.length > 0, 'task に分類されない');
});

test('1f. incident キーワードが incident に分類される', () => {
  writeIncoming('本番環境で障害が発生した\nAPIクォータのエラーが出ている');
  const r = ib.parseIncoming();
  assert.ok(r.sections.incident.length > 0, 'incident に分類されない');
});

test('1g. msg キーワードが msg に分類される', () => {
  writeIncoming('守谷CTOに技術的実現性を確認お願いしたい');
  const r = ib.parseIncoming();
  assert.ok(r.sections.msg.length > 0, 'msg に分類されない');
});

test('1h. ## セクションヘッダーで分類が制御できる', () => {
  writeIncoming(
    '## タスク\n' +
    'YouTube APIを実装する\n' +
    '## 判断\n' +
    'Phase2は延期に決定した\n'
  );
  const r = ib.parseIncoming();
  assert.ok(r.sections.task.length > 0,     'task が検出されない');
  assert.ok(r.sections.decision.length > 0, 'decision が検出されない');
});

test('1i. redact が適用される（トークンがマスクされる）', () => {
  const fakeToken = 'ghp_' + 'A'.repeat(36);
  writeIncoming(`方針決定: token=${fakeToken}`);
  const r = ib.parseIncoming();
  assert.ok(r.ok);
  // content に raw トークンが含まれていないこと
  assert.ok(!r.content.includes(fakeToken), 'トークンが redact されていない');
});

// ─────────────────────────────────────────────────────
// 2. _classifyLine — 行分類
// ─────────────────────────────────────────────────────
console.log('\n[2. _classifyLine — 行分類]');

test('2a. 「方針決定」は decision', () => {
  assert.strictEqual(ib._classifyLine('APIの方針を決定した'), 'decision');
});

test('2b. 「実装する」は task', () => {
  assert.strictEqual(ib._classifyLine('新機能を実装する'), 'task');
});

test('2c. 「障害が発生」は incident', () => {
  assert.strictEqual(ib._classifyLine('本番で障害が発生した'), 'incident');
});

test('2d. 「守谷CTOに確認お願い」は msg', () => {
  assert.strictEqual(ib._classifyLine('守谷CTOに確認お願い'), 'msg');
});

test('2e. キーワードなしは memo', () => {
  assert.strictEqual(ib._classifyLine('今日は晴れです'), 'memo');
});

// ─────────────────────────────────────────────────────
// 3. checkInbox — メイン処理
// ─────────────────────────────────────────────────────
console.log('\n[3. checkInbox — メイン処理]');

test('3a. incoming.md なしは ok:false', () => {
  cleanup();
  const r = ib.checkInbox();
  assert.strictEqual(r.ok, false);
  assert.ok(r.text.includes('Inbox は空'));
});

test('3b. 正常処理で report.md が生成される', () => {
  cleanup();
  writeIncoming('Phase2を延期に決定した\n診断UIを実装する必要がある');
  const r = ib.checkInbox();
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(ib.REPORT), 'report.md が生成されない');
});

test('3c. Discord テキストに分類サマリーが含まれる', () => {
  cleanup();
  writeIncoming('Phase2延期に決定した\n修正を実装する\n障害が発生した');
  const r = ib.checkInbox();
  assert.ok(r.text.includes('Inbox Report'));
  // 少なくとも1種類は分類されているはず
  assert.ok(
    r.text.includes('候補') || r.text.includes('メモ') || r.text.includes('件'),
    '分類サマリーが表示されない'
  );
});

test('3d. 実行候補コマンドが含まれる（提案のみ）', () => {
  cleanup();
  writeIncoming('## 判断\nPhase2延期に決定した');
  const r = ib.checkInbox();
  // suggestionsがあれば command が含まれるはず
  if (r.suggestions && r.suggestions.length > 0) {
    assert.ok(r.text.includes('```'), 'コマンドブロックがない');
  }
  // 提案のみで自動実行しない旨が含まれる
  assert.ok(r.text.includes('提案のみ') || r.text.includes('手動'), '「提案のみ」の注意書きがない');
});

test('3e. sections と suggestions が戻り値に含まれる', () => {
  cleanup();
  writeIncoming('Phase2延期に決定した');
  const r = ib.checkInbox();
  assert.ok(r.ok);
  assert.ok(r.sections, 'sections がない');
  assert.ok(Array.isArray(r.suggestions), 'suggestions が配列でない');
});

// ─────────────────────────────────────────────────────
// 4. 自動実行禁止確認
// ─────────────────────────────────────────────────────
console.log('\n[4. 自動実行禁止確認]');

test('4a. checkInbox は !task add を自動実行しない（ソース確認）', () => {
  const diagSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8'
  );
  // コード部分（コメント除く）に自動実行がないこと
  const codeLines = diagSrc.split('\n').filter(l => !/^\s*\/\//.test(l));
  const code = codeLines.join('\n');
  assert.ok(!code.includes('taskManager.createTask('), '自動 createTask が含まれている');
  assert.ok(!code.includes("require('./task-manager')"), '自動 task-manager 呼び出しがある');
});

test('4b. checkInbox は !decision log を自動実行しない', () => {
  const diagSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8'
  );
  const codeLines = diagSrc.split('\n').filter(l => !/^\s*\/\//.test(l));
  const code = codeLines.join('\n');
  assert.ok(!code.includes("require('./decision-log')"), '自動 decision-log 呼び出しがある');
});

test('4c. checkInbox は !incident open を自動実行しない', () => {
  const diagSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8'
  );
  const codeLines = diagSrc.split('\n').filter(l => !/^\s*\/\//.test(l));
  const code = codeLines.join('\n');
  assert.ok(!code.includes("require('./incident-manager')"), '自動 incident-manager 呼び出しがある');
});

test('4d. 提案コマンドはテキストとして表示するだけ（eval/exec しない）', () => {
  const diagSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'utils', 'inbox-bridge.js'), 'utf8'
  );
  const codeLines = diagSrc.split('\n').filter(l => !/^\s*\/\//.test(l));
  const code = codeLines.join('\n');
  assert.ok(!code.includes('eval('), 'eval が含まれている');
  assert.ok(!code.includes('execSync('), 'execSync が含まれている');
});

// ─────────────────────────────────────────────────────
// 5. getStatus / clearInbox
// ─────────────────────────────────────────────────────
console.log('\n[5. getStatus / clearInbox]');

test('5a. getStatus がステータス情報を返す', () => {
  const r = ib.getStatus();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('Inbox Bridge'), 'ステータス情報が不足');
  assert.ok(r.text.includes('incoming.md'));
});

test('5b. clearInbox が incoming.md を空にする', () => {
  writeIncoming('テストデータ');
  ib.clearInbox();
  const content = fs.existsSync(ib.INCOMING)
    ? fs.readFileSync(ib.INCOMING, 'utf8')
    : '';
  assert.strictEqual(content, '', 'クリア後も内容が残っている');
});

test('5c. incoming.md なしでも clearInbox はエラーにならない', () => {
  cleanup();
  const r = ib.clearInbox();
  assert.strictEqual(r.ok, true);
});

// ─────────────────────────────────────────────────────
// 6. .gitignore 確認
// ─────────────────────────────────────────────────────
console.log('\n[6. .gitignore 確認]');

test('6a. data/inbox/ が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/inbox/'), 'data/inbox/ が gitignore にない');
});

test('6b. data/outbox/ が .gitignore に追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/outbox/'), 'data/outbox/ が gitignore にない');
});

// ─────────────────────────────────────────────────────
// 7. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[7. index.js 統合確認]');

test("7a. startsWith('!inbox') が実装されている", () => {
  assert.ok(src.includes("startsWith('!inbox')"), '!inbox ハンドラがない');
});

function inboxArea() {
  const idx = src.indexOf("startsWith('!inbox')");
  return src.slice(idx, idx + 2500); // Phase3 追加で長くなったため拡張
}

test("7b. check / status / clear が実装されている", () => {
  const area = inboxArea();
  assert.ok(area.includes("inboxSub === 'check'"),  'check がない');
  assert.ok(area.includes("inboxSub === 'status'"), 'status がない');
  assert.ok(area.includes("inboxSub === 'clear'"),  'clear がない');
});

test('7c. clear は Owner 限定', () => {
  const area = inboxArea();
  assert.ok(area.includes('DISCORD_OWNER_ID'), 'Owner 制限がない');
});

test('7d. inbox-bridge.js を require している', () => {
  const area = inboxArea();
  assert.ok(area.includes("require('./utils/inbox-bridge')"), 'require がない');
});

// ─────────────────────────────────────────────────────
// 8. docs 確認
// ─────────────────────────────────────────────────────
console.log('\n[8. docs確認]');

test('8a. docs/vp-room-operations.md が存在する', () => {
  const p = path.join(__dirname, '..', 'docs', 'vp-room-operations.md');
  assert.ok(fs.existsSync(p), 'vp-room-operations.md がない');
});

test('8b. 運用ルールに「外部非公開」の記載がある', () => {
  const doc = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'vp-room-operations.md'), 'utf8'
  );
  assert.ok(doc.includes('外部') && (doc.includes('非公開') || doc.includes('禁止')), '外部非公開の記載がない');
});

test('8c. 運用ルールに「提案まで」「自動実行しない」の記載がある', () => {
  const doc = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'vp-room-operations.md'), 'utf8'
  );
  assert.ok(doc.includes('提案') && doc.includes('自動'), '制限の記載がない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
cleanup();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
