'use strict';

// YouTube シードデータ 一括収集スクリプト（CLI実行用）
//
// 使い方:
//   node scripts/youtube-seed-collect.js --genre=vtuber
//   node scripts/youtube-seed-collect.js --genres=vtuber,gaming
//   node scripts/youtube-seed-collect.js --all
//   node scripts/youtube-seed-collect.js --list          # プリセット一覧
//   node scripts/youtube-seed-collect.js --dry-run       # クォータ見積もりのみ
//
// 必要な環境変数:
//   YOUTUBE_API_KEY  — Google Cloud Console で YouTube Data API v3 を有効化して取得
//
// .env ファイルがあれば自動読み込み:
//   YOUTUBE_API_KEY=AIza...
//
// クォータ設計（日次上限: 10,000 units）:
//   1ジャンル(3クエリ) ≈ 620〜700 units
//   全5ジャンル一括   ≈ 3,100〜3,500 units （上限の約31%）
//   残りクォータは !youtube predict (URL解析) 等に余裕を持って充当可能

const fs   = require('fs');
const path = require('path');

// .env 読み込み（dotenv がなくても動作）
function loadDotenv() {
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotenv();

const YouTubeApiClient = require('../bot/utils/youtube-api-client');
const collector        = require('../bot/utils/youtube-data-collector');
const { GENRE_PRESETS, estimateQuotaForGenre, estimateTotalQuota } = require('../bot/utils/youtube-seed-presets');

// ─── CLI 引数パース ──────────────────────────────────────

const argv    = process.argv.slice(2);
const argMap  = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argMap[m[1]] = m[2] ?? true;
}

const isDryRun = !!argMap['dry-run'];
const isList   = !!argMap['list'];
const isAll    = !!argMap['all'];

let targetGenres = [];
if (isAll) {
  targetGenres = Object.keys(GENRE_PRESETS);
} else if (argMap['genres']) {
  targetGenres = String(argMap['genres']).split(',').map(g => g.trim()).filter(Boolean);
} else if (argMap['genre']) {
  targetGenres = [String(argMap['genre']).trim()];
}

// ─── プリセット一覧表示 ──────────────────────────────────

if (isList) {
  console.log('\nYouTube シードプリセット一覧\n');
  for (const [key, p] of Object.entries(GENRE_PRESETS)) {
    const q = estimateQuotaForGenre(p);
    console.log(`  ${key.padEnd(12)} ${p.label.padEnd(16)} クエリ${p.queries.length}件 ≈${q} units`);
    for (const query of p.queries) console.log(`    - "${query}"`);
  }
  console.log(`\n全ジャンル合計: ≈${estimateTotalQuota()} units (日次上限 10,000 units の ${Math.round(estimateTotalQuota()/100)}%)`);
  process.exit(0);
}

// ─── 引数バリデーション ──────────────────────────────────

if (targetGenres.length === 0) {
  console.error(
    'Usage:\n' +
    '  node scripts/youtube-seed-collect.js --genre=<genre>\n' +
    '  node scripts/youtube-seed-collect.js --genres=vtuber,gaming\n' +
    '  node scripts/youtube-seed-collect.js --all\n' +
    '  node scripts/youtube-seed-collect.js --list\n' +
    '  node scripts/youtube-seed-collect.js --dry-run --all\n'
  );
  process.exit(1);
}

for (const g of targetGenres) {
  if (!GENRE_PRESETS[g]) {
    console.error(`未知のジャンル: "${g}"\n利用可能: ${Object.keys(GENRE_PRESETS).join(', ')}`);
    process.exit(1);
  }
}

// ─── ドライラン ─────────────────────────────────────────

if (isDryRun) {
  console.log('\n[DRY-RUN] クォータ消費見積もり\n');
  let total = 0;
  for (const g of targetGenres) {
    const p = GENRE_PRESETS[g];
    const q = estimateQuotaForGenre(p);
    total += q;
    console.log(`  ${g}: ${p.label} — ≈${q} units (${p.queries.length}クエリ × hit${p.hitLimitPerQuery}件/query)`);
  }
  console.log(`\n  合計: ≈${total} units / 10,000 units`);
  process.exit(0);
}

