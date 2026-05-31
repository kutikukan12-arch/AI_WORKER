'use strict';

// =====================================================
// company-manager.js — AI会社 人員配置マネージャー (Phase E-5c)
//
// 役割:
//   プロジェクトのタスク状況を分析し、
//   最適な Worker 構成（何人・何の役割）を推薦する。
//
// 主要関数:
//   analyzeProjectStaffing(projectId) → stats
//   recommendStaffing(stats)          → plan
//   formatStaffingPlan(plan)          → Discord表示文字列
//
// 判断ルール:
//   IMPLEMENT/FIX/REFACTOR 3件につき IMPLEMENTER 1人
//   REVIEW 1件以上なら REVIEWER 1人（REVIEWING積み上がりで増員）
//   TEST 1件以上なら TESTER 1人
//   RESEARCH/DOCS 2件以上なら RESEARCHER 1人
//   エラー率/タイムアウト多発で REVIEWER 増員
//   上限: MAX_WORKERS（デフォルト 8）
// =====================================================

const logger         = require('./logger');
const taskManager    = require('./task-manager');
const workerRegistry = require('./worker-registry');

// ─── 設定定数 ─────────────────────────────────────────

// IMPLEMENT/FIX/REFACTOR 何件でIMPLEMENTER 1人
const IMPL_PER_WORKER = 3;

// REVIEWING 何件でREVIEWER 1人（最低1人保証）
const REVIEW_PER_WORKER = 2;

// RESEARCH/DOCS がこれ以上で RESEARCHER 1人
const RESEARCHER_THRESHOLD = 2;

// 失敗率（直近10件）がこれを超えたら REVIEWER を増員
const ERROR_RATE_THRESHOLD = 0.20;

// タイムアウト経験タスクがこれ以上で REVIEWER を増員
const TIMEOUT_THRESHOLD = 2;

// Worker 総数の絶対上限
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '8', 10);

// ─── スケール定義 ──────────────────────────────────────
// アクティブタスク数（PENDING + IN_PROGRESS + REVIEWING）からスケールを判定する。
// maxImpl / maxReview はロール別の上限。
const SCALE_TABLE = [
  { key: 'MICRO',  label: '極小',   upTo:  3, maxImpl: 1, maxReview: 1 },
  { key: 'SMALL',  label: '小規模', upTo:  9, maxImpl: 2, maxReview: 1 },
  { key: 'MEDIUM', label: '中規模', upTo: 20, maxImpl: 3, maxReview: 1 },
  { key: 'LARGE',  label: '大規模', upTo: 40, maxImpl: 4, maxReview: 2 },
  { key: 'XLARGE', label: '超大規模',upTo: Infinity, maxImpl: 5, maxReview: 2 },
];

// ─────────────────────────────────────────────────────
// _getScale(activeCount) — アクティブタスク数からスケールを返す（内部用）
// ─────────────────────────────────────────────────────
function _getScale(activeCount) {
  return SCALE_TABLE.find(s => activeCount <= s.upTo) || SCALE_TABLE[SCALE_TABLE.length - 1];
}

