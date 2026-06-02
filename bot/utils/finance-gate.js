'use strict';
// =====================================================
// finance-gate.js — Finance Gate Phase 1
//
// 目的:
//   社長ポケットマネーから出る開発費に上限を設ける。
//   月次予算と各しきい値に基づき、自動実行を制御する。
//
// ゲートレベル:
//   OK         — 予算に余裕あり（通常実行）
//   WARNING    — warningRate(50%) 超過 → 警告表示して続行
//   APPROVAL   — approvalRate(80%) 超過 → CEO 確認が必要
//   HARD_STOP  — hardStopRate(100%) 超過 → 強制停止
//
// 費用の扱い:
//   ・Claude Code CLI: 実費（total_cost_usd から取得できれば）
//   ・OpenAI API: 推定値（token数から計算）
//   ・取得不可のコストは「推定」と明記
//
// 重要:
//   ・このゲートは勝手に課金停止しない（通知・確認のみ）
//   ・実費と推定値は区別して表示
//   ・不明なコストは「推定」と明記
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const financeManager = require('./finance-manager');

const CONFIG_FILE  = path.join(__dirname, '..', '..', 'data', 'finance-config.json');
const APPROVE_FILE = path.join(__dirname, '..', '..', 'data', 'finance-approval.json');

// ─── ゲートレベル定数 ────────────────────────────────
const GATE_LEVEL = {
  OK:         'OK',
  WARNING:    'WARNING',
  APPROVAL:   'APPROVAL',
  HARD_STOP:  'HARD_STOP',
};

// ─── USD → JPY 換算レート（概算）───────────────────
const USD_TO_JPY = 155;

// ─── デフォルト設定 ──────────────────────────────────
const DEFAULT_CONFIG = {
  monthlyBudgetJPY:    5000,   // 月予算（円）— 実課金のみ対象
  warningRate:         0.50,   // 50% で WARNING
  approvalRate:        0.80,   // 80% で APPROVAL 必要
  hardStopRate:        1.00,   // 100% で HARD STOP
  perRunLimitJPY:      500,    // 1実行あたりの上限（円）
  fixedMonthlyCostJPY: 0,      // Claudeプランなど固定費（円・表示専用）
  enabled:             true,   // ゲート有効/無効
  updatedAt:           null,
  // 重要: Finance Gate の判定は actualCostUsd のみ使用
  //       Claude Code 換算額は実課金でないためゲート判定に含めない
};

// ─────────────────────────────────────────────────────
// Config 管理
// ─────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// デフォルト設定ファイルを作成（初回起動時）
function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    logger.info('[FinanceGate] デフォルト設定ファイルを作成: data/finance-config.json');
  }
}

// ─────────────────────────────────────────────────────
// 今月の実課金使用額を取得（Finance Gate の判定用）
//
// 重要:
//   ・Claude Code 換算額は含めない（実課金ではないため）
//   ・actualCostUsd（OpenAI API 等）のみ使用
// ─────────────────────────────────────────────────────
function getMonthlyUsage() {
  try {
    // getCostSummary があれば使用（Rev.2 以降）
    const fm = financeManager;
    let actualUsd = 0;

    if (typeof fm.getCostSummary === 'function') {
      const cs = fm.getCostSummary();
      actualUsd = cs.actual?.usd || 0;
    } else {
      // 後方互換: 旧 getTodaySummary
      const summary = fm.getTodaySummary();
      actualUsd = summary.actualMonthlyUsd || summary.monthlyTotalUsd || 0;
    }

    return {
      usd:        Math.round(actualUsd * 10000) / 10000,
      jpy:        Math.round(actualUsd * USD_TO_JPY),
      isEstimate: true,         // USD→JPY 換算は概算
      isActualOnly: true,       // Claude Code 換算額を含まないことを明示
    };
  } catch {
    return { usd: 0, jpy: 0, isEstimate: true, isActualOnly: true };
  }
}

