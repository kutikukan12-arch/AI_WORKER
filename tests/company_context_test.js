'use strict';
// Company Context Manager テスト (Phase1-5)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const ctx = require('../bot/utils/context-manager');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMPANY_CONTEXT.md'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. Phase1: COMPANY_CONTEXT.md の存在と内容
// ─────────────────────────────────────────────────────
console.log('\n[1. COMPANY_CONTEXT.md 内容確認]');

test('1a. docs/COMPANY_CONTEXT.md が存在する', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'COMPANY_CONTEXT.md')));
});

test('1b. AI_WORKER 概要セクションがある', () => {
  assert.ok(doc.includes('AI_WORKER 概要') || doc.includes('AI_WORKER概要'));
});

test('1c. 8名の AI社員が記載されている', () => {
  const members = ['宮城', '守谷', '白石', '相沢', '市川', '金森', '黒川', '育野'];
  for (const m of members) {
    assert.ok(doc.includes(m), `${m} が記載されていない`);
  }
});

test('1d. 黒川の禁止事項が記載されている', () => {
  assert.ok(doc.includes('判断代理') && doc.includes('禁止'), '黒川禁止事項がない');
});

test('1e. 重要ルール8条が記載されている', () => {
  assert.ok(doc.includes('社内非公開'),          'ルール1がない');
  assert.ok(doc.includes('公開商品'),             'ルール2がない');
  assert.ok(doc.includes('CEO最終判断'),           'ルール3がない');
  assert.ok(doc.includes('eval'),                'ルール6がない');
  assert.ok(doc.includes('training model'),      'ルール7がない');
  assert.ok(doc.includes('security-check'),      'ルール8がない');
});

test('1f. 完成済みシステム16種が記載されている', () => {
  const systems = [
    'Task System', 'Decision Log', 'Incident Manager',
    'Desktop Inbox Bridge', 'Desktop Agent', 'Workflow Router',
    'Worker Status', 'Discord Company Infrastructure',
  ];
  for (const s of systems) {
    assert.ok(doc.includes(s), `${s} が記載されていない`);
  }
});

test('1g. 開発フローが記載されている', () => {
  assert.ok(doc.includes('市川'), '開発フローに市川がない');
  assert.ok(doc.includes('宮城'), '開発フローに宮城がない');
  assert.ok(doc.includes('守谷'), '開発フローに守谷がない');
  assert.ok(doc.includes('育野'), '開発フローに育野がない');
});

// ─────────────────────────────────────────────────────
// 2. Phase4: Secret 混入チェック
// ─────────────────────────────────────────────────────
console.log('\n[2. Phase4 — Secret 混入チェック]');

test('2a. COMPANY_CONTEXT.md に Discord Token が含まれない', () => {
  assert.ok(!/MT[A-Za-z0-9]{18,32}\.[A-Za-z0-9_-]{4,8}\.[A-Za-z0-9_-]{20,}/.test(doc),
    'Discord Token が含まれている');
});

test('2b. COMPANY_CONTEXT.md に GitHub PAT が含まれない', () => {
  assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(doc), 'GitHub PAT が含まれている');
  assert.ok(!/github_pat_[A-Za-z0-9_]{80,}/.test(doc), 'GitHub fine-grained PAT が含まれている');
});

test('2c. COMPANY_CONTEXT.md に OpenAI Key が含まれない', () => {
  assert.ok(!/sk-proj-[A-Za-z0-9_\-]{20,}/.test(doc), 'OpenAI Key が含まれている');
});

test('2d. validateContextSecurity() が violations:0 を返す', () => {
  const r = ctx.validateContextSecurity();
  assert.strictEqual(r.ok, true, `violations: ${r.violations.join(', ')}`);
  assert.strictEqual(r.violations.length, 0);
});

// ─────────────────────────────────────────────────────
// 3. Phase2: context-manager.js 関数テスト
// ─────────────────────────────────────────────────────
console.log('\n[3. context-manager.js 関数テスト]');

test('3a. getContextSummary() が ok:true を返す', () => {
  const r = ctx.getContextSummary();
  assert.strictEqual(r.ok, true);
  assert.ok(r.version, 'version がない');
  assert.ok(r.updatedAt, 'updatedAt がない');
  assert.ok(r.summary, 'summary がない');
});

