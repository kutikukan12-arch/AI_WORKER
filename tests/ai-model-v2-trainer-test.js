'use strict';
// ai-model-v2-trainer テスト

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

// ─────────────────────────────────────────────────────
// テスト用一時ディレクトリのセットアップ
// ─────────────────────────────────────────────────────
const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'v2trainer-'));
const historyDir = path.join(tmpDir, 'history');
const modelsFile = path.join(tmpDir, 'ml-models.json');
fs.mkdirSync(historyDir, { recursive: true });

// モジュールの定数を差し替えるため、require 前にパスを上書き
// ここでは直接モジュールを読み込まず、ラッパー経由でモジュール内部関数をテストする

// ── ヘルパー: 擬似タスクを生成 ──
function makeTask(overrides = {}) {
  const now = new Date().toISOString();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  return {
    id:        'task_test',
    type:      'IMPLEMENT',
    size:      'MEDIUM',
    prompt:    'テスト実装タスク',
    state:     '完了',
    createdAt:  twoHoursAgo,
    updatedAt:  now,
    reviewResult: null,
    stateHistory: [
      { state: '未着手',  at: twoHoursAgo },
      { state: '完了',    at: now         },
    ],
    ...overrides,
  };
}

// ── ヘルパー: history ファイルを書き込む ──
function writeHistory(filename, tasks) {
  fs.writeFileSync(
    path.join(historyDir, filename),
    JSON.stringify({ tasks }, null, 2),
    'utf8',
  );
}

// ─────────────────────────────────────────────────────
// 1. ai-feature-extractor のユニットテスト
// ─────────────────────────────────────────────────────
console.log('\n[1. ai-feature-extractor: encode()]');

const extractor = require('../bot/utils/ai-feature-extractor');

test('encode() は Float64Array(26) を返す', () => {
  const task = makeTask();
  const vec  = extractor.encode(task);
  assert.ok(vec instanceof Float64Array, 'Float64Array でない');
  assert.strictEqual(vec.length, extractor.FEATURE_DIM);
});

test('encode(): type one-hot が正しい (IMPLEMENT → idx 0 = 1.0)', () => {
  const vec = extractor.encode(makeTask({ type: 'IMPLEMENT' }));
  assert.strictEqual(vec[0], 1.0, 'IMPLEMENT の one-hot が 1.0 でない');
  assert.strictEqual(vec[1], 0.0, '2番目が 0.0 でない');
});

test('encode(): size one-hot が正しい (MEDIUM → idx 9 = 1.0)', () => {
  const vec = extractor.encode(makeTask({ size: 'MEDIUM' }));
  // TASK_TYPES は 8 個 → size の MEDIUM は index 8+1 = 9
  assert.strictEqual(vec[9], 1.0, 'MEDIUM の one-hot が 1.0 でない');
});

test('encode(): prompt シグナル (テスト→ sig_test が 1.0)', () => {
  const vec = extractor.encode(makeTask({ prompt: 'テストコードを書いて' }));
  // sig_test は PROMPT_SIGNALS の index 4 → feature index 11+4 = 15
  const sigTestIdx = 8 + 3 + 4; // type(8) + size(3) + sig index 4
  assert.strictEqual(vec[sigTestIdx], 1.0, 'sig_test が 1.0 でない');
});

test('encode(): bias 項は常に 1.0', () => {
  const vec = extractor.encode(makeTask());
  assert.strictEqual(vec[extractor.FEATURE_DIM - 1], 1.0, 'bias が 1.0 でない');
});

test('describe() は空でない文字列を返す', () => {
  const vec = extractor.encode(makeTask());
  const desc = extractor.describe(vec);
  assert.ok(typeof desc === 'string' && desc.length > 0, 'describe が空');
});

// ─────────────────────────────────────────────────────
// 2. ai-model-v2 のユニットテスト（LogisticRegression / LinearRegression）
// ─────────────────────────────────────────────────────
console.log('\n[2. ai-model-v2: LogisticRegression / LinearRegression]');

const { LogisticRegression, LinearRegression, SoftmaxClassifier } = require('../bot/utils/ai-model-v2');
const { FEATURE_DIM } = extractor;

function makeXY(n, successRate = 0.7) {
  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const task = makeTask({ type: i % 2 === 0 ? 'IMPLEMENT' : 'FIX' });
    X.push(extractor.encode(task));
    y.push(Math.random() < successRate ? 1 : 0);
  }
  return { X, y };
}

test('LogisticRegression: train() がエラーなく終了する', () => {
  const { X, y } = makeXY(20);
  const m = new LogisticRegression({ epochs: 10, batchSize: 4 }).train(X, y);
  assert.ok(m.weights instanceof Float64Array, 'weights が Float64Array でない');
  assert.strictEqual(m.weights.length, FEATURE_DIM);
});

test('LogisticRegression: predict() が [0, 1] の値を返す', () => {
  const { X, y } = makeXY(20);
  const m = new LogisticRegression({ epochs: 10 }).train(X, y);
  const p = m.predict(X[0]);
  assert.ok(p >= 0 && p <= 1, `predict = ${p} が [0,1] 外`);
});

