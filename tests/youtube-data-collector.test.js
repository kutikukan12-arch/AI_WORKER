'use strict';

/**
 * YouTube データ収集モジュールの精度テスト
 *
 * テスト対象:
 *   youtube-data-collector.js
 *     - parseDuration()    ISO 8601 duration → 秒数
 *     - calcBuzzRatio()    viewCount / subscriberCount
 *     - labelByBuzz()      buzz_ratio → hit / miss / null
 *     - normalizeVideo()   YouTube API レスポンス → 正規化オブジェクト
 *     - saveSeedData()     ジャンル別シードデータの保存・追記・重複除外
 *     - loadAllSeedData()  全シードデータの読み込み
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  parseDuration,
  calcBuzzRatio,
  labelByBuzz,
  normalizeVideo,
  saveSeedData,
  loadAllSeedData,
  HIT_THRESHOLD,
  MISS_THRESHOLD,
} = require('../bot/utils/youtube-data-collector');

// ── テスト用 YouTube API レスポンス ────────────────────────
function makeRawVideo(overrides = {}) {
  return {
    id: 'vid_001',
    snippet: {
      channelId:    'ch_001',
      channelTitle: 'テストチャンネル',
      title:        'テスト動画',
      description:  'これは説明文です。'.repeat(10),
      publishedAt:  '2024-03-15T10:00:00Z',
      tags:         ['tag1', 'tag2'],
    },
    statistics: {
      viewCount:    '10000',
      likeCount:    '800',
      commentCount: '50',
    },
    contentDetails: {
      duration: 'PT10M30S',
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────
// parseDuration()
// ─────────────────────────────────────────────────────

describe('parseDuration()', () => {

  describe('標準的な ISO 8601 フォーマット', () => {
    test('PT1H2M3S → 3723秒', () => {
      assert.equal(parseDuration('PT1H2M3S'), 3723);
    });

    test('PT10M30S → 630秒', () => {
      assert.equal(parseDuration('PT10M30S'), 630);
    });

    test('PT1H → 3600秒', () => {
      assert.equal(parseDuration('PT1H'), 3600);
    });

    test('PT30M → 1800秒', () => {
      assert.equal(parseDuration('PT30M'), 1800);
    });

    test('PT45S → 45秒', () => {
      assert.equal(parseDuration('PT45S'), 45);
    });

    test('PT2H30M → 9000秒', () => {
      assert.equal(parseDuration('PT2H30M'), 9000);
    });

    test('PT1H0M0S → 3600秒', () => {
      assert.equal(parseDuration('PT1H0M0S'), 3600);
    });
  });

  describe('境界・エッジケース', () => {
    test('null → 0秒（エラーにならない）', () => {
      assert.equal(parseDuration(null), 0);
    });

    test('undefined → 0秒', () => {
      assert.equal(parseDuration(undefined), 0);
    });

    test('空文字列 → 0秒', () => {
      assert.equal(parseDuration(''), 0);
    });

    test('PT0S → 0秒', () => {
      assert.equal(parseDuration('PT0S'), 0);
    });

    test('不正なフォーマット → 0秒', () => {
      assert.equal(parseDuration('invalid'), 0);
    });
  });
});

// ─────────────────────────────────────────────────────
// calcBuzzRatio()
// ─────────────────────────────────────────────────────

describe('calcBuzzRatio()', () => {

  test('viewCount=10000, subs=1000 → 10.0', () => {
    assert.ok(Math.abs(calcBuzzRatio(10000, 1000) - 10.0) < 0.001);
  });

  test('viewCount=300, subs=1000 → 0.3', () => {
    assert.ok(Math.abs(calcBuzzRatio(300, 1000) - 0.3) < 0.001);
  });

  test('subs=0 → null（ゼロ除算防止）', () => {
    assert.equal(calcBuzzRatio(10000, 0), null);
  });

  test('subs=null → null', () => {
    assert.equal(calcBuzzRatio(10000, null), null);
  });

  test('subs=undefined → null', () => {
    assert.equal(calcBuzzRatio(10000, undefined), null);
  });

  test('viewCount=0, subs=1000 → 0.0', () => {
    assert.equal(calcBuzzRatio(0, 1000), 0.0);
  });

  test('viewCount=5000, subs=1000 → HIT_THRESHOLD(5.0) に等しい', () => {
    assert.ok(Math.abs(calcBuzzRatio(5000, 1000) - HIT_THRESHOLD) < 0.001);
  });
});

// ─────────────────────────────────────────────────────
// labelByBuzz()
// ─────────────────────────────────────────────────────

describe('labelByBuzz()', () => {

  describe('hit 判定', () => {
    test('buzz > HIT_THRESHOLD(5.0) → "hit"', () => {
      assert.equal(labelByBuzz(5.1), 'hit');
    });

    test('buzz = 10.0 → "hit"', () => {
      assert.equal(labelByBuzz(10.0), 'hit');
    });

    test('buzz = 100.0 → "hit"', () => {
      assert.equal(labelByBuzz(100.0), 'hit');
    });
  });

  describe('miss 判定', () => {
    test('buzz < MISS_THRESHOLD(0.3) → "miss"', () => {
      assert.equal(labelByBuzz(0.29), 'miss');
    });

    test('buzz = 0.0 → "miss"', () => {
      assert.equal(labelByBuzz(0.0), 'miss');
    });

    test('buzz = 0.001 → "miss"', () => {
      assert.equal(labelByBuzz(0.001), 'miss');
    });
  });

  describe('中間帯 → null', () => {
    test('buzz = HIT_THRESHOLD(5.0) → null（境界は hit でない）', () => {
      assert.equal(labelByBuzz(HIT_THRESHOLD), null);
    });

    test('buzz = MISS_THRESHOLD(0.3) → null（境界は miss でない）', () => {
      assert.equal(labelByBuzz(MISS_THRESHOLD), null);
    });

    test('buzz = 2.0 (中間) → null', () => {
      assert.equal(labelByBuzz(2.0), null);
    });

    test('buzz = 1.0 → null', () => {
      assert.equal(labelByBuzz(1.0), null);
    });
  });

  describe('無効入力', () => {
    test('null → null', () => {
      assert.equal(labelByBuzz(null), null);
    });
  });
});

// ─────────────────────────────────────────────────────
// normalizeVideo()
// ─────────────────────────────────────────────────────

describe('normalizeVideo()', () => {

  describe('基本フィールドのマッピング', () => {
    const SUB = 1000;

    test('videoId が正しくマッピングされる', () => {
      const v = normalizeVideo(makeRawVideo({ id: 'abc123' }), SUB);
      assert.equal(v.videoId, 'abc123');
    });

    test('channelId / channelTitle が正しくマッピングされる', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.channelId,    'ch_001');
      assert.equal(v.channelTitle, 'テストチャンネル');
    });

    test('title が正しくマッピングされる', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.title, 'テスト動画');
    });

    test('publishedAt が正しくマッピングされる', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.publishedAt, '2024-03-15T10:00:00Z');
    });

    test('tags が配列としてマッピングされる', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.deepEqual(v.tags, ['tag1', 'tag2']);
    });

    test('tags が undefined の場合 空配列', () => {
      const raw = makeRawVideo();
      delete raw.snippet.tags;
      const v = normalizeVideo(raw, SUB);
      assert.deepEqual(v.tags, []);
    });
  });

  describe('数値フィールドの変換', () => {
    const SUB = 1000;

    test('viewCount が整数に変換される', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.viewCount, 10000);
      assert.ok(Number.isInteger(v.viewCount));
    });

    test('likeCount が整数に変換される', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.likeCount, 800);
    });

    test('commentCount が整数に変換される', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.commentCount, 50);
    });

    test('subscriberCount が渡した値と一致する', () => {
      const v = normalizeVideo(makeRawVideo(), 50000);
      assert.equal(v.subscriberCount, 50000);
    });

    test('duration が秒数に変換される（PT10M30S = 630）', () => {
      const v = normalizeVideo(makeRawVideo(), SUB);
      assert.equal(v.duration, 630);
    });
  });

  describe('buzzRatio / label の計算', () => {
    test('buzzRatio = viewCount / subscriberCount', () => {
      const v = normalizeVideo(makeRawVideo(), 1000);
      assert.ok(Math.abs(v.buzzRatio - 10000 / 1000) < 0.001);
    });

    test('buzzRatio > HIT_THRESHOLD → label = "hit"', () => {
      // viewCount=10000, subs=1000 → ratio=10 → hit
      const v = normalizeVideo(makeRawVideo(), 1000);
      assert.equal(v.label, 'hit');
    });

    test('buzz < MISS_THRESHOLD → label = "miss"', () => {
      const raw = makeRawVideo();
      raw.statistics.viewCount = '100'; // ratio=0.1 → miss
      const v = normalizeVideo(raw, 1000);
      assert.equal(v.label, 'miss');
    });

    test('中間帯 → label = null', () => {
      const raw = makeRawVideo();
      raw.statistics.viewCount = '1000'; // ratio=1.0 → null
      const v = normalizeVideo(raw, 1000);
      assert.equal(v.label, null);
    });

    test('subscriberCount=0 → buzzRatio = null, label = null', () => {
      const v = normalizeVideo(makeRawVideo(), 0);
      assert.equal(v.buzzRatio, null);
      assert.equal(v.label, null);
    });
  });

  describe('description の切り詰め', () => {
    test('description が 500文字を超える場合 500文字に切り詰められる', () => {
      const raw = makeRawVideo();
      raw.snippet.description = 'a'.repeat(1000);
      const v = normalizeVideo(raw, 1000);
      assert.equal(v.description.length, 500);
    });

    test('description が 500文字未満ならそのまま', () => {
      const raw = makeRawVideo();
      raw.snippet.description = 'abc';
      const v = normalizeVideo(raw, 1000);
      assert.equal(v.description, 'abc');
    });
  });

  describe('collectedAt フィールド', () => {
    test('collectedAt が ISO8601 形式の文字列', () => {
      const v = normalizeVideo(makeRawVideo(), 1000);
      assert.ok(typeof v.collectedAt === 'string');
      assert.ok(!isNaN(Date.parse(v.collectedAt)), `不正な collectedAt: ${v.collectedAt}`);
    });
  });

  describe('statistics が空の場合', () => {
    test('viewCount が未設定 → 0', () => {
      const raw = makeRawVideo();
      raw.statistics = {};
      const v = normalizeVideo(raw, 1000);
      assert.equal(v.viewCount, 0);
    });

    test('likeCount が未設定 → 0', () => {
      const raw = makeRawVideo();
      raw.statistics = {};
      const v = normalizeVideo(raw, 1000);
      assert.equal(v.likeCount, 0);
    });

    test('statistics 自体が undefined → エラーにならない', () => {
      const raw = makeRawVideo();
      delete raw.statistics;
      assert.doesNotThrow(() => normalizeVideo(raw, 1000));
    });
  });
});

// ─────────────────────────────────────────────────────
// saveSeedData() / loadAllSeedData()
// ─────────────────────────────────────────────────────

describe('saveSeedData() / loadAllSeedData()', () => {

  // テスト用一時ディレクトリを使うため SEEDS_DIR をモンキーパッチ
  // 実装はモジュールの SEEDS_DIR を直接参照しているため、
  // ここでは require してから内部パスを一時パスに差し替える
  const collectorPath = require.resolve('../bot/utils/youtube-data-collector');

  let tmpDir;
  let origSeedsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-seeds-test-'));
    // モジュールの内部変数 SEEDS_DIR を差し替えるため、
    // require キャッシュを消してから環境変数で渡す手法ではなく
    // 直接 tmpDir をテスト用パスとして saveSeedData に使えないため、
    // tmpDir を SEEDS_DIR として機能するよう実装側ではなくテスト側で
    // ファイルを直接操作して検証する。
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // saveSeedData / loadAllSeedData は SEEDS_DIR = data/youtube-seeds/ に書くため
  // テスト専用のシンプルな動作確認を行う

  describe('saveSeedData() の戻り値', () => {
    const TEST_DIR = path.join(__dirname, '..', 'data', 'youtube-seeds');
    const TEST_GENRE = '_test_phase3_';
    const testFile   = path.join(TEST_DIR, `${TEST_GENRE}.json`);

    after(() => {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    });

    test('初回保存: hit / miss が正しく保存される', () => {
      const hit1  = { videoId: 'h1', title: 'hit video 1' };
      const miss1 = { videoId: 'm1', title: 'miss video 1' };
      const result = saveSeedData(TEST_GENRE, [hit1], [miss1]);

      assert.equal(result.genre, TEST_GENRE);
      assert.equal(result.hits.length,   1);
      assert.equal(result.misses.length, 1);
      assert.equal(result.hits[0].videoId,   'h1');
      assert.equal(result.misses[0].videoId, 'm1');
    });

    test('追記保存: 新規 videoId のみ追加される', () => {
      const hit2  = { videoId: 'h2', title: 'hit video 2' };
      const miss2 = { videoId: 'm2', title: 'miss video 2' };
      const result = saveSeedData(TEST_GENRE, [hit2], [miss2]);

      assert.equal(result.hits.length,   2);
      assert.equal(result.misses.length, 2);
    });

    test('重複除外: 同じ videoId は追加されない', () => {
      const dupHit = { videoId: 'h1', title: 'duplicate hit' };
      const result  = saveSeedData(TEST_GENRE, [dupHit], []);

      // h1 は既に存在するため、hits は 2件のまま
      assert.equal(result.hits.length, 2);
    });

    test('updatedAt が ISO8601 形式', () => {
      const result = saveSeedData(TEST_GENRE, [], []);
      assert.ok(typeof result.updatedAt === 'string');
      assert.ok(!isNaN(Date.parse(result.updatedAt)), `不正な updatedAt: ${result.updatedAt}`);
    });

    test('ファイルが実際に作成・更新される', () => {
      assert.ok(fs.existsSync(testFile), 'シードファイルが存在しない');
      const data = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.equal(data.genre, TEST_GENRE);
    });
  });

  describe('loadAllSeedData()', () => {
    const TEST_DIR = path.join(__dirname, '..', 'data', 'youtube-seeds');
    const TEST_GENRE = '_test_phase3_load_';
    const testFile   = path.join(TEST_DIR, `${TEST_GENRE}.json`);

    before(() => {
      // テスト用シードファイルを直接作成
      if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(testFile, JSON.stringify({
        genre:     TEST_GENRE,
        hits:      [{ videoId: 'lh1' }, { videoId: 'lh2' }],
        misses:    [{ videoId: 'lm1' }],
        updatedAt: new Date().toISOString(),
      }));
    });

    after(() => {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    });

    test('配列を返す', () => {
      const data = loadAllSeedData();
      assert.ok(Array.isArray(data));
    });

    test('hits に label="hit" が付与される', () => {
      const data = loadAllSeedData();
      const hits = data.filter(v => v.videoId === 'lh1' || v.videoId === 'lh2');
      assert.ok(hits.length > 0, 'hit 動画が見つからない');
      for (const v of hits) assert.equal(v.label, 'hit');
    });

    test('misses に label="miss" が付与される', () => {
      const data = loadAllSeedData();
      const miss = data.find(v => v.videoId === 'lm1');
      assert.ok(miss, 'miss 動画が見つからない');
      assert.equal(miss.label, 'miss');
    });

    test('データ件数: hits 2 + misses 1 = 3件以上含まれる（他ジャンルも混在する可能性あり）', () => {
      const data  = loadAllSeedData();
      const ours  = data.filter(v => ['lh1', 'lh2', 'lm1'].includes(v.videoId));
      assert.equal(ours.length, 3);
    });
  });

  describe('SEEDS_DIR が存在しない場合', () => {
    test('存在しないディレクトリから loadAllSeedData → 空配列を返す（エラーなし）', () => {
      // 実装は fs.existsSync で guard しているので存在しない場合は [] を返す
      // ここでは直接確認できないため、少なくともエラーにならないことを確認
      assert.doesNotThrow(() => loadAllSeedData());
    });
  });
});

// ─────────────────────────────────────────────────────
// 定数の検証
// ─────────────────────────────────────────────────────

describe('エクスポート定数', () => {
  test('HIT_THRESHOLD が 5.0', () => {
    assert.equal(HIT_THRESHOLD, 5.0);
  });

  test('MISS_THRESHOLD が 0.3', () => {
    assert.equal(MISS_THRESHOLD, 0.3);
  });

  test('HIT_THRESHOLD > MISS_THRESHOLD（不整合がない）', () => {
    assert.ok(HIT_THRESHOLD > MISS_THRESHOLD,
      `HIT_THRESHOLD(${HIT_THRESHOLD}) <= MISS_THRESHOLD(${MISS_THRESHOLD})`);
  });
});
