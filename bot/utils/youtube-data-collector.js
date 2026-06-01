'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const SEEDS_DIR    = path.join(__dirname, '..', '..', 'data', 'youtube-seeds');
const HIT_THRESHOLD  = 5.0;   // buzz_ratio > 5.0 → hit
const MISS_THRESHOLD = 0.3;   // buzz_ratio < 0.3 → miss

// ISO 8601 duration → seconds  (e.g. "PT1H2M3S" → 3723)
function parseDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function calcBuzzRatio(viewCount, subscriberCount) {
  if (!subscriberCount || subscriberCount === 0) return null;
  return viewCount / subscriberCount;
}

function labelByBuzz(buzzRatio) {
  if (buzzRatio === null) return null;
  if (buzzRatio > HIT_THRESHOLD)  return 'hit';
  if (buzzRatio < MISS_THRESHOLD) return 'miss';
  return null;
}

function normalizeVideo(v, subscriberCount) {
  const views    = parseInt(v.statistics?.viewCount    || '0', 10);
  const likes    = parseInt(v.statistics?.likeCount    || '0', 10);
  const comments = parseInt(v.statistics?.commentCount || '0', 10);
  const buzzRatio = calcBuzzRatio(views, subscriberCount);

  return {
    videoId:         v.id,
    channelId:       v.snippet?.channelId,
    channelTitle:    v.snippet?.channelTitle,
    title:           v.snippet?.title,
    description:     (v.snippet?.description || '').slice(0, 500),
    publishedAt:     v.snippet?.publishedAt,
    tags:            v.snippet?.tags || [],
    duration:        parseDuration(v.contentDetails?.duration),
    viewCount:       views,
    likeCount:       likes,
    commentCount:    comments,
    subscriberCount,
    buzzRatio,
    label:           labelByBuzz(buzzRatio),
    collectedAt:     new Date().toISOString(),
  };
}

// Phase2: hit 動画収集 — search.list(order=viewCount) で高再生数動画を取得
// publishedBefore: 30日前以上（再生数が安定したもの）
async function collectHitVideos(client, query, opts = {}) {
  const limit      = opts.limit || 100;
  const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const videos     = [];
  let   pageToken;

  while (videos.length < limit) {
    const res = await client.searchVideos(query, {
      order: 'viewCount', maxResults: 50,
      publishedBefore: cutoffDate, pageToken,
    });

    const videoIds = (res.items || []).map(it => it.id?.videoId).filter(Boolean);
    if (videoIds.length === 0) break;

    const details    = await client.getVideoDetails(videoIds);
    const channelIds = [...new Set(details.map(v => v.snippet?.channelId).filter(Boolean))];

    // チャンネル登録者数をバッチ取得
    const subMap = {};
    for (let i = 0; i < channelIds.length; i += 50) {
      const chRes = await client.getChannelInfo(channelIds.slice(i, i + 50));
      for (const ch of (chRes.items || [])) {
        if (!ch.statistics?.hiddenSubscriberCount) {
          subMap[ch.id] = parseInt(ch.statistics?.subscriberCount || '0', 10);
        }
      }
    }

    for (const v of details) {
      const sub  = subMap[v.snippet?.channelId];
      if (!sub) continue;
      const norm = normalizeVideo(v, sub);
      if (norm.label === 'hit') videos.push(norm);
      if (videos.length >= limit) break;
    }

    if (!res.nextPageToken || videos.length >= limit) break;
    pageToken = res.nextPageToken;
  }

  logger.info(`[Collector] collectHitVideos: query="${query}" → ${videos.length}件`);
  return videos;
}

// Phase2/3: miss 動画収集 — hit 動画のチャンネルの uploads プレイリストを走査
// hiddenSubscriberCount チャンネルはスキップ
async function collectMissFromChannels(client, channelIds, opts = {}) {
  const limitPerChannel = opts.limitPerChannel || 20;
  const maxChannels     = opts.maxChannels || 5;
  const videos          = [];

  for (const channelId of channelIds.slice(0, maxChannels)) {
    try {
      const { uploadsPlaylistId, subscriberCount } = await client.getUploadsPlaylistId(channelId);
      let   pageToken;
      let   collected = 0;

      while (collected < limitPerChannel) {
        const res      = await client.getChannelUploads(uploadsPlaylistId, { pageToken });
        const videoIds = (res.items || []).map(it => it.contentDetails?.videoId).filter(Boolean);
        if (videoIds.length === 0) break;

        const details = await client.getVideoDetails(videoIds);
        for (const v of details) {
          const norm = normalizeVideo(v, subscriberCount);
          if (norm.label === 'miss') {
            videos.push(norm);
            collected++;
          }
          if (collected >= limitPerChannel) break;
        }

        if (!res.nextPageToken || collected >= limitPerChannel) break;
        pageToken = res.nextPageToken;
      }
    } catch (e) {
      logger.warn(`[Collector] チャンネルスキップ ${channelId}: ${e.message}`);
    }
  }

  logger.info(`[Collector] collectMissFromChannels: ${channelIds.length}ch → ${videos.length}件`);
  return videos;
}

// genre 別シードデータをファイルに保存（重複除外・追記）
function saveSeedData(genre, hitVideos, missVideos) {
  if (!fs.existsSync(SEEDS_DIR)) fs.mkdirSync(SEEDS_DIR, { recursive: true });

  const file     = path.join(SEEDS_DIR, `${genre}.json`);
  const existing = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { genre, hits: [], misses: [], updatedAt: null };

  const seenHit  = new Set(existing.hits.map(v => v.videoId));
  const seenMiss = new Set(existing.misses.map(v => v.videoId));

  for (const v of hitVideos)  if (!seenHit.has(v.videoId))  existing.hits.push(v);
  for (const v of missVideos) if (!seenMiss.has(v.videoId)) existing.misses.push(v);

  existing.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));

  logger.info(`[Collector] saved ${genre}: hits=${existing.hits.length} misses=${existing.misses.length}`);
  return existing;
}

// 全ジャンルのシードデータを読み込んでフラット配列で返す
function loadAllSeedData() {
  if (!fs.existsSync(SEEDS_DIR)) return [];
  return fs.readdirSync(SEEDS_DIR)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8'));
        return [
          ...d.hits.map(v => ({ ...v, label: 'hit' })),
          ...d.misses.map(v => ({ ...v, label: 'miss' })),
        ];
      } catch {
        return [];
      }
    });
}

module.exports = {
  collectHitVideos,
  collectMissFromChannels,
  saveSeedData,
  loadAllSeedData,
  parseDuration,
  calcBuzzRatio,
  labelByBuzz,
  normalizeVideo,
  HIT_THRESHOLD,
  MISS_THRESHOLD,
};
