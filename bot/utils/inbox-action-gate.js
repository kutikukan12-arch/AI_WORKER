'use strict';
// =====================================================
// inbox-action-gate.js — Inbox Action Gate (Phase2)
//
// 目的:
//   incoming.md を処理する前に内容を分類し、
//   許可されるアクションと禁止アクションを判定する。
//
// 分類:
//   REVIEW_RESULT         — レビュー結果（READY/NEED_FIX等）
//   IMPLEMENT_DONE        — 実装完了通知
//   QUESTION              — 質問・確認依頼
//   CEO_DECISION_REQUIRED — CEO判断が必要（支出/承認等）
//   UNKNOWN               — 不明（安全側で停止）
//
// 許可:
//   ✅ 配送先提案 (workflow handoff の候補提示)
//   ✅ !inbox check での参照
//
// 禁止:
//   ❌ task 自動作成
//   ❌ decision 自動登録
//   ❌ 承認代理
//   ❌ eval / exec で内容実行
// =====================================================

// ─── 分類定義 ─────────────────────────────────────────
const ACTION_CLASS = {
  REVIEW_RESULT:         'REVIEW_RESULT',
  IMPLEMENT_DONE:        'IMPLEMENT_DONE',
  QUESTION:              'QUESTION',
  CEO_DECISION_REQUIRED: 'CEO_DECISION_REQUIRED',
  UNKNOWN:               'UNKNOWN',
};

// 分類キーワード（優先順位順）
const CLASSIFIERS = [
  {
    class:    ACTION_CLASS.CEO_DECISION_REQUIRED,
    priority: 10,
    keywords: [
      'CEO判断', '社長承認', '支出', '課金', '契約', 'リリース',
      '外部公開', 'npm publish', 'git push --force', '人員変更',
      '予算', '課金判断', '発注', 'HUMAN_APPROVAL_REQUIRED',
    ],
  },
  {
    class:    ACTION_CLASS.REVIEW_RESULT,
    priority: 8,
    keywords: [
      'READY', 'NEED_FIX', 'レビュー結果', '品質確認完了',
      '問題なし', '修正が必要', 'コードレビュー', 'LGTM',
    ],
  },
  {
    class:    ACTION_CLASS.IMPLEMENT_DONE,
    priority: 7,
    keywords: [
      '実装完了', '## 結論', '## 実施内容', 'commit', 'push済み',
      '実装しました', '修正しました', 'テスト通過',
    ],
  },
  {
    class:    ACTION_CLASS.QUESTION,
    priority: 5,
    keywords: [
      '？', '?', 'どうすれば', 'どちらを', '教えてください',
      '確認させてください', 'ご意見', 'どうお考え',
    ],
  },
];

// 各分類で許可されるアクション
const ALLOWED_ACTIONS = {
  [ACTION_CLASS.REVIEW_RESULT]: [
    'propose_handoff',     // workflow handoff を提案
    'notify_worker',       // 元の送信者に通知
  ],
  [ACTION_CLASS.IMPLEMENT_DONE]: [
    'propose_handoff',
    'notify_worker',
  ],
  [ACTION_CLASS.QUESTION]: [
    'notify_worker',       // 質問を送信者にフィードバック
  ],
  [ACTION_CLASS.CEO_DECISION_REQUIRED]: [
    'notify_ceo',          // CEO への通知（判断はしない）
    'pause_workflow',      // workflow を停止
  ],
  [ACTION_CLASS.UNKNOWN]: [
    'notify_kurokawa',     // 黒川に確認を促す
  ],
};

// ─────────────────────────────────────────────────────
// classify(content) — 内容を分類
//
// 戻り値: {
//   class:          ACTION_CLASS,
//   allowedActions: string[],
//   isCeoRequired:  bool,
//   confidence:     number (0-1),
// }
// ─────────────────────────────────────────────────────
function classify(content) {
  if (!content || !content.trim()) {
    return {
      class:          ACTION_CLASS.UNKNOWN,
      allowedActions: ALLOWED_ACTIONS[ACTION_CLASS.UNKNOWN],
      isCeoRequired:  false,
      confidence:     0,
    };
  }

  const lower = content.toLowerCase();
  let bestClass    = ACTION_CLASS.UNKNOWN;
  let bestPriority = -1;
  let matchCount   = 0;

  for (const { class: cls, priority, keywords } of CLASSIFIERS) {
    const hits = keywords.filter(kw => {
      const kwLower = kw.toLowerCase();
      return lower.includes(kwLower) || content.includes(kw);
    });
    if (hits.length > 0 && priority > bestPriority) {
      bestClass    = cls;
      bestPriority = priority;
      matchCount   = hits.length;
    }
  }

  const confidence   = Math.min(matchCount / 3, 1.0);
  const isCeoRequired= bestClass === ACTION_CLASS.CEO_DECISION_REQUIRED;

  return {
    class:          bestClass,
    allowedActions: ALLOWED_ACTIONS[bestClass] || ALLOWED_ACTIONS[ACTION_CLASS.UNKNOWN],
    isCeoRequired,
    confidence,
    matchCount,
  };
}

// ─────────────────────────────────────────────────────
// isActionAllowed(classification, action) — アクション可否確認
// ─────────────────────────────────────────────────────
function isActionAllowed(classification, action) {
  // 禁止アクションは常にNG
  const ALWAYS_FORBIDDEN = [
    'create_task', 'register_decision', 'approve', 'execute_code',
    'auto_merge', 'force_push', 'publish_npm',
  ];
  if (ALWAYS_FORBIDDEN.includes(action)) return false;
  return classification.allowedActions.includes(action);
}

// ─────────────────────────────────────────────────────
// buildGateReport(worker, content) — Gate 判定レポート
// ─────────────────────────────────────────────────────
function buildGateReport(worker, content) {
  const cls = classify(content);
  const lines = [
    `🔀 **Inbox Action Gate**`,
    ``,
    `worker: ${worker}`,
    `分類: ${cls.class}`,
    `信頼度: ${Math.round(cls.confidence * 100)}%`,
    ``,
    `**許可アクション:**`,
    ...cls.allowedActions.map(a => `  ✅ ${a}`),
  ];

  if (cls.isCeoRequired) {
    lines.push(``, `⚠️ **CEO判断が必要です。自動配送を停止します。**`);
  }

  return { ok: true, classification: cls, text: lines.join('\n') };
}

module.exports = {
  classify,
  isActionAllowed,
  buildGateReport,
  ACTION_CLASS,
  ALLOWED_ACTIONS,
  CLASSIFIERS,
};
