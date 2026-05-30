'use strict';

// =====================================================
// ai-review.js - AI 自動レビューユーティリティ
//
// 役割:
//   Claude Code が行った変更内容を自動チェックし、
//   問題点・注意点を検出する。
//
// レビュー観点:
//   - 要件外機能の追加
//   - 不必要なパッケージの追加
//   - 機密ファイルの変更
//   - 大量ファイル変更（意図しない削除等）
//   - 設定ファイルの変更
//
// 判定結果:
//   問題なし    → 実装続行
//   修正推奨    → Claude Code へ差し戻し
//   却下推奨    → 人間確認
// =====================================================

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const REVIEWS_PATH = path.join(__dirname, '..', '..', 'reviews');

// ─────────────────────────────────────────────────────
// レビュー対象パターン
// ─────────────────────────────────────────────────────

// 「要件に含まれていないのに追加されたら警告」するパッケージ
const SUSPICIOUS_PACKAGES = [
  // 重量級フレームワーク（Phase1では不要なもの）
  'webpack', 'babel', 'vite', 'rollup', 'parcel',
  // データベース（Phase1では使わない）
  'redis', 'mongodb', 'mysql2', 'postgres', 'sequelize', 'prisma',
  // 認証系（Phase1では不要）
  'passport', 'oauth', 'jwt', 'bcrypt',
  // GraphQL（Phase1では不要）
  'graphql', 'apollo', 'urql',
  // 通信系（Phase1では必要最小限のみ）
  'socket.io', 'grpc',
];

// 変更があったら人間確認を促す機密・重要ファイルパターン
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/,
  /credential/i,
  /secret/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
];

// 設定ファイル変更パターン（警告を出す）
const CONFIG_FILE_PATTERNS = [
  /package\.json$/,
  /tsconfig/,
  /\.eslintrc/,
  /\.babelrc/,
  /webpack\.config/,
  /vite\.config/,
];

// ─────────────────────────────────────────────────────
// 変更内容をレビューする
//
// 引数:
//   prompt       - 元の指示内容
//   output       - Claude Code の実行結果
//   changedFiles - 変更されたファイルの一覧（git status --porcelain 形式）
//
// 戻り値:
//   { verdict, issues, warnings, checks }
//   verdict: '問題なし' | '修正推奨' | '却下推奨'
// ─────────────────────────────────────────────────────
function reviewChanges(prompt, output, changedFiles = [], taskType = 'IMPLEMENT') {
  const issues   = [];   // 深刻な問題（却下推奨）
  const warnings = [];   // 軽微な警告（修正推奨）
  const checks   = [];   // 確認済みの項目（問題なし）

  const text        = (prompt + ' ' + (output || '')).toLowerCase();
  // bare形式 (bot/index.js) と porcelain形式 (M  bot/index.js) の両方対応
  const fileNames   = changedFiles.map(f =>
    /^[MADR?]{1,2}\s/.test(f) ? f.slice(2).trim() : f.trim()
  );

  // ─── チェック 0: IMPLEMENT + 変更0件 ───
  // 変更なしなのに「問題なし」と判定される誤動作を防ぐ
  if (taskType === 'IMPLEMENT' && changedFiles.length === 0) {
    issues.push(
      `IMPLEMENTタスクで変更ファイルが0件です。\n` +
      `  → 実装が完了していない可能性があります。`
    );
  }

  // ─── チェック 1: 大量ファイル変更 ───
  if (changedFiles.length > 25) {
    issues.push(
      `変更ファイルが大量です（${changedFiles.length}件）。\n` +
      `  → 意図していない削除・変更が含まれていないか確認してください。`
    );
  } else if (changedFiles.length > 10) {
    warnings.push(`変更ファイルが多めです（${changedFiles.length}件）。内容を確認してください。`);
  } else {
    checks.push(`変更ファイル数は適切です（${changedFiles.length}件）`);
  }

  // ─── チェック 2: 機密ファイルの変更 ───
  const sensitiveChanged = fileNames.filter(f =>
    SENSITIVE_FILE_PATTERNS.some(p => p.test(f))
  );
  if (sensitiveChanged.length > 0) {
    issues.push(
      `機密・重要ファイルが変更されました:\n` +
      sensitiveChanged.map(f => `  → ${f}`).join('\n')
    );
  } else {
    checks.push('機密ファイルの変更なし');
  }

  // ─── チェック 3: 設定ファイルの変更 ───
  const configChanged = fileNames.filter(f =>
    CONFIG_FILE_PATTERNS.some(p => p.test(f))
  );
  if (configChanged.length > 0) {
    warnings.push(
      `設定ファイルが変更されました:\n` +
      configChanged.map(f => `  → ${f}`).join('\n') +
      `\n  追加されたパッケージや設定を確認してください。`
    );
  } else {
    checks.push('設定ファイルの変更なし');
  }

  // ─── チェック 4: 要件外パッケージの追加 ───
  const addedPackages = SUSPICIOUS_PACKAGES.filter(pkg => {
    const inOutput = text.includes(pkg);
    const inPrompt = prompt.toLowerCase().includes(pkg);
    // プロンプトで要求していないのに追加された場合のみ警告
    return inOutput && !inPrompt;
  });
  if (addedPackages.length > 0) {
    warnings.push(
      `要件外の可能性があるパッケージが追加されました:\n` +
      addedPackages.map(p => `  → ${p}`).join('\n') +
      `\n  本当に必要なパッケージか確認してください。`
    );
  } else {
    checks.push('不審なパッケージ追加なし');
  }

  // ─── チェック 5: ファイル削除の確認 ───
  // porcelain形式 (D  file) と bare形式 (file) の両方に対応
  const deletedFiles = changedFiles.filter(f => /^D/.test(f));
  if (deletedFiles.length > 3) {
    issues.push(
      `複数のファイルが削除されています（${deletedFiles.length}件）:\n` +
      deletedFiles.slice(0, 5).map(f => `  → ${f.slice(2).trim()}`).join('\n') +
      (deletedFiles.length > 5 ? `\n  ... 他 ${deletedFiles.length - 5}件` : '')
    );
  } else if (deletedFiles.length > 0) {
    warnings.push(
      `ファイルが削除されました（${deletedFiles.length}件）: ` +
      deletedFiles.map(f => f.slice(2).trim()).join(', ')
    );
  }

  // ─── 判定 ───
  let verdict;
  if (issues.length > 0) {
    verdict = '却下推奨';
    logger.warn(`AIレビュー: 却下推奨 | 問題点${issues.length}件 | 警告${warnings.length}件`);
  } else if (warnings.length > 0) {
    verdict = '修正推奨';
    logger.info(`AIレビュー: 修正推奨 | 警告${warnings.length}件`);
  } else {
    verdict = '問題なし';
    logger.info('AIレビュー: 問題なし');
  }

  return { verdict, issues, warnings, checks };
}

