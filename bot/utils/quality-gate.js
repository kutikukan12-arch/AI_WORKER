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
// _isValidationFailure(task)
//
// H2: REVIEWING 状態のうち、completion-validator 失敗によるものを識別。
// M4: 最後のエントリだけでなく stateHistory 全体をスキャンし、
//     REVIEWING に遷移した際に「未完了」を含む note が記録されていれば
//     validator 失敗と判定する（末尾依存の脆さを解消）。
//
// レビュー待ち（AIレビュー等）は正常状態のため RED にしない。
// ─────────────────────────────────────────────────────
function _isValidationFailure(task) {
  const hist = task.stateHistory || [];
  // stateHistory 全体から「REVIEWING かつ 未完了」の記録を探す
  return hist.some(h =>
    (h.state === 'レビュー待ち' || h.state === 'REVIEWING') &&
    (h.note || '').includes('未完了')
  );
}

// ─────────────────────────────────────────────────────
// _resolveTaskProject(taskId)
//
// M2: taskId から projectId を引く。
// アクティブ tasks.json → history の順で探す。
// ─────────────────────────────────────────────────────
function _resolveTaskProject(taskId) {
  try {
    const taskManager = require('./task-manager');
    const active = taskManager.getTask(taskId);
    if (active) return active.projectId || 'default';
    // history から探す
    if (!fs.existsSync(HISTORY_DIR)) return null;
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).slice(-3);
    for (const f of files) {
      try {
        const h = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
        const t = (h.tasks || []).find(x => x.id === taskId);
        if (t) return t.projectId || 'default';
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

// ─────────────────────────────────────────────────────
// _loadCodexResults(projectId) — M2 修正: projectId でフィルタ
//
// result_<taskId>.md のファイル名から taskId を取り出し、
// そのタスクの projectId を照合して絞り込む。
// projectId が null の場合は全件返す（後方互換）。
// ─────────────────────────────────────────────────────
function _loadCodexResultsByProject(projectId) {
  const results = [];
  if (!fs.existsSync(REVIEWS_DIR)) return results;
  try {
    const files = fs.readdirSync(REVIEWS_DIR).filter(f => f.startsWith('result_') && f.endsWith('.md'));
    for (const f of files) {
      try {
        // result_<taskId>.md → taskId 抽出
        const taskId = f.replace(/^result_/, '').replace(/\.md$/, '');
        if (projectId) {
          const taskPid = _resolveTaskProject(taskId);
          // M3: projectId が解決できない場合は安全のため除外（UNKNOWN 扱い）
          // taskPid === null → 混入防止のためスキップ
          if (!taskPid || taskPid !== projectId) continue;
        }
        const content = fs.readFileSync(path.join(REVIEWS_DIR, f), 'utf8');
        const danger  = _parseResultDanger(content);
        if (danger) results.push({ file: f, taskId, danger });
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
// H2: REVIEWING は正常なレビュー待ちのため RED トリガ対象外。
//     completion-validator 失敗（stateNote に「未完了」）のみ RED。
// M1: 完了済み（history）のエラーは RED に使わない（スコアのみ）。
// M2: Codex 結果を projectId 単位に絞り込む。
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

  // H2: completion-validator 失敗（REVIEWING かつ stateNote=未完了）のみ RED 対象
  const validationFailed = reviewing.filter(_isValidationFailure);

  // ai-review 却下推奨（アクティブタスクのみ — M1: history は除外）
  const rejectedReview = projTasks.filter(t =>
    t.reviewResult?.verdict === '却下推奨'
  );

  // errorType AUTH / PERMISSION（アクティブタスクのみ — M1: history は除外）
  const authErrors = projTasks.filter(t =>
    t.errorType === 'AUTH' || t.errorType === 'PERMISSION'
  );

  // M1（B案）: securityBlocked フィールドは task に永続化されないため
  // RED トリガから除外する。security.js による blocking は prepareNextTask()
  // 側で実行時に防御されており、quality-gate での重複チェックは不要。
  // const secBlocked = projTasks.filter(t => t.securityBlocked === true);
  // → securityBlockCount を常に 0 とする
  const secBlockCount = 0;

  // ─── 履歴タスク集計（スコア用のみ — M1: history は RED に使わない）─
  const history = _loadRecentHistory(projectId, 20);
  const doneCount    = history.length;
  const failedInHist = history.filter(t =>
    t.errorType || t.state === 'FAILED'
  ).length;
  const timeoutInHist = history.filter(t => t.errorType === 'TIMEOUT').length;
  const errorRate     = doneCount > 0 ? (failedInHist / doneCount) : 0;

  // ─── Codex 危険度集計（M2: projectId 単位）───────────
  const codexResults  = _loadCodexResultsByProject(projectId);
  const codexHighList = codexResults.filter(r => r.danger === '高');
  const codexMidList  = codexResults.filter(r => r.danger === '中');

  // ─── 最近のエラー概要（redact 済み）────────────────────
  const recentErrors = projTasks
    .filter(t => t.lastError)
    .slice(0, 5)
    .map(t => `[${t.id}] ${_redact(t.lastError || '').slice(0, 80)}`);

  logger.debug(
    `[QualityGate] indicators: ${projectId || 'all'} | ` +
    `reviewing:${reviewing.length} validFail:${validationFailed.length} ` +
    `authErr:${authErrors.length} codexHigh:${codexHighList.length} ` +
    `errorRate:${Math.round(errorRate * 100)}%`
  );

  return {
    projectId:              projectId || null,
    // RED トリガ関連（アクティブタスクのみ / history は含めない）
    rejectedReviewCount:    rejectedReview.length,    // M1: history 除外
    authErrorCount:         authErrors.length,         // M1: history 除外
    securityBlockCount:     secBlockCount,  // M1(B案): 常に 0（フィールド未永続化のため）
    validationFailedCount:  validationFailed.length,  // H2: validator 失敗のみ
    reviewingCount:         reviewing.length,          // H2: スコア用（RED ではない）
    codexHighCount:         codexHighList.length,      // M2: project 単位
    // スコア計算用
    doneCount,
    failedCount:            failedInHist,
    timeoutCount:           timeoutInHist,
    pendingCount:           pending.length,
    inProgressCount:        inProgress.length,
    codexMidCount:          codexMidList.length,
    errorRate,
    // 表示用
    recentErrors,
    codexHighFiles:         codexHighList.map(r => r.file),
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
      `🔴 AUTH/PERMISSION エラーが ${indicators.authErrorCount}件あります（アクティブ）`
    );
  }
  if (indicators.securityBlockCount > 0) {
    redTriggers.push(
      `🔴 セキュリティブロックが ${indicators.securityBlockCount}件発生しています`
    );
  }
  // H2: REVIEWING（レビュー待ち）は正常状態のため RED 対象外。
  //     completion-validator 失敗（stateNote に「未完了」）のみ RED。
  if (indicators.validationFailedCount > 0) {
    redTriggers.push(
      `🔴 完了バリデーション失敗が ${indicators.validationFailedCount}件あります`
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

// ─────────────────────────────────────────────────────
// quality-gates.json — Gate 定義ストレージ
//
// !quality gate add / remove で管理するゲート設定を保存する。
// ゲートは "GREEN 以上必須" / "YELLOW 以上必須" など閾値を持つ。
// ─────────────────────────────────────────────────────
const GATES_FILE = path.join(DATA_DIR, 'quality-gates.json');

function _loadGates() {
  if (!fs.existsSync(GATES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(GATES_FILE, 'utf8')).gates || [];
  } catch { return []; }
}

function _saveGates(gates) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GATES_FILE, JSON.stringify({ gates, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────
// addGate(gate)
//
// ゲート定義を追加する。
// gate: { id, projectId, minLevel, description }
//   minLevel: 'GREEN' | 'YELLOW'（それ以下なら gate NG）
// ─────────────────────────────────────────────────────
function addGate(gate) {
  if (!gate.id || !gate.projectId || !gate.minLevel) {
    return { ok: false, reason: 'id / projectId / minLevel が必要です' };
  }
  const VALID_LEVELS = new Set(['GREEN', 'YELLOW']);
  if (!VALID_LEVELS.has(gate.minLevel)) {
    return { ok: false, reason: `minLevel は GREEN または YELLOW のみ有効` };
  }
  const gates = _loadGates();
  if (gates.find(g => g.id === gate.id)) {
    return { ok: false, reason: `gate \`${gate.id}\` は既に存在します` };
  }
  gates.push({ ...gate, createdAt: new Date().toISOString() });
  _saveGates(gates);
  logger.info(`[QualityGate] gate 追加: ${gate.id} | ${gate.projectId} | minLevel:${gate.minLevel}`);
  return { ok: true, gate };
}

// ─────────────────────────────────────────────────────
// removeGate(id)
// ─────────────────────────────────────────────────────
function removeGate(id) {
  const gates = _loadGates();
  const idx   = gates.findIndex(g => g.id === id);
  if (idx === -1) return { ok: false, reason: `gate \`${id}\` が見つかりません` };
  const [removed] = gates.splice(idx, 1);
  _saveGates(gates);
  return { ok: true, gate: removed };
}

// ─────────────────────────────────────────────────────
// listGates()
// ─────────────────────────────────────────────────────
function listGates() { return _loadGates(); }

// ─────────────────────────────────────────────────────
// evaluateGates(projectId)
//
// 登録済みゲートのうち projectId に関係するものを評価する。
// assessment を取得し、minLevel を満たすか判定。
//
// 戻り値: { passed: bool, results: [{gate, level, ok}] }
// ─────────────────────────────────────────────────────
const LEVEL_ORDER = { RED: 0, YELLOW: 1, GREEN: 2 };

function evaluateGates(projectId) {
  const gates = _loadGates().filter(g =>
    g.projectId === projectId || g.projectId === '*'
  );
  if (gates.length === 0) {
    return { passed: true, results: [], noGates: true };
  }

  const assessment = assessQuality(projectId);
  const results    = gates.map(gate => {
    const currentOrder = LEVEL_ORDER[assessment.level] ?? 0;
    const minOrder     = LEVEL_ORDER[gate.minLevel]    ?? 2;
    const ok           = currentOrder >= minOrder;
    return { gate, level: assessment.level, score: assessment.score, ok };
  });

  const passed = results.every(r => r.ok);
  return { passed, results, assessment };
}

// ─────────────────────────────────────────────────────
// generateReport(projectId)
//
// !quality report 用の詳細レポートを生成する。
// assessQuality + gateResults をまとめたテキストを返す。
// ─────────────────────────────────────────────────────
function generateReport(projectId) {
  const assessment = assessQuality(projectId);
  const gateResult = evaluateGates(projectId);
  const lines      = [];
  const now        = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  lines.push(`📋 **Quality Report** — ${now}`);
  if (projectId) lines.push(`Project: \`${projectId}\``);
  lines.push('');

  // Gate 評価
  if (gateResult.noGates) {
    lines.push('**ゲート:** 未設定（`!quality gate add` で追加できます）');
  } else {
    const gateIcon = gateResult.passed ? '✅' : '❌';
    lines.push(`**ゲート評価:** ${gateIcon} ${gateResult.passed ? 'PASSED' : 'FAILED'}`);
    gateResult.results.forEach(r => {
      const icon = r.ok ? '✅' : '❌';
      lines.push(`  ${icon} \`${r.gate.id}\` ${r.gate.minLevel} 以上必須 → 現在 **${r.level}**`);
    });
  }
  lines.push('');

  // Quality 状態
  lines.push(formatQualityStatus(assessment));

  // インジケータ詳細
  const ind = assessment.indicators;
  lines.push('');
  lines.push('**📊 指標詳細:**');
  lines.push(`  完了タスク: ${ind.doneCount}件 | 失敗: ${ind.failedCount}件 | タイムアウト: ${ind.timeoutCount}件`);
  lines.push(`  エラー率: ${Math.round(ind.errorRate * 100)}% | Codex 高: ${ind.codexHighCount}件 | Codex 中: ${ind.codexMidCount}件`);

  return {
    text:       lines.join('\n'),
    assessment,
    gateResult,
    generatedAt: now,
  };
}

// ─────────────────────────────────────────────────────
// formatGateList() — !quality gate list 用
// ─────────────────────────────────────────────────────
function formatGateList() {
  const gates = _loadGates();
  if (gates.length === 0) {
    return (
      '**🚦 Quality Gates: 未設定**\n\n' +
      '```\n!quality gate add <id> <project> <GREEN|YELLOW>\n```'
    );
  }
  const lines = ['**🚦 Quality Gates**', ''];
  gates.forEach(g => {
    lines.push(`  \`${g.id}\`  ${g.projectId}  minLevel:**${g.minLevel}**  ${g.description || ''}`);
  });
  lines.push('');
  lines.push('`!quality gate add/remove` でゲートを管理できます。');
  return lines.join('\n');
}

module.exports = {
  gatherIndicators,
  computeQualityScore,
  assessQuality,
  formatQualityStatus,
  // Gate 管理
  addGate,
  removeGate,
  listGates,
  evaluateGates,
  // レポート
  generateReport,
  formatGateList,
};
