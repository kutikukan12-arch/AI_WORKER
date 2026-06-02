'use strict';
// =====================================================
// finance-manager.js — 🅵 Finance Manager Phase 1 (Rev.2)
//
// 費用の種別を明確に分離する:
//
//   actualCostUsd         — 実際に課金される費用
//     ・OpenAI API (GPT-4o) — Codex レビュー呼び出し
//     ・その他 API で実課金されるもの
//
//   estimatedEquivalentUsd — 参考換算（実請求ではない）
//     ・Claude Code CLI — Claudeプラン内利用の換算額
//     ・Claude API トークン数からの換算
//     ※ 実際の請求はプラン月額固定費のみ
//
//   fixedMonthlyCostJPY   — 固定費（月額サブスク）
//     ・Claudeプラン料金（設定値）
//
// 重要:
//   ・Claude Code換算額を実費として合計に入れない
//   ・実費不明なものは「推定」と明記
//   ・Finance Gate の予算判定は actualCostUsd のみ使用
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const LOG_DIR     = path.join(__dirname, '..', '..', 'logs');
const costTracker = require('./cost-tracker');

const USD_TO_JPY  = 155; // 換算レート（概算）

// ─── OpenAI GPT-4o 料金（USD/1M tokens・参考値）────────
const OPENAI_PRICE = {
  'gpt-4o':       { input: 2.50, output: 10.00 },
  'gpt-4o-mini':  { input: 0.15, output:  0.60 },
  'gpt-4':        { input: 30.0, output: 60.00 },
};
const DEFAULT_MODEL = 'gpt-4o';

// ─── Claude Code 換算レート（参考値・実費ではない）───────
// Claude Pro プランの実勢価格から1タスクあたりを概算する参考値
// ※ Anthropic は Claude Code CLI を従量課金していないため、
//   これは「仮に API 利用したら○円相当」という参考換算に過ぎない
const CLAUDE_CODE_EQUIV_PER_TASK_USD = 0.02; // 1タスクあたり約$0.02相当（参考）

// ─── 日次コスト状態閾値（OpenAI など実課金のみ） ─────────
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
    if (!fs.existsSync(monthlyFile(date))) return _defaultMonthly();
    return { ..._defaultMonthly(), ...JSON.parse(fs.readFileSync(monthlyFile(date), 'utf8')) };
  } catch {
    return _defaultMonthly();
  }
}