// ─────────────────────────────────────────────────────
// analyzeProjectStaffing(projectId)
//
// 指定プロジェクトのタスク状況を集計して stats オブジェクトを返す。
// projectId を省略/null にすると全プロジェクトが対象になる。
//
// 戻り値:
//   {
//     projectId,        プロジェクトID（null=全体）
//     totalTasks,       対象タスクの総数
//     activeCount,      PENDING + IN_PROGRESS + REVIEWING の合計
//     byState,          { '未着手': N, '作業中': N, ... }
//     pendingByType,    { IMPLEMENT: N, FIX: N, ... }（PENDING のみ）
//     reviewingCount,   REVIEWING 状態タスク数
//     pendingImpl,      IMPLEMENT + FIX + REFACTOR の PENDING 数
//     pendingReview,    REVIEW の PENDING 数
//     pendingTest,      TEST の PENDING 数
//     pendingResearch,  RESEARCH + DOCS の PENDING 数
//     pendingUndefined, type が未定義の PENDING 数
//     withTimeouts,     timeoutCount > 0 のタスク数
//     withErrors,       errorType が設定済みのタスク数
//     errorRate,        直近 10 件の errorType 保持率（0.0〜1.0）
//   }
// ─────────────────────────────────────────────────────
function analyzeProjectStaffing(projectId) {
  const allTasks = taskManager.listTasks();
  const tasks = projectId
    ? allTasks.filter(t => (t.projectId || 'default') === projectId)
    : allTasks;

  // ── 状態別集計 ───────────────────────────────────────
  const byState = {};
  for (const s of Object.values(taskManager.STATES)) byState[s] = 0;
  tasks.forEach(t => {
    const s = t.state || taskManager.STATES.PENDING;
    byState[s] = (byState[s] || 0) + 1;
  });

  const activeCount =
    (byState[taskManager.STATES.PENDING]     || 0) +
    (byState[taskManager.STATES.IN_PROGRESS] || 0) +
    (byState[taskManager.STATES.REVIEWING]   || 0);

  // ── PENDING タスクのタイプ別集計 ─────────────────────
  const pending = tasks.filter(t => t.state === taskManager.STATES.PENDING);
  const pendingByType = {};
  pending.forEach(t => {
    const tp = t.type || 'undefined';
    pendingByType[tp] = (pendingByType[tp] || 0) + 1;
  });

  // ── エラー・タイムアウト統計 ──────────────────────────
  const withTimeouts = tasks.filter(t => (t.timeoutCount || 0) > 0).length;
  const withErrors   = tasks.filter(t => t.errorType && t.errorType !== 'UNKNOWN').length;

  // 直近 10 件（updatedAt 降順）の失敗率
  const recent10    = [...tasks]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 10);
  const errorRate   = recent10.length > 0
    ? recent10.filter(t => t.errorType && t.errorType !== 'UNKNOWN').length / recent10.length
    : 0;

  // ── 利便性フィールド（呼び出し側で計算不要にする）────
  const pendingImpl     = (pendingByType.IMPLEMENT || 0) + (pendingByType.FIX || 0) + (pendingByType.REFACTOR || 0);
  const pendingReview   = pendingByType.REVIEW   || 0;
  const pendingTest     = pendingByType.TEST      || 0;
  const pendingResearch = (pendingByType.RESEARCH || 0) + (pendingByType.DOCS || 0);
  const pendingUndefined = pendingByType.undefined || 0;

  logger.debug(`[CompanyMgr] analyze: ${projectId || 'all'} | active:${activeCount} | impl:${pendingImpl} review:${pendingReview}`);

  return {
    projectId,
    totalTasks:     tasks.length,
    activeCount,
    byState,
    pendingByType,
    reviewingCount: byState[taskManager.STATES.REVIEWING] || 0,
    pendingImpl,
    pendingReview,
    pendingTest,
    pendingResearch,
    pendingUndefined,
    withTimeouts,
    withErrors,
    errorRate,
  };
}

