'use strict';

// =====================================================
// quality-gate.js — Quality Gate (Phase E-6)
//
// 設計原則:
//   1. RED トリガは worst-wins（1件でも RED → 即 RED）
//   2. スコアは RED トリガがない場合のみ使用（RED 時は null）
//   3. 秘密情報は必ず redact でマスクする
//   4. --skip-gate は未実装（将来拡張）
//
// RED トリガ（スコア合算しない）:
//   - ai-review verdict が `却下推奨`
//   - errorType が `AUTH` または `PERMISSION`
//   - security block（securityBlocked フラグ）
//   - completion-validator が未完了（REVIEWING 状態）
//   - Codex 危険度が `高`
//
// スコア（0-100、RED トリガなし時のみ）:
//   BASE 100 から各指標で減点。
//   YELLOW: < 70  /  GREEN: >= 70
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const REVIEWS_DIR = path.join(__dirname, '..', '..', 'reviews');

// ─── 秘密情報マスク ────────────────────────────────────
function _redact(str) {
  try { return require('./redact').redact(str || ''); } catch { return str || ''; }
}

// ─── 直近 N 件の history タスクをロード ─────────────────
function _loadRecentHistory(projectId, limit = 20) {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  try {
    const files = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-3); // 直近3ヶ月分
    const tasks = [];
    for (const f of files) {
      try {
        const h = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
        (h.tasks || [])
          .filter(t => !projectId || (t.projectId || 'default') === projectId)
          .forEach(t => tasks.push(t));
      } catch { /* ignore */ }
    }
    return tasks.slice(-limit);
  } catch { return []; }
}

// ─── reviews/result_<taskId>.md から危険度を抽出 ─────────
function _parseResultDanger(content) {
  const m = content.match(/危険度.*?(高|中|低)/);
  return m ? m[1] : null;
}

