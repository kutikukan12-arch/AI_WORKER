'use strict';
// =====================================================
// workflow-safety-layer.js — Autonomous Workflow Safety Layer
//
// Phase1: Conversation Budget  (workflow-budget.js)
// Phase2: Inbox Action Gate    (inbox-action-gate.js)
// Phase3: 社員間 Workflow Loop 制御
//
// 許可するワークフローチェーン:
//   宮城 → 守谷 (IMPLEMENT_DONE → REVIEW)
//   守谷 → 宮城 (NEED_FIX → 修正)
//   市川 → 宮城 (仕様 → 実装)
//   育野 → ikuno (LESSON_CANDIDATE)
//
// 禁止:
//   ❌ CEO承認回避
//   ❌ 支出判断
//   ❌ 危険操作（push force / npm publish 等）
//   ❌ 無限ループ
//   ❌ eval / exec
//
// 黒川の役割:
//   ✅ 安全条件チェック
//   ✅ ターン数カウント
//   ✅ 禁止チェーン拒否
//   ❌ 判断代理なし
// =====================================================

const budget = require('./workflow-budget');
const gate   = require('./inbox-action-gate');
const { redact } = require('./redact');

// ─── 許可されたワークフローチェーン ─────────────────
const ALLOWED_CHAINS = [
  { from: 'miyagi',   to: 'moriya',   event: 'IMPLEMENT_DONE'    },
  { from: 'moriya',   to: 'miyagi',   event: 'NEED_FIX'          },
  { from: 'moriya',   to: 'ichikawa', event: 'REVIEW_READY'      },
  // Phase4: ichikawa→miyagi は SPEC_READY のみ（IMPLEMENT_DONE は削除）
  { from: 'ichikawa', to: 'miyagi',   event: 'SPEC_READY'        },
  { from: 'any',      to: 'ikuno',    event: 'LESSON_CANDIDATE'  },
  { from: 'any',      to: 'ikuno',    event: 'INCIDENT_CANDIDATE'},
  { from: 'ceo',      to: 'kanzaki',  event: 'VP_BRIEF_REQUEST'  },
];

// ─────────────────────────────────────────────────────
// validateChain(from, to, event) — チェーン検証
// ─────────────────────────────────────────────────────
function validateChain(from, to, event) {
  const allowed = ALLOWED_CHAINS.some(c =>
    (c.from === 'any' || c.from === from) &&
    (c.to   === 'any' || c.to   === to)   &&
    c.event === event
  );
  return {
    allowed,
    reason: allowed ? null : `未許可チェーン: ${from}→${to}(${event})`,
  };
}

// ─────────────────────────────────────────────────────
// checkSafeToHandoff(params) — ハンドオフ安全確認
//
// params: { convId, from, to, event, inboxContent? }
//
// 戻り値: {
//   safe:    bool,
//   reason?: string,
//   action?: 'escalate_vp' | 'ceo_required' | 'loop_detected' | 'chain_not_allowed',
// }
// ─────────────────────────────────────────────────────
function checkSafeToHandoff({ convId, from, to, event, inboxContent = '' }) {
  // 1. チェーン検証
  const chainResult = validateChain(from, to, event);
  if (!chainResult.allowed) {
    return { safe: false, reason: chainResult.reason, action: 'chain_not_allowed' };
  }

  // 2. Inbox Action Gate（content が CEO判断必要なら停止）
  if (inboxContent) {
    const cls = gate.classify(redact(inboxContent));
    if (cls.isCeoRequired) {
      return {
        safe:   false,
        reason: `Inbox に CEO判断必要な内容が含まれています: ${cls.class}`,
        action: 'ceo_required',
      };
    }
  }

  // 3. Budget ターン確認
  const turnResult = budget.recordTurn(convId, from, to, event);
  if (!turnResult.allowed) {
    return { safe: false, reason: turnResult.reason, action: turnResult.action };
  }

  return { safe: true, turns: turnResult.conv?.currentTurns };
}

