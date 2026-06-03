'use strict';
// AI_WORKER 社内Discord Infrastructure テスト
// Phase1-5: docs / decision初期化 / bot設定確認 / セキュリティ

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const ROOT_DIR = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────
// 1. Phase2: docs ファイルの存在と内容確認
// ─────────────────────────────────────────────────────
console.log('\n[1. docs — company-rules.md]');

test('1a. docs/company-rules.md が存在する', () => {
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'company-rules.md')));
});

test('1b. 社内非公開の記載がある', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'company-rules.md'), 'utf8');
  assert.ok(doc.includes('社内非公開') || doc.includes('非公開'));
});

test('1c. 黒川禁止事項が記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'company-rules.md'), 'utf8');
  assert.ok(doc.includes('判断') && doc.includes('禁止'), '黒川禁止事項がない');
});

test('1d. git管理禁止ファイル一覧が記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'company-rules.md'), 'utf8');
  assert.ok(doc.includes('.env'), '.env の記載がない');
  assert.ok(doc.includes('inbox'), 'inbox の記載がない');
});

test('1e. Desktop Agent ルールが記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'company-rules.md'), 'utf8');
  assert.ok(doc.includes('Desktop Agent'), 'Desktop Agent ルールがない');
  assert.ok(doc.includes('eval'), 'eval 禁止の記載がない');
});

console.log('\n[2. docs — discord-structure.md]');

test('2a. docs/discord-structure.md が存在する', () => {
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'discord-structure.md')));
});

test('2b. 3カテゴリが記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'discord-structure.md'), 'utf8');
  assert.ok(doc.includes('社内本部'), '社内本部カテゴリがない');
  assert.ok(doc.includes('AI社員室'), 'AI社員室カテゴリがない');
  assert.ok(doc.includes('記録室'),   '記録室カテゴリがない');
});

test('2c. 8名の AI社員チャンネルが記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'discord-structure.md'), 'utf8');
  const workers = ['宮城', '守谷', '白石', '市川', '相沢', '金森', '黒川', '育野'];
  for (const w of workers) {
    assert.ok(doc.includes(w), `${w} のチャンネルが記載されていない`);
  }
});

test('2d. .env チャンネルID マッピングが記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'discord-structure.md'), 'utf8');
  assert.ok(doc.includes('CEO_REPORT_CHANNEL_ID'), 'CEO_REPORT_CHANNEL_ID がない');
  assert.ok(doc.includes('HUMAN_CHECK_CHANNEL_ID'), 'HUMAN_CHECK_CHANNEL_ID がない');
  assert.ok(doc.includes('AI_REVIEW_CHANNEL_ID'), 'AI_REVIEW_CHANNEL_ID がない');
});

test('2e. セットアップ手順が記載されている', () => {
  const doc = fs.readFileSync(path.join(DOCS_DIR, 'discord-structure.md'), 'utf8');
  assert.ok(doc.includes('setup-company-discord.js'), 'setup スクリプトの手順がない');
});

// ─────────────────────────────────────────────────────
// 3. Phase1: setup-company-discord.js の存在と安全性
// ─────────────────────────────────────────────────────
console.log('\n[3. scripts — setup-company-discord.js]');

test('3a. scripts/setup-company-discord.js が存在する', () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'scripts', 'setup-company-discord.js')));
});

test('3b. 冪等設計: 既存チャンネルはスキップされる（ソース確認）', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'setup-company-discord.js'), 'utf8'
  );
  assert.ok(src.includes('スキップ') || src.includes('skip'), '既存スキップの記述がない');
  assert.ok(!src.includes('channel.delete') && !src.includes('.delete('), '既存チャンネル削除が含まれている');
});

test('3c. --dry-run オプションが実装されている', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'setup-company-discord.js'), 'utf8'
  );
  assert.ok(src.includes('--dry-run') || src.includes('DRY_RUN'), 'dry-run がない');
});

test('3d. 3カテゴリ (社内本部/AI社員室/記録室) が定義されている', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'setup-company-discord.js'), 'utf8'
  );
  assert.ok(src.includes('社内本部'), '社内本部カテゴリがない');
  assert.ok(src.includes('AI社員室'), 'AI社員室カテゴリがない');
  assert.ok(src.includes('記録室'),   '記録室カテゴリがない');
});

test('3e. 13チャンネルが定義されている', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'setup-company-discord.js'), 'utf8'
  );
  const required = ['社長室', '副社長室', '黒川-進行管理', '作業指示',
    '宮城-lead-engineer', '守谷-cto-review', '白石-coo', '市川-pm',
    '相沢-cs', '金森-cfo', '育野-learning',
    'decision-log', 'incident-log', 'lesson-log', 'release-log', 'security-log'];
  for (const ch of required) {
    assert.ok(src.includes(ch), `${ch} チャンネルが定義されていない`);
  }
});

// ─────────────────────────────────────────────────────
// 4. Phase3: Decision 初期登録の確認
// ─────────────────────────────────────────────────────
console.log('\n[4. Decision — 初期登録確認]');

const dl = require('../bot/utils/decision-log');

test('4a. scripts/init-company-decisions.js が存在する', () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'scripts', 'init-company-decisions.js')));
});