// ─────────────────────────────────────────────────────
// recommendStaffing(stats)
//
// analyzeProjectStaffing() の結果を受け取り、
// 最適な Worker 構成を計算して返す。
//
// 戻り値:
//   {
//     workers:  { IMPLEMENTER: N, REVIEWER: N, TESTER: N, RESEARCHER: N }
//     total:    N
//     scale:    'SMALL' など
//     scaleLabel: '小規模' など
//     capped:   boolean（MAX_WORKERS で切り詰めた場合 true）
//     adjustedForErrors: boolean
//     reasoning: string[]  判断理由の一覧
//   }
// ─────────────────────────────────────────────────────
function recommendStaffing(stats) {
  const scale    = _getScale(stats.activeCount);
  const reasoning = [];

  // ── IMPLEMENTER ────────────────────────────────────
  let implementer = stats.pendingImpl > 0
    ? Math.ceil(stats.pendingImpl / IMPL_PER_WORKER)
    : 0;
  implementer = Math.min(implementer, scale.maxImpl);
  if (stats.pendingImpl > 0) {
    reasoning.push(
      `IMPL系タスク ${stats.pendingImpl}件 ÷ ${IMPL_PER_WORKER} = IMPLEMENTER ${implementer}人`
    );
  }

  // ── REVIEWER ───────────────────────────────────────
  // REVIEW状態のPENDINGタスク か REVIEWING状態のタスク があれば最低1人
  const needsReviewer = stats.pendingReview > 0 || stats.reviewingCount > 0;
  let reviewer = needsReviewer
    ? Math.max(1, Math.ceil(stats.reviewingCount / REVIEW_PER_WORKER))
    : 0;
  reviewer = Math.min(reviewer, scale.maxReview);

  // エラー率/タイムアウト多発で REVIEWER を増員（上限は scale.maxReview）
  const errorAdjusted = stats.errorRate > ERROR_RATE_THRESHOLD || stats.withTimeouts >= TIMEOUT_THRESHOLD;
  if (errorAdjusted && reviewer < scale.maxReview) {
    reviewer = Math.min(reviewer + 1, scale.maxReview);
    reasoning.push(
      `失敗率${Math.round(stats.errorRate * 100)}% or タイムアウト${stats.withTimeouts}件 → REVIEWER +1`
    );
  }
  if (needsReviewer) {
    reasoning.push(
      `REVIEW PENDING ${stats.pendingReview}件 / REVIEWING ${stats.reviewingCount}件 → REVIEWER ${reviewer}人`
    );
  }

  // ── TESTER ─────────────────────────────────────────
  let tester = stats.pendingTest > 0 ? 1 : 0;
  if (tester > 0) reasoning.push(`TEST PENDING ${stats.pendingTest}件 → TESTER 1人`);

  // ── RESEARCHER ─────────────────────────────────────
  let researcher = stats.pendingResearch >= RESEARCHER_THRESHOLD ? 1 : 0;
  if (researcher > 0) {
    reasoning.push(
      `RESEARCH/DOCS PENDING ${stats.pendingResearch}件（閾値 ${RESEARCHER_THRESHOLD}件）→ RESEARCHER 1人`
    );
  } else if (stats.pendingResearch > 0) {
    reasoning.push(
      `RESEARCH/DOCS PENDING ${stats.pendingResearch}件（閾値 ${RESEARCHER_THRESHOLD}件 未満）→ RESEARCHER 不要`
    );
  }

  // ── type:undefined の警告 ──────────────────────────
  if (stats.pendingUndefined > 0) {
    reasoning.push(
      `⚠️ type未定義タスク ${stats.pendingUndefined}件あり → \`!task edit\` で修正推奨`
    );
  }

  // ── 合計・MAX_WORKERS キャップ ─────────────────────
  let total  = implementer + reviewer + tester + researcher;
  let capped = false;

  if (total > MAX_WORKERS) {
    capped = true;
    const excess = total - MAX_WORKERS;
    reasoning.push(`⚠️ 合計 ${total}人が上限 ${MAX_WORKERS}人を超えるため削減`);
    // 優先度低いロールから削減: RESEARCHER → TESTER → REVIEWER
    for (const [key, ref] of [['RESEARCHER', { v: researcher }], ['TESTER', { v: tester }], ['REVIEWER', { v: reviewer }]]) {
      if (total <= MAX_WORKERS) break;
      // 直接削減
      if (key === 'RESEARCHER' && researcher > 0) { researcher--; total--; }
      else if (key === 'TESTER'      && tester > 0)     { tester--;      total--; }
      else if (key === 'REVIEWER'    && reviewer > 1)   { reviewer--;    total--; }
    }
  }

  // PENDING がある限り IMPLEMENTER は最低1人
  if (stats.pendingImpl > 0 && implementer === 0) {
    implementer = 1;
    total = implementer + reviewer + tester + researcher;
    reasoning.push('IMPL系タスクあり → IMPLEMENTER 最低1人を保証');
  }

  return {
    workers: {
      IMPLEMENTER: implementer,
      REVIEWER:    reviewer,
      TESTER:      tester,
      RESEARCHER:  researcher,
    },
    total:              implementer + reviewer + tester + researcher,
    scale:              scale.key,
    scaleLabel:         scale.label,
    capped,
    adjustedForErrors:  errorAdjusted,
    reasoning,
  };
}

