'use strict';

/**
 * youtube-seed-presets.js のテスト
 *
 * テスト対象（APIキー不要・純粋関数）:
 *   - GENRE_PRESETS   — ジャンルプリセット構造の整合性
 *   - estimateQuotaForGenre()  — 1ジャンル分のクォータ見積もり
 *   - estimateTotalQuota()     — 全ジャンル合計のクォータ見積もり
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  GENRE_PRESETS,
  estimateQuotaForGenre,
  estimateTotalQuota,
} = require('../bot/utils/youtube-seed-presets');

// ─────────────────────────────────────────────────────
// GENRE_PRESETS 構造検証
// ─────────────────────────────────────────────────────

describe('GENRE_PRESETS 構造', () => {

  test('オブジェクトが存在する', () => {
    assert.ok(typeof GENRE_PRESETS === 'object' && GENRE_PRESETS !== null);
  });

  test('1つ以上のジャンルが登録されている', () => {
    assert.ok(Object.keys(GENRE_PRESETS).length >= 1, 'ジャンルが0件');
  });

  test('既知ジャンル (vtuber / gaming / cooking / music / education) が存在する', () => {
    const expected = ['vtuber', 'gaming', 'cooking', 'music', 'education'];
    for (const genre of expected) {
      assert.ok(genre in GENRE_PRESETS, `ジャンル "${genre}" が存在しない`);
    }
  });

  for (const [key, preset] of Object.entries(GENRE_PRESETS)) {
    describe(`ジャンル "${key}"`, () => {

      test('label フィールドが非空文字列', () => {
        assert.ok(typeof preset.label === 'string' && preset.label.length > 0,
          `label=${JSON.stringify(preset.label)}`);
      });

      test('queries フィールドが配列', () => {
        assert.ok(Array.isArray(preset.queries), 'queries が配列でない');
      });

      test('queries が 1件以上', () => {
        assert.ok(preset.queries.length >= 1, `queries.length=${preset.queries.length}`);
      });

      test('queries の各要素が非空文字列', () => {
        for (const q of preset.queries) {
          assert.ok(typeof q === 'string' && q.length > 0, `空クエリ: ${JSON.stringify(q)}`);
        }
      });

      test('hitLimitPerQuery が正の整数', () => {
        assert.ok(
          Number.isInteger(preset.hitLimitPerQuery) && preset.hitLimitPerQuery > 0,
          `hitLimitPerQuery=${preset.hitLimitPerQuery}`
        );
      });

      test('missChannelsMax が正の整数', () => {
        assert.ok(
          Number.isInteger(preset.missChannelsMax) && preset.missChannelsMax > 0,
          `missChannelsMax=${preset.missChannelsMax}`
        );
      });

      test('missPerChannel が正の整数', () => {
        assert.ok(
          Number.isInteger(preset.missPerChannel) && preset.missPerChannel > 0,
          `missPerChannel=${preset.missPerChannel}`
        );
      });
    });
  }
});

// ─────────────────────────────────────────────────────
// estimateQuotaForGenre()
// ─────────────────────────────────────────────────────

describe('estimateQuotaForGenre()', () => {

  test('戻り値が正の整数', () => {
    const preset = GENRE_PRESETS.vtuber;
    const quota  = estimateQuotaForGenre(preset);
    assert.ok(Number.isInteger(quota) && quota > 0, `quota=${quota}`);
  });

  test('全ジャンルで正の整数を返す', () => {
    for (const [key, preset] of Object.entries(GENRE_PRESETS)) {
      const quota = estimateQuotaForGenre(preset);
      assert.ok(
        Number.isInteger(quota) && quota > 0,
        `ジャンル "${key}": quota=${quota}`
      );
    }
  });

  test('クエリ数が多いほどクォータが大きい（単調性）', () => {
    const few  = estimateQuotaForGenre({ queries: ['q1'],       hitLimitPerQuery: 100, missChannelsMax: 10, missPerChannel: 30 });
    const many = estimateQuotaForGenre({ queries: ['q1', 'q2'], hitLimitPerQuery: 100, missChannelsMax: 10, missPerChannel: 30 });
    assert.ok(many > few, `many(${many}) <= few(${few})`);
  });

  test('search.list が支配的コスト: quota は 200 * queries.length 以上', () => {
    // search.list = 100 units/call × 2 pages = 200 units/query (最低コスト)
    const preset = { queries: ['q1', 'q2', 'q3'], hitLimitPerQuery: 100, missChannelsMax: 10, missPerChannel: 1 };
    const quota  = estimateQuotaForGenre(preset);
    assert.ok(quota >= 200 * preset.queries.length, `quota(${quota}) < search最低コスト(${200 * preset.queries.length})`);
  });

  test('日次上限 (10000) を超えない現実的なジャンル設定', () => {
    // 各ジャンルのクォータが DAILY_LIMIT / ジャンル数 以下であれば全ジャンル一括収集できる
    const genres = Object.entries(GENRE_PRESETS);
    for (const [key, preset] of genres) {
      const quota = estimateQuotaForGenre(preset);
      assert.ok(quota < 10000, `ジャンル "${key}": quota(${quota}) >= DAILY_LIMIT(10000)`);
    }
  });
});

// ─────────────────────────────────────────────────────
// estimateTotalQuota()
// ─────────────────────────────────────────────────────

describe('estimateTotalQuota()', () => {

  test('戻り値が正の整数', () => {
    const total = estimateTotalQuota();
    assert.ok(Number.isInteger(total) && total > 0, `total=${total}`);
  });

  test('全ジャンルの estimateQuotaForGenre() の合計と一致する', () => {
    const expected = Object.values(GENRE_PRESETS).reduce(
      (sum, p) => sum + estimateQuotaForGenre(p), 0
    );
    assert.equal(estimateTotalQuota(), expected);
  });

  test('合計が各ジャンルの個別見積もりより大きい', () => {
    const total = estimateTotalQuota();
    for (const preset of Object.values(GENRE_PRESETS)) {
      const single = estimateQuotaForGenre(preset);
      assert.ok(total > single, `total(${total}) <= single genre(${single})`);
    }
  });

  test('日次上限 (10000) 内に収まる（全ジャンル一括収集が可能）', () => {
    const total = estimateTotalQuota();
    assert.ok(total < 10000,
      `全ジャンル合計 ${total} units が日次上限 10000 を超えている`);
  });
});
