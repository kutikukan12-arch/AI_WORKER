'use strict';
// =====================================================
// finance-manager.js — 🅵 Finance Manager Phase 1
//
// 目的:
//   AI_WORKER の運用コストを CEO が把握できるようにする。
//
// 集計対象:
//   ① Claude Code CLI  — cost-tracker.js 経由（total_cost_usd）
//   ② OpenAI API (GPT-4o) — Codex レビュー呼び出し（トークン数から推定）
//   ③ その他           — 取得不可として表示
//
// データ保存:
//   ・当日詳細: logs/cost-YYYY-MM-DD.jsonl (cost-tracker.js が管理)
//   ・月次集計: logs/cost-YYYY-MM.json
//
// 警戒閾値（.env または デフォルト値）:
//   COST_WARN_DAILY_USD  = 5.00   (1日 $5 以上で YELLOW)
//   COST_ALERT_DAILY_USD = 10.00  (1日 $10 以上で RED)
//
// 注意:
//   - 推定値であり確定コストではない
//   - APIキー・認証情報は絶対に表示しない
//   - 不明なコストは「取得不可」と表示
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const LOG_DIR   = path.join(__dirname, '..', '..', 'logs');
const costTracker = require('./cost-tracker');

// ─── OpenAI GPT-4o 料金（USD/1M tokens・推定値）───────
const OPENAI_PRICE = {
  'gpt-4o':       { input: 2.50, output: 10.00 },
  'gpt-4o-mini':  { input: 0.15, output:  0.60 },
  'gpt-4':        { input: 30.0, output: 60.00 },
};
const DEFAULT_MODEL = 'gpt-4o';

// ─── コスト警戒閾値 ──────────────────────────────────
function getThresholds() {
  return {
    warnDaily:  parseFloat(process.env.COST_WARN_DAILY_USD  || '5.00'),
    alertDaily: parseFloat(process.env.COST_ALERT_DAILY_USD || '10.00'),
  };
}

// ─────────────────────────────────────────────────────
// 月次集計ファイルパス: logs/cost-YYYY-MM.json
// ─────────────────────────────────────────────────────
function monthlyFile(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return path.join(LOG_DIR, `cost-${y}-${m}.json`);
}

function loadMonthly(date = new Date()) {
  try {
    return JSON.parse(fs.readFileSync(monthlyFile(date), 'utf8'));
  } catch {
    return { totalUsd: 0, bySource: {}, byProject: {}, taskCount: 0, lastUpdated: null };
  }
}

function saveMonthly(data, date = new Date()) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const tmp = monthlyFile(date) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, monthlyFile(date));
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// OpenAI API コストを推定・記録する
//
// 引数:
//   projectId     — string
//   taskId        — string
//   model         — 使用モデル（デフォルト: gpt-4o）
//   inputTokens   — 入力トークン数
//   outputTokens  — 出力トークン数
//
// 戻り値: 推定コスト USD（記録失敗時は 0）
// ─────────────────────────────────────────────────────
function recordOpenAI({ projectId = 'default', taskId = null, model = DEFAULT_MODEL, inputTokens = 0, outputTokens = 0 }) {
  try {
    const price    = OPENAI_PRICE[model] || OPENAI_PRICE[DEFAULT_MODEL];
    const costUsd  = (inputTokens / 1_000_000) * price.input +
                     (outputTokens / 1_000_000) * price.output;
    const rounded  = Math.round(costUsd * 1_000_000) / 1_000_000;

    // 月次集計に追記
    const monthly  = loadMonthly();
    monthly.totalUsd            = (monthly.totalUsd || 0) + rounded;
    monthly.bySource             = monthly.bySource || {};
    monthly.bySource.openai      = (monthly.bySource.openai || 0) + rounded;
    monthly.byProject            = monthly.byProject || {};
    monthly.byProject[projectId] = (monthly.byProject[projectId] || 0) + rounded;
    monthly.taskCount            = (monthly.taskCount || 0) + 1;
    monthly.lastUpdated          = new Date().toISOString();
    saveMonthly(monthly);

    logger.debug(`[Finance] OpenAI ${model} | in:${inputTokens} out:${outputTokens} → $${rounded.toFixed(6)} | ${projectId}`);
    return rounded;
  } catch (e) {
    logger.debug(`[Finance] recordOpenAI 失敗（無視）: ${e.message}`);
    return 0;
  }
}