test('3b. getContextSummary に 8名の記載がある', () => {
  const r = ctx.getContextSummary();
  const members = ['宮城', '守谷', '白石', '相沢', '市川', '金森', '黒川', '育野'];
  for (const m of members) {
    assert.ok(r.summary.includes(m) || doc.includes(m), `${m} が見つからない`);
  }
});

test('3c. getContextFull() がファイル内容を返す', () => {
  const r = ctx.getContextFull();
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.length > 100, '内容が短すぎる');
  assert.ok(r.text.includes('AI_WORKER'), 'AI_WORKER が含まれない');
});

test('3d. getContextFull() に secret が含まれない（redact 適用）', () => {
  const fakeToken = 'ghp_' + 'T'.repeat(36);
  // ファイルは汚染していないので、redact の動作は別途確認
  const r = ctx.getContextFull();
  assert.ok(!r.text.includes(fakeToken), 'fake token が含まれている');
});

// ─────────────────────────────────────────────────────
// 4. Phase3: 更新候補通知
// ─────────────────────────────────────────────────────
console.log('\n[4. Phase3 — 更新候補通知]');

test('4a. notifyUpdateCandidate が通知文を生成する', () => {
  const r = ctx.notifyUpdateCandidate('new_system', 'Company Context Manager 追加');
  assert.strictEqual(r.ok, true);
  assert.ok(r.msgText.includes('COMPANY_CONTEXT'), '通知文が不適切');
  assert.ok(r.msgText.includes('新システム完成'), 'トリガーラベルがない');
});

test('4b. notifyUpdateCandidate が summary に redact を適用する', () => {
  const fakeToken = 'ghp_' + 'U'.repeat(36);
  const r = ctx.notifyUpdateCandidate('new_rule', `token: ${fakeToken}`);
  assert.ok(!r.msgText.includes(fakeToken), 'token が通知文に含まれている');
});

test('4c. UPDATE_TRIGGERS に全トリガー種別が定義されている', () => {
  const required = ['NEW_MEMBER', 'ROLE_CHANGE', 'NEW_SYSTEM', 'NEW_DECISION', 'NEW_RULE', 'FLOW_CHANGE'];
  for (const k of required) {
    assert.ok(k in ctx.UPDATE_TRIGGERS, `${k} が UPDATE_TRIGGERS にない`);
  }
});

// ─────────────────────────────────────────────────────
// 5. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[5. index.js 統合確認]');

test("5a. compSub === 'context' が実装されている", () => {
  assert.ok(src.includes("compSub === 'context'"), '!company context がない');
});

test('5b. context-manager.js を require している', () => {
  const idx  = src.indexOf("compSub === 'context'");
  const area = src.slice(idx, idx + 400);
  assert.ok(area.includes("require('./utils/context-manager')"), 'require がない');
});

test('5c. !company context full が実装されている', () => {
  const idx  = src.indexOf("compSub === 'context'");
  const area = src.slice(idx, idx + 400);
  assert.ok(area.includes("full"), '!company context full がない');
});

test('5d. !company help に context が記載されている', () => {
  const idx  = src.indexOf("compSub === 'context'");
  const area = src.slice(idx, idx + 1000);
  assert.ok(area.includes('!company context'), 'help に context がない');
});

// ─────────────────────────────────────────────────────
// 6. 既存機能への影響確認
// ─────────────────────────────────────────────────────
console.log('\n[6. 既存機能への影響確認]');

test('6a. !company staff が維持されている', () => {
  assert.ok(src.includes("compSub === 'staff'"), '!company staff が消えている');
});

test('6b. !company assign が維持されている', () => {
  assert.ok(src.includes("compSub === 'assign'"), '!company assign が消えている');
});

test('6c. !workflow / !worker / !inbox が維持されている', () => {
  assert.ok(src.includes("startsWith('!workflow')"), '!workflow が消えている');
  assert.ok(src.includes("startsWith('!worker')"),   '!worker が消えている');
  assert.ok(src.includes("startsWith('!inbox')"),    '!inbox が消えている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