test('4b. init スクリプトが冪等（既存はスキップ）', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'init-company-decisions.js'), 'utf8'
  );
  assert.ok(src.includes('スキップ') || src.includes('existingTitles'), '冪等設計がない');
});

test('4c. 8件の初期 Decision が登録されている', () => {
  const decisions = dl._load();
  const initialTitles = [
    'AI_WORKER は社内非公開システムとして運用する',
    '黒川 Chief of Staff の判断代理を禁止する',
    'セキュリティルール L-16 を採用する',
    'YouTube training model の公開を禁止する',
  ];
  for (const title of initialTitles) {
    const found = decisions.some(d => d.title === title);
    assert.ok(found, `初期 Decision が見つからない: ${title.slice(0, 40)}`);
  }
});

test('4d. 初期 Decision が DECIDED ステータス', () => {
  const decisions = dl._load();
  const initial = decisions.filter(d =>
    d.title === 'AI_WORKER は社内非公開システムとして運用する'
  );
  assert.ok(initial.length > 0, '初期 Decision がない');
  assert.strictEqual(initial[0].status, 'DECIDED');
});

test('4e. 重複登録なし（active なタイトルが一意）', () => {
  const decisions = dl._load();
  // archived は履歴として保持されるため一意性チェックの対象外。
  // active / DECIDED のみで重複が無いことを確認する。
  const active = decisions.filter(d => d.status === 'active' || d.status === 'DECIDED');
  const titles = active.map(d => d.title);
  const unique = new Set(titles);
  assert.strictEqual(unique.size, titles.length, `active な重複タイトルがある: ${titles.length - unique.size}件`);
});

// ─────────────────────────────────────────────────────
// 5. Phase4: Bot チャンネル設定確認（ソース確認）
// ─────────────────────────────────────────────────────
console.log('\n[5. Phase4 — Bot 設定確認]');

const indexSrc = fs.readFileSync(path.join(ROOT_DIR, 'bot', 'index.js'), 'utf8');

test('5a. CEO_REPORT_CHANNEL_ID が bot/index.js で参照されている', () => {
  assert.ok(indexSrc.includes('CEO_REPORT_CHANNEL_ID'), 'CEO_REPORT_CHANNEL_ID がない');
});

test('5b. HUMAN_CHECK_CHANNEL_ID が bot/index.js で参照されている', () => {
  assert.ok(indexSrc.includes('HUMAN_CHECK_CHANNEL_ID'), 'HUMAN_CHECK_CHANNEL_ID がない');
});

test('5c. AI_REVIEW_CHANNEL_ID が bot/index.js で参照されている', () => {
  assert.ok(indexSrc.includes('AI_REVIEW_CHANNEL_ID'), 'AI_REVIEW_CHANNEL_ID がない');
});

test('5d. CODEX_REVIEW_CHANNEL_ID が bot/index.js で参照されている', () => {
  assert.ok(indexSrc.includes('CODEX_REVIEW_CHANNEL_ID'), 'CODEX_REVIEW_CHANNEL_ID がない');
});

test('5e. ERROR_CHANNEL_ID が bot/index.js で参照されている', () => {
  assert.ok(indexSrc.includes('ERROR_CHANNEL_ID'), 'ERROR_CHANNEL_ID がない');
});

// ─────────────────────────────────────────────────────
// 6. Phase5: セキュリティ確認
// ─────────────────────────────────────────────────────
console.log('\n[6. セキュリティ確認]');

test('6a. data/inbox/ が .gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/inbox/'));
});

test('6b. data/outbox/ が .gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/outbox/'));
});

test('6c. data/desktop-agent/ が .gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/desktop-agent/'));
});

test('6d. training model が .gitignore に含まれる', () => {
  const gi = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/youtube-model.json'));
  assert.ok(gi.includes('data/youtube-model-pre.json'));
});

test('6e. training model が git 追跡対象外', () => {
  const { execSync } = require('child_process');
  const tracked = execSync('git ls-files data/youtube-model.json data/youtube-model-pre.json', {
    cwd: ROOT_DIR, encoding: 'utf8',
  }).trim();
  assert.strictEqual(tracked, '', `training model が追跡されている: "${tracked}"`);
});

test('6f. setup-company-discord.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'setup-company-discord.js'), 'utf8'
  );
  const codeOnly = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('eval('), 'eval が含まれている');
});

test('6g. init-company-decisions.js に eval がない', () => {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'scripts', 'init-company-decisions.js'), 'utf8'
  );
  const codeOnly = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!codeOnly.includes('eval('), 'eval が含まれている');
});

// ─────────────────────────────────────────────────────
// 7. 既存テスト影響確認
// ─────────────────────────────────────────────────────
console.log('\n[7. 既存機能への影響確認]');

test('7a. !decision コマンドが bot/index.js に維持されている', () => {
  assert.ok(indexSrc.includes("startsWith('!decision')"), '!decision が消えている');
});

test('7b. !msg コマンドが bot/index.js に維持されている', () => {
  assert.ok(indexSrc.includes("startsWith('!msg')"), '!msg が消えている');
});

test('7c. !inbox コマンドが bot/index.js に維持されている', () => {
  assert.ok(indexSrc.includes("startsWith('!inbox')"), '!inbox が消えている');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
