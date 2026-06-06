'use strict';

// =====================================================
// auto-recovery-manager.js — Auto Recovery Manager
//
// 役割:
//   TIMEOUT / STALE / RETRY などのエラー状態を
//   AI組織内で自動復旧する。CEOへの通知を最小化。
//
// 復旧フロー:
//   問題発生
//   → classifyRecovery() で原因分類
//   → handleAutoRecovery() で自動処理
//   → 復旧成功: CoS(黒川)チャンネルへ完了通知
//   → 復旧失敗: 守谷/白石へエスカレーション
//   → CEO必要: 「最終判断」としてCEOへのみ通知
//
// 対象:
//   TIMEOUT → auto split → runner再投入
//   STALE approval → auto cleanup
//   分類ミス → re-classify & retry
//   routing問題 → re-route
//
// CEO通知は:
//   「復旧完了（要確認）」または「人間判断が必要（守谷/白石）」のみ
//   タイムアウト単体ではCEO通知しない
//
// 禁止:
//   - 高危険度操作の自動承認
//   - 外部公開判断の自動化
//   - 費用発生の自動承認
//   - CEO承認の完全撤廃
// =====================================================

const logger = require('./logger');
const path   = require('path');

// ─────────────────────────────────────────────────────
// 復旧アクション定数
// ─────────────────────────────────────────────────────
const RECOVERY_ACTIONS = {
  AUTO_SPLIT:       'auto_split',       // タイムアウト → 自動分割
  AUTO_RETRY:       'auto_retry',       // 短期エラー → 自動リトライ
  STALE_CLEANUP:    'stale_cleanup',    // 孤児approval → 自動クリーンアップ
  RECLASSIFY:       'reclassify',       // 分類ミス → 再分類
  ESCALATE_COS:     'escalate_cos',     // CoS(黒川)へエスカレーション
  ESCALATE_MORIYA:  'escalate_moriya',  // 守谷CTOへエスカレーション
  ESCALATE_CEO:     'escalate_ceo',     // CEO最終判断（最終手段）
};

// ─────────────────────────────────────────────────────
// 復旧分類: タスクの状態からアクションを決定
//
// 引数:
//   task    - タスクオブジェクト
//   context - 追加コンテキスト
//     context.timeoutCount  - タイムアウト回数
//     context.retryCount    - リトライ回数
//     context.errorType     - エラータイプ文字列
//
// 戻り値: RECOVERY_ACTIONS の値
// ─────────────────────────────────────────────────────
function classifyRecovery(task, context = {}) {
  if (!task || typeof task !== 'object') {
    return RECOVERY_ACTIONS.ESCALATE_COS;
  }

  const state       = String(task.state    || '').toLowerCase();
  const errorType   = String(task.errorType || context.errorType || '').toUpperCase();
  const taskType    = String(task.type     || 'IMPLEMENT').toUpperCase();
  const timeoutCount = task.timeoutCount   || context.timeoutCount || 0;
  const dangerLevel  = String(task.dangerLevel || context.danger || '低');

  // ── タイムアウト系 ──
  if (errorType === 'TIMEOUT' || context.isTimeout) {
    if (timeoutCount >= 2) {
      // 2回目タイムアウト: 守谷CTOへエスカレーション
      return RECOVERY_ACTIONS.ESCALATE_MORIYA;
    }
    // 1回目タイムアウト: 自動分割
    return RECOVERY_ACTIONS.AUTO_SPLIT;
  }

  // ── 高危険度はCEOへ（安全ゲートを弱体化させない）──
  if (dangerLevel === '高') {
    return RECOVERY_ACTIONS.ESCALATE_CEO;
  }

  // ── 孤児・stale状態 ──
  if (errorType === 'STALE' || context.isStale) {
    return RECOVERY_ACTIONS.STALE_CLEANUP;
  }

  // ── REVIEWING状態（バリデーション失敗）──
  if (state === 'レビュー待ち' || state === 'reviewing') {
    // RESEARCH/TEST/DOCSは変更なしでOKなので再分類
    const noChangesOk = ['RESEARCH', 'TEST', 'DOCS', 'REVIEW',
      'REVIEW_CODE', 'REVIEW_PRODUCT', 'REVIEW_SECURITY', 'OPS'];
    if (noChangesOk.includes(taskType)) {
      return RECOVERY_ACTIONS.RECLASSIFY;
    }
    // IMPLEMENTが変更0件 = CoSへエスカレーション
    return RECOVERY_ACTIONS.ESCALATE_COS;
  }

  // ── ON_HOLD（保留）──
  if (state === '保留' || state === 'on_hold') {
    if (errorType === 'TIMEOUT') {
      return RECOVERY_ACTIONS.AUTO_SPLIT;
    }
    return RECOVERY_ACTIONS.ESCALATE_COS;
  }

  // ── デフォルト: CoSへエスカレーション ──
  return RECOVERY_ACTIONS.ESCALATE_COS;
}

