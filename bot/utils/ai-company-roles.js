'use strict';
// =====================================================
// ai-company-roles.js — AI Board 拡張ロールシステム
//
// 追加役職:
//   🅳 UX           — ユーザー体験・UI品質
//   🅵 Finance      — コスト・ROI・予算管理
//   🅶 Sales        — 市場投入・機能の販売可能性
//   🅸 Support      — サポート負荷・バグ対応
//   🅹 Legal        — コンプライアンス・リスク
//   🅻 Security     — セキュリティ審査
//   🅾 CostOptimizer — AI実行コスト最適化
//
// 各ロール構造:
//   id:       string   — ロールID
//   emoji:    string   — 絵文字
//   name:     string   — 表示名
//   scope:    string[] — 担当範囲
//   criteria: string[] — 判断基準
//   evaluate(ctx) → { verdict, comment }
//
// evaluate の引数 ctx:
//   execStatus    — EXEC_STATUS string (from ceo-report)
//   runStats      — { tasksDone, tasksFailed, stopReason, yellowCount }
//   quality       — { level, score }
//   taskSummary   — { pending, onHold, reviewing, awaiting, inProgress, total }
//
// verdict は 'OK' | 'CAUTION' | 'RISK' | 'N/A'
// =====================================================

const VERDICT = {
  OK:      'OK',
  CAUTION: 'CAUTION',
  RISK:    'RISK',
  NA:      'N/A',
};

const VERDICT_EMOJI = {
  OK:      '🟢',
  CAUTION: '🟡',
  RISK:    '🔴',
  'N/A':   '⬜',
};

// ─────────────────────────────────────────────────────
// ロール定義
// ─────────────────────────────────────────────────────