// ─── 実行 ────────────────────────────────────────────────

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) {
  console.error('❌ YOUTUBE_API_KEY が未設定です。.env または環境変数に設定してください。');
  process.exit(1);
}

async function collectGenre(client, genreKey) {
  const preset = GENRE_PRESETS[genreKey];
  console.log(`\n▶ ジャンル: ${genreKey} (${preset.label})`);
  console.log(`  クエリ数: ${preset.queries.length}  hit上限: ${preset.hitLimitPerQuery}/query`);

  const allHits    = [];
  const allMissChIds = [];

  for (let i = 0; i < preset.queries.length; i++) {
    const query = preset.queries[i];
    console.log(`\n  [${i + 1}/${preset.queries.length}] "${query}" 収集中...`);

    try {
      const hits = await collector.collectHitVideos(client, query, {
        limit: preset.hitLimitPerQuery,
      });
      console.log(`    hit: ${hits.length}件`);

      for (const h of hits) {
        allHits.push(h);
        if (h.channelId && !allMissChIds.includes(h.channelId)) {
          allMissChIds.push(h.channelId);
        }
      }
    } catch (e) {
      console.warn(`    ⚠ クエリ失敗: ${e.message}`);
    }

    const q = client.getQuotaStatus();
    console.log(`    クォータ: ${q.used} / 10,000 units 消費済み`);
  }

  // hit チャンネルから miss を収集
  console.log(`\n  miss収集: ${allMissChIds.length}チャンネルから最大${preset.missChannelsMax}ch × ${preset.missPerChannel}件`);
  let misses = [];
  try {
    misses = await collector.collectMissFromChannels(client, allMissChIds, {
      maxChannels:    preset.missChannelsMax,
      limitPerChannel: preset.missPerChannel,
    });
    console.log(`  miss: ${misses.length}件`);
  } catch (e) {
    console.warn(`  ⚠ miss収集失敗: ${e.message}`);
  }

  const saved = collector.saveSeedData(genreKey, allHits, misses);
  const q     = client.getQuotaStatus();

  console.log(`\n  ✅ 保存完了: hits=${saved.hits.length}件 misses=${saved.misses.length}件`);
  console.log(`  クォータ残: ${10000 - q.used} / 10,000 units`);
  return saved;
}

async function main() {
  console.log(`\n🎬 YouTube シードデータ収集 (${new Date().toLocaleString('ja-JP')})`);
  console.log(`対象ジャンル: ${targetGenres.join(', ')}`);

  const client = new YouTubeApiClient(apiKey);
  const results = {};

  for (const genreKey of targetGenres) {
    try {
      results[genreKey] = await collectGenre(client, genreKey);
    } catch (e) {
      console.error(`\n❌ ${genreKey} 収集エラー: ${e.message}`);
    }
  }

  // サマリー
  console.log('\n─────────────────────────────────────────');
  console.log('収集サマリー\n');
  let totalSamples = 0;
  for (const [key, data] of Object.entries(results)) {
    const n = (data.hits?.length || 0) + (data.misses?.length || 0);
    totalSamples += n;
    console.log(`  ${key.padEnd(12)} hits=${String(data.hits?.length || 0).padStart(4)}  misses=${String(data.misses?.length || 0).padStart(4)}  合計=${n}`);
  }
  const q = client.getQuotaStatus();
  console.log(`\n  総サンプル数: ${totalSamples}件`);
  console.log(`  クォータ消費: ${q.used} / 10,000 units`);
  console.log('\n次のステップ:');
  console.log('  Discord で `!youtube train` を実行してモデルを訓練してください。');
  console.log('  訓練後 `!youtube status` で sampleCount と usedML を確認できます。\n');
}

main().catch(e => {
  console.error(`致命的エラー: ${e.message}`);
  process.exit(1);
});