// ─────────────────────────────────────────────────────
// shouldNotifyCEO — CEOへの通知が必要か判定
//
// 復旧アクションからCEO通知の必要性を返す
// ─────────────────────────────────────────────────────
function shouldNotifyCEO(action) {
  return action === RECOVERY_ACTIONS.ESCALATE_CEO;
}

// ─────────────────────────────────────────────────────
// shouldNotifyCOS — CoSへの通知が必要か判定
// ─────────────────────────────────────────────────────
function shouldNotifyCOS(action) {
  return action === RECOVERY_ACTIONS.ESCALATE_COS ||
         action === RECOVERY_ACTIONS.ESCALATE_MORIYA;
}

// ─────────────────────────────────────────────────────
// canAutoHandle — AI自動処理可能か判定
// ─────────────────────────────────────────────────────
function canAutoHandle(action) {
  return action === RECOVERY_ACTIONS.AUTO_SPLIT    ||
         action === RECOVERY_ACTIONS.AUTO_RETRY    ||
         action === RECOVERY_ACTIONS.STALE_CLEANUP ||
         action === RECOVERY_ACTIONS.RECLASSIFY;
}

// ─────────────────────────────────────────────────────
// buildRecoveryMessage — 復旧メッセージを生成
//
// CEOを煩わせないよう、通知先ごとに適切なメッセージを返す。
// ─────────────────────────────────────────────────────
function buildRecoveryMessage(action, task, extra = {}) {
  const taskId   = task?.id   || '(不明)';
  const taskType = task?.type || 'IMPLEMENT';
  const prompt   = (task?.prompt || '').slice(0, 60);
  const reason   = extra.reason || '';
  const children = extra.children || [];

  switch (action) {
    case RECOVERY_ACTIONS.AUTO_SPLIT:
      return [
        `⏱️ **タイムアウト → 自動分割 (AI処理)**`,
        `タスク: \`${taskId}\` [${taskType}]`,
        children.length > 0
          ? `→ ${children.length}件に分割して続行:\n` +
            children.map(c => `  \`${c.id}\`: ${(c.prompt || '').slice(0, 40)}`).join('\n')
          : '→ 分割中...',
        ``,
        `> ℹ️ CEOへの確認は不要。自動続行します。`,
      ].join('\n');

    case RECOVERY_ACTIONS.STALE_CLEANUP:
      return [
        `🗑️ **孤児approval自動クリーンアップ (AI処理)**`,
        `対象: \`${taskId}\``,
        `理由: ${reason || '対応タスクが存在しない孤児approval'}`,
        `> ℹ️ CEOへの確認は不要。`,
      ].join('\n');

    case RECOVERY_ACTIONS.RECLASSIFY:
      return [
        `🔄 **タスク再分類 (AI処理)**`,
        `タスク: \`${taskId}\` [${taskType}]`,
        `理由: ${reason || '変更0件だが非IMPLEMENT型のため完了扱い'}`,
        `> ℹ️ CEOへの確認は不要。`,
      ].join('\n');

    case RECOVERY_ACTIONS.ESCALATE_MORIYA:
      return [
        `🟡 **タイムアウト2回 → 守谷CTOへエスカレーション**`,
        `タスク: \`${taskId}\` [${taskType}]`,
        `内容: ${prompt}`,
        `理由: 同一タスク系統で2回タイムアウト。技術的検討が必要。`,
        ``,
        `> 守谷CTOへ確認を依頼してください。`,
        `> CEOへの通知は保留中。`,
      ].join('\n');

    case RECOVERY_ACTIONS.ESCALATE_COS:
      return [
        `🟡 **CoS確認依頼 (AI組織内)**`,
        `タスク: \`${taskId}\` [${taskType}]`,
        `内容: ${prompt}`,
        `理由: ${reason || 'AI組織内での判断が必要'}`,
        ``,
        `> 黒川CoSへ確認中。CEO通知は不要。`,
      ].join('\n');

    case RECOVERY_ACTIONS.ESCALATE_CEO:
      return [
        `🔴 **CEO判断必要 (最終エスカレーション)**`,
        `タスク: \`${taskId}\` [${taskType}]`,
        `内容: ${prompt}`,
        `理由: ${reason || '高危険度操作または重要な判断が必要'}`,
      ].join('\n');

    default:
      return `⚠️ 復旧アクション不明: ${action} | タスク: \`${taskId}\``;
  }
}