// ─────────────────────────────────────────────────────
// formatStaffingPlan(plan, stats, currentWorkers)
//
// recommendStaffing() の結果を Discord 表示用文字列に変換する。
//
// 引数:
//   plan           - recommendStaffing() の戻り値
//   stats          - analyzeProjectStaffing() の戻り値（任意）
//   currentWorkers - workerRegistry.listWorkers() の戻り値（任意）
//
// 戻り値: Discord に送信できる文字列
// ─────────────────────────────────────────────────────
function formatStaffingPlan(plan, stats = null, currentWorkers = []) {
  const { ROLE_EMOJI } = workerRegistry;
  const projectLabel = stats?.projectId || '全体';

  const lines = [
    `**📊 人員配置レポート — \`${projectLabel}\`**`,
    `スケール: ${plan.scaleLabel}（${plan.scale}）`,
    '',
  ];

  // ── 現在の Workers ─────────────────────────────────
  if (currentWorkers.length > 0) {
    lines.push('**現在の構成:**');
    const currentByRole = {};
    currentWorkers.forEach(w => {
      currentByRole[w.role] = (currentByRole[w.role] || 0) + 1;
    });
    for (const [role, count] of Object.entries(currentByRole)) {
      lines.push(`  ${ROLE_EMOJI[role] || '🤖'} ${role}: ${count}人`);
    }
    lines.push('');
  }

  // ── 推奨構成 ──────────────────────────────────────
  lines.push('**推奨構成:**');
  const roleOrder = ['IMPLEMENTER', 'REVIEWER', 'TESTER', 'RESEARCHER'];
  let hasAnyWorker = false;
  for (const role of roleOrder) {
    const count = plan.workers[role] || 0;
    if (count > 0) {
      hasAnyWorker = true;
      const current = currentWorkers.filter(w => w.role === role).length;
      const diff = count - current;
      const diffStr = diff > 0 ? ` _(+${diff})_` : diff < 0 ? ` _(-${Math.abs(diff)})_` : '';
      lines.push(`  ${ROLE_EMOJI[role] || '🤖'} **${role}**: ${count}人${diffStr}`);
    }
  }
  if (!hasAnyWorker) lines.push('  （タスクなし — Workers 不要）');

  lines.push('');
  lines.push(`**合計: ${plan.total}人** / 上限 ${MAX_WORKERS}人`);
  if (plan.capped) lines.push('⚠️ 上限に達したため一部を削減しました');
  if (plan.adjustedForErrors) lines.push('⚠️ エラー/タイムアウト多発のため REVIEWER を増員しています');

  // ── タスクサマリー（stats がある場合）──────────────
  if (stats) {
    lines.push('');
    lines.push('**タスク状況:**');
    const stateNames = Object.values(taskManager.STATES)
      .filter(s => (stats.byState[s] || 0) > 0)
      .map(s => `${s}:${stats.byState[s]}`)
      .join(' / ');
    lines.push(`  ${stateNames || '（タスクなし）'}`);
    if (stats.withTimeouts > 0) lines.push(`  ⏱ タイムアウト経験: ${stats.withTimeouts}件`);
    if (stats.withErrors   > 0) lines.push(`  ⚠️ エラー記録あり: ${stats.withErrors}件`);
    if (stats.pendingUndefined > 0) lines.push(`  ⚠️ type未定義: ${stats.pendingUndefined}件（\`!task edit\` で修正推奨）`);
  }

  // ── 判断理由 ──────────────────────────────────────
  if (plan.reasoning.length > 0) {
    lines.push('');
    lines.push('**判断理由:**');
    plan.reasoning.forEach(r => lines.push(`  • ${r}`));
  }

  // ── 次のアクション ────────────────────────────────
  lines.push('');
  lines.push('```');
  lines.push('!company hire IMPLEMENTER   # 増員');
  lines.push('!company auto-staff on      # 自動増減を有効化');
  lines.push('```');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// getStaffingReport(projectId) — 3関数を一括実行して報告文を返す
//
// !company staff コマンドから直接呼べるエントリポイント。
//
// 戻り値: { stats, plan, text }
// ─────────────────────────────────────────────────────
function getStaffingReport(projectId) {
  const stats          = analyzeProjectStaffing(projectId);
  const plan           = recommendStaffing(stats);
  const currentWorkers = workerRegistry.listWorkers().filter(w =>
    w.projectId === projectId || w.projectId === '*'
  );
  const text = formatStaffingPlan(plan, stats, currentWorkers);
  logger.info(`[CompanyMgr] report: ${projectId || 'all'} → ${plan.total}人推奨 (${plan.scaleLabel})`);
  return { stats, plan, text };
}

// ─────────────────────────────────────────────────────
// computeDelta(projectId, plan)
//
// 推奨 plan と現在の workers.json を比較し、
// 追加・削除すべき Worker の差分を返す。
//
// 削除対象から外すもの:
//   - status === 'busy' の Worker
//   - projectId === '*' の Worker
//
// 戻り値:
//   {
//     toAdd:    [{ role, count }],   // 追加が必要なロール別件数
//     toRemove: [workerId],          // 削除してよい workerId 一覧
//     warnings: string[],            // スキップ理由など
//   }
// ─────────────────────────────────────────────────────
function computeDelta(projectId, plan) {
  const allWorkers = workerRegistry.listWorkers();
  // このプロジェクト専用ワーカー（'*' は対象外）
  const scoped     = allWorkers.filter(w =>
    w.projectId === projectId && w.projectId !== '*'
  );

  const toAdd    = [];
  const toRemove = [];
  const warnings = [];

  for (const [role, needed] of Object.entries(plan.workers)) {
    const existing = scoped.filter(w => w.role === role);
    const have     = existing.length;
    const diff     = needed - have;

    if (diff > 0) {
      // 不足: 追加が必要
      const globalCount = allWorkers.length;
      const canAdd      = Math.max(0, MAX_WORKERS - globalCount);
      const actualAdd   = Math.min(diff, canAdd);
      if (actualAdd < diff) {
        warnings.push(
          `⚠️ ${role}: ${diff}人追加したいが MAX_WORKERS(${MAX_WORKERS}) の上限で ${actualAdd}人のみ追加`
        );
      }
      if (actualAdd > 0) {
        toAdd.push({ role, count: actualAdd });
      }
    } else if (diff < 0) {
      // 過剰: idle な Worker を削除候補にする（busy / '*' は触らない）
      const removable = existing
        .filter(w =>
          w.status !== workerRegistry.WORKER_STATUS.BUSY &&
          w.projectId !== '*'
        )
        .slice(0, Math.abs(diff)); // 過剰分だけ
      removable.forEach(w => toRemove.push(w.workerId));
    }
  }

  return { toAdd, toRemove, warnings };
}

// ─────────────────────────────────────────────────────
// applyStaffingPlan(projectId, options)
//
// computeDelta() の結果を実際に反映する。
// dryRun:true の場合は変更せず結果のみ返す（--preview）。
//
// 引数:
//   projectId - 対象プロジェクトID
//   options   - { dryRun: bool }
//
// 戻り値:
//   {
//     dryRun:   bool,
//     added:    [worker],   // 追加した Worker オブジェクト
//     removed:  [workerId], // 削除した workerId
//     skipped:  [workerId], // busy/global のためスキップ
//     warnings: string[],
//     plan, stats,
//   }
// ─────────────────────────────────────────────────────
function applyStaffingPlan(projectId, options = {}) {
  const { dryRun = false } = options;
  const stats    = analyzeProjectStaffing(projectId);
  const plan     = recommendStaffing(stats);
  const delta    = computeDelta(projectId, plan);

  const added    = [];
  const removed  = [];
  const skipped  = [];
  const warnings = [...delta.warnings];

  if (!dryRun) {
    // 追加
    for (const { role, count } of delta.toAdd) {
      for (let i = 0; i < count; i++) {
        const res = workerRegistry.addWorker(role, null, projectId);
        if (res.ok) {
          added.push(res.worker);
        } else {
          warnings.push(`addWorker(${role}) 失敗: ${res.reason}`);
        }
      }
    }
    // 削除
    for (const wid of delta.toRemove) {
      const res = workerRegistry.removeWorker(wid);
      if (res.ok) {
        removed.push(wid);
      } else {
        // busy に変わっていた等: スキップして警告
        skipped.push(wid);
        warnings.push(`removeWorker(${wid}) スキップ: ${res.reason}`);
      }
    }
  }

  logger.info(
    `[CompanyMgr] assign ${dryRun ? '[dryRun] ' : ''}${projectId}: ` +
    `+${dryRun ? delta.toAdd.map(a => `${a.count}×${a.role}`).join(',') : added.length}` +
    ` -${dryRun ? delta.toRemove.length : removed.length}`
  );

  return { dryRun, added, removed, skipped, warnings, plan, stats, delta };
}

// ─────────────────────────────────────────────────────
// formatAssignResult(result)
//
// applyStaffingPlan() の戻り値を Discord 表示文字列に変換する。
// ─────────────────────────────────────────────────────
function formatAssignResult(result) {
  const { dryRun, added, removed, skipped, warnings, plan, delta } = result;
  const { ROLE_EMOJI } = workerRegistry;
  const lines = [];

  if (dryRun) {
    lines.push('🔍 **[プレビュー] 人員変更シミュレーション**');
    lines.push('');
    if (delta.toAdd.length === 0 && delta.toRemove.length === 0) {
      lines.push('✅ 現在の人員は推奨通りです。変更不要です。');
    } else {
      if (delta.toAdd.length > 0) {
        lines.push('**追加予定:**');
        for (const { role, count } of delta.toAdd) {
          lines.push(`  ${ROLE_EMOJI[role] || '🤖'} ${role} × ${count}人`);
        }
      }
      if (delta.toRemove.length > 0) {
        lines.push('**削除予定（idle のみ）:**');
        delta.toRemove.forEach(wid => lines.push(`  ❌ \`${wid}\``));
      }
    }
  } else {
    lines.push('✅ **人員を調整しました**');
    lines.push('');
    if (added.length === 0 && removed.length === 0) {
      lines.push('変更なし（現在の人員は推奨通りです）');
    } else {
      if (added.length > 0) {
        lines.push('**追加したワーカー:**');
        added.forEach(w => lines.push(`  ${ROLE_EMOJI[w.role] || '🤖'} \`${w.workerId}\` [${w.role}]`));
      }
      if (removed.length > 0) {
        lines.push('**削除したワーカー:**');
        removed.forEach(wid => lines.push(`  ❌ \`${wid}\``));
      }
      if (skipped.length > 0) {
        lines.push(`**スキップ（busy）:** ${skipped.join(', ')}`);
      }
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('**⚠️ 警告:**');
    warnings.forEach(w => lines.push(`  ${w}`));
  }

  lines.push('');
  lines.push(`推奨合計: **${plan.total}人** (${plan.scaleLabel})`);
  lines.push('`!company staff` で現状を再確認できます。');

  return lines.join('\n');
}

module.exports = {
  // メイン 3 関数
  analyzeProjectStaffing,
  recommendStaffing,
  formatStaffingPlan,
  // 便利ラッパー
  getStaffingReport,
  // assign 用
  computeDelta,
  applyStaffingPlan,
  formatAssignResult,
  // 定数（テスト・拡張用に export）
  IMPL_PER_WORKER,
  REVIEW_PER_WORKER,
  RESEARCHER_THRESHOLD,
  ERROR_RATE_THRESHOLD,
  MAX_WORKERS,
  SCALE_TABLE,
};
