'use strict';

// =====================================================
// priority.js - タスク優先度スコアリング
//
// 役割:
//   タスクの依頼内容・危険度・種別から優先度を判定する。
//   task-manager.js や ai-meeting.js から呼ばれる。
//
// 優先度: 高 / 中 / 低
// =====================================================

// ─── 優先度を上げるキーワード ───
const HIGH_PRIORITY_KEYWORDS = [
  // 緊急・障害
  '緊急', '急いで', '今すぐ', '至急', 'urgent', 'critical', 'asap',
  // エラー・バグ
  'エラー', 'バグ', 'bug', 'error', '落ちた', '動かない', 'クラッシュ',
  // セキュリティ
  'セキュリティ', 'security', '脆弱性', 'vulnerability', '漏洩', 'breach',
  // 本番
  '本番', 'production', 'prod', 'リリース前', 'deploy',
];

// ─── 優先度を下げるキーワード ───
const LOW_PRIORITY_KEYWORDS = [
  // 整理・整頓
  '整理', 'リファクタ', 'refactor', 'クリーンアップ', 'cleanup',
  // ドキュメント
  'ドキュメント', 'コメント', 'README', 'docs',
  // 将来
  '将来', 'いずれ', 'そのうち', '余裕があれば', 'future',
];

// ─── 危険度→優先度マッピング ───
const DANGER_TO_PRIORITY = {
  '高': '高',
  '中': '中',
  '低': '低',
};

// ─────────────────────────────────────────────────────
// スコアからラベルへ変換
// ─────────────────────────────────────────────────────
function scoreToLabel(score) {
  if (score >= 2) return '高';
  if (score <= -1) return '低';
  return '中';
}

// ─────────────────────────────────────────────────────
// 優先度を計算する
//
// 引数:
//   prompt      - タスクの依頼内容
//   dangerLevel - 危険度（'高'|'中'|'低'、省略可）
//   manualPriority - 手動設定（'高'|'中'|'低'、省略時はnull）
//
// 戻り値:
//   { priority: '高'|'中'|'低', reason: '...' }
// ─────────────────────────────────────────────────────
function calculate(prompt, dangerLevel = '低', manualPriority = null) {
  // 手動設定が最優先
  if (manualPriority && ['高', '中', '低'].includes(manualPriority)) {
    return { priority: manualPriority, reason: '手動設定' };
  }

  let score = 0;
  const matchedHigh = [];
  const matchedLow  = [];

  const lowerPrompt = prompt.toLowerCase();

  // 高優先度キーワードチェック
  for (const kw of HIGH_PRIORITY_KEYWORDS) {
    if (lowerPrompt.includes(kw.toLowerCase())) {
      score += 1;
      matchedHigh.push(kw);
      if (score >= 3) break; // 上限
    }
  }

  // 低優先度キーワードチェック
  for (const kw of LOW_PRIORITY_KEYWORDS) {
    if (lowerPrompt.includes(kw.toLowerCase())) {
      score -= 1;
      matchedLow.push(kw);
      if (score <= -2) break; // 下限
    }
  }

  // 危険度による調整
  if (dangerLevel === '高') score += 1;
  if (dangerLevel === '低') score -= 1;

  const priority = scoreToLabel(score);

  // 理由の生成
  let reason = `スコア${score}`;
  if (matchedHigh.length > 0) reason += ` | キーワード: ${matchedHigh.slice(0, 3).join(', ')}`;
  if (dangerLevel === '高') reason += ' | 危険度高';
  if (matchedLow.length > 0) reason += ` | 低優先: ${matchedLow[0]}`;

  return { priority, reason };
}

// ─────────────────────────────────────────────────────
// 優先度の絵文字
// ─────────────────────────────────────────────────────
function toEmoji(priority) {
  return { '高': '🔴', '中': '🟡', '低': '🟢' }[priority] || '⬜';
}

// ─────────────────────────────────────────────────────
// 優先度の数値（ソート用: 高=3, 中=2, 低=1）
// ─────────────────────────────────────────────────────
function toNumber(priority) {
  return { '高': 3, '中': 2, '低': 1 }[priority] || 0;
}

module.exports = { calculate, toEmoji, toNumber };