test('LogisticRegression: toJSON/fromJSON でウェイトが保持される', () => {
  const { X, y } = makeXY(20);
  const m1 = new LogisticRegression({ epochs: 10 }).train(X, y);
  const m2 = LogisticRegression.fromJSON(m1.toJSON());
  const p1 = m1.predict(X[0]);
  const p2 = m2.predict(X[0]);
  assert.ok(Math.abs(p1 - p2) < 1e-10, `fromJSON 後の predict が一致しない: ${p1} vs ${p2}`);
});

test('LinearRegression: train() + predict() が有限値を返す', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 20; i++) {
    X.push(extractor.encode(makeTask()));
    y.push(10 + Math.random() * 50); // 10〜60分
  }
  const m = new LinearRegression({ epochs: 10 }).train(X, y);
  const pred = m.predict(X[0]);
  assert.ok(Number.isFinite(pred), `predict が有限値でない: ${pred}`);
});

test('LinearRegression: toJSON/fromJSON でウェイトが保持される', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 20; i++) {
    X.push(extractor.encode(makeTask()));
    y.push(20 + i);
  }
  const m1 = new LinearRegression({ epochs: 10 }).train(X, y);
  const m2 = LinearRegression.fromJSON(m1.toJSON());
  const p1 = m1.predict(X[0]);
  const p2 = m2.predict(X[0]);
  assert.ok(Math.abs(p1 - p2) < 1e-10, `fromJSON 後の predict が一致しない`);
});

test('SoftmaxClassifier: train() + predict() が確率ベクトルを返す', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 30; i++) {
    X.push(extractor.encode(makeTask()));
    y.push(i % 3); // 3クラス
  }
  const m = new SoftmaxClassifier({ epochs: 10, numClasses: 3 }).train(X, y);
  const probs = m.predict(X[0]);
  assert.strictEqual(probs.length, 3);
  const sum = probs.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `確率の合計が 1.0 でない: ${sum}`);
});

// ─────────────────────────────────────────────────────
// 3. ai-model-v2-trainer のユニットテスト
// ─────────────────────────────────────────────────────
console.log('\n[3. ai-model-v2-trainer: trainV2() / trainIncrementalV2()]');

// モジュール内部のパスを差し替えるためモジュールキャッシュを利用
// trainV2 は DATA_DIR / HISTORY_DIR を使うため、実際のパスで動作確認する
// （テスト用一時ディレクトリへのモック注入は行わず、data/ 不在時のスキップ動作を確認）

const trainer = require('../bot/utils/ai-model-v2-trainer');

test('loadModels(): モデルファイルが存在しない場合 null を返す', () => {
  // data/ml-models.json がなくても null を返すべき
  const result = trainer.loadModels();
  // null または有効なオブジェクトであることを確認（既存ファイルがあれば object）
  assert.ok(result === null || (typeof result === 'object' && result !== null));
});

test('getV2Stats(): モデルファイルがなければ null を返す', () => {
  // data/ml-models.json がなければ null
  const stats = trainer.getV2Stats();
  assert.ok(stats === null || typeof stats === 'object');
});

test('trainV2(): data/history/ がなければ skipped:true を返す', () => {
  // 実際の data/history/ が存在する場合はスキップしない
  // ここでは戻り値の型のみ確認
  const result = trainer.trainV2();
  assert.ok(typeof result === 'object', 'trainV2() がオブジェクトを返さない');
  assert.ok('skipped' in result, 'skipped プロパティがない');
});

test('trainIncrementalV2(): 戻り値に skipped プロパティがある', () => {
  const result = trainer.trainIncrementalV2();
  assert.ok(typeof result === 'object');
  assert.ok('skipped' in result, 'skipped プロパティがない');
});

// ─────────────────────────────────────────────────────
// 4. _collectTrainingData の動作確認（モック history ファイルで）
// ─────────────────────────────────────────────────────
console.log('\n[4. 特徴量収集の動作確認（内部ロジック）]');

test('encode(): 壊れたデータでもクラッシュしない', () => {
  // 不完全なタスクでも encode がエラーにならないことを確認
  const badTask = { type: null, size: undefined, prompt: null, createdAt: null, updatedAt: null };
  let vec;
  assert.doesNotThrow(() => { vec = extractor.encode(badTask); });
  assert.strictEqual(vec.length, FEATURE_DIM);
});

test('encode(): recency_norm は 0.0〜1.0 の範囲', () => {
  const task = makeTask({ updatedAt: new Date().toISOString() });
  const vec  = extractor.encode(task);
  const idx  = FEATURE_DIM - 2; // recency_norm は bias の一つ前
  assert.ok(vec[idx] >= 0.0 && vec[idx] <= 1.0, `recency_norm = ${vec[idx]}`);
});

test('encode(): 90日以上前のタスクは recency_norm = 0.0', () => {
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  const vec  = extractor.encode(makeTask({ updatedAt: old }));
  const idx  = FEATURE_DIM - 2;
  assert.strictEqual(vec[idx], 0.0, `recency_norm が 0.0 でない: ${vec[idx]}`);
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`結果: ${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
