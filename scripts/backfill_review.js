'use strict';
/**
 * scripts/backfill_review.js
 *
 * codex_task_<id>.md が存在するが result_task_<id>.md がない場合に
 * バックフィルする一発スクリプト。
 *
 * 使い方:
 *   node scripts/backfill_review.js <taskId>         # 1件
 *   node scripts/backfill_review.js --all            # 全件（codex あり result なし）
 *   node scripts/backfill_review.js --dry-run        # 対象一覧のみ表示
 *   node scripts/backfill_review.js --dry-run --all
 */

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const codex      = require('../bot/utils/codex');
const REVIEWS    = path.join(__dirname, '..', 'reviews');
const ROOT       = path.join(__dirname, '..');

// ── codex_task_*.md から API 回答部分を抽出 ─────────────────
function extractApiResponse(content) {
  // "## Codex API 回答（自動取得: ...）" ヘッダー以降
  const m = content.match(/^## Codex API 回答（自動取得:[^）]*）\s*\n/m)
         || content.match(/^## Codex 回答（自動取得）\s*\n/m);
  if (!m) return null;
  return content.slice(m.index + m[0].length).trim() || null;
}

// ── codex_task_*.md のメタデータ（危険度）を抽出 ────────────
function extractDangerFromHeader(content) {
  const m = content.match(/\| 危険度\s+\|\s*(高|中|低)/);
  return m ? m[1] : null;
}

// ── result_task_*.md を書き込む ─────────────────────────────
function writeResultFile(taskId, danger, rawApiText) {
  const dangerEmoji = { '高': '🔴', '中': '🟡', '低': '🟢' }[danger] || '⬜';

  // parseCodexResult で構造化マーカーを試みる
  const parsed  = codex.parseCodexResult(rawApiText || '');
  const problem = parsed.problem || rawApiText || '（なし）';
  const suggestion = parsed.suggestion || '（なし）';
  // 危険度: ヘッダーから取得したものを優先（API回答に構造化マーカーがない場合）
  const finalDanger = parsed.danger !== '低' ? parsed.danger : (danger || '低');
  const finalEmoji  = { '高': '🔴', '中': '🟡', '低': '🟢' }[finalDanger] || '⬜';

  const resultPath = path.join(REVIEWS, `result_${taskId}.md`);
  fs.writeFileSync(resultPath, [
    `# Codex レビュー結果: ${taskId}`,
    ``,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| 作成日時 | ${new Date().toLocaleString('ja-JP')} |`,
    `| タスクID | ${taskId} |`,
    `| 危険度   | ${finalEmoji} ${finalDanger} |`,
    ``,
    `## 問題点`,
    ``,
    problem,
    ``,
    `## 改善案`,
    ``,
    suggestion,
    ``,
    `## フィードバック適用コマンド`,
    ``,
    `\`!apply-review ${taskId}\``,
  ].join('\n'), 'utf8');

  return { resultPath, finalDanger };
}

// ── メイン処理 ───────────────────────────────────────────────
function backfill(taskId, dryRun = false) {
  const codexPath  = path.join(REVIEWS, `codex_${taskId}.md`);
  const resultPath = path.join(REVIEWS, `result_${taskId}.md`);

  if (!fs.existsSync(codexPath)) {
    console.log(`  ⚠️  codex_${taskId}.md が見つかりません`);
    return false;
  }
  if (fs.existsSync(resultPath)) {
    console.log(`  ⏭️  result_${taskId}.md は既に存在します（スキップ）`);
    return false;
  }

  const content    = fs.readFileSync(codexPath, 'utf8');
  const apiText    = extractApiResponse(content);
  const danger     = extractDangerFromHeader(content) || '低';

  if (!apiText) {
    console.log(`  ❌ ${taskId}: Codex API 回答セクションが見つかりません`);
    return false;
  }

  if (dryRun) {
    console.log(`  📋 [DRY-RUN] ${taskId}: 危険度=${danger} | API回答 ${apiText.length}文字 → result_${taskId}.md を生成予定`);
    return true;
  }

  const { resultPath: written, finalDanger } = writeResultFile(taskId, danger, apiText);
  console.log(`  ✅ ${taskId}: reviews/result_${taskId}.md を生成 | 危険度=${finalDanger}`);
  return true;
}

// ── CLI エントリポイント ─────────────────────────────────────
const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const doAll  = args.includes('--all');
const ids    = args.filter(a => !a.startsWith('--'));

if (doAll) {
  // codex_task_*.md があるが result_task_*.md がない全タスクを処理
  const codexFiles = fs.readdirSync(REVIEWS)
    .filter(f => f.startsWith('codex_task_') && f.endsWith('.md'));

  console.log(`\n📋 backfill 対象スキャン: ${codexFiles.length} 件の codex_task_*.md\n`);
  let done = 0;
  for (const f of codexFiles) {
    const id = f.replace(/^codex_/, '').replace(/\.md$/, '');
    if (backfill(id, dryRun)) done++;
  }
  console.log(`\n完了: ${done} 件 ${dryRun ? '（DRY-RUN）' : '生成'}\n`);

} else if (ids.length > 0) {
  console.log('');
  let done = 0;
  for (const id of ids) {
    if (backfill(id, dryRun)) done++;
  }
  console.log(`\n完了: ${done} 件 ${dryRun ? '（DRY-RUN）' : '生成'}\n`);

} else {
  console.log(`
使い方:
  node scripts/backfill_review.js <taskId>         # 1件バックフィル
  node scripts/backfill_review.js task_xxx task_yyy # 複数指定
  node scripts/backfill_review.js --all             # 全件
  node scripts/backfill_review.js --dry-run --all   # 対象確認のみ
`);
}