// ─────────────────────────────────────────────────────
// processInbox(worker, content, convId) — inbox 処理
//
// incoming.md の内容を Gate で分類し、
// 許可されたアクションの候補を返す。
// 自動実行はしない（提案のみ）。
// ─────────────────────────────────────────────────────
function processInbox(worker, content, convId) {
  const safeContent = redact(String(content || ''));
  const cls         = gate.classify(safeContent);

  // CEO 判断必要 → workflow 停止
  if (cls.isCeoRequired) {
    if (convId) budget.closeConversation(convId, 'ceo_required');
    return {
      ok:      false,
      reason:  'ceo_required',
      message: `⛔ CEO判断が必要な内容が検出されました。\nワークフローを停止し、社長への確認を待ちます。`,
      classification: cls,
    };
  }

  // 配送候補の提案（提案のみ・自動実行なし）
  const handoffCandidates = _suggestHandoff(worker, cls);

  return {
    ok:                true,
    classification:    cls,
    handoffCandidates,
    message:           _buildProcessingMessage(worker, cls, handoffCandidates),
  };
}

// handoff 候補を提案（提案のみ）
function _suggestHandoff(worker, cls) {
  const suggestions = [];
  const ac = gate.ACTION_CLASS;

  if (cls.class === ac.REVIEW_RESULT) {
    // レビュー結果 → NEED_FIX なら宮城へ、READY なら市川へ
    if (cls.matchCount > 0) {
      suggestions.push({ to: 'miyagi', event: 'NEED_FIX',      hint: '修正依頼' });
      suggestions.push({ to: 'ichikawa', event: 'REVIEW_READY', hint: '商品確認依頼' });
    }
  } else if (cls.class === ac.IMPLEMENT_DONE) {
    suggestions.push({ to: 'moriya', event: 'IMPLEMENT_DONE', hint: 'CTOレビュー依頼' });
  }

  return suggestions;
}

function _buildProcessingMessage(worker, cls, candidates) {
  const lines = [
    `📋 **Inbox Action Gate 処理結果**`,
    `worker: ${worker}`,
    `分類: ${cls.class} (信頼度 ${Math.round(cls.confidence * 100)}%)`,
    ``,
  ];
  if (candidates.length > 0) {
    lines.push(`**配送候補 (提案のみ):**`);
    candidates.forEach(c => lines.push(`  💡 → ${c.to}: ${c.hint}`));
    lines.push(``, `⚠️ 配送には \`!workflow handoff ${candidates[0]?.event}\` を手動実行してください。`);
  } else {
    lines.push(`配送候補なし。内容を確認してください。`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────
// getWorkflowStatus(convId) — ワークフロー状態
// ─────────────────────────────────────────────────────
function getWorkflowStatus(convId) {
  const conv = budget.getConversation(convId);
  if (!conv) return { exists: false };

  const remaining = Math.max(0, conv.maxTurns - conv.currentTurns);
  return {
    exists:       true,
    convId,
    status:       conv.status,
    turns:        conv.currentTurns,
    maxTurns:     conv.maxTurns,
    remaining,
    history:      conv.history,
    needsEscalation: conv.status === 'limit_reached' || conv.status === 'loop_detected',
  };
}

// ─────────────────────────────────────────────────────
// Phase2: conversationId lifecycle helpers
// ─────────────────────────────────────────────────────

// タスクIDから conversationId を生成
function makeConvId(taskId) {
  return taskId ? `conv_${taskId}` : `conv_${Date.now()}`;
}

// 終了イベントで会話をクローズ
const CLOSE_EVENTS = new Set(['REVIEW_READY', 'BLOCKED', 'CEO_CONFIRM_REQUIRED']);

function autoCloseIfNeeded(convId, event) {
  if (!convId || !event) return false;
  if (CLOSE_EVENTS.has(event)) {
    budget.closeConversation(convId, `event:${event}`);
    return true;
  }
  return false;
}

module.exports = {
  checkSafeToHandoff,
  processInbox,
  validateChain,
  getWorkflowStatus,
  makeConvId,
  autoCloseIfNeeded,
  ALLOWED_CHAINS,
  CLOSE_EVENTS,
};
