'use strict';
// =====================================================
// operation-watch.js — 黒川 Operation Watch
//
// 目的: 運用上の問題を検出し、社長・神崎 VP に報告する。
// 担当: 🅶 黒川 Chief of Staff
//
// 確認項目:
//   1. 放置ハンドオフ（長期間未解決）
//   2. 止まっている社員（ブロック・長時間レビュー待ち）
//   3. 未確認 inbox（社員の inbox/outbox 積み残し）
//   4. 長期未更新 Decision（90日以上更新なし）
//   5. 機能使用状況（Workflow Learning から推定）
//   6. Lesson 未登録候補（RESOLVED Incident で Lesson なし）
//
// 禁止:
//   ❌ 削除・変更
//   ❌ 自動承認・自動実行
//   ❌ eval / exec
//
// 黒川は「検出まで」。対応は社長・神崎が判断する。
// =====================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DOCS_DIR = path.join(__dirname, '..', '..', 'docs');

// 閾値定義
const HANDOFF_STALE_MS     = 4  * 60 * 60 * 1000;  // 4時間
const WORKER_STUCK_MS      = 6  * 60 * 60 * 1000;  // 6時間
const DECISION_OLD_DAYS    = 90;
const OUTBOX_UNREAD_BYTES  = 50;                    // 実質空でない最小サイズ

// ─────────────────────────────────────────────────────
// 1. 放置ハンドオフ検出
// ─────────────────────────────────────────────────────
function _checkStaleHandoffs() {
  const findings = [];
  try {
    const wstate = require('./workflow-state');
    const stale  = wstate.detectWaiting(HANDOFF_STALE_MS);
    for (const h of stale) {
      const WORKER_JP = {
        miyagi:'宮城', moriya:'守谷', shiraishi:'白石', aizawa:'相沢',
        ichikawa:'市川', kanemori:'金森', kurokawa:'黒川', ikuno:'育野',
        kanzaki:'神崎', ceo:'CEO',
      };
      findings.push({
        category: '放置ハンドオフ',
        severity: 'high',
        finding:  `\`${h.id}\` → ${WORKER_JP[h.to] || h.to} への ${h.event} が ${h.ageLabel} 未処理`,
        cause:    '担当者が確認していない可能性があります',
        proposal: `\`!workflow status\` で詳細確認 → \`!inbox send ${h.to} <確認依頼>\``,
      });
    }
  } catch { /* ignore */ }
  return findings;
}

// ─────────────────────────────────────────────────────
// 2. 止まっている社員検出
// ─────────────────────────────────────────────────────
function _checkStuckWorkers() {
  const findings = [];
  try {
    const wsm  = require('./worker-status');
    const data = wsm._load();
    const now  = Date.now();

    for (const worker of wsm.VALID_WORKERS) {
      const ws = data[worker] || {};
      if (!ws.status || !ws.updatedAt) continue;

      const age  = now - new Date(ws.updatedAt).getTime();
      const disp = wsm.WORKER_DISPLAY[worker] || worker;

      if (ws.status === 'blocked') {
        findings.push({
          category: '停止社員',
          severity: 'high',
          finding:  `${disp} がブロック中（${_ageLabel(age)}）`,
          cause:    `タスクがブロック状態: ${ws.taskId || '不明'}`,
          proposal: `\`!worker status\` で確認 → 社長への報告が必要です`,
        });
      } else if (ws.status === 'waiting_review' && age > WORKER_STUCK_MS) {
        findings.push({
          category: '停止社員',
          severity: 'medium',
          finding:  `${disp} が ${_ageLabel(age)} レビュー待ち`,
          cause:    'レビュアーへの依頼が届いていない可能性',
          proposal: `\`!workflow status\` で関連ハンドオフを確認してください`,
        });
      }
    }
  } catch { /* ignore */ }
  return findings;
}

