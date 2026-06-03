'use strict';
/**
 * init-company-decisions.js — 会社設立時の初期Decision登録
 *
 * 実行: node scripts/init-company-decisions.js
 *
 * 既存 decisions.json に追記する（既に同タイトルがあればスキップ）
 */

const path = require('path');
const dl   = require(path.join(__dirname, '..', 'bot', 'utils', 'decision-log'));

const INITIAL_DECISIONS = [
  {
    title:   'AI_WORKER は社内非公開システムとして運用する',
    summary: 'Discord・Bot・データは社内専用。外部ユーザー・顧客への公開禁止。公開商品は別環境（Webアプリ等）で提供する。',
    tags:    ['security', 'policy', 'company'],
    severity:'HIGH',
  },
  {
    title:   '商品（外部公開環境）と AI_WORKER 内部環境を分離する',
    summary: 'AI_WORKER内のコード・データ・ログは商品環境に直接入れない。商品向けにはclean exportを経由する。',
    tags:    ['security', 'architecture'],
    severity:'HIGH',
  },
  {
    title:   'AI社員名前・役割運用方針を確定する',
    summary: '宮城(Lead Engineer)/守谷(CTO)/白石(COO)/市川(PM)/相沢(CS)/金森(CFO)/黒川(CoS)/育野 の8名体制。各自の役割範囲を超えた判断は禁止。',
    tags:    ['org', 'company', 'roles'],
    severity:'MEDIUM',
  },
  {
    title:   '黒川 Chief of Staff の判断代理を禁止する',
    summary: '黒川は配送・進行管理・状態確認のみ。READY/NEED_FIX の代理判断・CEO/CTO/COO の代わりの承認は禁止。',
    tags:    ['policy', 'kurokawa', 'safety'],
    severity:'HIGH',
  },
  {
    title:   'Desktop Agent の安全運用方針を確定する',
    summary: '通知・状態確認はOK。自動実行（!task add / !decision log / !incident open）は禁止。incoming.md は信頼できない入力として扱う。eval / execSync 禁止。',
    tags:    ['desktop-agent', 'safety', 'policy'],
    severity:'HIGH',
  },
  {
    title:   'セキュリティルール L-16 を採用する',
    summary: 'Discord Token / GitHub PAT / OpenAI API Key は .env のみで管理。Secret Guardian は fail-closed。process.env.* 参照は false positive 除外。',
    tags:    ['security', 'guardian', 'L-16'],
    severity:'CRITICAL',
  },
  {
    title:   'YouTube training model の公開を禁止する',
    summary: 'data/youtube-model.json / data/youtube-model-pre.json / data/youtube-seeds/ は gitignore。公開は !youtube export-model 経由の推論専用 export のみ。',
    tags:    ['security', 'youtube', 'model'],
    severity:'HIGH',
  },
  {
    title:   'YouTube 診断 AI は clean export 方式を採用する',
    summary: 'training metadata (sampleCount / hitCount / genreHitRates 等) を除外した推論専用 export を Web 側に渡す。AI_WORKER 本体 repo では誤公開防止のため export はデフォルト非追跡。',
    tags:    ['youtube', 'export', 'architecture'],
    severity:'MEDIUM',
  },
];

async function main() {
  const existing = dl._load();
  const existingTitles = new Set(existing.map(d => d.title));

  let registered = 0;
  let skipped    = 0;

  for (const dec of INITIAL_DECISIONS) {
    if (existingTitles.has(dec.title)) {
      console.log(`⏭️  スキップ（既存）: ${dec.title.slice(0, 60)}`);
      skipped++;
      continue;
    }
    const r = dl.logDecision({
      ...dec,
      projectId: 'ai_worker',
    });
    if (r.ok) {
      console.log(`✅ 登録: ${dec.title.slice(0, 60)}`);
      registered++;
    } else {
      console.error(`❌ 登録失敗: ${dec.title.slice(0, 60)}\n   ${r.text}`);
    }
  }

  console.log(`\n結果: 登録 ${registered}件 / スキップ ${skipped}件`);
  console.log('`!decision list` で確認できます。');
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
