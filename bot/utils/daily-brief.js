'use strict';
// =====================================================
// daily-brief.js — Morning Brief / Daily Closing (Phase4)
//
// !start-day: 黒川が朝の状況整理を出力
// !end-day:   黒川(進行) + 神崎(判断) + 育野(Lesson候補) でまとめ
//
// 禁止:
//   ❌ task作成・承認・決定
//   ❌ Decision確定
//   ❌ eval / exec
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR   = path.join(__dirname, '..', '..', 'data');
const BRIEF_FILE = path.join(DATA_DIR, 'daily-brief.json');

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _loadBrief() {
  try {
    if (!fs.existsSync(BRIEF_FILE)) return { snapshots: [] };
    return JSON.parse(fs.readFileSync(BRIEF_FILE, 'utf8'));
  } catch { return { snapshots: [] }; }
}

function _saveBrief(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = BRIEF_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, BRIEF_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// buildMorningBrief() — !start-day
// ─────────────────────────────────────────────────────
function buildMorningBrief() {
  const now  = new Date().toLocaleString('ja-JP');
  const date = new Date().toLocaleDateString('ja-JP');

  // 情報収集
  let projects    = [];
  let taskSnap    = {};
  let pendingDec  = 0;
  let humanChecks = 0;

  try {
    const pm = require('./project-manager');
    projects = (pm.listProjects ? pm.listProjects() : []).slice(0, 3);
  } catch { /* ignore */ }

  try {
    const tm   = require('./task-manager');
    const list = tm.listTasks();
    list.forEach(t => { taskSnap[t.state] = (taskSnap[t.state] || 0) + 1; });
    humanChecks = list.filter(t => t.state === '人間確認待ち' || t.state === 'AWAITING').length;
  } catch { /* ignore */ }

  try {
    const wstate = require('./workflow-state');
    pendingDec = wstate.detectWaiting(0).length;
  } catch { /* ignore */ }

  // 前日のスナップショット取得
  const data     = _loadBrief();
  const lastSnap = data.snapshots.slice(-1)[0] || null;

  const lines = [
    `🌅 **Morning Brief — ${date}**`,
    `担当: 🅶 黒川 Chief of Staff`,
    `生成: ${now}`,
    ``,
    `社長、おはようございます。`,
    ``,
    `**【現在の稼働プロジェクト】**`,
    projects.length
      ? projects.slice(0,3).map(p => `• ${redact(String(p.name || p.id || p)).slice(0,60)}`).join('\n')
      : '• （プロジェクト情報取得中）',
    ``,
    `**【タスク状況】**`,
    Object.entries(taskSnap).length
      ? Object.entries(taskSnap).map(([s, n]) => `• ${s}: ${n}件`).join('\n')
      : '• タスクなし',
    ``,
    `**【今日見るべき判断】**`,
    humanChecks > 0 ? `🔴 HUMAN_CHECK 待ち ${humanChecks}件 → \`!approve\` で確認` : '✅ HUMAN_CHECK 待ちなし',
    pendingDec > 0  ? `🟡 未解決ハンドオフ ${pendingDec}件 → \`!workflow status\` で確認` : '',
    ``,
    `**【昨日からの続き】**`,
    lastSnap
      ? `前回の日次: ${new Date(lastSnap.at).toLocaleDateString('ja-JP')} — 未完 ${lastSnap.incompleteCount || 0}件`
      : '（前回データなし）',
    ``,
    `> \`!kurokawa report\` で詳細な進行状況を確認できます。`,
    `> 一日の終わりは \`!end-day\` でまとめてください。`,
  ].filter(l => l !== '');

  return { ok: true, text: lines.join('\n').slice(0, 1900) };
}

// ─────────────────────────────────────────────────────
// buildDailyClosing() — !end-day
//
// 黒川: 進行まとめ
// 神崎: 重要判断まとめ
// 育野: Lesson候補
// ─────────────────────────────────────────────────────
function buildDailyClosing() {
  const now  = new Date().toLocaleString('ja-JP');
  const date = new Date().toLocaleDateString('ja-JP');

  // 完了・未完タスク
  let completed   = [];
  let incomplete  = [];
  let incidentLog = [];

  try {
    const tm   = require('./task-manager');
    const list = tm.listTasks();
    completed  = list.filter(t => t.state === '完了' || t.state === 'DONE').slice(-5);
    incomplete = list.filter(t =>
      t.state !== '完了' && t.state !== 'DONE' && t.state !== 'ARCHIVED'
    ).slice(-5);
  } catch { /* ignore */ }

  try {
    const im = require('./incident-manager');
    incidentLog = im._load().filter(i => i.status === 'RESOLVED').slice(-3);
  } catch { /* ignore */ }

  // 重要Decision（本日）
  let todayDecisions = [];
  try {
    const dl   = require('./decision-log');
    const today = new Date().toISOString().slice(0, 10);
    todayDecisions = dl._load()
      .filter(d => d.createdAt && d.createdAt.startsWith(today))
      .slice(-3);
  } catch { /* ignore */ }

  const lines = [
    `🌙 **Daily Closing Report — ${date}**`,
    `担当: 🅶 黒川 / 🅸 神崎 / 🅷 育野`,
    `生成: ${now}`,
    ``,
    `**🅶 黒川 — 進行まとめ**`,
    ``,
    `完了: ${completed.length}件`,
    ...completed.map(t => `  ✅ ${String(t.prompt || t.id).slice(0, 60)}`),
    ``,
    `未完: ${incomplete.length}件`,
    ...incomplete.map(t => `  🔧 ${String(t.prompt || t.id).slice(0, 60)} [${t.state}]`),
    ``,
    `**🅸 神崎 — 重要判断まとめ**`,
    ``,
    todayDecisions.length
      ? todayDecisions.map(d => `• ${redact(d.title).slice(0, 80)} [${d.severity}]`).join('\n')
      : '• 本日の新規 Decision なし',
    ``,
    `**🅷 育野 — Lesson候補**`,
    ``,
    incidentLog.length
      ? incidentLog.map(i => `• ${redact(i.title).slice(0, 60)} → LESSONS.md 追記を検討`).join('\n')
      : '• 本日の Lesson候補なし（!incident resolve 後に表示）',
    ``,
    `**明日の候補:**`,
    incomplete.length > 0
      ? `  最初にやること: ${String(incomplete[0].prompt || incomplete[0].id).slice(0, 60)}`
      : '  タスクをご確認ください',
    ``,
    `⚠️ Decision登録・承認は社長が手動で行ってください。`,
    `> \`!decision log\` / \`!incident resolve\` / \`!vp review\``,
  ].filter(l => l !== '');

  // スナップショット保存
  const data  = _loadBrief();
  const snap  = {
    at:              new Date().toISOString(),
    completedCount:  completed.length,
    incompleteCount: incomplete.length,
    decisionCount:   todayDecisions.length,
  };
  data.snapshots = [...(data.snapshots || []), snap].slice(-30);
  _saveBrief(data);

  return { ok: true, text: lines.join('\n').slice(0, 1900), snap };
}

module.exports = {
  buildMorningBrief,
  buildDailyClosing,
  BRIEF_FILE,
  _loadBrief,
  _saveBrief,
};