const ROLES = {

  UX: {
    id:    'UX',
    emoji: '🅳',
    name:  'UX（ユーザー体験）',
    scope: [
      'UIタスクの完了状況',
      'ユーザビリティ・アクセシビリティ品質',
      'デザインレビューの実施判断',
    ],
    criteria: [
      '実装タスク完了度: 未着手タスクがなければOK',
      '品質スコア: RED → RISK / YELLOW → CAUTION',
      'レビュー待ちあり → CAUTION',
    ],
    evaluate(ctx) {
      const { execStatus, runStats, quality, taskSummary } = ctx;
      const { tasksDone, tasksFailed } = runStats;
      const { reviewing, pending } = taskSummary;

      if (quality.level === 'RED') {
        return {
          verdict: VERDICT.RISK,
          comment: `品質問題（RED）が検出されています。UIの不具合がユーザー体験に直結するため、先に品質問題を解消してください。`,
        };
      }
      if (execStatus === 'BLOCKED') {
        return {
          verdict: VERDICT.RISK,
          comment: `システムが停止中のためUXの評価ができません。問題解決後に再評価してください。`,
        };
      }
      if (reviewing > 0 || quality.level === 'YELLOW') {
        return {
          verdict: VERDICT.CAUTION,
          comment: `${reviewing > 0 ? `${reviewing}件のレビュー待ちがあります。` : ''}品質に注意が必要な箇所があります。UXテストを推奨します。`,
        };
      }
      if (tasksDone > 0) {
        return {
          verdict: VERDICT.OK,
          comment: `${tasksDone}件の実装が完了しています。ユーザーテストの実施を推奨します。`,
        };
      }
      return {
        verdict: VERDICT.CAUTION,
        comment: `実装タスクが${pending}件残っています。UX評価はタスク完了後に実施してください。`,
      };
    },
  },

  FINANCE: {
    id:    'FINANCE',
    emoji: '🅵',
    name:  'Finance（財務・ROI）',
    scope: [
      '開発投資効率（完了タスク数 / 失敗タスク数）',
      'ROI観点でのリリース判断',
      '予算超過リスクの評価',
    ],
    criteria: [
      '失敗率 > 20% → RISK（リトライコスト増大）',
      '失敗率 10〜20% → CAUTION',
      '失敗タスクなし → OK',
    ],
    evaluate(ctx) {
      const { runStats, taskSummary } = ctx;
      const { tasksDone, tasksFailed, stopReason } = runStats;
      const total = tasksDone + tasksFailed;
      const failRate = total > 0 ? tasksFailed / total : 0;

      if (failRate > 0.2) {
        return {
          verdict: VERDICT.RISK,
          comment: `失敗率 ${Math.round(failRate * 100)}%（${tasksFailed}/${total}件）。リトライコストが増大しています。タスク設計の見直しを推奨します。`,
        };
      }
      if (failRate > 0.1) {
        return {
          verdict: VERDICT.CAUTION,
          comment: `失敗率 ${Math.round(failRate * 100)}%（${tasksFailed}/${total}件）。コスト効率の改善余地があります。`,
        };
      }
      if (tasksDone === 0) {
        return {
          verdict: VERDICT.NA,
          comment: `完了タスクがなく評価できません。`,
        };
      }
      return {
        verdict: VERDICT.OK,
        comment: `完了${tasksDone}件・失敗${tasksFailed}件。投資効率は良好な範囲内です。`,
      };
    },
  },

  SALES: {
    id:    'SALES',
    emoji: '🅶',
    name:  'Sales（市場投入）',
    scope: [
      '機能の販売可能性・市場投入準備状況',
      'リリース判断（顧客提案タイミング）',
      '残開発量からの出荷見込み評価',
    ],
    criteria: [
      'execStatus = RELEASE_READY → 営業準備開始OK',
      'execStatus = BLOCKED       → 顧客提案不可',
      'それ以外                   → 開発継続中・提案時期尚早',
    ],
    evaluate(ctx) {
      const { execStatus, taskSummary } = ctx;
      const { pending, onHold } = taskSummary;
      const remain = pending + onHold;

      if (execStatus === 'RELEASE_READY') {
        return {
          verdict: VERDICT.OK,
          comment: `市場投入準備が整いつつあります。営業資料の準備・デモ環境の整備を開始してください。`,
        };
      }
      if (execStatus === 'BLOCKED') {
        return {
          verdict: VERDICT.RISK,
          comment: `現在の状態では顧客提案ができません。問題を解決してから営業活動を再開してください。`,
        };
      }
      return {
        verdict: VERDICT.CAUTION,
        comment: `残タスク ${remain}件。リリースまで開発継続が必要です。提案時期はまだ先の見込みです。`,
      };
    },
  },

  SUPPORT: {
    id:    'SUPPORT',
    emoji: '🅸',
    name:  'Support（サポート・バグ対応）',
    scope: [
      'バグ・FIX タスクによるサポート負荷見積もり',
      'ドキュメント整備状況',
      'ユーザー問い合わせ発生リスクの評価',
    ],
    criteria: [
      'tasksFailed > 0 → サポート工数増加の可能性',
      'RELEASE_READY  → サポート体制準備が必要',
      'それ以外       → 通常範囲',
    ],
    evaluate(ctx) {
      const { execStatus, runStats, taskSummary } = ctx;
      const { tasksFailed, stopReason } = runStats;
      const { awaiting } = taskSummary;

      if (tasksFailed > 2) {
        return {
          verdict: VERDICT.RISK,
          comment: `${tasksFailed}件の失敗タスクあり。バグ修正不足による問い合わせ増加が懸念されます。ドキュメントと既知の問題リストを整備してください。`,
        };
      }
      if (execStatus === 'RELEASE_READY') {
        return {
          verdict: VERDICT.CAUTION,
          comment: `リリース準備段階です。FAQ・操作マニュアル・サポート体制を事前に整備してください。`,
        };
      }
      if (tasksFailed > 0) {
        return {
          verdict: VERDICT.CAUTION,
          comment: `${tasksFailed}件の失敗タスクが存在します。サポート負荷が若干増加する可能性があります。`,
        };
      }
      return {
        verdict: VERDICT.OK,
        comment: `サポート負荷は現時点で低水準と見積もられます。`,
      };
    },
  },

  LEGAL: {
    id:    'LEGAL',
    emoji: '🅹',
    name:  'Legal（コンプライアンス・リスク）',
    scope: [
      'ライセンス・プライバシーポリシーの確認判断',
      '品質問題に起因する法的リスク評価',
      'リリース前のコンプライアンスチェック要否',
    ],
    criteria: [
      '品質 RED      → RISK（潜在的な法的リスクあり）',
      'RELEASE_READY → CAUTION（最終確認推奨）',
      'それ以外      → OK（通常範囲）',
    ],
    evaluate(ctx) {
      const { execStatus, quality } = ctx;

      if (quality.level === 'RED') {
        return {
          verdict: VERDICT.RISK,
          comment: `品質問題（RED）が法的リスクになる可能性があります。セキュリティ・プライバシー観点での確認が必要です。`,
        };
      }
      if (execStatus === 'RELEASE_READY') {
        return {
          verdict: VERDICT.CAUTION,
          comment: `リリース前にライセンス確認・プライバシーポリシーの最終レビューを実施してください。`,
        };
      }
      if (quality.level === 'YELLOW') {
        return {
          verdict: VERDICT.CAUTION,
          comment: `品質問題（YELLOW）があります。リリース前にコンプライアンス観点での確認を推奨します。`,
        };
      }
      return {
        verdict: VERDICT.OK,
        comment: `現時点での法的リスクは通常範囲内です。リリース前の最終確認を忘れずに実施してください。`,
      };
    },
  },

  SECURITY: {
    id:    'SECURITY',
    emoji: '🅻',
    name:  'Security（セキュリティ審査）',
    scope: [
      'セキュリティ脆弱性リスクの評価',
      '品質問題に起因するセキュリティリスク',
      'リリース前のセキュリティ審査要否判断',
    ],
    criteria: [
      '品質 RED かつ BLOCKED       → RISK',
      '品質 RED または失敗 > 0     → CAUTION',
      'RELEASE_READY              → CAUTION（審査推奨）',
      'それ以外                    → OK',
    ],
    evaluate(ctx) {
      const { execStatus, runStats, quality } = ctx;
      const { tasksFailed } = runStats;

      if (quality.level === 'RED' && execStatus === 'BLOCKED') {
        return {
          verdict: VERDICT.RISK,
          comment: `品質問題（RED）かつシステム停止中です。セキュリティ上の脆弱性が存在する可能性があります。リリースを停止し、審査を実施してください。`,
        };
      }
      if (quality.level === 'RED' || tasksFailed > 0) {
        return {
          verdict: VERDICT.CAUTION,
          comment: `${quality.level === 'RED' ? '品質問題（RED）' : `${tasksFailed}件の失敗タスク`}があります。セキュリティ関連の問題が含まれていないか確認してください。`,
        };
      }
      if (execStatus === 'RELEASE_READY') {
        return {
          verdict: VERDICT.CAUTION,
          comment: `リリース前にセキュリティ審査（認証・認可・データ保護）を実施してください。`,
        };
      }
      return {
        verdict: VERDICT.OK,
        comment: `現時点でのセキュリティリスクは許容範囲内と判断します。`,
      };
    },
  },

  COST_OPTIMIZER: {
    id:    'COST_OPTIMIZER',
    emoji: '🅾',
    name:  'Cost Optimizer（AI実行コスト最適化）',
    scope: [
      'AI実行タスクの効率性評価',
      'タイムアウト・失敗によるリトライコスト分析',
      'タスク分割・設計改善の推奨',
    ],
    criteria: [
      'タイムアウト停止 → RISK（タスク分割推奨）',
      '失敗率 > 20%     → RISK（タスク設計見直し）',
      'yellowCount > 2  → CAUTION（品質ループコスト）',
      'それ以外         → OK',
    ],
    evaluate(ctx) {
      const { runStats } = ctx;
      const { tasksDone, tasksFailed, stopReason, yellowCount = 0 } = runStats;
      const total    = tasksDone + tasksFailed;
      const failRate = total > 0 ? tasksFailed / total : 0;

      if (/timeout_limit|timeout/.test(stopReason)) {
        return {
          verdict: VERDICT.RISK,
          comment: `タイムアウト停止が発生しています。タスクが大きすぎる可能性があります。タスクをより細かく分割することでコストと成功率を改善できます。`,
        };
      }
      if (failRate > 0.2) {
        return {
          verdict: VERDICT.RISK,
          comment: `失敗率 ${Math.round(failRate * 100)}%（${tasksFailed}/${total}件）。リトライコストが増大しています。タスクの指示・分割方法を見直してください。`,
        };
      }
      if (yellowCount > 2) {
        return {
          verdict: VERDICT.CAUTION,
          comment: `品質警告が${yellowCount}回発生しています。品質ループのリトライコストを削減するため、早期の問題修正を推奨します。`,
        };
      }
      if (tasksDone === 0) {
        return {
          verdict: VERDICT.NA,
          comment: `完了タスクがなく評価できません。`,
        };
      }
      return {
        verdict: VERDICT.OK,
        comment: `AI実行効率は良好です（完了${tasksDone}件・失敗${tasksFailed}件）。現在のタスク設計を継続してください。`,
      };
    },
  },

};

