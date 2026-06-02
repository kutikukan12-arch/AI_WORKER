'use strict';
// ai-company-roles.js のテスト
// 各ロールの判定ロジックと出力フォーマットを検証する。

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const roles = require('../bot/utils/ai-company-roles');
const ceoReport = require('../bot/utils/ceo-report');

// ─── テスト用 ctx ヘルパー ───────────────────────────────
function makeCtx(overrides = {}) {
  return {
    execStatus:  'CONTINUE_DEVELOPMENT',
    runStats:    { tasksDone: 5, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
    quality:     { level: 'GREEN', score: 85 },
    taskSummary: { pending: 2, onHold: 0, reviewing: 0, awaiting: 0, inProgress: 0, total: 7 },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// 1. モジュール構造
// ─────────────────────────────────────────────────────
describe('モジュール構造', () => {
  test('ROLE_ORDER に7ロールが定義されている', () => {
    assert.strictEqual(roles.ROLE_ORDER.length, 7);
    const expected = ['UX', 'FINANCE', 'SALES', 'SUPPORT', 'LEGAL', 'SECURITY', 'COST_OPTIMIZER'];
    assert.deepStrictEqual(roles.ROLE_ORDER, expected);
  });

  test('各ロールに emoji / name / scope / criteria / evaluate が存在する', () => {
    for (const id of roles.ROLE_ORDER) {
      const role = roles.ROLES[id];
      assert.ok(role.emoji,    `${id}: emoji がない`);
      assert.ok(role.name,     `${id}: name がない`);
      assert.ok(Array.isArray(role.scope)    && role.scope.length > 0,    `${id}: scope がない`);
      assert.ok(Array.isArray(role.criteria) && role.criteria.length > 0, `${id}: criteria がない`);
      assert.strictEqual(typeof role.evaluate, 'function', `${id}: evaluate が関数でない`);
    }
  });

  test('evaluateAll が全ロールのキーを返す', () => {
    const ctx = makeCtx();
    const result = roles.evaluateAll(ctx);
    for (const id of roles.ROLE_ORDER) {
      assert.ok(id in result, `${id} が evaluateAll の戻り値にない`);
      assert.ok(result[id].verdict, `${id}: verdict がない`);
      assert.ok(result[id].comment, `${id}: comment がない`);
    }
  });

  test('getRoleInfo が担当範囲と判断基準を返す', () => {
    const info = roles.getRoleInfo('UX');
    assert.ok(info, 'UX の getRoleInfo が null');
    assert.strictEqual(info.id, 'UX');
    assert.ok(Array.isArray(info.scope));
    assert.ok(Array.isArray(info.criteria));
  });

  test('存在しないロールIDは getRoleInfo で null を返す', () => {
    assert.strictEqual(roles.getRoleInfo('UNKNOWN'), null);
  });
});

// ─────────────────────────────────────────────────────
// 2. UX ロール
// ─────────────────────────────────────────────────────
describe('UX ロール', () => {
  test('品質 RED → RISK', () => {
    const ctx = makeCtx({ quality: { level: 'RED', score: 30 } });
    const ev = roles.ROLES.UX.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('BLOCKED → RISK', () => {
    const ctx = makeCtx({ execStatus: 'BLOCKED' });
    const ev = roles.ROLES.UX.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('reviewing > 0 → CAUTION', () => {
    const ctx = makeCtx({ taskSummary: { pending: 0, onHold: 0, reviewing: 2, awaiting: 0, inProgress: 0, total: 5 } });
    const ev = roles.ROLES.UX.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('品質 GREEN・tasksDone > 0 → OK', () => {
    const ctx = makeCtx();
    const ev = roles.ROLES.UX.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });
});

// ─────────────────────────────────────────────────────
// 3. Finance ロール
// ─────────────────────────────────────────────────────
describe('Finance ロール', () => {
  test('失敗率 > 20% → RISK', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 7, tasksFailed: 3, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.FINANCE.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('失敗率 10〜20% → CAUTION', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 8, tasksFailed: 1, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.FINANCE.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('失敗なし → OK', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 10, tasksFailed: 0, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.FINANCE.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });

  test('tasksDone = 0 → N/A', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 0, tasksFailed: 0, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.FINANCE.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.NA);
  });
});

// ─────────────────────────────────────────────────────
// 4. Sales ロール
// ─────────────────────────────────────────────────────
describe('Sales ロール', () => {
  test('RELEASE_READY → OK', () => {
    const ctx = makeCtx({ execStatus: 'RELEASE_READY' });
    const ev = roles.ROLES.SALES.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });

  test('BLOCKED → RISK', () => {
    const ctx = makeCtx({ execStatus: 'BLOCKED' });
    const ev = roles.ROLES.SALES.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('CONTINUE_DEVELOPMENT → CAUTION', () => {
    const ctx = makeCtx({ execStatus: 'CONTINUE_DEVELOPMENT' });
    const ev = roles.ROLES.SALES.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });
});

// ─────────────────────────────────────────────────────
// 5. Support ロール
// ─────────────────────────────────────────────────────
describe('Support ロール', () => {
  test('tasksFailed > 2 → RISK', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 5, tasksFailed: 3, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.SUPPORT.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('RELEASE_READY → CAUTION', () => {
    const ctx = makeCtx({ execStatus: 'RELEASE_READY', runStats: { tasksDone: 10, tasksFailed: 0, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.SUPPORT.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('失敗なし・非RELEASE_READY → OK', () => {
    const ctx = makeCtx();
    const ev = roles.ROLES.SUPPORT.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });
});

// ─────────────────────────────────────────────────────
// 6. Legal ロール
// ─────────────────────────────────────────────────────
describe('Legal ロール', () => {
  test('品質 RED → RISK', () => {
    const ctx = makeCtx({ quality: { level: 'RED', score: 20 } });
    const ev = roles.ROLES.LEGAL.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('RELEASE_READY + GREEN → CAUTION', () => {
    const ctx = makeCtx({ execStatus: 'RELEASE_READY' });
    const ev = roles.ROLES.LEGAL.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('GREEN・非リリース → OK', () => {
    const ctx = makeCtx();
    const ev = roles.ROLES.LEGAL.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });
});

// ─────────────────────────────────────────────────────
// 7. Security ロール
// ─────────────────────────────────────────────────────
describe('Security ロール', () => {
  test('RED + BLOCKED → RISK', () => {
    const ctx = makeCtx({ execStatus: 'BLOCKED', quality: { level: 'RED', score: 10 } });
    const ev = roles.ROLES.SECURITY.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('失敗タスクあり → CAUTION', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 5, tasksFailed: 1, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.SECURITY.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('RELEASE_READY + GREEN → CAUTION', () => {
    const ctx = makeCtx({ execStatus: 'RELEASE_READY', runStats: { tasksDone: 10, tasksFailed: 0, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.SECURITY.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('正常状態 → OK', () => {
    const ctx = makeCtx();
    const ev = roles.ROLES.SECURITY.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });
});

// ─────────────────────────────────────────────────────
// 8. Cost Optimizer ロール
// ─────────────────────────────────────────────────────
describe('Cost Optimizer ロール', () => {
  test('タイムアウト停止 → RISK', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 3, tasksFailed: 0, stopReason: 'timeout_limit', yellowCount: 0 } });
    const ev = roles.ROLES.COST_OPTIMIZER.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('失敗率 > 20% → RISK', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 7, tasksFailed: 3, stopReason: '', yellowCount: 0 } });
    const ev = roles.ROLES.COST_OPTIMIZER.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.RISK);
  });

  test('yellowCount > 2 → CAUTION', () => {
    const ctx = makeCtx({ runStats: { tasksDone: 5, tasksFailed: 0, stopReason: '', yellowCount: 3 } });
    const ev = roles.ROLES.COST_OPTIMIZER.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.CAUTION);
  });

  test('正常状態 → OK', () => {
    const ctx = makeCtx();
    const ev = roles.ROLES.COST_OPTIMIZER.evaluate(ctx);
    assert.strictEqual(ev.verdict, roles.VERDICT.OK);
  });
});

// ─────────────────────────────────────────────────────
// 9. formatCompanyRolesReport 出力検証
// ─────────────────────────────────────────────────────
describe('formatCompanyRolesReport', () => {
  test('全ロールの絵文字と名前が出力に含まれる', () => {
    const ctx = makeCtx();
    const evaluations = roles.evaluateAll(ctx);
    const text = roles.formatCompanyRolesReport(evaluations);

    for (const id of roles.ROLE_ORDER) {
      const role = roles.ROLES[id];
      assert.ok(text.includes(role.emoji), `${id}: emoji が出力にない`);
      assert.ok(text.includes(role.name),  `${id}: name が出力にない`);
    }
  });

  test('RISK 状態では 🔴 が出力される', () => {
    const ctx = makeCtx({ quality: { level: 'RED', score: 10 }, execStatus: 'BLOCKED' });
    const evaluations = roles.evaluateAll(ctx);
    const text = roles.formatCompanyRolesReport(evaluations);
    assert.ok(text.includes('🔴'), 'RISK のとき 🔴 が出力にない');
  });
});

// ─────────────────────────────────────────────────────
// 10. ceo-report.js との統合
// ─────────────────────────────────────────────────────
describe('ceo-report.js との統合', () => {
  const mockTm = {
    listTasks: () => [],
    STATES: {
      PENDING: '未着手', ON_HOLD: '保留', REVIEWING: 'レビュー待ち',
      AWAITING: '人間確認待ち', IN_PROGRESS: '作業中', DONE: '完了',
    },
  };
  const mockPm = { filterTasksByProject: () => [] };

  test('generateCeoReport に companyEvaluations が含まれる', () => {
    const report = ceoReport.generateCeoReport(
      'test-proj',
      { tasksDone: 5, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
      { level: 'GREEN', score: 88, redTriggers: [] },
      'NEEDS_REFINEMENT',
      mockTm,
      mockPm
    );
    assert.ok(report.companyEvaluations, 'companyEvaluations がない');
    for (const id of roles.ROLE_ORDER) {
      assert.ok(id in report.companyEvaluations, `${id} が companyEvaluations にない`);
    }
  });

  test('formatCeoReportPart4 が AI Board 役割別評価ヘッダーを含む', () => {
    const report = ceoReport.generateCeoReport(
      'test-proj',
      { tasksDone: 3, tasksFailed: 0, stopReason: 'project_done', yellowCount: 0 },
      { level: 'GREEN', score: 80, redTriggers: [] },
      'NEEDS_REFINEMENT',
      mockTm,
      mockPm
    );
    const text = ceoReport.formatCeoReportPart4(report);
    assert.ok(text.includes('AI Board 役割別評価'), 'ヘッダーがない');
    assert.ok(text.includes('🅳'), 'UX 絵文字がない');
    assert.ok(text.includes('🅻'), 'Security 絵文字がない');
  });

  test('formatCeoReportPart4: companyEvaluations なしは fallback 文字列を返す', () => {
    const text = ceoReport.formatCeoReportPart4({ companyEvaluations: null });
    assert.ok(text.includes('拡張ロール評価なし'));
  });
});
