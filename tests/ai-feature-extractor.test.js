'use strict';

/**
 * ai-feature-extractor.js のユニットテスト
 *
 * テスト対象:
 *   1. encode() — Float64Array(26) を返すこと
 *   2. taskType one-hot エンコーディング
 *   3. taskSize one-hot エンコーディング
 *   4. プロンプトシグナル検出
 *   5. prompt_len_norm 正規化
 *   6. 時刻・曜日サイクリック符号化（有限値であること）
 *   7. recency_norm 正規化
 *   8. バイアス項（常に 1.0）
 *   9. describe() — デバッグ用サマリー
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  encode, describe: describeVec,
  FEATURE_NAMES, FEATURE_DIM,
  TASK_TYPES, TASK_SIZES, PROMPT_SIGNALS,
} = require('../bot/utils/ai-feature-extractor');

// ── インデックス定義 ─────────────────────────────────
const TYPE_OFFSET   = 0;
const SIZE_OFFSET   = TASK_TYPES.length;       // 8
const SIG_OFFSET    = SIZE_OFFSET + TASK_SIZES.length; // 11
const PLEN_IDX      = SIG_OFFSET + PROMPT_SIGNALS.length; // 19
const HOUR_SIN_IDX  = PLEN_IDX + 1;  // 20
const HOUR_COS_IDX  = PLEN_IDX + 2;  // 21
const DOW_SIN_IDX   = PLEN_IDX + 3;  // 22
const DOW_COS_IDX   = PLEN_IDX + 4;  // 23
const RECENCY_IDX   = PLEN_IDX + 5;  // 24
const BIAS_IDX      = FEATURE_DIM - 1; // 25

describe('FEATURE_DIM / FEATURE_NAMES', () => {
  test('FEATURE_DIM は 26', () => {
    assert.equal(FEATURE_DIM, 26);
  });

  test('FEATURE_NAMES の要素数が FEATURE_DIM と一致', () => {
    assert.equal(FEATURE_NAMES.length, FEATURE_DIM);
  });

  test('FEATURE_NAMES に重複がない', () => {
    const unique = new Set(FEATURE_NAMES);
    assert.equal(unique.size, FEATURE_DIM);
  });
});

describe('encode() — 基本', () => {
  test('Float64Array(FEATURE_DIM) を返す', () => {
    const vec = encode({ type: 'IMPLEMENT', size: 'MEDIUM', prompt: 'test' });
    assert.ok(vec instanceof Float64Array);
    assert.equal(vec.length, FEATURE_DIM);
  });

  test('引数なしでもエラーにならない', () => {
    assert.doesNotThrow(() => encode({}));
  });

  test('全要素が有限値', () => {
    const vec = encode({ type: 'FIX', size: 'LARGE', prompt: '認証 delete 本番', createdAt: new Date().toISOString() });
    for (let i = 0; i < FEATURE_DIM; i++) {
      assert.ok(isFinite(vec[i]), `vec[${i}] (${FEATURE_NAMES[i]}) = ${vec[i]} が有限値でない`);
    }
  });

  test('バイアス項は常に 1.0', () => {
    assert.equal(encode({}) [BIAS_IDX], 1.0);
    assert.equal(encode({ type: 'UNKNOWN', size: 'UNKNOWN', prompt: '' })[BIAS_IDX], 1.0);
  });
});

describe('encode() — taskType one-hot', () => {
  for (let i = 0; i < TASK_TYPES.length; i++) {
    const t = TASK_TYPES[i];
    test(`${t} → index ${TYPE_OFFSET + i} が 1.0、他が 0.0`, () => {
      const vec = encode({ type: t });
      assert.equal(vec[TYPE_OFFSET + i], 1.0);
      for (let j = 0; j < TASK_TYPES.length; j++) {
        if (j !== i) assert.equal(vec[TYPE_OFFSET + j], 0.0);
      }
    });
  }

  test('小文字でも正しく one-hot される', () => {
    const v1 = encode({ type: 'IMPLEMENT' });
    const v2 = encode({ type: 'implement' });
    assert.deepEqual(Array.from(v1.slice(0, TASK_TYPES.length)),
                     Array.from(v2.slice(0, TASK_TYPES.length)));
  });

  test('未知タイプ → type ブロック全て 0.0', () => {
    const vec = encode({ type: 'UNKNOWN_TYPE' });
    for (let i = 0; i < TASK_TYPES.length; i++) {
      assert.equal(vec[TYPE_OFFSET + i], 0.0);
    }
  });
});

describe('encode() — taskSize one-hot', () => {
  for (let i = 0; i < TASK_SIZES.length; i++) {
    const s = TASK_SIZES[i];
    test(`${s} → index ${SIZE_OFFSET + i} が 1.0、他が 0.0`, () => {
      const vec = encode({ size: s });
      assert.equal(vec[SIZE_OFFSET + i], 1.0);
      for (let j = 0; j < TASK_SIZES.length; j++) {
        if (j !== i) assert.equal(vec[SIZE_OFFSET + j], 0.0);
      }
    });
  }

  test('未知サイズ → size ブロック全て 0.0', () => {
    const vec = encode({ size: 'GIANT' });
    for (let i = 0; i < TASK_SIZES.length; i++) {
      assert.equal(vec[SIZE_OFFSET + i], 0.0);
    }
  });
});

describe('encode() — プロンプトシグナル', () => {
  const sigPatterns = [
    { name: 'sig_auth',   prompt: '認証処理を実装する',    idx: 0 },
    { name: 'sig_delete', prompt: 'データを削除する',      idx: 1 },
    { name: 'sig_prod',   prompt: '本番環境へdeployする', idx: 2 },
    { name: 'sig_db',     prompt: 'databaseのmigration',  idx: 3 },
    { name: 'sig_test',   prompt: 'テストを追加する',      idx: 4 },
    { name: 'sig_backup', prompt: 'バックアップを作成',    idx: 5 },
    { name: 'sig_small',  prompt: '小さく実装する',        idx: 6 },
    { name: 'sig_docs',   prompt: 'ドキュメントを更新',    idx: 7 },
  ];

  for (const { name, prompt, idx } of sigPatterns) {
    test(`${name}: 一致するプロンプト → 1.0`, () => {
      const vec = encode({ prompt });
      assert.equal(vec[SIG_OFFSET + idx], 1.0, `${name} が検出されなかった`);
    });
  }

  test('無関係なプロンプト → シグナル全て 0.0', () => {
    const vec = encode({ prompt: 'タスクを完了する' });
    for (let i = 0; i < PROMPT_SIGNALS.length; i++) {
      assert.equal(vec[SIG_OFFSET + i], 0.0, `${PROMPT_SIGNALS[i].name} が誤検出`);
    }
  });

  test('複数シグナルが同時に検出される', () => {
    const vec = encode({ prompt: '認証とデータベースのmigration' });
    assert.equal(vec[SIG_OFFSET + 0], 1.0); // sig_auth
    assert.equal(vec[SIG_OFFSET + 3], 1.0); // sig_db
  });
});

describe('encode() — prompt_len_norm', () => {
  test('空文字 → 0.0', () => {
    assert.equal(encode({ prompt: '' })[PLEN_IDX], 0.0);
  });

  test('500文字 → 1.0', () => {
    assert.equal(encode({ prompt: 'a'.repeat(500) })[PLEN_IDX], 1.0);
  });

  test('500文字超 → 1.0（上限クリップ）', () => {
    assert.equal(encode({ prompt: 'a'.repeat(2000) })[PLEN_IDX], 1.0);
  });

  test('250文字 → ~0.5', () => {
    const v = encode({ prompt: 'a'.repeat(250) })[PLEN_IDX];
    assert.ok(Math.abs(v - 0.5) < 0.01, `got ${v}`);
  });
});

describe('encode() — 時刻・曜日サイクリック', () => {
  test('hour_sin² + hour_cos² ≈ 1（単位円上）', () => {
    const vec = encode({ createdAt: '2026-01-15T14:30:00Z' });
    const sq = vec[HOUR_SIN_IDX] ** 2 + vec[HOUR_COS_IDX] ** 2;
    assert.ok(Math.abs(sq - 1.0) < 1e-9, `sq = ${sq}`);
  });

  test('dow_sin² + dow_cos² ≈ 1（単位円上）', () => {
    const vec = encode({ createdAt: '2026-01-15T14:30:00Z' }); // Thursday
    const sq = vec[DOW_SIN_IDX] ** 2 + vec[DOW_COS_IDX] ** 2;
    assert.ok(Math.abs(sq - 1.0) < 1e-9, `sq = ${sq}`);
  });
});

describe('encode() — recency_norm', () => {
  test('今日の updatedAt → 1.0 近傍', () => {
    const now = new Date().toISOString();
    const v = encode({ updatedAt: now })[RECENCY_IDX];
    assert.ok(v > 0.99, `got ${v}`);
  });

  test('91日前 → 0.0（下限クリップ）', () => {
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    assert.equal(encode({ updatedAt: old })[RECENCY_IDX], 0.0);
  });

  test('45日前 → ~0.5', () => {
    const mid = new Date(Date.now() - 45 * 86400_000).toISOString();
    const v = encode({ updatedAt: mid })[RECENCY_IDX];
    assert.ok(v > 0.4 && v < 0.6, `got ${v}`);
  });

  test('updatedAt なし createdAt あり → createdAt を使う', () => {
    const now = new Date().toISOString();
    const v = encode({ createdAt: now })[RECENCY_IDX];
    assert.ok(v > 0.99);
  });

  test('どちらもなし → 0.5（デフォルト）', () => {
    assert.equal(encode({})[RECENCY_IDX], 0.5);
  });
});

describe('describe()', () => {
  test('非ゼロ要素を含む文字列を返す', () => {
    const vec = encode({ type: 'IMPLEMENT', size: 'MEDIUM', prompt: 'test' });
    const result = describeVec(vec);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  test('type_IMPLEMENT を含む', () => {
    const vec = encode({ type: 'IMPLEMENT' });
    assert.ok(describeVec(vec).includes('type_IMPLEMENT'));
  });

  test('bias=1.000 を含む', () => {
    const vec = encode({});
    assert.ok(describeVec(vec).includes('bias=1.000'));
  });
});