function _defaultMonthly() {
  return {
    actualCostUsd:           0,  // 実課金合計（OpenAI API 等）
    estimatedEquivalentUsd:  0,  // 参考換算合計（Claude Code等・実請求でない）
    byActualSource:          {},  // 実課金の内訳 { openai: ... }
    byEquivalentSource:      {},  // 換算の内訳   { claude: ... }
    byProject:               {},  // プロジェクト別（実課金のみ）
    taskCount:               0,
    lastUpdated:             null,
    // 後方互換: 旧フォーマットとの互換性保持
    totalUsd:                0,   // 旧フィールド（読み取り時のみ使用）
    bySource:                {},  // 旧フィールド（読み取り時のみ使用）
  };
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
// OpenAI API コストを記録する（実課金）
// ─────────────────────────────────────────────────────
function recordOpenAI({ projectId = 'default', taskId = null, model = DEFAULT_MODEL, inputTokens = 0, outputTokens = 0 }) {
  try {
    const price   = OPENAI_PRICE[model] || OPENAI_PRICE[DEFAULT_MODEL];
    const costUsd = (inputTokens / 1_000_000) * price.input +
                    (outputTokens / 1_000_000) * price.output;
    const rounded = Math.round(costUsd * 1_000_000) / 1_000_000;

    const monthly = loadMonthly();

    // 実課金として記録
    monthly.actualCostUsd                     = (monthly.actualCostUsd || 0) + rounded;
    monthly.byActualSource                    = monthly.byActualSource || {};
    monthly.byActualSource.openai             = (monthly.byActualSource.openai || 0) + rounded;
    monthly.byProject                         = monthly.byProject || {};
    monthly.byProject[projectId]              = (monthly.byProject[projectId] || 0) + rounded;
    monthly.taskCount                         = (monthly.taskCount || 0) + 1;
    monthly.lastUpdated                       = new Date().toISOString();

    // 後方互換フィールドも更新
    monthly.totalUsd = monthly.actualCostUsd;
    monthly.bySource = { ...monthly.byActualSource };

    saveMonthly(monthly);

    logger.debug(`[Finance] OpenAI ${model} | in:${inputTokens} out:${outputTokens} → $${rounded.toFixed(6)} | ${projectId} [実課金]`);
    return rounded;
  } catch (e) {
    logger.debug(`[Finance] recordOpenAI 失敗（無視）: ${e.message}`);
    return 0;
  }
}

// ─────────────────────────────────────────────────────
// Claude Code 換算額を記録する（参考値・実課金ではない）
// ─────────────────────────────────────────────────────
function syncClaudeCosts(date = new Date()) {
  try {
    const daily   = costTracker.todayTotal();
    const monthly = loadMonthly(date);

    // Claude Code は実課金ではなくプラン内利用のため byEquivalentSource に分類
    monthly.byEquivalentSource              = monthly.byEquivalentSource || {};
    monthly.byEquivalentSource.claudeCode   = (monthly.byEquivalentSource.claudeCode || 0) + daily.totalUsd;
    monthly.estimatedEquivalentUsd          = Object.values(monthly.byEquivalentSource).reduce((s, v) => s + v, 0);

    // actualCostUsd は変更しない（Claude Code は実課金に含めない）

    // 後方互換
    monthly.bySource.claude     = monthly.byEquivalentSource.claudeCode;
    monthly.lastUpdated         = new Date().toISOString();
    saveMonthly(monthly, date);
  } catch (e) {
    logger.debug(`[Finance] syncClaudeCosts 失敗（無視）: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────
// 費用サマリーを取得（実課金 / 換算 / 固定費 を分離）
// ─────────────────────────────────────────────────────
function getCostSummary() {
  try {
    const today   = costTracker.todayTotal();
    const monthly = loadMonthly();

    // 実課金（OpenAI API 等）
    const actualMonthlyUsd   = monthly.actualCostUsd
      || monthly.bySource?.openai   // 旧フォーマット互換
      || 0;
    const actualMonthlyJPY   = Math.round(actualMonthlyUsd * USD_TO_JPY);

    // 参考換算（Claude Code）
    const equivMonthlyUsd    = monthly.estimatedEquivalentUsd
      || monthly.bySource?.claude   // 旧フォーマット互換
      || 0;
    const equivMonthlyJPY    = Math.round(equivMonthlyUsd * USD_TO_JPY);

    // OpenAI 今月累計（実課金の内訳）
    const openaiMonthlyUsd   = monthly.byActualSource?.openai
      || monthly.bySource?.openai
      || 0;

    return {
      // 実課金
      actual: {
        usd:        Math.round(actualMonthlyUsd * 10000) / 10000,
        jpy:        actualMonthlyJPY,
        openaiUsd:  Math.round(openaiMonthlyUsd * 10000) / 10000,
        isEstimate: true,   // API 実費を USD→JPY 換算しているので「推定」
      },
      // 参考換算（実請求ではない）
      equivalent: {
        usd:           Math.round(equivMonthlyUsd * 10000) / 10000,
        jpy:           equivMonthlyJPY,
        claudeTaskCount: today.taskCount,
        isEquivalentOnly: true,  // 実請求ではない
      },
      byProject: monthly.byProject || {},
      taskCount: monthly.taskCount || 0,
    };
  } catch {
    return {
      actual:     { usd: 0, jpy: 0, openaiUsd: 0, isEstimate: true },
      equivalent: { usd: 0, jpy: 0, claudeTaskCount: 0, isEquivalentOnly: true },
      byProject:  {},
      taskCount:  0,
    };
  }
}

// 後方互換: getTodaySummary（既存コード向け）
function getTodaySummary() {
  try {
    const summary = getCostSummary();
    return {
      claude:         0,                          // Claude は実課金ではない
      openai:         summary.actual.openaiUsd,
      totalUsd:       0,                          // 実課金がなければ 0
      monthlyTotalUsd: summary.actual.usd,        // 実課金のみ
      actualMonthlyUsd: summary.actual.usd,
      equivMonthlyUsd:  summary.equivalent.usd,
      byProject:       summary.byProject,
    };
  } catch {
    return { claude: 0, openai: 0, totalUsd: 0, monthlyTotalUsd: 0, actualMonthlyUsd: 0, equivMonthlyUsd: 0, byProject: {} };
  }
}

// ─────────────────────────────────────────────────────
// ステータス判定（GREEN / YELLOW / RED）— 実課金のみ
// ─────────────────────────────────────────────────────
function getStatus(actualDailyUsd) {
  const { warnDaily, alertDaily } = getThresholds();
  if (actualDailyUsd >= alertDaily) return 'RED';
  if (actualDailyUsd >= warnDaily)  return 'YELLOW';
  return 'GREEN';
}

// ─────────────────────────────────────────────────────
// CEO Report / Finance Report 用フォーマット
// ─────────────────────────────────────────────────────
function formatFinanceSection() {
  try {
    const summary = getCostSummary();
    const { actual, equivalent } = summary;

    // 実課金の状態
    const status      = getStatus(actual.openaiUsd); // 今日分は近似
    const statusEmoji = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[status] || '❓';

    // OpenAI 実課金
    const openaiStr = actual.openaiUsd > 0
      ? `¥${Math.round(actual.openaiUsd * USD_TO_JPY).toLocaleString()}（推定 $${actual.openaiUsd.toFixed(4)}）`
      : '¥0（ログなし）';

    // Claude Code 換算（参考）
    const equivStr = equivalent.usd > 0
      ? `約¥${equivalent.jpy.toLocaleString()}相当（換算値・実請求ではありません）`
      : '取得不可（換算値・実請求ではありません）';

    // プロジェクト別（実課金のみ）
    const projectLines = Object.entries(summary.byProject || {})
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([pid, usd]) => `　${pid}: ¥${Math.round(usd * USD_TO_JPY).toLocaleString()}`)
      .join('\n') || '　（記録なし）';

    return (
      `💰 **Finance — AI 利用コスト**\n\n` +
      `${statusEmoji} **実課金状態: ${status}**\n\n` +
      `💳 **実課金（OpenAI API・今月）:** ${openaiStr}\n` +
      `🤖 **参考換算（Claude Code使用量）:** ${equivStr}\n` +
      `🔒 **固定費（Claudeプラン）:** 月額プラン料金（別途ご確認ください）\n\n` +
      (Object.keys(summary.byProject).length > 0 ? `📁 実課金 プロジェクト別:\n${projectLines}\n\n` : '') +
      `> ⚠️ **注意:** Claude Code換算額は実請求ではありません。\n` +
      `> 実費は console.anthropic.com（プラン料金）/ platform.openai.com/usage（API費）でご確認ください。`
    );
  } catch (e) {
    logger.debug(`[Finance] formatFinanceSection 失敗: ${e.message}`);
    return `💰 **Finance — コスト取得不可**\n\nAPIダッシュボードでご確認ください。`;
  }
}

// ─────────────────────────────────────────────────────
// !cost コマンド用: 詳細サマリーテキスト
// ─────────────────────────────────────────────────────
function formatCostReport() {
  try {
    const today   = costTracker.todayTotal();
    const summary = getCostSummary();
    const { actual, equivalent } = summary;

    const lines = [
      `💰 **AI_WORKER コストレポート**`,
      ``,
      `📊 **実課金（今月・OpenAI API 等）**`,
      `  金額: ${actual.usd > 0 ? `$${actual.usd.toFixed(4)} USD ≈ ¥${actual.jpy.toLocaleString()}（推定）` : '¥0（ログなし）'}`,
      ``,
      `🤖 **Claude Code 使用量（参考換算・実請求ではありません）**`,
      `  タスク数: ${today.taskCount}件`,
      `  換算額: ${equivalent.usd > 0 ? `約¥${equivalent.jpy.toLocaleString()}相当` : '取得不可'}`,
      `  実行時間: ${today.totalSec > 0 ? `${Math.floor(today.totalSec / 60)}分${today.totalSec % 60}秒` : '不明'}`,
      ``,
      `🔒 **固定費**`,
      `  Claudeプラン: 月額プラン料金（console.anthropic.com でご確認）`,
    ];

    if (Object.keys(summary.byProject).length > 0) {
      lines.push(``, `📁 **プロジェクト別（実課金・今月）**`);
      Object.entries(summary.byProject)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .forEach(([pid, usd]) => {
          lines.push(`  ${pid}: ¥${Math.round(usd * USD_TO_JPY).toLocaleString()}`);
        });
    }

    lines.push(
      ``,
      `> ⚠️ Claude Code換算額は実請求ではありません。`,
      `> 確定額: console.anthropic.com（プラン）/ platform.openai.com/usage（API）`
    );
    return lines.join('\n');
  } catch (e) {
    return `💰 コストレポート取得失敗: ${e.message.slice(0, 100)}`;
  }
}

module.exports = {
  recordOpenAI,
  syncClaudeCosts,
  getCostSummary,
  getTodaySummary,   // 後方互換
  getStatus,
  formatFinanceSection,
  formatCostReport,
  // テスト用
  _monthlyFile: monthlyFile,
  _loadMonthly: loadMonthly,
  _saveMonthly: saveMonthly,
  _defaultMonthly,
};
