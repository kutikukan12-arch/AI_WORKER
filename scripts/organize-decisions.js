'use strict';

// =====================================================
// organize-decisions.js — Decision Log 整理（🅷 育野 Learning Manager）
//
// 方針: 削除しない。統合は archive(status=archived) + supersededBy で行い、
//       過去の判断理由（title/summary/refs/tags）は保持する。
//
// 実施内容:
//   1. ID衝突の修復（init時の Date.now() 同ms生成で重複したIDを一意化）
//   2. 全Decisionへ category 付与（categorizeDecision の6分類）
//   3. 重複Decisionの統合（同一タイトルは最新を残し、旧を archive + supersededBy）
//
// 使い方:
//   node scripts/organize-decisions.js            # 実行（データを更新）
//   node scripts/organize-decisions.js --dry-run  # 変更せず計画だけ表示
// =====================================================

const fs   = require('fs');
const path = require('path');
const dl   = require(path.join(__dirname, '..', 'bot', 'utils', 'decision-log'));

const DRY = process.argv.includes('--dry-run');
const REPORT_PATH = path.join(__dirname, '..', 'docs', `decision-log-cleanup-${new Date().toISOString().slice(0,10)}.md`);
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

// ─── Step 0: バックアップ ───────────────────────────
function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const src = path.join(__dirname, '..', 'data', 'decisions.json');
  const dst = path.join(__dirname, '..', 'data', `decisions.backup_organize_${ts}.json`);
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  return path.basename(dst);
}

// ─── Step 1: ID衝突の修復 ───────────────────────────
function fixIdCollisions() {
  const list = dl._load();
  const seen = new Map();
  const fixes = [];
  for (const d of list) {
    if (!seen.has(d.id)) { seen.set(d.id, 1); continue; }
    const n = seen.get(d.id) + 1;
    seen.set(d.id, n);
    const oldId = d.id;
    const newId = `${oldId}_${n}`;
    fixes.push({ oldId, newId, title: d.title });
    d.id = newId;
  }
  if (!DRY && fixes.length) dl._save(list);
  return fixes;
}

// ─── Step 2: カテゴリ付与 ───────────────────────────
function assignCategories() {
  const list = dl._load();
  const assigned = [];
  for (const d of list) {
    if (!d.category) {
      d.category = dl.categorizeDecision(d);
      assigned.push({ id: d.id, category: d.category, title: d.title });
    }
  }
  if (!DRY && assigned.length) dl._save(list);
  return assigned;
}

// ─── Step 3: 重複統合（archive + supersededBy）──────
function consolidateDuplicates() {
  const active   = dl._load().filter(d => dl._isActive(d));
  const clusters = dl.findDuplicates(active);
  const results  = [];
  for (const { keep, archive } of clusters) {
    for (const old of archive) {
      const r = DRY ? { ok: true } : dl.archiveDecision(old.id, keep.id, `重複統合: ${keep.id} に集約`);
      results.push({ archivedId: old.id, keepId: keep.id, title: old.title, ok: r.ok, reason: r.reason });
    }
  }
  return { clusters, results };
}

// ─── main ───────────────────────────────────────────
function main() {
  const before = dl._load();
  log(`# Decision Log 整理レポート — ${new Date().toISOString().slice(0,10)}`);
  log('');
  log(`> 🅷 育野 Learning Manager${DRY ? ' / **DRY-RUN（変更なし）**' : ''}`);
  log(`> 方針: 削除しない・統合は archive + supersededBy・履歴保持`);
  log('');
  const bak = DRY ? '(dry-run: バックアップなし)' : backup();
  log(`バックアップ: \`${bak}\``);
  log(`対象: ${before.length} 件`);
  log('');

  // Step 1
  const idFixes = fixIdCollisions();
  log(`## 1. ID衝突の修復（${idFixes.length}件）`);
  if (idFixes.length === 0) log('- 衝突なし');
  for (const f of idFixes) log(`- \`${f.oldId}\` → \`${f.newId}\`  (${f.title.slice(0,40)})`);
  log('');

  // Step 2
  const cats = assignCategories();
  log(`## 2. カテゴリ付与（${cats.length}件）`);
  for (const c of cats) log(`- ${dl.CATEGORY_EMOJI[c.category] || ''} \`${c.category}\`  ${c.title.slice(0,46)}`);
  log('');

  // Step 3
  const { clusters, results } = consolidateDuplicates();
  log(`## 3. 重複統合（${clusters.length}グループ / archive ${results.length}件）`);
  log('');
  log('### 重複一覧');
  if (clusters.length === 0) log('- 重複なし');
  for (const { keep, archive } of clusters) {
    log(`- 残す（最新）: \`${keep.id}\` ${keep.title.slice(0,50)}`);
    for (const a of archive) log(`  - archive: \`${a.id}\` ${a.title.slice(0,50)} → supersededBy \`${keep.id}\``);
  }
  log('');
  log('### archive結果');
  for (const r of results) log(`- ${r.ok ? '✅' : '❌'} \`${r.archivedId}\` → \`${r.keepId}\`${r.ok ? '' : '  ('+r.reason+')'}`);
  log('');

  // 最終状態
  const after  = dl._load();
  const active = after.filter(d => dl._isActive(d));
  const byCat  = {};
  for (const d of active) byCat[d.category || '(未分類)'] = (byCat[d.category || '(未分類)'] || 0) + 1;
  log('## 最終状態');
  log(`- 全件: ${after.length}（削除0・履歴保持）`);
  log(`- 🟢 active: ${active.length} / 📦 archived: ${after.length - active.length}`);
  log('- カテゴリ別（active）:');
  for (const [c, n] of Object.entries(byCat)) log(`  - ${dl.CATEGORY_EMOJI[c] || '🏷️'} ${c}: ${n}件`);
  const remainingDups = dl.findDuplicates(active);
  log(`- 残存重複: ${remainingDups.length}グループ ${remainingDups.length === 0 ? '✅' : '⚠️'}`);

  if (!DRY) {
    fs.writeFileSync(REPORT_PATH, out.join('\n') + '\n', 'utf8');
    console.log(`\n📄 レポート: ${path.relative(path.join(__dirname,'..'), REPORT_PATH)}`);
  }
}

main();