// ─────────────────────────────────────────────────────
// 3. 未確認 inbox 検出
// ─────────────────────────────────────────────────────
function _checkUnreadInbox() {
  const findings = [];
  try {
    const ib = require('./inbox-bridge');
    for (const worker of ib.VALID_WORKERS) {
      const inPath  = ib._workerInboxPath(worker);
      const outPath = ib._workerOutboxPath(worker);
      const disp    = ib.WORKER_DISPLAY[worker] || worker;

      // 未確認 incoming
      if (fs.existsSync(inPath)) {
        const size = fs.statSync(inPath).size;
        if (size >= OUTBOX_UNREAD_BYTES) {
          const mtime   = fs.statSync(inPath).mtime;
          const ageLabel = _ageLabel(Date.now() - mtime.getTime());
          findings.push({
            category: '未確認inbox',
            severity: 'low',
            finding:  `${disp} の inbox に ${size} bytes（${ageLabel}前）の未確認メッセージ`,
            cause:    '返信・確認が済んでいない可能性があります',
            proposal: `\`!inbox check ${worker}\` で内容を確認してください`,
          });
        }
      }
      // 送信済み outbox（返信待ち）
      if (fs.existsSync(outPath)) {
        const size = fs.statSync(outPath).size;
        if (size >= OUTBOX_UNREAD_BYTES) {
          const mtime   = fs.statSync(outPath).mtime;
          const age     = Date.now() - mtime.getTime();
          if (age > 24 * 60 * 60 * 1000) { // 24時間以上
            const ageLabel = _ageLabel(age);
            findings.push({
              category: '返信待ちoutbox',
              severity: 'low',
              finding:  `${disp} への送信済みメッセージが ${ageLabel} 前から未返信`,
              cause:    '担当者が inbox を確認していない可能性',
              proposal: `\`!inbox status\` で状況を確認してください`,
            });
          }
        }
      }
    }
  } catch { /* ignore */ }
  return findings;
}

// ─────────────────────────────────────────────────────
// 4. 長期未更新 Decision 検出
// ─────────────────────────────────────────────────────
function _checkStaleDecisions() {
  const findings = [];
  try {
    const dl       = require('./decision-log');
    const list     = dl.listActiveDecisions(50);
    const threshMs = DECISION_OLD_DAYS * 24 * 60 * 60 * 1000;
    const now      = Date.now();

    const oldOnes = list.filter(d => {
      const created = new Date(d.createdAt).getTime();
      return (now - created) > threshMs;
    });

    if (oldOnes.length > 0) {
      findings.push({
        category: '長期未更新 Decision',
        severity: 'low',
        finding:  `${DECISION_OLD_DAYS}日以上前の active Decision: ${oldOnes.length}件`,
        cause:    '状況変化によって既に無効になった判断が含まれている可能性',
        proposal: `\`!decision list\` で確認し、古いものは \`!decision archive\` でアーカイブしてください（育野へ確認依頼）`,
      });
    }
  } catch { /* ignore */ }
  return findings;
}

// ─────────────────────────────────────────────────────
// 5. 機能使用状況（Workflow Learning から推定）
// ─────────────────────────────────────────────────────
function _checkUnusedFeatures() {
  const findings = [];
  try {
    const kr      = require('./kurokawa-report');
    const learning = kr._loadLearning();
    const sessions = learning.sessions || [];

    if (sessions.length === 0) {
      findings.push({
        category: '機能使用状況',
        severity: 'info',
        finding:  '!kurokawa report が一度も実行されていません',
        cause:    'Workflow Intelligence が未活用',
        proposal: '`!kurokawa report` を定期的に実行して進行状況を把握してください',
      });
    }

    // sync 状況
    const syncPath = path.join(DATA_DIR, 'sync-history.json');
    if (!fs.existsSync(syncPath)) {
      findings.push({
        category: '機能使用状況',
        severity: 'info',
        finding:  '!company sync が一度も実行されていません',
        cause:    'Company Memory Sync が未活用',
        proposal: '`!company sync` を実行して全社員の認識を揃えてください',
      });
    }

    // VP Review 状況
    const vpPath = path.join(DATA_DIR, 'vp-reviews.json');
    if (!fs.existsSync(vpPath)) {
      findings.push({
        category: '機能使用状況',
        severity: 'info',
        finding:  '!vp review が一度も実行されていません',
        cause:    '神崎 VP Brain が未活用',
        proposal: '重要判断の前に `!vp review <テーマ>` で判断材料を整理してください',
      });
    }
  } catch { /* ignore */ }
  return findings;
}

