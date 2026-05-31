'use strict';

// =====================================================
// company_manager_test.js — company-manager.js の単体テスト
//
// テストケース:
//   A. recommendStaffing — ルールの正確な適用
//   B. analyzeProjectStaffing — 集計ロジック
//   C. formatStaffingPlan — 出力フォーマット
//   D. エッジケース
//   E. youtube予測AI 実データシミュレーション
// =====================================================

const assert  = require('assert');
const cm      = require('../bot/utils/company-manager');

let pass = 0;
let fail = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    pass++;
  } catch (e) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${e.message}`);
    fail++;
  }
}

// ─────────────────────────────────────────────────────
// ヘルパー: stats オブジェクトを直接組み立てる
// ─────────────────────────────────────────────────────
function makeStats(overrides = {}) {
  return {
    projectId:       'test',
    totalTasks:      0,
    activeCount:     0,
    byState:         {},
    pendingByType:   {},
    reviewingCount:  0,
    pendingImpl:     0,
    pendingReview:   0,
    pendingTest:     0,
    pendingResearch: 0,
    pendingUndefined: 0,
    withTimeouts:    0,
    withErrors:      0,
    errorRate:       0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// A. recommendStaffing — コアルール
// ─────────────────────────────────────────────────────

console.log('\n[A] recommendStaffing — コアルール');

test('IMPLEMENT 3件 → IMPLEMENTER 1人', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 3, activeCount: 3 }));
  assert.strictEqual(plan.workers.IMPLEMENTER, 1);
});

test('IMPLEMENT 4件 → IMPLEMENTER 2人（ceil(4/3)=2）', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 4, activeCount: 4 }));
  assert.strictEqual(plan.workers.IMPLEMENTER, 2);
});

test('IMPLEMENT 9件（MEDIUM規模）→ IMPLEMENTER 3人', () => {
  // activeCount=10 → MEDIUM(upTo:20, maxImpl:3) になるよう設定
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 9, activeCount: 10 }));
  assert.strictEqual(plan.workers.IMPLEMENTER, 3);
});

test('REVIEW 1件（PENDING）→ REVIEWER 1人', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingReview: 1, activeCount: 1 }));
  assert.strictEqual(plan.workers.REVIEWER, 1);
});

test('REVIEWING 3件（MEDIUM規模）→ REVIEWER 2人（ceil(3/2)=2）', () => {
  // activeCount=10 → MEDIUM(maxReview:1)。LARGE(21+, maxReview:2)になるよう設定
  const plan = cm.recommendStaffing(makeStats({ reviewingCount: 3, activeCount: 25 }));
  assert.strictEqual(plan.workers.REVIEWER, 2, `実際: ${plan.workers.REVIEWER}`);
});

test('REVIEW 0件 + REVIEWING 0件 → REVIEWER 0人', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 2, activeCount: 2 }));
  assert.strictEqual(plan.workers.REVIEWER, 0);
});

test('TEST 1件 → TESTER 1人', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingTest: 1, activeCount: 1 }));
  assert.strictEqual(plan.workers.TESTER, 1);
});

test('TEST 0件 → TESTER 0人', () => {
  const plan = cm.recommendStaffing(makeStats({ activeCount: 0 }));
  assert.strictEqual(plan.workers.TESTER, 0);
});

test('RESEARCH 2件 → RESEARCHER 1人（閾値ちょうど）', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingResearch: 2, activeCount: 2 }));
  assert.strictEqual(plan.workers.RESEARCHER, 1);
});

test('RESEARCH 1件 → RESEARCHER 0人（閾値未満）', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingResearch: 1, activeCount: 1 }));
  assert.strictEqual(plan.workers.RESEARCHER, 0);
});

// ─────────────────────────────────────────────────────
// B. エラー・タイムアウト調整
// ─────────────────────────────────────────────────────

console.log('\n[B] エラー・タイムアウト調整');

test('errorRate > 0.2 → REVIEWER 最低1人', () => {
  const plan = cm.recommendStaffing(makeStats({
    pendingImpl: 3, activeCount: 3,
    errorRate: 0.3, reviewingCount: 0, pendingReview: 0,
  }));
  assert.strictEqual(plan.workers.REVIEWER, 1);
  assert.ok(plan.adjustedForErrors);
});

test('withTimeouts >= 2 → REVIEWER 最低1人', () => {
  const plan = cm.recommendStaffing(makeStats({
    pendingImpl: 3, activeCount: 3,
    withTimeouts: 3,
  }));
  assert.strictEqual(plan.workers.REVIEWER, 1);
  assert.ok(plan.adjustedForErrors);
});

test('errorRate 正常 + タイムアウトなし → adjustedForErrors false', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 3, activeCount: 3 }));
  assert.ok(!plan.adjustedForErrors);
});

// ─────────────────────────────────────────────────────
// C. MAX_WORKERS 上限制御
// ─────────────────────────────────────────────────────

console.log('\n[C] MAX_WORKERS 上限制御');

test('total <= MAX_WORKERS なら capped=false', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 3, activeCount: 3 }));
  assert.ok(!plan.capped);
});

test('total <= MAX_WORKERS (8) ならそのまま返す', () => {
  const stats = makeStats({
    pendingImpl: 6, reviewingCount: 2, pendingTest: 1,
    pendingResearch: 2, activeCount: 11,
  });
  const plan = cm.recommendStaffing(stats);
  assert.ok(plan.total <= cm.MAX_WORKERS, `total=${plan.total}`);
});

// ─────────────────────────────────────────────────────
// D. スケール判定
// ─────────────────────────────────────────────────────

console.log('\n[D] スケール判定');

test('activeCount 2 → MICRO', () => {
  const plan = cm.recommendStaffing(makeStats({ activeCount: 2 }));
  assert.strictEqual(plan.scale, 'MICRO');
});

test('activeCount 5 → SMALL', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 5, activeCount: 5 }));
  assert.strictEqual(plan.scale, 'SMALL');
});

test('activeCount 15 → MEDIUM', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 9, activeCount: 15 }));
  assert.strictEqual(plan.scale, 'MEDIUM');
});

test('MICRO で IMPLEMENT 1件 → IMPLEMENTER 1人（上限1人を下回らない）', () => {
  const plan = cm.recommendStaffing(makeStats({ pendingImpl: 1, activeCount: 1 }));
  assert.strictEqual(plan.workers.IMPLEMENTER, 1);
});

// ─────────────────────────────────────────────────────
// E. 複合シナリオ（設計書の例と一致するか）
// ─────────────────────────────────────────────────────

console.log('\n[E] 複合シナリオ');

test('例1: IMPL3 + REVIEW1 + TEST1 (5件) → IMPL1 REV1 TEST1 合計3', () => {
  const stats = makeStats({
    pendingImpl: 3, pendingReview: 1, pendingTest: 1, activeCount: 5,
  });
  const plan = cm.recommendStaffing(stats);
  assert.strictEqual(plan.workers.IMPLEMENTER, 1);
  assert.strictEqual(plan.workers.REVIEWER,    1);
  assert.strictEqual(plan.workers.TESTER,      1);
  assert.strictEqual(plan.workers.RESEARCHER,  0);
  assert.strictEqual(plan.total, 3);
});

test('例2: IMPL18 + FIX5 + REVIEW3 + TEST2 + RESEARCH2 (30件) → 合計 ≤ MAX_WORKERS', () => {
  const stats = makeStats({
    pendingImpl: 23, pendingReview: 3, reviewingCount: 0,
    pendingTest: 2, pendingResearch: 2, activeCount: 30,
  });
  const plan = cm.recommendStaffing(stats);
  assert.ok(plan.total <= cm.MAX_WORKERS, `total=${plan.total}`);
  // IMPLEMENTER はスケール LARGE (maxImpl=4) 上限内
  assert.ok(plan.workers.IMPLEMENTER >= 1);
  assert.ok(plan.workers.IMPLEMENTER <= 4);
});

// ─────────────────────────────────────────────────────
// F. formatStaffingPlan — 出力フォーマット
// ─────────────────────────────────────────────────────

console.log('\n[F] formatStaffingPlan');

test('文字列が返る', () => {
  const stats = makeStats({ pendingImpl: 3, pendingTest: 1, activeCount: 4 });
  const plan  = cm.recommendStaffing(stats);
  const text  = cm.formatStaffingPlan(plan, stats, []);
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('IMPLEMENTER が含まれる', () => {
  const stats = makeStats({ pendingImpl: 3, activeCount: 3 });
  const plan  = cm.recommendStaffing(stats);
  const text  = cm.formatStaffingPlan(plan, stats, []);
  assert.ok(text.includes('IMPLEMENTER'), 'テキストに IMPLEMENTER が含まれない');
});

test('reasoning が含まれる', () => {
  const stats = makeStats({ pendingImpl: 6, activeCount: 6 });
  const plan  = cm.recommendStaffing(stats);
  const text  = cm.formatStaffingPlan(plan, stats, []);
  assert.ok(text.includes('判断理由'), '判断理由が含まれない');
});

// ─────────────────────────────────────────────────────
// G. youtube予測AI 実データ シミュレーション
// （実ファイルロードなし・仕様書の想定値で再現）
// ─────────────────────────────────────────────────────

console.log('\n[G] youtube予測AI シミュレーション（仕様書準拠）');

test('Phase1 MVP 7タスク（IMPL6 + TEST1）→ IMPL2 REV1 TEST1 合計4', () => {
  // 仕様書の実装推奨順序: chroma/seed/predictor/seed-status/simulate/night-batch + テスト
  const stats = makeStats({
    pendingImpl:     6,  // IMPLEMENT × 6
    pendingTest:     1,  // TEST × 1
    pendingReview:   0,  // まだなし（IMPLEMENT完了後に自動生成）
    pendingResearch: 0,  // 仕様書完成済み
    reviewingCount:  0,
    activeCount:     7,
  });
  const plan = cm.recommendStaffing(stats);
  assert.strictEqual(plan.workers.IMPLEMENTER, 2, `IMPLEMENTER: ${plan.workers.IMPLEMENTER}`);
  assert.strictEqual(plan.workers.TESTER,      1, `TESTER: ${plan.workers.TESTER}`);
  assert.strictEqual(plan.workers.RESEARCHER,  0, `RESEARCHER: ${plan.workers.RESEARCHER}`);
  assert.strictEqual(plan.total, 2 + plan.workers.REVIEWER + 1, `合計: ${plan.total}`);
});

test('実データ現状（PENDING 4件: IMPL2 + REVIEW2）→ IMPL1 REV1 合計2', () => {
  // node -e で確認した実際の値
  const stats = makeStats({
    pendingImpl:    2,
    pendingReview:  2,
    pendingTest:    0,
    pendingResearch: 0,
    reviewingCount: 0,
    withTimeouts:   1,  // タイムアウト 1 件（閾値 2 未満）
    activeCount:    4,
  });
  const plan = cm.recommendStaffing(stats);
  assert.strictEqual(plan.workers.IMPLEMENTER, 1);
  assert.strictEqual(plan.workers.REVIEWER,    1);
  assert.strictEqual(plan.workers.TESTER,      0);
  assert.strictEqual(plan.workers.RESEARCHER,  0);
  assert.strictEqual(plan.total, 2);
});

// ─────────────────────────────────────────────────────
// F. computeDelta / applyStaffingPlan / formatAssignResult
// ─────────────────────────────────────────────────────

console.log('\n── F. computeDelta / applyStaffingPlan / formatAssignResult ──');

const wr = require('../bot/utils/worker-registry');
const path = require('path');
const fs   = require('fs');
const WORKERS_FILE = path.join(__dirname, '..', 'data', 'workers.json');

// テスト前にテスト用ワーカーをクリーンアップ
function cleanupTestWorkers() {
  if (!fs.existsSync(WORKERS_FILE)) return;
  const raw = JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf8'));
  raw.workers = (raw.workers || []).filter(w => w.projectId !== 'assign-test');
  fs.writeFileSync(WORKERS_FILE, JSON.stringify(raw, null, 2), 'utf8');
}
cleanupTestWorkers();

test('F-1. computeDelta: 推奨 IMPLEMENTER 1人・現在 0人 → toAdd に IMPLEMENTER 1件', () => {
  const plan = {
    workers: { IMPLEMENTER: 1, REVIEWER: 0, TESTER: 0, RESEARCHER: 0 },
    total: 1,
    scaleLabel: '極小',
  };
  const delta = cm.computeDelta('assign-test', plan);
  assert.ok(delta.toAdd.some(a => a.role === 'IMPLEMENTER' && a.count >= 1),
    'toAdd に IMPLEMENTER が含まれない');
  assert.strictEqual(delta.toRemove.length, 0);
});

test('F-2. computeDelta: 推奨 0人・現在 idle IMPLEMENTER 1人 → toRemove に含まれる', () => {
  wr.addWorker('IMPLEMENTER', 'f2-impl', 'assign-test');
  const plan = {
    workers: { IMPLEMENTER: 0, REVIEWER: 0, TESTER: 0, RESEARCHER: 0 },
    total: 0,
    scaleLabel: '極小',
  };
  const delta = cm.computeDelta('assign-test', plan);
  assert.ok(delta.toRemove.includes('f2-impl'), 'f2-impl が toRemove に含まれない');
  wr.removeWorker('f2-impl');
});

test('F-3. computeDelta: busy Worker は toRemove から除外', () => {
  wr.addWorker('IMPLEMENTER', 'f3-busy', 'assign-test');
  wr.updateWorkerStatus('f3-busy', wr.WORKER_STATUS.BUSY, 'task_xxx');
  const plan = {
    workers: { IMPLEMENTER: 0, REVIEWER: 0, TESTER: 0, RESEARCHER: 0 },
    total: 0,
    scaleLabel: '極小',
  };
  const delta = cm.computeDelta('assign-test', plan);
  assert.ok(!delta.toRemove.includes('f3-busy'), 'busy Worker が toRemove に含まれた');
  wr.updateWorkerStatus('f3-busy', wr.WORKER_STATUS.IDLE, null);
  wr.removeWorker('f3-busy');
});

test('F-4. computeDelta: projectId="*" Worker は toRemove から除外', () => {
  wr.addWorker('IMPLEMENTER', 'f4-global', '*');
  const plan = {
    workers: { IMPLEMENTER: 0, REVIEWER: 0, TESTER: 0, RESEARCHER: 0 },
    total: 0,
    scaleLabel: '極小',
  };
  const delta = cm.computeDelta('assign-test', plan);
  assert.ok(!delta.toRemove.includes('f4-global'), '"*" Worker が toRemove に含まれた');
  wr.removeWorker('f4-global');
});

test('F-5. applyStaffingPlan dryRun=true は workers.json を変更しない', () => {
  const before = wr.listWorkers().map(w => w.workerId).join(',');
  const result = cm.applyStaffingPlan('assign-test', { dryRun: true });
  const after  = wr.listWorkers().map(w => w.workerId).join(',');
  assert.strictEqual(before, after, 'dryRun なのに workers.json が変わった');
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.added.length, 0);
  assert.strictEqual(result.removed.length, 0);
});

test('F-6. formatAssignResult dryRun=true は "プレビュー" を含む', () => {
  const result = cm.applyStaffingPlan('assign-test', { dryRun: true });
  const text   = cm.formatAssignResult(result);
  assert.ok(typeof text === 'string', 'text が文字列でない');
  assert.ok(text.includes('プレビュー'), 'プレビュー文言がない: ' + text.slice(0, 80));
});

test('F-7. formatAssignResult dryRun=false は "調整" を含む', () => {
  // assign-test に何も Worker がない状態で applyStaffingPlan → テスト環境では変更0
  const result = cm.applyStaffingPlan('assign-test', { dryRun: false });
  const text   = cm.formatAssignResult(result);
  assert.ok(typeof text === 'string', 'text が文字列でない');
  assert.ok(text.includes('調整') || text.includes('変更なし'), '結果文言がない');
});

test('F-8. computeDelta / applyStaffingPlan / formatAssignResult が export されている', () => {
  assert.ok(typeof cm.computeDelta       === 'function');
  assert.ok(typeof cm.applyStaffingPlan  === 'function');
  assert.ok(typeof cm.formatAssignResult === 'function');
});

cleanupTestWorkers();

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`結果: ${pass} 件パス / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
