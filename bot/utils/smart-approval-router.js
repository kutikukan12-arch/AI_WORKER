'use strict';

// =====================================================
// smart-approval-router.js — Smart Approval Router
//
// 役割:
//   Approval（承認依頼）をCEOへ送る前に分類する。
//   AI組織内で解決可能なものはCEOへ通知しない。
//
// 分類結果:
//   'ceo'  — CEOのみが判断できる（本当の経営判断）
//   'cos'  — CoS(黒川)が処理できる（AI組織内エスカレーション）
//   'ai'   — AI自動処理（CEOもCoSも不要）
//
// CEO必須:
//   ✅ 外部公開 / 外部リリース
//   ✅ 課金 / 費用発生 / コスト承認
//   ✅ 秘密情報 / APIキー / 認証情報
//   ✅ データ削除 / 本番DB変更
//   ✅ 事業判断 / 方針変更
//   ✅ セキュリティインシデント
//
// AI処理（CEO通知しない）:
//   ❌ timeout / タイムアウト
//   ❌ split判断 / 分割
//   ❌ task整理 / stale cleanup
//   ❌ AI担当変更 / routing
//   ❌ テスト失敗一次対応
//   ❌ 変更0件（RESEARCH/TEST/DOCS）
//   ❌ 自動リトライ可能なエラー
//
// CoS処理:
//   ⚠️ 複数AIへのエスカレーション
//   ⚠️ タスク方針変更（経営判断不要）
//   ⚠️ 守谷/白石への確認が必要
// =====================================================

const logger = require('./logger');

// ─────────────────────────────────────────────────────
// CEO必須キーワード（これを含む場合は必ずCEOへ）
// ─────────────────────────────────────────────────────
const CEO_REQUIRED_PATTERNS = [
  // 外部公開
  /外部公開/i, /外部リリース/i, /βリリース/i, /β公開/i,
  /公開判断/i, /リリース判断/i, /deploy.*prod/i, /本番.*デプロイ/i,
  /外部配布/i, /external.*publish/i, /publish.*external/i,

  // 課金・費用
  /課金/i, /費用発生/i, /コスト承認/i, /支払い/i,
  /billing/i, /payment/i, /有料/i, /月額/i,
  /予算承認/i, /budget.*approv/i,

  // 秘密情報・セキュリティ
  /秘密情報/i, /apiキー/i, /api.*key.*漏/i, /token.*漏/i,
  /credential/i, /認証情報.*漏/i, /セキュリティインシデント/i,
  /secret.*leak/i, /key.*expos/i,

  // データ削除・本番変更
  /本番.*削除/i, /production.*delete/i, /データ削除/i,
  /本番DB/i, /本番データ/i, /irreversible/i, /不可逆/i,

  // 事業判断
  /事業判断/i, /方針変更/i, /事業方針/i, /経営判断/i,
  /business.*decision/i, /strategy.*change/i,
];

// ─────────────────────────────────────────────────────
// AI処理キーワード（これを含む場合はCEO不要）
// ─────────────────────────────────────────────────────
const AI_INTERNAL_PATTERNS = [
  // タイムアウト関連
  /timeout/i, /タイムアウト/i, /timed.*out/i,
  /auto.*split/i, /自動分割/i, /分割.*タイムアウト/i,

  // タスク整理
  /stale.*approval/i, /stale.*cleanup/i, /孤児.*approval/i,
  /task.*整理/i, /approval.*整理/i, /古い.*approval/i,

  // ルーティング・担当変更
  /routing.*error/i, /ルーティング/i, /担当.*変更/i,
  /ai.*routing/i, /re.*route/i, /re.*assign/i,

  // 0-diff（変更なし）
  /変更.*0件/i, /0件.*変更/i, /mtime.*変更.*0/i,
  /ファイル.*変更.*なし/i, /no.*changes.*detected/i,

  // テスト・確認フェーズ
  /テスト.*失敗.*一次/i, /test.*failure.*initial/i,
  /動作確認.*失敗/i,

  // 自動リトライ
  /auto.*retry/i, /自動.*リトライ/i, /retry.*attempt/i,

  // handoff
  /handoff.*only/i, /handoffのみ/i,
];

// ─────────────────────────────────────────────────────
// taskType別のデフォルト分類
// RESEARCH/TEST/DOCS の0-diff完了はCEO不要
// ─────────────────────────────────────────────────────
const CEO_NOT_REQUIRED_TYPES = new Set([
  'RESEARCH', 'TEST', 'DOCS', 'REVIEW',
  'REVIEW_CODE', 'REVIEW_PRODUCT', 'REVIEW_SECURITY', 'OPS',
]);

