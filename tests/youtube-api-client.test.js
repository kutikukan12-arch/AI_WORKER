'use strict';

/**
 * youtube-api-client.js の APIキーなしテスト
 *
 * テスト対象（HTTP通信なし）:
 *   - コンストラクタ: APIキー必須バリデーション
 *   - getQuotaStatus(): クォータ状態の取得
 *   - _useQuota(): クォータ消費・超過検出
 *
 * 注意: searchVideos / getVideoDetails / getChannelInfo などの
 *       実際の API 呼び出しメソッドはここではテストしない（APIキー必要）。
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const YouTubeApiClient = require('../bot/utils/youtube-api-client');

const QUOTA_FILE = path.join(__dirname, '..', 'data', 'youtube-quota.json');
const QUOTA_BAK  = QUOTA_FILE + '.test-bak';

// ─────────────────────────────────────────────────────
// コンストラクタ
// ─────────────────────────────────────────────────────

describe('YouTubeApiClient コンストラクタ', () => {

  test('APIキーなし → Error("YOUTUBE_API_KEY が必要です") をスロー', () => {
    assert.throws(
      () => new YouTubeApiClient(),
      /YOUTUBE_API_KEY が必要です/
    );
  });

  test('空文字列 → Error をスロー', () => {
    assert.throws(() => new YouTubeApiClient(''));
  });

  test('null → Error をスロー', () => {
    assert.throws(() => new YouTubeApiClient(null));
  });

  test('undefined → Error をスロー', () => {
    assert.throws(() => new YouTubeApiClient(undefined));
  });

  test('有効なキー文字列 → インスタンスが生成される', () => {
    const client = new YouTubeApiClient('fake_api_key_for_test');
    assert.ok(client instanceof YouTubeApiClient);
  });

  test('生成されたインスタンスが apiKey プロパティを持つ', () => {
    const client = new YouTubeApiClient('test_key_abc');
    assert.equal(client.apiKey, 'test_key_abc');
  });
});

// ─────────────────────────────────────────────────────
// getQuotaStatus()
// ─────────────────────────────────────────────────────

describe('getQuotaStatus()', () => {

  before(() => {
    if (fs.existsSync(QUOTA_FILE)) fs.copyFileSync(QUOTA_FILE, QUOTA_BAK);
  });

  after(() => {
    if (fs.existsSync(QUOTA_BAK)) {
      fs.copyFileSync(QUOTA_BAK, QUOTA_FILE);
      fs.unlinkSync(QUOTA_BAK);
    }
  });

  const client = new YouTubeApiClient('fake_key');

  test('オブジェクトを返す', () => {
    const status = client.getQuotaStatus();
    assert.ok(typeof status === 'object' && status !== null);
  });

  test('date フィールドが YYYY-MM-DD 形式の文字列', () => {
    const { date } = client.getQuotaStatus();
    assert.ok(typeof date === 'string', `date が文字列でない: ${typeof date}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(date), `不正な date 形式: ${date}`);
  });

  test('used フィールドが 0 以上の整数', () => {
    const { used } = client.getQuotaStatus();
    assert.ok(Number.isInteger(used) && used >= 0, `used=${used}`);
  });

  test('date が今日の日付と一致する', () => {
    const today  = new Date().toISOString().slice(0, 10);
    const { date } = client.getQuotaStatus();
    assert.equal(date, today);
  });

  test('クォータファイルを削除しても getQuotaStatus() がエラーにならない', () => {
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
    assert.doesNotThrow(() => client.getQuotaStatus());
  });

  test('クォータファイルなし → used = 0', () => {
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
    const { used } = client.getQuotaStatus();
    assert.equal(used, 0);
  });
});

// ─────────────────────────────────────────────────────
// _useQuota() — クォータ消費・超過
// ─────────────────────────────────────────────────────

describe('_useQuota()', () => {

  before(() => {
    if (fs.existsSync(QUOTA_FILE)) fs.copyFileSync(QUOTA_FILE, QUOTA_BAK);
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
  });

  after(() => {
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
    if (fs.existsSync(QUOTA_BAK)) {
      fs.copyFileSync(QUOTA_BAK, QUOTA_FILE);
      fs.unlinkSync(QUOTA_BAK);
    }
  });

  const client = new YouTubeApiClient('fake_key');

  test('100 units 消費 → used が 100 増える', () => {
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
    client._useQuota(100);
    const { used } = client.getQuotaStatus();
    assert.equal(used, 100);
  });

  test('続けて 1 unit 消費 → used が 101', () => {
    client._useQuota(1);
    const { used } = client.getQuotaStatus();
    assert.equal(used, 101);
  });

  test('戻り値がオブジェクトで date / used を持つ', () => {
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
    const result = client._useQuota(50);
    assert.ok('date' in result, 'date がない');
    assert.ok('used' in result, 'used がない');
  });

  test('クォータ上限 (10000) を超える消費 → Error("YouTube クォータ超過") をスロー', () => {
    // 上限ギリギリの状態を書き込む
    const today = new Date().toISOString().slice(0, 10);
    const dir   = path.dirname(QUOTA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: today, used: 9999 }));

    assert.throws(
      () => client._useQuota(100),
      /YouTube クォータ超過/
    );
  });

  test('上限ちょうどの使用 (used=9900, cost=100) → エラーにならない', () => {
    const today = new Date().toISOString().slice(0, 10);
    const dir   = path.dirname(QUOTA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: today, used: 9900 }));

    assert.doesNotThrow(() => client._useQuota(100));
    const { used } = client.getQuotaStatus();
    assert.equal(used, 10000);
  });

  test('上限+1 (used=9900, cost=101) → Error をスロー', () => {
    const today = new Date().toISOString().slice(0, 10);
    const dir   = path.dirname(QUOTA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: today, used: 9900 }));

    assert.throws(() => client._useQuota(101), /YouTube クォータ超過/);
  });
});

// ─────────────────────────────────────────────────────
// クォータファイルが別の日付の場合のリセット確認
// ─────────────────────────────────────────────────────

describe('クォータ日次リセット', () => {

  before(() => {
    if (fs.existsSync(QUOTA_FILE)) fs.copyFileSync(QUOTA_FILE, QUOTA_BAK);
  });

  after(() => {
    if (fs.existsSync(QUOTA_FILE)) fs.unlinkSync(QUOTA_FILE);
    if (fs.existsSync(QUOTA_BAK)) {
      fs.copyFileSync(QUOTA_BAK, QUOTA_FILE);
      fs.unlinkSync(QUOTA_BAK);
    }
  });

  const client = new YouTubeApiClient('fake_key');

  test('昨日の日付のファイルがある → getQuotaStatus().used = 0 (リセット)', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dir = path.dirname(QUOTA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: yesterday, used: 5000 }));

    const { used } = client.getQuotaStatus();
    assert.equal(used, 0, `昨日のデータがリセットされていない: used=${used}`);
  });

  test('昨日の日付のファイルがある → getQuotaStatus().date が今日', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const today     = new Date().toISOString().slice(0, 10);
    const dir = path.dirname(QUOTA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: yesterday, used: 5000 }));

    const { date } = client.getQuotaStatus();
    assert.equal(date, today);
  });
});
