'use strict';

// YouTube シードデータ収集用ジャンル別プリセット
//
// クォータ設計（YouTube Data API v3 日次上限: 10,000 units）:
//   search.list         100 units/call  ← 最大コスト
//   videos.list           1 unit/50 IDs
//   channels.list         1 unit/50 IDs
//   playlistItems.list    1 unit/page
//
// 1ジャンル・1クエリあたりのコスト概算:
//   search.list  × 2pages = 200 units
//   videos.list  × 2calls =   2 units
//   channels.list × 1call =   1 units
//   playlistItems × 3pages=   3 units
//   合計 ≈ 206 units/query
//
// 5ジャンル × 3クエリ = 15クエリ ≈ 3,090 units（日次上限の約31%）
// 全ジャンル一括収集でも余裕あり。

const GENRE_PRESETS = {
  vtuber: {
    label:          'VTuber・配信',
    queries: [
      'VTuber 歌ってみた',
      'VTuber 雑談配信 切り抜き',
      'にじさんじ ホロライブ 動画',
    ],
    hitLimitPerQuery:  100,
    missChannelsMax:   10,
    missPerChannel:    30,
  },
  gaming: {
    label:          'ゲーム実況',
    queries: [
      'ゲーム実況 初見プレイ',
      '縛りプレイ ゲーム実況',
      'マインクラフト 実況',
    ],
    hitLimitPerQuery:  100,
    missChannelsMax:   10,
    missPerChannel:    30,
  },
  cooking: {
    label:          '料理・グルメ',
    queries: [
      '簡単レシピ 料理 作り方',
      '食べてみた グルメ レビュー',
      '節約飯 一人暮らし 料理',
    ],
    hitLimitPerQuery:  100,
    missChannelsMax:   10,
    missPerChannel:    30,
  },
  music: {
    label:          '音楽・MV',
    queries: [
      'オリジナル曲 MV',
      '歌ってみた cover',
      '弾いてみた 演奏してみた',
    ],
    hitLimitPerQuery:  100,
    missChannelsMax:   10,
    missPerChannel:    30,
  },
  education: {
    label:          '教育・解説',
    queries: [
      '解説動画 わかりやすい',
      'プログラミング 入門 初心者',
      '英語 勉強法 学習',
    ],
    hitLimitPerQuery:  100,
    missChannelsMax:   10,
    missPerChannel:    30,
  },
};

// 1ジャンル分のクォータ消費を見積もる
// search.list が支配的コスト（100 units/call × 2pages per query）
function estimateQuotaForGenre(preset) {
  const qCount   = preset.queries.length;
  const hitLimit = preset.hitLimitPerQuery || 100;
  const maxCh    = preset.missChannelsMax || 10;

  const searchUnits   = qCount * 2 * 100;                        // 2 pages × 100 units
  const videoUnits    = qCount * Math.ceil(hitLimit / 50) * 1;   // videos.list batches
  const channelUnits  = qCount * 1 + Math.ceil(maxCh / 50) * 1; // channels.list
  const playlistUnits = maxCh * 3;                               // playlistItems pages
  return searchUnits + videoUnits + channelUnits + playlistUnits;
}

// 全ジャンル合計のクォータ見積もり
function estimateTotalQuota() {
  return Object.values(GENRE_PRESETS).reduce(
    (sum, p) => sum + estimateQuotaForGenre(p), 0
  );
}

module.exports = { GENRE_PRESETS, estimateQuotaForGenre, estimateTotalQuota };
