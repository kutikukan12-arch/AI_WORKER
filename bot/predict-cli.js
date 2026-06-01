'use strict';

// YouTube ヒット予測 CLI
// Usage: node bot/predict-cli.js --title "タイトル" --subs 10000 [options]

const { predict, buildSummary } = require('./utils/youtube-predictor');

// ── ヘルプ ──────────────────────────────────────────────────

function printHelp() {
  console.log(`
YouTube ヒット予測 CLI

使い方:
  node bot/predict-cli.js --title "タイトル" --subs 10000 [options]

オプション（入力）:
  -t, --title      動画タイトル              ★必須
  -c, --channel    チャンネル名              （表示用のみ）
  -s, --subs       チャンネル登録者数        （整数）
  -v, --views      視聴数                    （0 または省略 → 投稿前扱い）
  -l, --likes      いいね数
      --comments   コメント数
  -d, --duration   動画長（秒）              （例: 600 = 10分）
      --tags       タグ（カンマ区切り）      （例: "AI,技術,解説"）
      --tag        タグ（複数指定）          （例: --tag AI --tag 技術）
      --desc       概要欄テキスト
      --published  投稿日時 ISO 8601         （例: 2024-03-01T18:00:00Z）

オプション（出力）:
      --json       結果を JSON でも出力する
  -h, --help       このヘルプを表示

例（投稿前）:
  node bot/predict-cli.js -t "【衝撃】AIが仕事を奪う未来" -s 50000 --tags "AI,テクノロジー,未来" -d 600

例（投稿後）:
  node bot/predict-cli.js -t "daily vlog" -s 1000 -v 8500 -l 300 --comments 40 -d 900
`);
}

// ── 引数パーサー ─────────────────────────────────────────────

function parseArgs(argv) {
  const args  = {};
  const tags  = [];
  const raw   = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const key = raw[i];
    const val = raw[i + 1];

    const take = () => { i++; return val; };

    switch (key) {
      case '--title':    case '-t': args.title       = take(); break;
      case '--channel':  case '-c': args.channel     = take(); break;
      case '--subs':     case '-s': args.subs        = Number(take()); break;
      case '--views':    case '-v': args.views       = Number(take()); break;
      case '--likes':    case '-l': args.likes       = Number(take()); break;
      case '--comments':            args.comments    = Number(take()); break;
      case '--duration': case '-d': args.duration    = Number(take()); break;
      case '--desc':                args.description = take(); break;
      case '--published':           args.publishedAt = take(); break;
      case '--tags':
        tags.push(...take().split(',').map(s => s.trim()).filter(Boolean));
        break;
      case '--tag':
        tags.push(take());
        break;
      case '--json':                args.json        = true; break;
      case '--help':   case '-h':   printHelp(); process.exit(0); break;
      default:
        if (key.startsWith('-')) {
          console.error(`エラー: 未知のオプション "${key}"。-h でヘルプを確認してください。`);
          process.exit(1);
        }
    }
  }

  args.tags = tags;
  return args;
}

// ── 整形出力（Discord マークダウン → plain text） ────────────

function stripMarkdown(text) {
  return text.replace(/\*\*/g, '').replace(/`/g, '');
}

// ── エントリポイント ─────────────────────────────────────────

function main() {
  const a = parseArgs(process.argv);

  if (!a.title) {
    console.error('エラー: --title は必須です。-h でヘルプを確認してください。');
    process.exit(1);
  }

  const video = {
    title:           a.title,
    subscriberCount: a.subs        || 0,
    viewCount:       a.views       || 0,
    likeCount:       a.likes       || 0,
    commentCount:    a.comments    || 0,
    duration:        a.duration    || 0,
    description:     a.description || '',
    tags:            a.tags,
    publishedAt:     a.publishedAt || null,
  };

  const isPrePub = !video.viewCount;

  const result  = predict(video);
  const summary = buildSummary(video, result);

  // ─── ヘッダー ───
  console.log('');
  if (a.channel) console.log(`チャンネル : ${a.channel}`);
  console.log(`タイトル   : ${a.title}`);
  if (video.tags.length) console.log(`タグ       : ${video.tags.join(', ')}`);
  if (video.subscriberCount) console.log(`登録者数   : ${video.subscriberCount.toLocaleString()}`);
  if (isPrePub) {
    console.log(`モード     : 投稿前予測（viewCount 未設定）`);
    console.log(`※ 注意     : predict() は投稿前スコアリング未対応（buzzRatio=0固定 → 常にmiss判定）`);
  } else {
    console.log(`視聴数     : ${video.viewCount.toLocaleString()}`);
  }
  console.log('');

  // ─── 予測結果 ───
  console.log(stripMarkdown(summary));

  // ─── JSON 出力 ───
  if (a.json) {
    console.log('\n--- JSON ---');
    console.log(JSON.stringify({ video, result }, null, 2));
  }
}

main();
