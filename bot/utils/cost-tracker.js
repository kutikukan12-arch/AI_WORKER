'use strict';

// =====================================================
// cost-tracker.js - Claude Code 実行コストの記録・集計
//
// 役割:
//   Claude Code CLI の --output-format json から得た total_cost_usd を
//   日次の JSONL 台帳（logs/cost-YYYY-MM-DD.jsonl）に追記し、
//   当日合計などを集計できるようにする。
//
//   これまでコストは一切記録されておらず「気づいたら超過」状態だった。
//   1行=1タスクの追記専用ログにすることで、後から !cost 等で集計可能にする。
//
// 失敗してもタスク本体を止めないため、全関数は例外を握りつぶす。
// =====================================================

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

// ─────────────────────────────────────────────────────
// 当日の台帳ファイルパス（logs/cost-YYYY-MM-DD.jsonl）
// ─────────────────────────────────────────────────────
function dailyFile(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10); // YYYY-MM-DD（UTC基準で日付固定）
  return path.join(LOG_DIR, `cost-${ymd}.jsonl`);
}

// ─────────────────────────────────────────────────────
// record(entry) — 1タスク分のコストを追記
//   entry: { taskId, costUsd, durationSec, numTurns, source }
// ─────────────────────────────────────────────────────
function record(entry = {}) {
  try {
    const costUsd = Number(entry.costUsd);
    if (!Number.isFinite(costUsd)) return; // コスト不明なら記録しない

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      ts:          new Date().toISOString(),
      taskId:      entry.taskId || null,
      costUsd:     costUsd,
      durationSec: Number(entry.durationSec) || null,
      numTurns:    Number(entry.numTurns) || null,
      source:      entry.source || null,
    });
    fs.appendFileSync(dailyFile(), line + '\n', 'utf8');
  } catch (err) {
    logger.debug(`cost-tracker record 失敗（無視）: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────
// readDay(date) — 指定日の台帳を配列で返す（壊れた行はスキップ）
// ─────────────────────────────────────────────────────
function readDay(date = new Date()) {
  try {
    const raw = fs.readFileSync(dailyFile(date), 'utf8');
    return raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────
// todayTotal() — 当日合計コスト($)・タスク数・累計時間を返す
// ─────────────────────────────────────────────────────
function todayTotal() {
  const rows = readDay();
  const totalUsd = rows.reduce((s, r) => s + (Number(r.costUsd) || 0), 0);
  const totalSec = rows.reduce((s, r) => s + (Number(r.durationSec) || 0), 0);
  return {
    totalUsd:  Math.round(totalUsd * 10000) / 10000,
    taskCount: rows.length,
    totalSec,
  };
}

module.exports = { record, readDay, todayTotal, dailyFile };
