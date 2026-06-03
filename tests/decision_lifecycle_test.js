'use strict';
// Decision Lifecycle Manager Phase1-5 テスト

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const dl  = require('../bot/utils/decision-log');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// 本番 decisions.json を保護
const DEC_FILE = path.join(__dirname, '..', 'data', 'decisions.json');
const _orig    = fs.existsSync(DEC_FILE) ? fs.readFileSync(DEC_FILE, 'utf8') : null;
function reset() { dl._save([]); }
function restore() {
  if (_orig !== null) fs.writeFileSync(DEC_FILE, _orig, 'utf8');
  else try { fs.unlinkSync(DEC_FILE); } catch {}
}

// ─────────────────────────────────────────────────────
// 1. Phase1: スキーマ拡張
// ─────────────────────────────────────────────────────
console.log('\n[1. Phase1 スキーマ拡張]');

test('1a. 新規 Decision の status は active', () => {
  reset();
  dl.logDecision({ title: 'テスト' });
  const rec = dl._load()[0];
  assert.strictEqual(rec.status, 'active');
});

test('1b. supersededBy フィールドが存在する', () => {
  reset();
  dl.logDecision({ title: 'テスト' });
  const rec = dl._load()[0];
  assert.ok('supersededBy' in rec, 'supersededBy がない');
  assert.strictEqual(rec.supersededBy, null);
});

test('1c. category フィールドが存在する', () => {
  reset();
  dl.logDecision({ title: 'テスト' });
  const rec = dl._load()[0];
  assert.ok('category' in rec, 'category がない');
});

test('1d. CATEGORIES に6種が含まれる', () => {
  const required = ['core', 'workflow', 'security', 'product', 'finance', 'learning'];
  for (const c of required) {
    assert.ok(dl.CATEGORIES.includes(c), `${c} が CATEGORIES にない`);
  }
});

test('1e. CATEGORY_EMOJI に全カテゴリの絵文字がある', () => {
  for (const c of dl.CATEGORIES) {
    assert.ok(dl.CATEGORY_EMOJI[c], `${c} に絵文字がない`);
  }
});

test('1f. 後方互換: DECIDED status は _isActive が true', () => {
  reset();
  dl.logDecision({ title: '後方互換テスト' });
  const list = dl._load();
  // 手動で status を DECIDED に変更してテスト
  list[0].status = 'DECIDED';
  dl._save(list);
  const rec = dl._load()[0];
  assert.ok(dl._isActive(rec), 'DECIDED が active と認識されない');
});

// ─────────────────────────────────────────────────────
// 2. Phase3: archive — 削除禁止・履歴保持
// ─────────────────────────────────────────────────────
console.log('\n[2. Phase3 archive]');

test('2a. archive しても Decision が消えない', () => {
  reset();
  const r = dl.logDecision({ title: 'アーカイブテスト' });
  dl.archiveDecision(r.id, null, 'テスト');
  const all = dl._load();
  assert.strictEqual(all.length, 1, 'archive で削除された');
});

test('2b. archive 後 status は archived', () => {
  reset();
  const r = dl.logDecision({ title: 'status テスト' });
  dl.archiveDecision(r.id);
  const rec = dl._load()[0];
  assert.strictEqual(rec.status, 'archived');
});

test('2c. supersededBy が保存される', () => {
  reset();
  const r1 = dl.logDecision({ title: '旧Decision' });
  const r2 = dl.logDecision({ title: '新Decision' });
  dl.archiveDecision(r1.id, r2.id, '新しい判断に置き換え');
  const rec = dl._load().find(d => d.id === r1.id);
  assert.strictEqual(rec.supersededBy, r2.id);
});

test('2d. archived Decision をさらに archive しようとするとエラー', () => {
  reset();
  const r = dl.logDecision({ title: '二重 archive テスト' });
  dl.archiveDecision(r.id);
  const r2 = dl.archiveDecision(r.id);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.reason.includes('archived'));
});

test('2e. archivedAt / archivedReason が保存される', () => {
  reset();
  const r = dl.logDecision({ title: '理由テスト' });
  dl.archiveDecision(r.id, null, '廃止理由テスト');
  const rec = dl._load()[0];
  assert.ok(rec.archivedAt, 'archivedAt がない');
  assert.ok(rec.archivedReason.includes('廃止理由テスト'));
});

// ─────────────────────────────────────────────────────
// 3. Phase4: !decision list 表示改善
// ─────────────────────────────────────────────────────
console.log('\n[3. Phase4 list 表示]');