// ─────────────────────────────────────────────────────
// 予算消化率を計算してゲートレベルを返す
// ─────────────────────────────────────────────────────
function evaluateBudget() {
  ensureConfigFile();
  const config = loadConfig();

  if (!config.enabled) {
    return {
      level:       GATE_LEVEL.OK,
      config,
      usage:       { usd: 0, jpy: 0, isEstimate: true },
      rate:        0,
      remaining:   config.monthlyBudgetJPY,
      budgetJPY:   config.monthlyBudgetJPY,
      message:     null,
    };
  }

  const usage = getMonthlyUsage();
  const rate  = config.monthlyBudgetJPY > 0
    ? usage.jpy / config.monthlyBudgetJPY
    : 0;
  const remaining = Math.max(0, config.monthlyBudgetJPY - usage.jpy);

  let level = GATE_LEVEL.OK;
  if      (rate >= config.hardStopRate)  level = GATE_LEVEL.HARD_STOP;
  else if (rate >= config.approvalRate)  level = GATE_LEVEL.APPROVAL;
  else if (rate >= config.warningRate)   level = GATE_LEVEL.WARNING;

  return { level, config, usage, rate, remaining, budgetJPY: config.monthlyBudgetJPY };
}

// ─────────────────────────────────────────────────────
// Approval 管理（APPROVAL レベル時の CEO 確認フロー）
// ─────────────────────────────────────────────────────
function loadApproval() {
  try {
    if (fs.existsSync(APPROVE_FILE)) {
      return JSON.parse(fs.readFileSync(APPROVE_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return { approved: false, approvedAt: null, approvedBy: null, expiresAt: null };
}

function saveApproval(data) {
  const dir = path.dirname(APPROVE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(APPROVE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** APPROVAL レベルでも CEO が承認済みか確認（有効期限: 24h） */
function isBudgetApproved() {
  const appr = loadApproval();
  if (!appr.approved || !appr.expiresAt) return false;
  return new Date(appr.expiresAt).getTime() > Date.now();
}

/** CEO が予算超過を承認（24h 有効） */
function approveBudgetOverrun(approvedBy = 'owner') {
  saveApproval({
    approved:   true,
    approvedAt: new Date().toISOString(),
    approvedBy,
    expiresAt:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  logger.info(`[FinanceGate] 予算超過承認: by=${approvedBy} expires=24h`);
}

/** 承認をリセット */
function resetApproval() {
  saveApproval({ approved: false, approvedAt: null, approvedBy: null, expiresAt: null });
}

// ─────────────────────────────────────────────────────
// Project Runner 起動前チェック
//
// 戻り値:
//   { allowed: boolean, level, message, budgetSummary }
// ─────────────────────────────────────────────────────
function checkRunnerStart() {
  try {
    const eval_ = evaluateBudget();
    const { level, config, usage, rate, remaining, budgetJPY } = eval_;

    const ratePercent  = Math.round(rate * 100);
    const estimateMark = usage.isEstimate ? '（推定）' : '';
    const budgetBar    = buildBudgetBar(rate);

    const budgetSummary = formatBudgetLine(eval_);

    if (level === GATE_LEVEL.OK || level === GATE_LEVEL.WARNING) {
      const message = level === GATE_LEVEL.WARNING
        ? `🟡 **予算警告** — 今月の使用額が予算の ${ratePercent}% に達しました${estimateMark}\n${budgetSummary}`
        : null;
      return { allowed: true, level, message, budgetSummary };
    }

    if (level === GATE_LEVEL.APPROVAL) {
      if (isBudgetApproved()) {
        return {
          allowed:     true,
          level,
          message:     `🟠 **予算承認済み** — 予算の ${ratePercent}% 消化中。承認期限内で続行します。\n${budgetSummary}`,
          budgetSummary,
        };
      }
      return {
        allowed: false,
        level,
        message:
          `🟠 **予算 ${ratePercent}% 消化 — CEO 確認が必要です**${estimateMark}\n\n` +
          `${budgetSummary}\n\n` +
          `予算の ${Math.round(config.approvalRate * 100)}% を超えたため、実行前に確認が必要です。\n` +
          `続行する場合: \`!finance approve\`\n` +
          `予算を見直す場合: \`!finance config set monthlyBudgetJPY <金額>\``,
        budgetSummary,
      };
    }

    // HARD_STOP
    return {
      allowed: false,
      level,
      message:
        `🔴 **予算上限到達 — 自動実行を停止しました**${estimateMark}\n\n` +
        `${budgetSummary}\n\n` +
        `今月の予算（${budgetJPY.toLocaleString()}円）を使い切りました。\n` +
        `予算追加: \`!finance config set monthlyBudgetJPY <新しい金額>\`\n` +
        `来月まで待つ場合: ランナーは手動で起動してください。`,
      budgetSummary,
    };
  } catch (e) {
    logger.warn(`[FinanceGate] checkRunnerStart エラー（続行）: ${e.message}`);
    return { allowed: true, level: GATE_LEVEL.OK, message: null, budgetSummary: null };
  }
}

// ─────────────────────────────────────────────────────
// 予算状況を1行テキストにフォーマット
// ─────────────────────────────────────────────────────
function buildBudgetBar(rate) {
  const filled = Math.min(10, Math.round(rate * 10));
  const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `[${bar}]`;
}

function formatBudgetLine(eval_) {
  const { usage, rate, remaining, budgetJPY, config } = eval_;
  const ratePercent  = Math.round(rate * 100);
  const barStr       = buildBudgetBar(rate);
  const estimateMark = usage.isEstimate ? '推定' : '実費';

  return (
    `💰 今月予算: ${barStr} ${ratePercent}% ` +
    `（${usage.jpy.toLocaleString()}円 / ${budgetJPY.toLocaleString()}円 ・${estimateMark}）` +
    ` | 残: ${remaining.toLocaleString()}円`
  );
}

// ─────────────────────────────────────────────────────
// CEO Report 用の予算セクション
// ─────────────────────────────────────────────────────
function formatBudgetSection() {
  try {
    const eval_    = evaluateBudget();
    const { level, usage, rate, remaining, budgetJPY, config } = eval_;
    const levelEmoji = { OK: '🟢', WARNING: '🟡', APPROVAL: '🟠', HARD_STOP: '🔴' }[level] || '❓';
    const ratePercent = Math.round(rate * 100);
    const barStr     = buildBudgetBar(rate);
    const estimateMark = usage.isEstimate ? '（推定値）' : '（実費）';

    // 換算情報を追加
    let equivLine = '';
    try {
      const fm = require('./finance-manager');
      if (typeof fm.getCostSummary === 'function') {
        const cs = fm.getCostSummary();
        if (cs.equivalent?.jpy > 0) {
          equivLine = `\n参考換算: ¥${cs.equivalent.jpy.toLocaleString()}相当（Claude Code・実請求でない）`;
        }
      }
    } catch { /* ignore */ }

    const fixedLine = config.fixedMonthlyCostJPY > 0
      ? `\n固定費: Claudeプラン ¥${config.fixedMonthlyCostJPY.toLocaleString()}/月（別途）`
      : '';

    const lines = [
      `💰 **月次予算 — Finance Gate**`,
      ``,
      `状態: ${levelEmoji} **${level}**`,
      `${barStr} ${ratePercent}% 消化（実課金のみ）`,
      `実課金: ¥${usage.jpy.toLocaleString()} / ¥${budgetJPY.toLocaleString()}（月予算）` + equivLine + fixedLine,
      `残り: ¥${remaining.toLocaleString()}`,
    ];

    if (level === GATE_LEVEL.WARNING) {
      lines.push(``, `⚠️ 予算の ${Math.round(config.warningRate * 100)}% を超えました。コスト確認をお勧めします。`);
    } else if (level === GATE_LEVEL.APPROVAL) {
      lines.push(``, `🟠 予算の ${Math.round(config.approvalRate * 100)}% 超過。次回実行前に \`!finance approve\` が必要です。`);
    } else if (level === GATE_LEVEL.HARD_STOP) {
      lines.push(``, `🔴 予算上限に達しました。自動実行は停止されます。\`!finance config\` で予算を見直してください。`);
    }

    lines.push(``, `> ⚠️ 予算判定は**実課金（OpenAI API 等）のみ**です。Claude Code換算額はゲート判定に含みません。`);
    lines.push(`> 確定額: console.anthropic.com（プラン）/ platform.openai.com/usage（API）`);

    return lines.join('\n');
  } catch {
    return `💰 **月次予算** — 取得不可（\`!finance status\` で確認してください）`;
  }
}

// ─────────────────────────────────────────────────────
// !finance コマンド用: 詳細ステータス
// ─────────────────────────────────────────────────────
function formatFinanceStatus() {
  try {
    const eval_    = evaluateBudget();
    const appr     = loadApproval();
    const { level, usage, rate, remaining, budgetJPY, config } = eval_;
    const levelEmoji = { OK: '🟢', WARNING: '🟡', APPROVAL: '🟠', HARD_STOP: '🔴' }[level] || '❓';
    const ratePercent = Math.round(rate * 100);
    const barStr     = buildBudgetBar(rate);
    const approvalInfo = appr.approved && appr.expiresAt
      ? `承認済み（期限: ${new Date(appr.expiresAt).toLocaleString('ja-JP')}）`
      : '未承認';

    // Claude Code 換算と固定費を取得
    let equivJPY = 0, fixedJPY = config.fixedMonthlyCostJPY || 0;
    try {
      const fm = require('./finance-manager');
      if (typeof fm.getCostSummary === 'function') {
        equivJPY = fm.getCostSummary().equivalent?.jpy || 0;
      }
    } catch { /* ignore */ }

    return [
      `💰 **Finance Gate ステータス**`,
      ``,
      `${levelEmoji} 状態: **${level}**（実課金ベース）`,
      `${barStr} ${ratePercent}%`,
      ``,
      `📊 **今月のコスト内訳**`,
      `  💳 実課金（OpenAI API 等）: ¥${usage.jpy.toLocaleString()}（推定 $${usage.usd.toFixed(4)}）`,
      `  🤖 参考換算（Claude Code）:  ${equivJPY > 0 ? `約¥${equivJPY.toLocaleString()}相当` : '取得不可'}（実請求でない）`,
      `  🔒 固定費（Claudeプラン）:   ${fixedJPY > 0 ? `¥${fixedJPY.toLocaleString()}/月` : '未設定（console.anthropic.com 参照）'}`,
      `  📅 月予算（実課金上限）:      ¥${budgetJPY.toLocaleString()}`,
      `  💰 残り:                      ¥${remaining.toLocaleString()}`,
      ``,
      `⚙️ **設定**`,
      `  WARNING:   ${Math.round(config.warningRate  * 100)}%（¥${Math.round(budgetJPY * config.warningRate).toLocaleString()}）`,
      `  APPROVAL:  ${Math.round(config.approvalRate * 100)}%（¥${Math.round(budgetJPY * config.approvalRate).toLocaleString()}）`,
      `  HARD STOP: ${Math.round(config.hardStopRate * 100)}%（¥${Math.round(budgetJPY * config.hardStopRate).toLocaleString()}）`,
      `  1実行上限: ¥${config.perRunLimitJPY.toLocaleString()}`,
      `  ゲート: ${config.enabled ? '有効' : '無効'}`,
      ``,
      `🔓 APPROVAL 承認: ${approvalInfo}`,
      ``,
      `> 費用は推定値。確定額は console.anthropic.com / platform.openai.com で確認。`,
    ].join('\n');
  } catch {
    return '💰 Finance Gate ステータス取得失敗';
  }
}

module.exports = {
  GATE_LEVEL,
  loadConfig,
  saveConfig,
  evaluateBudget,
  checkRunnerStart,
  isBudgetApproved,
  approveBudgetOverrun,
  resetApproval,
  formatBudgetLine,
  formatBudgetSection,
  formatFinanceStatus,
  // テスト用
  _getMonthlyUsage:   getMonthlyUsage,
  _buildBudgetBar:    buildBudgetBar,
  _ensureConfigFile:  ensureConfigFile,
};