// ─────────────────────────────────────────────────────
// 6. Lesson 未登録候補（RESOLVED Incident で Lesson なし）
// ─────────────────────────────────────────────────────
function _checkMissingLessons() {
  const findings = [];
  try {
    const im = require('./incident-manager');
    const list = im._load();
    const resolvedNoLesson = list.filter(i =>
      i.status === 'RESOLVED' &&
      !i.data?.prevention &&
      !i.data?.mitigation
    );
    if (resolvedNoLesson.length > 0) {
      findings.push({
        category: 'Lesson 未登録',
        severity: 'low',
        finding:  `対応内容が記録されていない RESOLVED Incident: ${resolvedNoLesson.length}件`,
        cause:    '!incident resolve で対応内容が入力されていない可能性',
        proposal: `\`!incident list all\` で確認し、育野へ Lesson 候補を共有してください`,
      });
    }
  } catch { /* ignore */ }
  return findings;
}

// ─────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────
function _ageLabel(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}日`;
  if (h > 0)  return `${h}時間`;
  return `${m}分`;
}

// ─────────────────────────────────────────────────────
// runWatch() — 全項目を確認してレポートを生成
//
// 戻り値: { ok, text, findings, totalFindings }
// ─────────────────────────────────────────────────────
function runWatch() {
  const now      = new Date().toLocaleString('ja-JP');
  const all      = [
    ..._checkStaleHandoffs(),
    ..._checkStuckWorkers(),
    ..._checkUnreadInbox(),
    ..._checkStaleDecisions(),
    ..._checkUnusedFeatures(),
    ..._checkMissingLessons(),
  ];

  const high  = all.filter(f => f.severity === 'high');
  const med   = all.filter(f => f.severity === 'medium');
  const low   = all.filter(f => f.severity === 'low');
  const info  = all.filter(f => f.severity === 'info');

  const lines = [
    `🔍 **黒川 Operation Watch**`,
    `確認日時: ${now}`,
    ``,
    `発見: 計 ${all.length}件 (🔴 高 ${high.length} / 🟡 中 ${med.length} / 🟢 低 ${low.length} / ℹ️ ${info.length})`,
    ``,
  ];

  if (all.length === 0) {
    lines.push('✅ 問題なし — 現在の確認範囲では運用上の問題は検出されませんでした。');
  } else {
    // 重要度降順で出力
    for (const f of [...high, ...med, ...low, ...info]) {
      const sev = { high:'🔴', medium:'🟡', low:'🟢', info:'ℹ️' }[f.severity] || '⚪';
      lines.push(`${sev} **【${f.category}】**`);
      lines.push(`  発見: ${f.finding}`);
      lines.push(`  原因候補: ${f.cause}`);
      lines.push(`  提案: ${f.proposal}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('⚠️ 黒川は「検出まで」です。対応・変更・削除は社長・神崎 VP が判断してください。');

  return {
    ok:            true,
    text:          lines.join('\n').slice(0, 1900),
    findings:      all,
    totalFindings: all.length,
    highCount:     high.length,
  };
}

module.exports = {
  runWatch,
  // テスト用
  _checkStaleHandoffs,
  _checkStuckWorkers,
  _checkUnreadInbox,
  _checkStaleDecisions,
  _checkUnusedFeatures,
  _checkMissingLessons,
  _ageLabel,
  HANDOFF_STALE_MS,
  WORKER_STUCK_MS,
  DECISION_OLD_DAYS,
};