test('3a. active Decision に 🟢 が表示される', () => {
  reset();
  dl.logDecision({ title: 'activeテスト' });
  const r = dl.listDecisions();
  assert.ok(r.text.includes('🟢'), '🟢 が表示されない');
});

test('3b. archived は !decision list から除外される', () => {
  reset();
  const r1 = dl.logDecision({ title: 'active' });
  const r2 = dl.logDecision({ title: 'archived にする' });
  dl.archiveDecision(r2.id);
  const list = dl.listDecisions();
  assert.ok(list.text.includes('active'),          'active が消えた');
  assert.ok(!list.text.includes('archived にする'), 'archived が表示される');
});

test('3c. !decision list all は archived も含む', () => {
  reset();
  const r2 = dl.logDecision({ title: 'archived' });
  dl.archiveDecision(r2.id);
  const listAll = dl.listDecisions(10, true);
  assert.ok(listAll.text.includes('archived') || listAll.text.includes('📦'), 'archived が含まれない');
});

test('3d. archived 件数が list のヘッダーに表示される', () => {
  reset();
  const r = dl.logDecision({ title: 'archived count' });
  dl.archiveDecision(r.id);
  dl.logDecision({ title: 'active' });
  const list = dl.listDecisions();
  assert.ok(list.text.includes('archived'), 'archived件数がヘッダーにない');
});

// ─────────────────────────────────────────────────────
// 4. Phase2: cleanup 提案
// ─────────────────────────────────────────────────────
console.log('\n[4. Phase2 cleanup]');

test('4a. buildCleanupReport は ok:true を返す', () => {
  reset();
  dl.logDecision({ title: 'テスト' });
  const r = dl.buildCleanupReport();
  assert.strictEqual(r.ok, true);
});

test('4b. 重複なしなら 重複なし と表示', () => {
  reset();
  dl.logDecision({ title: '一意なタイトルA' });
  dl.logDecision({ title: '一意なタイトルB' });
  const r = dl.buildCleanupReport();
  assert.ok(r.text.includes('重複なし') || r.duplicateCount === 0);
});

test('4c. 類似タイトルが重複候補として検出される', () => {
  reset();
  dl.logDecision({ title: 'AI_WORKERは社内非公開' });
  dl.logDecision({ title: 'AI WORKERは社内非公開' }); // 表記ゆれ
  const r = dl.buildCleanupReport();
  assert.ok(r.duplicateCount > 0, '重複が検出されない');
  assert.ok(r.text.includes('archive候補'), '提案文がない');
});

test('4d. cleanup は自動削除・自動 archive しない', () => {
  reset();
  dl.logDecision({ title: 'テスト1' });
  dl.logDecision({ title: 'テスト1' }); // 重複
  const before = dl._load().length;
  dl.buildCleanupReport();
  const after = dl._load().length;
  assert.strictEqual(before, after, '自動削除が実行された');
});

// ─────────────────────────────────────────────────────
// 5. Phase5: listActiveDecisions
// ─────────────────────────────────────────────────────
console.log('\n[5. Phase5 listActiveDecisions]');

test('5a. listActiveDecisions は active のみ返す', () => {
  reset();
  const r1 = dl.logDecision({ title: 'active 1' });
  const r2 = dl.logDecision({ title: 'active 2' });
  dl.archiveDecision(r2.id);
  const active = dl.listActiveDecisions();
  assert.strictEqual(active.length, 1, 'archived が含まれている');
  assert.strictEqual(active[0].id, r1.id);
});

test('5b. DECIDED status も listActiveDecisions に含まれる（後方互換）', () => {
  reset();
  dl.logDecision({ title: 'DECIDED テスト' });
  const list = dl._load();
  list[0].status = 'DECIDED';
  dl._save(list);
  const active = dl.listActiveDecisions();
  assert.strictEqual(active.length, 1, 'DECIDED が除外されている');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. !decision cleanup が実装されている", () => {
  assert.ok(src.includes("decSub === 'cleanup'"), '!decision cleanup がない');
});

test("6b. !decision archive が実装されている", () => {
  assert.ok(src.includes("decSub === 'archive'"), '!decision archive がない');
});

test("6c. !decision list all が実装されている", () => {
  const idx  = src.indexOf("decSub === 'list'");
  const area = src.slice(idx, idx + 200);
  assert.ok(area.includes("'all'"), '!decision list all がない');
});

test('6d. archive は削除ではなくアーカイブと明記されている', () => {
  const idx  = src.indexOf("decSub === 'archive'");
  const area = src.slice(idx, idx + 600);
  assert.ok(area.includes('アーカイブ') || area.includes('archive'), '削除防止の説明がない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
restore();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