// ロールの表示順
const ROLE_ORDER = ['UX', 'FINANCE', 'SALES', 'SUPPORT', 'LEGAL', 'SECURITY', 'COST_OPTIMIZER'];

// ─────────────────────────────────────────────────────
// evaluateAll(ctx)
//
// 全ロールの evaluate を実行してまとめて返す。
//
// 戻り値:
//   { UX: { verdict, comment }, FINANCE: {...}, ... }
// ─────────────────────────────────────────────────────
function evaluateAll(ctx) {
  const result = {};
  for (const id of ROLE_ORDER) {
    result[id] = ROLES[id].evaluate(ctx);
  }
  return result;
}

// ─────────────────────────────────────────────────────
// formatCompanyRolesReport(evaluations)
//
// evaluateAll() の戻り値を Discord テキストに変換する。
// ─────────────────────────────────────────────────────
function formatCompanyRolesReport(evaluations) {
  const lines = [];

  for (const id of ROLE_ORDER) {
    const role = ROLES[id];
    const ev   = evaluations[id];
    if (!ev) continue;

    const vEmoji = VERDICT_EMOJI[ev.verdict] || '❓';
    lines.push(`${role.emoji} **${role.name}** ${vEmoji} ${ev.verdict}`);
    lines.push(`  ${ev.comment}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ─────────────────────────────────────────────────────
// getRoleInfo(roleId)
//
// ロールの担当範囲・判断基準を返す（ヘルプ表示用）。
// ─────────────────────────────────────────────────────
function getRoleInfo(roleId) {
  const role = ROLES[roleId];
  if (!role) return null;
  return {
    id:       role.id,
    emoji:    role.emoji,
    name:     role.name,
    scope:    role.scope,
    criteria: role.criteria,
  };
}

module.exports = {
  VERDICT,
  VERDICT_EMOJI,
  ROLES,
  ROLE_ORDER,
  evaluateAll,
  formatCompanyRolesReport,
  getRoleInfo,
};
