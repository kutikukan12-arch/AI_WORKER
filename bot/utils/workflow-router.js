'use strict';
// =====================================================
// workflow-router.js — Workflow Router (Phase5+7+10)
//
// 社員の成果物・状態から次担当を決め、
// outbox への配送文を生成する。
//
// Phase10 Auto Handoff:
//   会社ルールで定義された固定ルートのみ自動配送可能。
//   黒川は判断代理・承認代理は禁止のまま。
//   固定ルート以外は CEO_CONFIRM_REQUIRED で停止。
//   全自動配送は audit log (autoExecuted:true) を記録必須。
//
// 固定ルート（FIXED_ROUTES allowlist）:
//   IMPLEMENT_DONE      (from miyagi)   → 守谷
//   NEED_FIX            (from moriya)   → 宮城
//   REVIEW_READY        (from moriya)   → 市川
//   LESSON_CANDIDATE    (from any)      → 育野
//   INCIDENT_CANDIDATE  (from any)      → 育野
//
// 禁止（変更なし）:
//   ❌ 黒川が READY/NEED_FIX を生成・判定する
//   ❌ 黒川が承認・優先順位変更をする
//   ❌ task/decision/incident を自動作成する
//   ❌ 不明イベントを勝手に配送する
//   ❌ CEO 判断待ちを自動通過させる
//   ❌ eval / exec / child_process
// =====================================================

const { redact } = require('./redact');

// ─── イベント種別 ────────────────────────────────────
const WORKFLOW_EVENTS = {
  IMPLEMENT_DONE:      'IMPLEMENT_DONE',
  NEED_FIX:            'NEED_FIX',
  REVIEW_READY:        'REVIEW_READY',
  USER_FEEDBACK:       'USER_FEEDBACK',
  COST_REQUIRED:       'COST_REQUIRED',
  INCIDENT_FOUND:      'INCIDENT_FOUND',
  BLOCKED:             'BLOCKED',
  // Phase10
  LESSON_CANDIDATE:    'LESSON_CANDIDATE',
  INCIDENT_CANDIDATE:  'INCIDENT_CANDIDATE',
  VP_BRIEF_REQUEST:    'VP_BRIEF_REQUEST',
  STRATEGY_REVIEW:     'STRATEGY_REVIEW',
  // Phase3: 社員間ルート
  SPEC_READY:          'SPEC_READY',   // 市川→宮城: 仕様確定 → 実装開始
  // Phase2: Internal Router 新ルート
  PM_READY:            'PM_READY',         // 市川→相沢: PM確認OK → CSテスト
  CS_READY:            'CS_READY',         // 相沢→黒川: CSテスト完了 → CoSまとめ
  KUROKAWA_SUMMARY:    'KUROKAWA_SUMMARY', // 黒川→CEO: CEO判断必要案件のみ報告
  TECH_REVIEW_DONE:    'TECH_REVIEW_DONE', // 守谷→黒川: 技術のみREADY（PM不要）
};