// ─────────────────────────────────────────────────────
// Discord 表示用にレビュー結果をフォーマット
// ─────────────────────────────────────────────────────
function formatReviewResult(taskId, prompt, review) {
  const { verdict, issues, warnings, checks } = review;

  // 判定バッジ
  const badge = {
    '問題なし':  '🟢 問題なし',
    '修正推奨':  '🟡 修正推奨',
    '却下推奨':  '🔴 却下推奨',
  }[verdict] || verdict;

  const dangerLevel = issues.length > 0 ? '高' : warnings.length > 0 ? '中' : '低';

  const issueText   = issues.length   > 0 ? issues.map(i => `⚠️ ${i}`).join('\n\n')   : '・なし';
  const warningText = warnings.length > 0 ? warnings.map(w => `💡 ${w}`).join('\n\n') : '・なし';

  return [
    `【追加された機能】`,
    prompt.slice(0, 100),
    ``,
    `【レビュー結果】`,
    badge,
    ``,
    `【問題点】`,
    issueText,
    ``,
    `【注意点】`,
    warningText,
    ``,
    `【危険度】`,
    dangerLevel,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// レビュー結果を reviews/<projectId>/ に保存
// ─────────────────────────────────────────────────────
function saveReviewResult(taskId, prompt, review, projectId = 'default') {
  const reviewDir = path.join(REVIEWS_PATH, projectId);
  if (!fs.existsSync(reviewDir)) {
    fs.mkdirSync(reviewDir, { recursive: true });
  }

  const timestamp = new Date().toLocaleString('ja-JP');
  const formatted = formatReviewResult(taskId, prompt, review);

  const content = [
    `# AI レビュー結果: ${taskId}`,
    ``,
    `| 項目 | 内容 |`,
    `|------|------|`,
    `| 実施日時 | ${timestamp} |`,
    `| 判定     | **${review.verdict}** |`,
    `| 問題点数 | ${review.issues.length}件 |`,
    `| 警告数   | ${review.warnings.length}件 |`,
    ``,
    `## 詳細`,
    ``,
    formatted,
    ``,
    `## 確認済み項目（問題なし）`,
    ``,
    review.checks.map(c => `- ✅ ${c}`).join('\n') || '（なし）',
    ``,
    `## 承認ルール`,
    ``,
    `- 🟢 問題なし  → 実装続行`,
    `- 🟡 修正推奨  → Claude Code へ差し戻し`,
    `- 🔴 却下推奨  → 人間確認`,
  ].join('\n');

  const filePath = path.join(REVIEWS_PATH, projectId, `review_${taskId}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  logger.info(`AIレビュー結果を保存: reviews/${projectId}/review_${taskId}.md | 判定: ${review.verdict}`);

  return { filePath, formatted, projectId };
}

module.exports = { reviewChanges, formatReviewResult, saveReviewResult };