// ─────────────────────────────────────────────────────
// cleanupStaleApprovals — 孤児approvalの自動クリーンアップ
//
// task-managerで存在しないapprovalをstaleに変更する。
// 保護対象（excludeIds）は変更しない。
//
// 引数:
//   options.excludeIds  - 保護するtaskId[]
//   options.dryRun      - true なら変更せずに対象リストのみ返す
//
// 戻り値: { ok, staled: [], skipped: [], dryRun }
// ─────────────────────────────────────────────────────
function cleanupStaleApprovals(options = {}) {
  const { excludeIds = [], dryRun = false, resolvedBy = 'auto-recovery' } = options;

  try {
    const approvalManager = require('./approval-manager');
    const result = approvalManager.closeStaleApprovals({
      excludeIds,
      resolvedBy,
    });

    if (!dryRun) {
      if (result.staled.length > 0) {
        logger.info(`[ARM] 孤児approval自動クリーンアップ: ${result.staled.length}件`);
      }
    }

    return { ok: true, staled: result.staled || [], skipped: result.skipped || [], dryRun };
  } catch (e) {
    logger.warn(`[ARM] cleanupStaleApprovals エラー: ${e.message}`);
    return { ok: false, error: e.message, staled: [], skipped: [], dryRun };
  }
}

// ─────────────────────────────────────────────────────
// formatRecoverySummary — 自動復旧サマリー（CEO向け最終通知用）
//
// 複数の復旧アクションをまとめてCEOへ報告する場合に使う。
// ─────────────────────────────────────────────────────
function formatRecoverySummary(actions) {
  if (!actions || actions.length === 0) return '（復旧アクションなし）';

  const ceoItems = actions.filter(a => a.action === RECOVERY_ACTIONS.ESCALATE_CEO);
  const aiItems  = actions.filter(a => canAutoHandle(a.action));
  const cosItems = actions.filter(a => shouldNotifyCOS(a.action));

  const lines = [
    `📊 **Auto Recovery Manager — サマリー**`,
    ``,
    aiItems.length  > 0 ? `🟢 AI自動処理: ${aiItems.length}件` : null,
    cosItems.length > 0 ? `🟡 CoS/技術確認: ${cosItems.length}件` : null,
    ceoItems.length > 0 ? `🔴 CEO判断必要: ${ceoItems.length}件` : null,
  ].filter(Boolean);

  if (ceoItems.length > 0) {
    lines.push(``, `**CEO判断が必要な案件:**`);
    ceoItems.forEach(a => {
      lines.push(`> • \`${a.taskId}\`: ${a.reason?.slice(0, 80)}`);
    });
  }

  return lines.join('\n');
}

module.exports = {
  RECOVERY_ACTIONS,
  classifyRecovery,
  shouldNotifyCEO,
  shouldNotifyCOS,
  canAutoHandle,
  buildRecoveryMessage,
  cleanupStaleApprovals,
  formatRecoverySummary,
};