// ─── Phase10: 固定ルート allowlist ──────────────────
// 黒川が自動配送できる唯一の経路リスト。
// allowedFrom: null = 誰からでも配送可 / 配列 = 特定社員のみ
// 黒川は READY/NEED_FIX を生成しない。受け取って転送するだけ。
const FIXED_ROUTES = {
  IMPLEMENT_DONE: {
    allowedFrom: ['miyagi'],   // 宮城からのみ
    to:          'moriya',
    reason:      '固定ルート: 宮城 実装完了 → 守谷 CTO レビュー',
  },
  NEED_FIX: {
    allowedFrom: ['moriya'],   // 守谷からのみ
    to:          'miyagi',
    reason:      '固定ルート: 守谷 NEED_FIX → 宮城 修正',
  },
  REVIEW_READY: {
    allowedFrom: ['moriya'],   // 守谷からのみ（黒川はREADYを生成しない）
    to:          'ichikawa',
    reason:      '固定ルート: 守谷 READY → 市川 PM 商品確認',
  },
  LESSON_CANDIDATE: {
    allowedFrom: null,          // 誰からでも
    to:          'ikuno',
    reason:      '固定ルート: Lesson候補 → 育野 Learning',
  },
  INCIDENT_CANDIDATE: {
    allowedFrom: null,          // 誰からでも（重大度判断は育野が行う）
    to:          'ikuno',
    reason:      '固定ルート: Incident候補 → 育野 Learning',
  },
  // 神崎 VP: 社長 → 神崎への判断材料整理依頼
  VP_BRIEF_REQUEST: {
    allowedFrom: ['ceo'],
    to:          'kanzaki',
    reason:      '固定ルート: CEO → 神崎 VP 判断材料整理',
  },
  // Phase3: 市川 → 宮城: 仕様確定 → 実装開始
  SPEC_READY: {
    allowedFrom: ['ichikawa'],
    to:          'miyagi',
    reason:      '固定ルート: 市川 PM 仕様確定 → 宮城 実装開始',
  },
  // Phase2: Internal Router 新ルート
  PM_READY: {
    allowedFrom: ['ichikawa'],
    to:          'aizawa',
    reason:      '固定ルート: 市川 PM READY → 相沢 CS テスト',
  },
  CS_READY: {
    allowedFrom: ['aizawa'],
    to:          'kurokawa',
    reason:      '固定ルート: 相沢 CS READY → 黒川 CoS まとめ',
  },
  KUROKAWA_SUMMARY: {
    allowedFrom: ['kurokawa'],
    to:          'ceo',
    reason:      '固定ルート: 黒川 CoS 最終報告 → CEO（判断必要案件のみ）',
  },
  TECH_REVIEW_DONE: {
    allowedFrom: ['moriya'],
    to:          'kurokawa',
    reason:      '固定ルート: 守谷 技術のみ READY → 黒川 CoS まとめ（PM確認不要）',
  },
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
  // Phase10 追加
  LESSON_CANDIDATE: {
    to:      'ikuno',
    label:   '育野 Learning',
    message: (ctx) =>
      `【Lesson候補共有】\n` +
      `${ctx.from || '（送信者）'} からの Lesson候補です。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ LESSONS.md への追記を検討してください（自動追記しない）。`,
  },
  INCIDENT_CANDIDATE: {
    to:      'ikuno',
    label:   '育野 Learning',
    message: (ctx) =>
      `【Incident候補共有】\n` +
      `${ctx.from || '（送信者）'} からの Incident候補です。\n` +
      `重大度の判断は育野（またはCEO）が行ってください。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ 必要なら \`!incident open\` を手動実行してください。`,
  },
  // 神崎 VP: 判断材料整理依頼
  // 社長が重要Decision前に論点整理を依頼する際に使う。
  // 神崎は決めない。判断材料を社長に提出するだけ。
  VP_BRIEF_REQUEST: {
    to:      'kanzaki',
    label:   '神崎 VP',
    message: (ctx) =>
      `【判断材料整理依頼】\n` +
      `社長より判断材料の整理をお願いします。\n` +
      `\nテーマ: ${ctx.summary || '（詳細なし）'}\n` +
      (ctx.taskId ? `\n関連: ${ctx.taskId}\n` : '') +
      `\n以下を整理してください:\n` +
      `- 各AI社員の意見・立場\n` +
      `- 事業・開発のバランス\n` +
      `- メリット / リスク\n` +
      `- 長期ロードマップへの影響\n` +
      `\n→ 整理後、社長に判断材料を提出してください（神崎は決定しません）。`,
  },
  // 神崎 VP: 大方針レビュー（社員 → 神崎）
  // 大型機能追加 / 新規事業 / 課金方針変更 / 会社ルール変更 が対象。
  // フロー: 社員 → 神崎 → 整理 → 社長判断。神崎→直接実行は禁止。
  STRATEGY_REVIEW: {
    to:      'kanzaki',
    label:   '神崎 VP',
    message: (ctx) =>
      `【大方針レビュー依頼】\n` +
      `${ctx.from || '（送信者）'} から大方針レビューの依頼です。\n` +
      `対象: 大型機能追加 / 新規事業 / 課金方針 / 会社ルール変更 など。\n` +
      `\nテーマ: ${ctx.summary || '（詳細なし）'}\n` +
      (ctx.taskId ? `\n関連: ${ctx.taskId}\n` : '') +
      `\n以下を整理して社長に提出してください:\n` +
      `- 各AI社員・部門の論点\n` +
      `- 事業 / 開発のバランス\n` +
      `- メリット / リスク\n` +
      `- 長期ロードマップへの影響\n` +
      `\n→ 神崎は整理のみ。決定・直接実行はしません（最終判断は社長）。`,
  },
  // Phase3: 市川 → 宮城 仕様確定
  SPEC_READY: {
    to:      'miyagi',
    label:   '宮城 Lead Engineer',
    message: (ctx) =>
      `【仕様確定・実装開始依頼】\n` +
      `市川 PM から仕様が確定しました。実装を開始してください。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n仕様概要:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ 実装完了後、\`!workflow handoff IMPLEMENT_DONE\` で守谷 CTO にレビューを依頼してください。`,
  },
  // Phase2: Internal Router 新ルート
  PM_READY: {
    to:      'aizawa',
    label:   '相沢 CS',
    message: (ctx) =>
      `【CSテスト依頼】\n` +
      `市川 PM から商品確認 READY が出ました。\n` +
      `CS 視点（初心者目線）でのテスト・フィードバックをお願いします。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ テスト完了後、\`!workflow handoff CS_READY aizawa\` で黒川 CoS へ報告してください。`,
  },
  CS_READY: {
    to:      'kurokawa',
    label:   '黒川 Chief of Staff',
    message: (ctx) =>
      `【CS確認完了・まとめ依頼】\n` +
      `相沢 CS から READY が出ました。\n` +
      `黒川 CoS で進捗をまとめ、CEO 判断が必要な案件のみ \`!workflow handoff KUROKAWA_SUMMARY\` で報告してください。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ 技術のみ完了の場合は CEO への報告不要（黒川判断でクローズ可）。`,
  },
  KUROKAWA_SUMMARY: {
    to:      'ceo',
    via:     'kurokawa',
    label:   'CEO（黒川 CoS 経由）',
    message: (ctx) =>
      `【黒川 CoS 最終報告】\n` +
      `黒川 Chief of Staff から CEO 判断が必要な案件の報告です。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ CEO のご判断をお願いします（承認 / 却下 / 追加確認）。`,
  },
  TECH_REVIEW_DONE: {
    to:      'kurokawa',
    label:   '黒川 Chief of Staff',
    message: (ctx) =>
      `【技術レビュー完了・まとめ依頼】\n` +
      `守谷 CTO が技術のみ READY と判定しました（PM・CS 確認不要）。\n` +
      `黒川 CoS でまとめ、必要に応じて CEO へ \`!workflow handoff KUROKAWA_SUMMARY\` で報告してください。\n` +
      `\nタスク: ${ctx.taskId || '（未指定）'}\n` +
      `\n内容:\n${ctx.summary || '（詳細なし）'}\n` +
      `\n→ 費用・公開を伴う場合は必ず CEO 判断を仰いでください。`,
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

// ─────────────────────────────────────────────────────
// autoHandoff(event, payload) — Phase10 固定ルート自動配送
//
// FIXED_ROUTES allowlist に該当する場合のみ自動実行する。
// 該当しない場合は CEO_CONFIRM_REQUIRED を返して停止する。
//
// payload: { from, taskId, summary, commitHash? }
//
// 戻り値:
//   DISPATCHED:            { ok:true, dispatched:true, to, handoffId, message }
//   CEO_CONFIRM_REQUIRED:  { ok:true, dispatched:false, reason, hint }
//   ERROR:                 { ok:false, error }
//
// 禁止（コードで保証）:
//   - FIXED_ROUTES 以外のイベントは配送しない
//   - allowedFrom 外の送信者は配送しない
//   - eval / exec / child_process 不使用
//   - task/decision/incident の自動作成しない
// ─────────────────────────────────────────────────────
function autoHandoff(event, payload = {}) {
  // ── 1. allowlist チェック ──────────────────────────
  const fixedRoute = FIXED_ROUTES[event];
  if (!fixedRoute) {
    return {
      ok:         true,
      dispatched: false,
      reason:     'CEO_CONFIRM_REQUIRED',
      hint:       `イベント \`${event}\` は固定ルートに含まれていません。\n` +
                  `固定ルート: ${Object.keys(FIXED_ROUTES).join(' / ')}\n` +
                  `CEO確認後に \`!inbox send\` で手動配送してください。`,
    };
  }

  // ── 2. from チェック ──────────────────────────────
  const from = String(payload.from || '').toLowerCase().trim();
  if (fixedRoute.allowedFrom !== null) {
    if (!from || !fixedRoute.allowedFrom.includes(from)) {
      return {
        ok:         true,
        dispatched: false,
        reason:     'CEO_CONFIRM_REQUIRED',
        hint:       `送信者 \`${from || '（未指定）'}\` は \`${event}\` の許可送信者ではありません。\n` +
                    `許可: ${fixedRoute.allowedFrom.join(' / ')}\n` +
                    `CEO確認後に手動配送してください。`,
      };
    }
  }

  // ── 3. route() でメッセージ生成 ──────────────────
  const routeResult = route(event, payload);
  if (!routeResult.ok) {
    return { ok: false, error: routeResult.error };
  }

  // ── 4. Safety Layer Gate ─────────────────────────
  const convId      = payload.taskId ? `conv_${payload.taskId}` : `conv_${Date.now()}`;
  const safetyLayer = require('./workflow-safety-layer');
  const audit       = require('./workflow-audit');

  // Phase3: payload.summary だけでなく実際の送信全文で検査
  const routeMsg    = routeResult.message || '';
  const scanTarget  = [payload.summary || '', routeMsg].join('\n');

  const safeCheck   = safetyLayer.checkSafeToHandoff({
    convId,
    from,
    to:           routeResult.to,
    event,
    inboxContent: scanTarget,
  });

  // 監査ログ（safe/unsafe 問わず全記録）
  audit.appendAudit({
    convId,
    from,
    to:         routeResult.to,
    event,
    safe:       safeCheck.safe,
    stopReason: safeCheck.safe ? null : safeCheck.reason,
    stopAction: safeCheck.safe ? null : safeCheck.action,
    taskId:     payload.taskId || null,
  });

  if (!safeCheck.safe) {
    const inboxBridgeNotify = require('./inbox-bridge');
    const budgetMod = require('./workflow-budget');

    // Phase2: escalate_vp / loop_detected → 神崎 VP へ判断材料整理依頼
    if (safeCheck.action === 'escalate_vp' || safeCheck.action === 'loop_detected') {
      const conv = budgetMod.getConversation(convId);
      if (conv) {
        const escalationMsg = budgetMod.buildEscalationMessage(conv);
        // 神崎 VP inbox へ配送（判断はしない）
        try { inboxBridgeNotify.sendToWorker('kanzaki', escalationMsg); } catch {}
      }
    }

    // 黒川 inbox へ停止通知
    try {
      const stopMsg = [
        `【Safety Gate 停止通知】`,
        `配送停止: ${from} → ${routeResult.to} (${event})`,
        `理由: ${safeCheck.reason}`,
        `アクション: ${safeCheck.action}`,
        `会話ID: ${convId}`,
        `→ 社長または神崎 VP が確認してください。`,
      ].join('\n');
      inboxBridgeNotify.sendToWorker('kurokawa', stopMsg);
    } catch {}

    // Phase1: 停止時は会話をクローズ
    safetyLayer.autoCloseIfNeeded(convId, safeCheck.action === 'ceo_required' ? 'BLOCKED' : 'REVIEW_READY');

    return {
      ok: true, dispatched: false,
      reason: safeCheck.reason, action: safeCheck.action,
      hint: `Safety Gate が配送を停止しました: ${safeCheck.reason}`,
    };
  }

  // ── 5. outbox への書き込み ─────────────────────────
  const inboxBridge = require('./inbox-bridge');
  const sendResult  = inboxBridge.sendToWorker(routeResult.to, routeResult.message);
  if (!sendResult.ok) {
    return { ok: false, error: `outbox 書き込み失敗: ${sendResult.text}` };
  }

  // ── 6. handoff log + Phase1 lifecycle ───────────
  const wfState = require('./workflow-state');
  const handoffId = wfState.recordHandoff({
    ...routeResult,
    autoExecuted: true,
    reason:       'fixed_route',
    fixedRouteReason: fixedRoute.reason,
  }, payload.taskId);

  // Phase1: 完了/終了イベントで会話をクローズ
  safetyLayer.autoCloseIfNeeded(convId, event);

  return {
    ok: true, dispatched: true,
    event, to: routeResult.to, toLabel: routeResult.toLabel,
    handoffId, convId, autoExecuted: true,
    reason: fixedRoute.reason, message: routeResult.message,
    turns: safeCheck.turns,
  };
}

// buildAutoHandoffText — Discord 表示用
function buildAutoHandoffText(result) {
  if (!result.ok) return `❌ Auto Handoff エラー: ${result.error}`;

  if (!result.dispatched) {
    return [
      `⚠️ **CEO確認が必要です (CEO_CONFIRM_REQUIRED)**`,
      ``,
      result.hint,
    ].join('\n');
  }

  return [
    `✅ **Auto Handoff 完了** (黒川 固定ルート自動配送)`,
    ``,
    `イベント: \`${result.event}\``,
    `配送先: **${result.toLabel}**`,
    `Handoff ID: \`${result.handoffId}\``,
    `理由: ${result.reason}`,
    ``,
    `配送文 (先頭):`,
    `\`\`\``,
    result.message.slice(0, 200),
    `\`\`\``,
    ``,
    `📋 \`!workflow status\` でログを確認できます。`,
    `⚠️ 黒川は配送のみ。READY/NEED_FIX 判定・承認は行っていません。`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────
// _hasProductImpact(text) — 商品・ユーザー影響キーワード検出
//
// 商品/サービス/公開/課金 などの語が含まれる場合 true。
// 守谷 CTO が REVIEW_READY を使う際、商品影響の有無を判断する補助。
// 判断はあくまで守谷自身が行う。このヘルパーは参考値のみ。
// ─────────────────────────────────────────────────────
const _PRODUCT_IMPACT_KEYWORDS = [
  '商品', '公開', 'β', 'ベータ', 'beta', 'web', 'ui',
  '表示', '機能追加', 'リリース', 'youtube', '診断', 'ユーザー',
  'エンドユーザー', '販売', '課金', 'product', 'feature', 'release',
  'サービス', 'サイト', '外部', 'お客様', 'launch', 'publish',
];

function _hasProductImpact(text) {
  const lower = String(text || '').toLowerCase();
  return _PRODUCT_IMPACT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

module.exports = {
  route,
  detectEventFromTaskState,
  buildHandoffText,
  autoHandoff,
  buildAutoHandoffText,
  _hasProductImpact,
  WORKFLOW_EVENTS,
  ROUTING_TABLE,
  FIXED_ROUTES,
};
