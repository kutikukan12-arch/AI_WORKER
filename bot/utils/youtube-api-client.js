'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const BASE_URL   = 'https://www.googleapis.com/youtube/v3';
const QUOTA_FILE = path.join(__dirname, '..', '..', 'data', 'youtube-quota.json');
const DAILY_LIMIT = 10000;

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _loadQuota() {
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const q = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
      if (q.date === _today()) return q;
    }
  } catch (e) {
    logger.warn(`[YouTube] quota load error: ${e.message}`);
  }
  return { date: _today(), used: 0 };
}

function _saveQuota(q) {
  try {
    const dir = path.dirname(QUOTA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(q, null, 2));
  } catch (e) {
    logger.warn(`[YouTube] quota save error: ${e.message}`);
  }
}

const REQUEST_TIMEOUT_MS = 30000;

function _classifyApiError(code, message) {
  if (code === 403 && /quota/i.test(message)) {
    return `YouTube API クォータ上限超過（本日 ${DAILY_LIMIT} ユニット使用済み）。明日以降に再試行してください。`;
  }
  if (code === 403) {
    return `YouTube API キー認証エラー（403）。.env の YOUTUBE_API_KEY を確認してください。`;
  }
  if (code === 400) {
    return `YouTube API 入力エラー（400）: ${String(message).slice(0, 100)} — 動画 ID や引数を確認してください。`;
  }
  if (code === 404) {
    return `YouTube API リソース未発見（404）。動画 ID・チャンネル ID が正しいか確認してください。`;
  }
  return `YouTube API エラー ${code}: ${message}`;
}

function _request(apiKey, endpoint, params) {
  const qs  = new URLSearchParams({ ...params, key: apiKey }).toString();
  const url = `${BASE_URL}/${endpoint}?${qs}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) {
            reject(new Error(_classifyApiError(data.error.code, data.error.message)));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(new Error(`YouTube API レスポンス解析エラー: ${e.message}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(
        `YouTube API タイムアウト: ${REQUEST_TIMEOUT_MS / 1000}秒 以内に応答がありませんでした。` +
        `ネットワーク接続を確認してから再試行してください。`
      ));
    });

    req.on('error', (err) => {
      if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
        reject(new Error(
          `YouTube API タイムアウト: 接続がタイムアウトしました。ネットワーク接続を確認してください。`
        ));
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        reject(new Error(
          `YouTube API 接続失敗（${err.code}）: ネットワーク接続または DNS を確認してください。`
        ));
      } else {
        reject(err);
      }
    });
  });
}

class YouTubeApiClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('YOUTUBE_API_KEY が必要です');
    this.apiKey = apiKey;
  }

  _useQuota(cost) {
    const q = _loadQuota();
    if (q.used + cost > DAILY_LIMIT) {
      throw new Error(`YouTube クォータ超過 (使用済み: ${q.used}/${DAILY_LIMIT} units)`);
    }
    q.used += cost;
    _saveQuota(q);
    logger.debug(`[YouTube] quota +${cost} → ${q.used}/${DAILY_LIMIT}`);
    return q;
  }

  getQuotaStatus() {
    return _loadQuota();
  }

  // search.list — 100 units/call
  async searchVideos(query, opts = {}) {
    this._useQuota(100);
    const params = {
      part:              'snippet',
      q:                 query,
      type:              'video',
      order:             opts.order             || 'viewCount',
      maxResults:        opts.maxResults        || 50,
      regionCode:        opts.regionCode        || 'JP',
      relevanceLanguage: opts.language          || 'ja',
    };
    if (opts.pageToken)      params.pageToken      = opts.pageToken;
    if (opts.channelId)      params.channelId      = opts.channelId;
    if (opts.publishedBefore) params.publishedBefore = opts.publishedBefore;
    if (opts.publishedAfter)  params.publishedAfter  = opts.publishedAfter;

    return _request(this.apiKey, 'search', params);
  }

  // videos.list — 1 unit per call (≤50 IDs/call)
  async getVideoDetails(videoIds) {
    const ids = Array.isArray(videoIds) ? videoIds : [videoIds];
    const results = [];

    for (let i = 0; i < ids.length; i += 50) {
      this._useQuota(1);
      const data = await _request(this.apiKey, 'videos', {
        part: 'snippet,statistics,contentDetails',
        id:   ids.slice(i, i + 50).join(','),
      });
      results.push(...(data.items || []));
    }
    return results;
  }

  // channels.list — 1 unit per call
  async getChannelInfo(channelIds) {
    const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
    this._useQuota(1);
    return _request(this.apiKey, 'channels', {
      part: 'snippet,statistics,contentDetails',
      id:   ids.join(','),
    });
  }

  // playlistItems.list — 1 unit per page
  async getChannelUploads(playlistId, opts = {}) {
    this._useQuota(1);
    const params = {
      part:       'snippet,contentDetails',
      playlistId,
      maxResults: opts.maxResults || 50,
    };
    if (opts.pageToken) params.pageToken = opts.pageToken;
    return _request(this.apiKey, 'playlistItems', params);
  }

  // channels.list → uploadsPlaylistId + subscriberCount
  // hiddenSubscriberCount チャンネルはエラーをスロー（buzz_ratio 計算不可）
  async getUploadsPlaylistId(channelId) {
    const data    = await this.getChannelInfo([channelId]);
    const channel = (data.items || [])[0];
    if (!channel) throw new Error(`チャンネル未発見: ${channelId}`);
    if (channel.statistics?.hiddenSubscriberCount) {
      throw new Error(`登録者数非公開: ${channelId}`);
    }
    return {
      uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
      subscriberCount:   parseInt(channel.statistics?.subscriberCount || '0', 10),
      channelTitle:      channel.snippet?.title || channelId,
    };
  }
}

module.exports = YouTubeApiClient;