// ─────────────────────────────────────────────────────
// Claude Code コスト（cost-tracker.js と同期）を月次集計に反映
//
// 毎日のコスト集計時や !cost コマンド時に呼ぶ。
// ─────────────────────────────────────────────────────
function syncClaudeCosts(date = new Date()) {
  try {
    const daily   = costTracker.todayTotal();
    const monthly = loadMonthly(date);

    monthly.bySource          = monthly.bySource || {};
    monthly.bySource.claude   = (monthly.bySource.claude || 0) + daily.totalUsd;
    monthly.totalUsd          = Object.values(monthly.bySource).reduce((s, v) => s + v, 0);
    monthly.lastUpdated       = new Date().toISOString();
    saveMonthly(monthly, date);
  } catch (e) {
    logger.debug(`[Finance] syncClaudeCosts 失敗（無視）: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────
// 今日の集計サマリー
// ─────────────────────────────────────────────────────
function getTodaySummary() {
  try {
    const claude   = costTracker.todayTotal();
    const monthly  = loadMonthly();
    const openaiM  = monthly.bySource?.openai || 0;

    // 当日 OpenAI は月次ファイルから「本日分」を取り出せないため推定
    // （月次ファイルが当月分合計のため日次は近似）
    const totalUsd = claude.totalUsd + openaiM; // ← 月次合計（今月のOpenAI合計）

    return {
      claude:    claude.totalUsd,    // Claude Code 今日（実績）
      openai:    openaiM,            // OpenAI 今月合計（詳細ログなし）
      claudeRaw: claude,
      totalUsd:  claude.totalUsd,    // 今日合計（Claude のみ確定）
      monthlyTotalUsd: monthly.totalUsd || 0,
      byProject: monthly.byProject || {},
    };
  } catch {
    return { claude: 0, openai: 0, totalUsd: 0, monthlyTotalUsd: 0, byProject: {} };
  }
}

// ─────────────────────────────────────────────────────
// ステータス判定（GREEN / YELLOW / RED）
// ─────────────────────────────────────────────────────
function getStatus(todayUsd) {
  const { warnDaily, alertDaily } = getThresholds();
  if (todayUsd >= alertDaily) return 'RED';
  if (todayUsd >= warnDaily)  return 'YELLOW';
  return 'GREEN';
}

// ─────────────────────────────────────────────────────
// CEO Report 用フォーマット
//
// 戻り値: Discord テキスト（ファイナンスセクション）
// ─────────────────────────────────────────────────────
function formatFinanceSection() {
  try {
    const summary    = getTodaySummary();
    const monthly    = loadMonthly();
    const status     = getStatus(summary.totalUsd);
    const statusEmoji = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[status] || '❓';

    // Claude Code 今日
    const claudeUsd = summary.claude;
    const claudeStr = claudeUsd > 0
      ? `$${claudeUsd.toFixed(4)} USD ≈ ¥${Math.round(claudeUsd * 155)}（推定）`
      : '取得不可（ログなし）';

    // OpenAI 今月累計
    const openaiM   = monthly.bySource?.openai || 0;
    const openaiStr = openaiM > 0
      ? `$${openaiM.toFixed(4)} USD ≈ ¥${Math.round(openaiM * 155)}（今月累計・推定）`
      : '取得不可（ログなし）';

    // 今月合計
    const monthlyUsd = monthly.totalUsd || 0;
    const monthlyStr = monthlyUsd > 0
      ? `$${monthlyUsd.toFixed(4)} USD ≈ ¥${Math.round(monthlyUsd * 155)}（推定）`
      : '取得不可';

    // プロジェクト別（上位3件）
    const projectLines = Object.entries(monthly.byProject || {})
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([pid, usd]) => `　${pid}: $${usd.toFixed(4)}`)
      .join('\n') || '　（記録なし）';

    return (
      `💰 **Finance — AI 利用コスト（推定値）**\n\n` +
      `🤖 **Claude Code（本日）:** ${claudeStr}\n` +
      `🔍 **OpenAI/Codex（今月）:** ${openaiStr}\n` +
      `📅 **今月合計:** ${monthlyStr}\n\n` +
      `状態: ${statusEmoji} **${status}**\n\n` +
      `プロジェクト別（今月）:\n${projectLines}\n\n` +
      `> ⚠️ 推定値です。確定額はAPIダッシュボードでご確認ください。\n` +
      `> Claude: console.anthropic.com | OpenAI: platform.openai.com/usage`
    );
  } catch (e) {
    logger.debug(`[Finance] formatFinanceSection 失敗: ${e.message}`);
    return `💰 **Finance — コスト取得不可**\n\n取得できませんでした。APIダッシュボードでご確認ください。`;
  }
}

// ─────────────────────────────────────────────────────
// !cost コマンド用: 詳細サマリーテキスト
// ─────────────────────────────────────────────────────
function formatCostReport() {
  try {
    const today   = costTracker.todayTotal();
    const monthly = loadMonthly();
    const status  = getStatus(today.totalUsd);
    const statusEmoji = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[status] || '❓';

    const lines = [
      `💰 **AI_WORKER コストレポート**`,
      ``,
      `${statusEmoji} **本日の状態: ${status}**`,
      ``,
      `📊 **本日（Claude Code）**`,
      `  タスク数: ${today.taskCount}件`,
      `  合計コスト: ${today.totalUsd > 0 ? `$${today.totalUsd.toFixed(4)} USD ≈ ¥${Math.round(today.totalUsd * 155)}` : '記録なし'}`,
      `  実行時間: ${today.totalSec > 0 ? `${Math.floor(today.totalSec / 60)}分${today.totalSec % 60}秒` : '不明'}`,
      ``,
      `📅 **今月累計**`,
      `  Claude Code: ${monthly.bySource?.claude ? `$${monthly.bySource.claude.toFixed(4)}` : '取得不可'}`,
      `  OpenAI:      ${monthly.bySource?.openai  ? `$${monthly.bySource.openai.toFixed(4)}`  : '取得不可'}`,
      `  合計:        ${monthly.totalUsd ? `$${monthly.totalUsd.toFixed(4)} USD ≈ ¥${Math.round(monthly.totalUsd * 155)}（推定）` : '取得不可'}`,
    ];

    const projects = Object.entries(monthly.byProject || {}).sort(([, a], [, b]) => b - a);
    if (projects.length > 0) {
      lines.push(``, `📁 **プロジェクト別（今月）**`);
      projects.slice(0, 5).forEach(([pid, usd]) => {
        lines.push(`  ${pid}: $${usd.toFixed(4)}`);
      });
    }

    lines.push(``, `> 推定値。確定額: console.anthropic.com / platform.openai.com/usage`);
    return lines.join('\n');
  } catch (e) {
    return `💰 コストレポート取得失敗: ${e.message.slice(0, 100)}`;
  }
}

module.exports = {
  recordOpenAI,
  syncClaudeCosts,
  getTodaySummary,
  getStatus,
  formatFinanceSection,
  formatCostReport,
  // テスト用
  _monthlyFile: monthlyFile,
  _loadMonthly: loadMonthly,
  _saveMonthly: saveMonthly,
};