function _loadCodexResults(projectId) {
  const results = [];
  if (!fs.existsSync(REVIEWS_DIR)) return results;
  try {
    const files = fs.readdirSync(REVIEWS_DIR).filter(f => f.startsWith('result_') && f.endsWith('.md'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(REVIEWS_DIR, f), 'utf8');
        const danger  = _parseResultDanger(content);
        if (danger) results.push({ file: f, danger });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return results;
}

// ─────────────────────────────────────────────────────
// gatherIndicators(projectId)
//
// プロジェクトの現状指標を収集する。
// 秘密情報は redact でマスクして返す。
//
// 戻り値: indicators オブジェクト
// ─────────────────────────────────────────────────────
function gatherIndicators(projectId) {
  const taskManager = require('./task-manager');
  const allTasks    = taskManager.listTasks();
  const projTasks   = projectId
    ? allTasks.filter(t => (t.projectId || 'default') === projectId)
    : allTasks;

  // ─── アクティブタスク集計 ───────────────────────────
  const reviewing     = projTasks.filter(t => t.state === taskManager.STATES.REVIEWING);
  const pending       = projTasks.filter(t => t.state === taskManager.STATES.PENDING);
  const inProgress    = projTasks.filter(t => t.state === taskManager.STATES.IN_PROGRESS);

  // ai-review 却下推奨
  const rejectedReview = projTasks.filter(t =>
    t.reviewResult?.verdict === '却下推奨'
  );

  // errorType AUTH / PERMISSION
  const authErrors = projTasks.filter(t =>
    t.errorType === 'AUTH' || t.errorType === 'PERMISSION'
  );

  // securityBlocked フラグ
  const secBlocked = projTasks.filter(t => t.securityBlocked === true);

  // ─── 履歴タスク集計（直近20件）──────────────────────
  const history = _loadRecentHistory(projectId, 20);
  const doneCount    = history.length;
  const failedInHist = history.filter(t =>
    t.errorType || t.state === 'FAILED'
  ).length;
  const rejectInHist = history.filter(t =>
    t.reviewResult?.verdict === '却下推奨'
  ).length;
  const authInHist   = history.filter(t =>
    t.errorType === 'AUTH' || t.errorType === 'PERMISSION'
  ).length;
  const timeoutInHist = history.filter(t => t.errorType === 'TIMEOUT').length;
  const errorRate     = doneCount > 0 ? (failedInHist / doneCount) : 0;

  // ─── Codex 危険度集計（reviews/result_*.md）──────────
  const codexResults  = _loadCodexResults(projectId);
  const codexHighList = codexResults.filter(r => r.danger === '高');
  const codexMidList  = codexResults.filter(r => r.danger === '中');

  // ─── 最近のエラー概要（redact 済み）────────────────────
  const recentErrors = projTasks
    .filter(t => t.lastError)
    .slice(0, 5)
    .map(t => `[${t.id}] ${_redact(t.lastError || '').slice(0, 80)}`);

  logger.debug(
    `[QualityGate] indicators: ${projectId || 'all'} | ` +
    `reviewing:${reviewing.length} authErr:${authErrors.length + authInHist} ` +
    `codexHigh:${codexHighList.length} errorRate:${Math.round(errorRate * 100)}%`
  );

  return {
    projectId:          projectId || null,
    // RED トリガ関連
    rejectedReviewCount: rejectedReview.length + rejectInHist,
    authErrorCount:      authErrors.length + authInHist,
    securityBlockCount:  secBlocked.length,
    reviewingCount:      reviewing.length,       // REVIEWING = 未完了（completion-validator 不通過）
    codexHighCount:      codexHighList.length,
    // スコア計算用
    doneCount,
    failedCount:         failedInHist,
    timeoutCount:        timeoutInHist,
    pendingCount:        pending.length,
    inProgressCount:     inProgress.length,
    codexMidCount:       codexMidList.length,
    errorRate,
    // 表示用
    recentErrors,
    codexHighFiles:      codexHighList.map(r => r.file),
  };
}

// ─────────────────────────────────────────────────────
// computeQualityScore(indicators)
//
// RED トリガがない場合のみ呼ぶ。
// BASE 100 から各指標で減点し 0-100 を返す。
//
// 減点ルール:
//   REVIEWING バックログ:  -5 / 件
//   エラー率 > 20%:        -10 / 10% 超過分
//   タイムアウト:           -5 / 2件
//   Codex 中 危険度:        -5 / 件
//   failedCount:           -3 / 件（上限 -15）
// ─────────────────────────────────────────────────────
function computeQualityScore(indicators) {
  let score = 100;
  const deductions = [];

  // REVIEWING バックログ（-5/件）
  if (indicators.reviewingCount > 0) {
    const d = indicators.reviewingCount * 5;
    score -= d;
    deductions.push(`REVIEWING ${indicators.reviewingCount}件: -${d}点`);
  }

  // エラー率（20% 超過分を 10% 刻みで -10）
  if (indicators.errorRate > 0.20) {
    const overPct   = Math.floor((indicators.errorRate - 0.20) / 0.10);
    const d         = (overPct + 1) * 10;
    score -= d;
    deductions.push(`エラー率${Math.round(indicators.errorRate * 100)}%: -${d}点`);
  }

  // タイムアウト（-5 / 2件）
  if (indicators.timeoutCount >= 2) {
    const d = Math.floor(indicators.timeoutCount / 2) * 5;
    score -= d;
    deductions.push(`タイムアウト${indicators.timeoutCount}件: -${d}点`);
  }

  // Codex 中 危険度（-5/件）
  if (indicators.codexMidCount > 0) {
    const d = indicators.codexMidCount * 5;
    score -= d;
    deductions.push(`Codex 中 ${indicators.codexMidCount}件: -${d}点`);
  }

  // failedCount（-3/件、上限 -15）
  if (indicators.failedCount > 0) {
    const d = Math.min(indicators.failedCount * 3, 15);
    score -= d;
    deductions.push(`失敗タスク${indicators.failedCount}件: -${d}点`);
  }

  return { score: Math.max(0, score), deductions };
}

// ─────────────────────────────────────────────────────
// assessQuality(projectId)
//
// RED トリガを worst-wins で判定し、なければスコアで GREEN/YELLOW を返す。
//
// 戻り値:
//   {
//     projectId,
//     level:       'GREEN' | 'YELLOW' | 'RED',
//     score:       number | null,   // RED 時は null
//     redTriggers: string[],        // RED トリガの理由一覧
//     deductions:  string[],        // スコア減点理由（GREEN/YELLOW 時のみ）
//     indicators,
//   }
// ─────────────────────────────────────────────────────
function assessQuality(projectId) {
  const indicators  = gatherIndicators(projectId);
  const redTriggers = [];

  // ─── RED トリガ判定（worst-wins）────────────────────
  if (indicators.rejectedReviewCount > 0) {
    redTriggers.push(
      `🔴 AI レビュー却下推奨が ${indicators.rejectedReviewCount}件あります`
    );
  }
  if (indicators.authErrorCount > 0) {
    redTriggers.push(
      `🔴 AUTH/PERMISSION エラーが ${indicators.authErrorCount}件あります`
    );
  }
  if (indicators.securityBlockCount > 0) {
    redTriggers.push(
      `🔴 セキュリティブロックが ${indicators.securityBlockCount}件発生しています`
    );
  }
  if (indicators.reviewingCount > 0) {
    redTriggers.push(
      `🔴 完了バリデーション未通過（REVIEWING）が ${indicators.reviewingCount}件あります`
    );
  }
  if (indicators.codexHighCount > 0) {
    redTriggers.push(
      `🔴 Codex 高危険度が ${indicators.codexHighCount}件あります`
    );
  }

  // RED トリガが1件でもあれば即 RED（スコア算出しない）
  if (redTriggers.length > 0) {
    logger.info(`[QualityGate] RED: ${projectId || 'all'} | triggers:${redTriggers.length}`);
    return {
      projectId,
      level:      'RED',
      score:      null,
      redTriggers,
      deductions: [],
      indicators,
    };
  }

  // ─── RED トリガなし → スコアで GREEN/YELLOW ──────────
  const { score, deductions } = computeQualityScore(indicators);
  const level = score >= 70 ? 'GREEN' : 'YELLOW';

  logger.info(`[QualityGate] ${level} score:${score} | ${projectId || 'all'}`);
  return {
    projectId,
    level,
    score,
    redTriggers: [],
    deductions,
    indicators,
  };
}

// ─────────────────────────────────────────────────────
// formatQualityStatus(assessment)
//
// assessQuality() の戻り値を Discord 表示文字列に変換する。
// ─────────────────────────────────────────────────────
function formatQualityStatus(assessment) {
  const { level, score, redTriggers, deductions, indicators, projectId } = assessment;

  const levelIcon = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }[level] || '❓';
  const lines     = [];

  lines.push(`${levelIcon} **Quality Gate: ${level}**`);
  if (projectId) lines.push(`Project: \`${projectId}\``);
  lines.push('');

  if (level === 'RED') {
    lines.push('**🚨 RED トリガ（要対応）**');
    redTriggers.forEach(t => lines.push(`  ${t}`));
  } else {
    lines.push(`**スコア: ${score}/100**`);
    if (deductions.length > 0) {
      lines.push('');
      lines.push('**減点内訳:**');
      deductions.forEach(d => lines.push(`  • ${d}`));
    } else {
      lines.push('減点なし ✅');
    }
  }

  lines.push('');
  lines.push('**現状サマリー:**');
  lines.push(
    `  完了: ${indicators.doneCount}件` +
    ` | REVIEWING: ${indicators.reviewingCount}件` +
    ` | エラー率: ${Math.round(indicators.errorRate * 100)}%`
  );
  if (indicators.codexHighCount > 0) {
    lines.push(`  Codex 高: ${indicators.codexHighCount}件`);
  }
  if (indicators.recentErrors.length > 0) {
    lines.push('');
    lines.push('**直近エラー（概要）:**');
    indicators.recentErrors.forEach(e => lines.push(`  \`${e}\``));
  }

  return lines.join('\n');
}

module.exports = {
  gatherIndicators,
  computeQualityScore,
  assessQuality,
  formatQualityStatus,
};
