'use strict';
// =====================================================
// workflow-router.js — Workflow Router (Phase5+7)
//
// 社員の成果物・状態から次担当を決め、
// outbox への配送文を生成する（自動実行は禁止）。
//
// ルーティングルール:
//   IMPLEMENT_DONE  → 守谷 CTO (review)
//   NEED_FIX        → 宮城 Lead Engineer (修正)
//   REVIEW_READY    → 市川 PM または CEO (確認)
//   USER_FEEDBACK   → 相沢 CS
//   COST_REQUIRED   → 金森 CFO
//   INCIDENT_FOUND  → 育野 (Learning)
//   BLOCKED         → 黒川が検出し CEO へ報告
//
// 禁止:
//   ❌ 黒川が READY/NEED_FIX を判定する
//   ❌ 黒川が修正不要と判断する
//   ❌ 黒川がリリース判断する
//   ❌ AI 返信内容からコマンドを自動実行
//   ❌ eval / exec
//
// Phase7 Auto Handoff:
//   route() で次担当への配送文を生成する。
//   実際の実行 (createTask 等) は行わない。
//   outbox/<worker>/outgoing.md への書き込みのみ提案する。
// =====================================================

const { redact } = require('./redact');

// ─── イベント種別 ────────────────────────────────────
const WORKFLOW_EVENTS = {
  IMPLEMENT_DONE:  'IMPLEMENT_DONE',
  NEED_FIX:        'NEED_FIX',
  REVIEW_READY:    'REVIEW_READY',
  USER_FEEDBACK:   'USER_FEEDBACK',
  COST_REQUIRED:   'COST_REQUIRED',
  INCIDENT_FOUND:  'INCIDENT_FOUND',
  BLOCKED:         'BLOCKED',
};