// ─────────────────────────────────────────────────────
// routeApproval — Approval のルーティング分類
//
// 引数:
//   reason   - 承認理由テキスト
//   prompt   - タスクのプロンプト（省略可）
//   taskType - タスクタイプ（省略時 'IMPLEMENT'）
//   context  - 追加コンテキスト（省略可）
//     context.danger     - '高'|'中'|'低'
//     context.changedFiles - string[]
//     context.isTimeout  - bool
//     context.isSplit    - bool
//     context.isStale    - bool
//
// 戻り値:
//   { route: 'ceo'|'cos'|'ai', reason: string }
// ─────────────────────────────────────────────────────
function routeApproval(reason, prompt = '', taskType = 'IMPLEMENT', context = {}) {
  const searchText = `${reason} ${prompt}`.toLowerCase();
  const typeNorm   = String(taskType || '').toUpperCase();

  // ── 1. CEO強制条件チェック（最優先）──
  for (const pat of CEO_REQUIRED_PATTERNS) {
    if (pat.test(searchText)) {
      logger.info(`[SAR] CEO必須: pattern=${pat} | reason=${reason.slice(0, 60)}`);
      return {
        route:  'ceo',
        reason: `CEOパターン検出: ${reason.slice(0, 80)}`,
        matched: pat.toString(),
      };
    }
  }

  // ── 2. AI内部処理パターン（CEO不要）──
  for (const pat of AI_INTERNAL_PATTERNS) {
    if (pat.test(searchText)) {
      logger.info(`[SAR] AI内部処理: pattern=${pat} | reason=${reason.slice(0, 60)}`);
      return {
        route:  'ai',
        reason: `AI内部処理: ${reason.slice(0, 80)}`,
        matched: pat.toString(),
      };
    }
  }

  // ── 3. コンテキストベースの判定 ──
  if (context.isTimeout)    return { route: 'ai',  reason: 'タイムアウト → AI自動処理' };
  if (context.isSplit)      return { route: 'ai',  reason: 'split判断 → AI自動処理' };
  if (context.isStale)      return { route: 'ai',  reason: 'stale → AI自動クリーンアップ' };

  // ── 4. タスクタイプによる判定 ──
  if (CEO_NOT_REQUIRED_TYPES.has(typeNorm)) {
    return {
      route:  'cos',
      reason: `${typeNorm}タスク → CoS確認（CEO不要）`,
    };
  }

  // ── 5. danger='高' + IMPLEMENT/FIX = CEOへ ──
  if (context.danger === '高') {
    return {
      route:  'ceo',
      reason: `高危険度(${typeNorm}) → CEO確認必要`,
    };
  }

  // ── 6. danger='中' かつ IMPLEMENT = CoSへ（CoSがAI組織内で判断）──
  if (context.danger === '中') {
    return {
      route:  'cos',
      reason: `中危険度(${typeNorm}) → CoS判断`,
    };
  }

  // ── 7. 低危険度 = AI処理 ──
  return {
    route:  'ai',
    reason: `低危険度(${typeNorm}) → AI自動処理`,
  };
}

// ─────────────────────────────────────────────────────
// isCEORequired — CEOへの通知が必要かどうかの簡易チェック
//
// 戻り値: true = CEO必要 / false = AI/CoSで処理可能
// ─────────────────────────────────────────────────────
function isCEORequired(reason, prompt, taskType, context) {
  const result = routeApproval(reason, prompt, taskType, context);
  return result.route === 'ceo';
}

// ─────────────────────────────────────────────────────
// isAIResolvable — AI自動処理可能かどうかの判定
//
// 戻り値: true = AI自動処理可能 / false = 人間確認必要
// ─────────────────────────────────────────────────────
function isAIResolvable(reason, prompt, taskType, context) {
  const result = routeApproval(reason, prompt, taskType, context);
  return result.route === 'ai';
}

// ─────────────────────────────────────────────────────
// formatRouteDecision — ルーティング判定結果の文字列表示
// ─────────────────────────────────────────────────────
function formatRouteDecision(result) {
  const emoji = { ceo: '🔴', cos: '🟡', ai: '🟢' }[result.route] || '⬜';
  const label = { ceo: 'CEO判断必要', cos: 'CoS/AI組織内', ai: 'AI自動処理' }[result.route] || '不明';
  return `${emoji} ${label}: ${result.reason}`;
}

module.exports = {
  routeApproval,
  isCEORequired,
  isAIResolvable,
  formatRouteDecision,
  CEO_REQUIRED_PATTERNS,
  AI_INTERNAL_PATTERNS,
  CEO_NOT_REQUIRED_TYPES,
};
