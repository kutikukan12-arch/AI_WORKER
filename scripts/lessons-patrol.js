'use strict';

// =====================================================
// lessons-patrol.js — 学習巡回（🅷 Claude H / Learning Guardian）
//
// 役割:
//   reviews/ と logs/ を定期巡回し、前回巡回以降に発生した
//   失敗シグナル（高/中危険度レビュー・タイムアウト・タスク失敗）を集計して
//   巡回レポート docs/patrols/patrol_<date>.md を生成する。
//
//   docs/LESSONS.md に新ルールを追記すべき候補を人間（または Claude H）に提示するのが目的。
//   自動でルールを書き換えることはしない（診断のみ）。
//
// 使い方:
//   node scripts/lessons-patrol.js            # 前回巡回以降の差分を集計
//   node scripts/lessons-patrol.js --all      # 全期間を集計
//   node scripts/lessons-patrol.js --since=2026-05-30  # 指定日以降
//
// 状態:
//   data/lessons-patrol-state.json に最終巡回時刻(ms)を保存。
// =====================================================

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const REVIEWS_DIR = path.join(ROOT, 'reviews');
const LOGS_DIR    = path.join(ROOT, 'logs');
const PATROL_DIR  = path.join(ROOT, 'docs', 'patrols');
const STATE_FILE  = path.join(ROOT, 'data', 'lessons-patrol-state.json');

// ─── 引数 ───────────────────────────────────────────
const args = process.argv.slice(2);
const ALL  = args.includes('--all');
const sinceArg = (args.find(a => a.startsWith('--since=')) || '').split('=')[1];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { console.error('state保存失敗:', e.message); }
}

// 巡回起点(ms)を決める
function resolveSinceMs() {
  if (ALL) return 0;
  if (sinceArg) {
    const t = Date.parse(sinceArg);
    if (!Number.isNaN(t)) return t;
  }
  const st = loadState();
  if (st.lastPatrolMs) return st.lastPatrolMs;
  return Date.now() - 7 * 24 * 60 * 60 * 1000; // 既定: 直近7日
}

// ─── reviews 集計 ───────────────────────────────────
function parseDanger(content) {
  const m = content.match(/危険度.*?(高|中|低)/);
  return m ? m[1] : null;
}

function scanReviews(sinceMs) {
  const out = { high: [], mid: [] };
  if (!fs.existsSync(REVIEWS_DIR)) return out;
  for (const f of fs.readdirSync(REVIEWS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(REVIEWS_DIR, f);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs < sinceMs) continue;
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const danger = parseDanger(content);
    const title  = (content.match(/##\s*元の依頼全文\s*\n(.+)/) || [])[1] || '';
    const rec = { file: f, title: title.trim().slice(0, 80), mtime: stat.mtime.toISOString() };
    if (danger === '高') out.high.push(rec);
    else if (danger === '中') out.mid.push(rec);
  }
  out.high.sort((a, b) => b.mtime.localeCompare(a.mtime));
  out.mid.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// ─── logs 集計 ──────────────────────────────────────
function scanLogs(sinceMs) {
  const res = { taskFail: 0, timeoutFail: 0, autoSplit: 0, byDay: {} };
  if (!fs.existsSync(LOGS_DIR)) return res;
  for (const f of fs.readdirSync(LOGS_DIR)) {
    if (!/^2026-.*\.log$/.test(f)) continue;
    const day = f.replace('.log', '');
    // ファイルの日付が since より前なら丸ごとスキップ（粗いが十分）
    const dayMs = Date.parse(day);
    if (!ALL && !Number.isNaN(dayMs) && dayMs + 86400000 < sinceMs) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.includes('タスク失敗')) {
        res.taskFail++;
        res.byDay[day] = (res.byDay[day] || 0) + 1;
        if (line.includes('タイムアウト')) res.timeoutFail++;
      }
      if (line.includes('autoSplitOnTimeout')) res.autoSplit++;
    }
  }
  return res;
}

// ─── レポート生成 ───────────────────────────────────
function buildReport(sinceMs, reviews, logs) {
  const now = new Date();
  const sinceLabel = sinceMs === 0 ? '全期間' : new Date(sinceMs).toISOString();
  const L = [];
  L.push(`# 学習巡回レポート — ${now.toISOString().slice(0, 10)}`);
  L.push('');
  L.push(`> 🅷 Claude H (Learning Guardian) / 集計起点: ${sinceLabel}`);
  L.push('');
  L.push('## サマリー');
  L.push('');
  L.push('| 指標 | 件数 |');
  L.push('|---|---|');
  L.push(`| 🔴 高危険度レビュー（新規） | ${reviews.high.length} |`);
  L.push(`| 🟡 中危険度レビュー（新規） | ${reviews.mid.length} |`);
  L.push(`| ❌ タスク失敗 | ${logs.taskFail} |`);
  L.push(`| ⏱️ うちタイムアウト | ${logs.timeoutFail} |`);
  L.push(`| ✂️ autoSplitOnTimeout 発火 | ${logs.autoSplit} |`);
  L.push('');

  const timeoutRate = logs.taskFail > 0 ? Math.round((logs.timeoutFail / logs.taskFail) * 100) : 0;
  L.push('## 所見');
  L.push('');
  if (logs.timeoutFail > 0 && timeoutRate >= 50) {
    L.push(`- ⚠️ タスク失敗の **${timeoutRate}%** がタイムアウト。L-08（着手前分割）の徹底状況を確認すること。`);
  }
  if (reviews.high.length > 0) {
    L.push(`- ⚠️ 高危険度レビューが ${reviews.high.length} 件。下記を確認し、横展開できる教訓があれば docs/LESSONS.md に L-xx を追記。`);
  }
  if (reviews.high.length === 0 && logs.timeoutFail === 0) {
    L.push('- ✅ 新規の高危険度・タイムアウト失敗なし。');
  }
  L.push('');

  if (reviews.high.length) {
    L.push('## 🔴 高危険度レビュー（要確認）');
    L.push('');
    reviews.high.forEach(r => L.push(`- \`${r.file}\` — ${r.title || '(タイトル抽出不可)'}`));
    L.push('');
  }
  if (reviews.mid.length) {
    L.push('## 🟡 中危険度レビュー');
    L.push('');
    reviews.mid.slice(0, 20).forEach(r => L.push(`- \`${r.file}\` — ${r.title || ''}`));
    L.push('');
  }

  L.push('---');
  L.push('次アクション: 上記から再発防止ルール候補を抽出し `docs/LESSONS.md` を更新する（🅷 Claude H）。');
  return L.join('\n');
}

// ─── main ───────────────────────────────────────────
function main() {
  const sinceMs = resolveSinceMs();
  const reviews = scanReviews(sinceMs);
  const logs    = scanLogs(sinceMs);
  const report  = buildReport(sinceMs, reviews, logs);

  fs.mkdirSync(PATROL_DIR, { recursive: true });
  const outFile = path.join(PATROL_DIR, `patrol_${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(outFile, report, 'utf8');

  saveState({ lastPatrolMs: Date.now(), lastPatrolAt: new Date().toISOString() });

  console.log(report);
  console.log('');
  console.log(`📄 レポート出力: ${path.relative(ROOT, outFile)}`);
}

main();