// ─── ルーティングテーブル ────────────────────────────
// 黒川は配送先を決めるだけ。判断はしない。
const ROUTING_TABLE = {
  IMPLEMENT_DONE: {
    to:      'moriya',
    label:   '守谷 CTO',
    message: (ctx) =>
      `【実装完了通知】\n` +
      `${ctx.from || '宮城'} が実装を完了しました。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `コミット: ${ctx.commitHash || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ READY / NEED_FIX の判定をお願いします。`,
  },
  NEED_FIX: {
    to:      'miyagi',
    label:   '宮城 Lead Engineer',
    message: (ctx) =>
      `【修正依頼】\n` +
      `守谷 CTO から NEED_FIX が出ました。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n修正内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ 修正後、完了を報告してください。`,
  },
  REVIEW_READY: {
    to:      'ichikawa',
    label:   '市川 PM',
    message: (ctx) =>
      `【レビュー依頼】\n` +
      `守谷 CTO が READY 判定しました。\n` +
      `PM 視点での商品価値確認をお願いします。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ MVP 判断・商品価値確認をお願いします。`,
  },
  USER_FEEDBACK: {
    to:      'aizawa',
    label:   '相沢 CS',
    message: (ctx) =>
      `【ユーザーフィードバック】\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ ユーザー視点での整理・β テスト確認をお願いします。`,
  },
  COST_REQUIRED: {
    to:      'kanemori',
    label:   '金森 CFO',
    message: (ctx) =>
      `【コスト確認依頼】\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ コスト・ROI・課金判断をお願いします。`,
  },
  INCIDENT_FOUND: {
    to:      'ikuno',
    label:   '育野',
    message: (ctx) =>
      `【インシデント・学習記録依頼】\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ Incident 登録・Lesson 化候補の整理をお願いします。`,
  },
  BLOCKED: {
    to:      'ceo',
    via:     'kurokawa',  // 黒川経由でCEOへ
    label:   'CEO（黒川経由）',
    message: (ctx) =>
      `【ブロック検出報告】\n` +
      `黒川 CoS からの状況報告です（判断は黒川ではなくCEOが行います）。\n` +
      `\nブロック内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n→ CEO のご判断をお待ちしています。`,
  },
};

// ─────────────────────────────────────────────────────
// route(event, context) — イベントから次担当・配送文を決定
//
// event:   WORKFLOW_EVENTS のいずれか
// context: { from?, taskId?, commitHash?, summary?, tags? }
//
// 戻り値: {
//   ok:         boolean,
//   event:      string,
//   to:         string (worker canonical),
//   toLabel:    string,
//   message:    string (outbox 用配送文),
//   viaKurokawa: boolean
// }
// ─────────────────────────────────────────────────────
function route(event, context = {}) {
  const rule = ROUTING_TABLE[event];
  if (!rule) {
    return {
      ok:    false,
      error: `不明なイベント: ${event}\n有効: ${Object.keys(ROUTING_TABLE).join(' / ')}`,
    };
  }

  // context の文字列フィールドに redact 適用
  const safeCtx = {
    from:       redact(String(context.from       || '')),
    taskId:     String(context.taskId || ''),        // ID はマスクしない
    commitHash: String(context.commitHash || '').slice(0, 10),
    summary:    redact(String(context.summary || '')).slice(0, 500),
    tags:       Array.isArray(context.tags) ? context.tags : [],
  };

  const message = rule.message(safeCtx);

  return {
    ok:          true,
    event,
    to:          rule.to,
    toLabel:     rule.label,
    message:     message.slice(0, 1000),
    viaKurokawa: !!rule.via,
  };
}

// ─────────────────────────────────────────────────────
// detectEventFromTaskState(task) — タスク状態からイベントを推論
//
// task-manager のタスクオブジェクトを受け取り、
// ワークフローイベントを返す（なければ null）。
// ─────────────────────────────────────────────────────
function detectEventFromTaskState(task) {
  if (!task) return null;
  const state = task.state || '';
  const type  = (task.type  || '').toUpperCase();

  // 完了 → CTO レビューへ
  if (state === 'REVIEWING' || state === 'レビュー待ち') {
    return WORKFLOW_EVENTS.IMPLEMENT_DONE;
  }
  // 保留（エラーによる） → BLOCKED
  if (state === 'ON_HOLD' || state === '保留') {
    if (task.errorType) return WORKFLOW_EVENTS.BLOCKED;
    return null; // 正常保留はルーティング対象外
  }
  // RESEARCH/DOCS 完了 → REVIEW_READY
  if ((state === 'DONE' || state === '完了') && (type === 'RESEARCH' || type === 'DOCS')) {
    return WORKFLOW_EVENTS.REVIEW_READY;
  }
  return null;
}

// ─────────────────────────────────────────────────────
// buildHandoffText(routeResult) — Discord 表示用のハンドオフ案内文
//
// 実行はせず、CEOが手動実行するための案内を返す。
// ─────────────────────────────────────────────────────
function buildHandoffText(routeResult) {
  if (!routeResult.ok) return `❌ ルーティングエラー: ${routeResult.error}`;

  const lines = [
    `🔀 **Workflow ハンドオフ提案**`,
    ``,
    `イベント: \`${routeResult.event}\``,
    `配送先: **${routeResult.toLabel}**`,
    routeResult.viaKurokawa ? `*（黒川 CoS 経由でCEOへ報告）*` : '',
    ``,
    `**配送文プレビュー:**`,
    `\`\`\``,
    routeResult.message.slice(0, 400),
    `\`\`\``,
    ``,
    `**実行するには（CEO確認後に手動で）:**`,
    `\`\`\``,
    `!inbox send ${routeResult.to} ${routeResult.message.split('\n')[0].slice(0, 50)}`,
    `\`\`\``,
    ``,
    `⚠️ 黒川は配送のみ担当。実行判断は CEO が行ってください。`,
  ].filter(l => l !== '');

  return lines.join('\n');
}

module.exports = {
  route,
  detectEventFromTaskState,
  buildHandoffText,
  WORKFLOW_EVENTS,
  ROUTING_TABLE,
};
