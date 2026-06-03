'use strict';
// =====================================================
// context-manager.js — Company Context Manager
//
// 目的:
//   AI_WORKERの現在状態・社員構成・ルール・進捗を1つの
//   Contextとして管理し、新しいAI社員・AI Toolが即座に
//   状況理解できる仕組みを提供する。
//
// Phase2: !company context コマンド表示
// Phase3: 重要変更時の育野への更新候補通知
// Phase4: Security — APIキー/token/secret の混入チェック
//
// 禁止:
//   ❌ COMPANY_CONTEXT.md に secret 情報を書かない
//   ❌ .env 内容をコンテキストに含めない
//   ❌ 顧客情報をコンテキストに含めない
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const CONTEXT_FILE = path.join(__dirname, '..', '..', 'docs', 'COMPANY_CONTEXT.md');

// バージョン情報
const CONTEXT_VERSION = '1.0';
const CONTEXT_UPDATED = '2026-06-04';

// 更新トリガー種別
const UPDATE_TRIGGERS = {
  NEW_MEMBER:   'new_member',
  ROLE_CHANGE:  'role_change',
  NEW_SYSTEM:   'new_system',
  NEW_DECISION: 'new_decision',
  NEW_RULE:     'new_rule',
  FLOW_CHANGE:  'flow_change',
};

// ─────────────────────────────────────────────────────
// getContextSummary() — Context の要約を返す
//
// 戻り値: { ok, version, updatedAt, filePath, summary }
// ─────────────────────────────────────────────────────
function getContextSummary() {
  const exists = fs.existsSync(CONTEXT_FILE);
  const lines  = [
    `📋 **会社共通コンテキスト**`,
    ``,
    `Version: \`${CONTEXT_VERSION}\``,
    `最終更新: ${CONTEXT_UPDATED}`,
    `ファイル: \`docs/COMPANY_CONTEXT.md\``,
    ``,
    `**組織:**`,
    `CEO → 🅰️宮城 🅱️守谷 🅲白石 🅳相沢 🅴市川 🅵金森 🅶黒川 🅷育野`,
    ``,
    `**フェーズ:** 社内基盤完了 → 実案件Workflow検証中`,
    ``,
    `**稼働システム:** 16種 (Task/Workflow/Inbox/Discord/Context 等)`,
    // Phase5: active Decision 数をコンテキストに反映
    (() => { try { const dl = require('./decision-log'); const n = dl.listActiveDecisions().length; return n > 0 ? `**有効 Decision:** ${n} 件 (🟢 active)` : ''; } catch { return ''; } })(),
    ``,
    `**基本方針:** 安全な会社運用 > 過剰自動化`,
    `**黒川ルール:** 配送・管理のみ。判断代理禁止。`,
    ``,
    exists
      ? `> \`!company context full\` で全文表示`
      : `⚠️ \`docs/COMPANY_CONTEXT.md\` が見つかりません`,
  ];

  return {
    ok:        true,
    version:   CONTEXT_VERSION,
    updatedAt: CONTEXT_UPDATED,
    filePath:  CONTEXT_FILE,
    summary:   lines.join('\n'),
  };
}

// ─────────────────────────────────────────────────────
// getContextFull() — Context 全文（先頭1800文字）
// ─────────────────────────────────────────────────────
function getContextFull() {
  if (!fs.existsSync(CONTEXT_FILE)) {
    return { ok: false, text: '❌ docs/COMPANY_CONTEXT.md が見つかりません' };
  }
  const raw     = fs.readFileSync(CONTEXT_FILE, 'utf8');
  // Phase4: secret 混入チェック（表示前に redact）
  const content = redact(raw);
  return {
    ok:   true,
    text: content.slice(0, 1800),
    full: content,
  };
}

// ─────────────────────────────────────────────────────
// Phase4: validateContextSecurity() — secret 混入確認
//
// COMPANY_CONTEXT.md に APIキー・token・secret が
// 含まれていないかスキャンする。
// 戻り値: { ok, violations }
// ─────────────────────────────────────────────────────
function validateContextSecurity() {
  if (!fs.existsSync(CONTEXT_FILE)) {
    return { ok: false, violations: ['ファイルが存在しない'] };
  }
  const content    = fs.readFileSync(CONTEXT_FILE, 'utf8');
  const violations = [];

  // secret パターン
  const SECRET_PATTERNS = [
    { name: 'Discord Bot Token',         re: /MT[A-Za-z0-9]{18,32}\.[A-Za-z0-9_-]{4,8}\.[A-Za-z0-9_-]{20,}/ },
    { name: 'GitHub PAT (classic)',       re: /\bghp_[A-Za-z0-9]{36}\b/ },
    { name: 'GitHub PAT (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/ },
    { name: 'OpenAI API Key',            re: /\bsk-proj-[A-Za-z0-9_\-]{20,}\b/ },
    { name: '.env 内容',                  re: /DISCORD_TOKEN\s*=\s*[A-Za-z0-9._\-]{20,}/ },
  ];

  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        violations.push(`L${i + 1}: ${name} の可能性あり`);
      }
    }
  });

  return { ok: violations.length === 0, violations };
}

// ─────────────────────────────────────────────────────
// Phase3: notifyUpdateCandidate(trigger, detail) — 育野へ更新候補通知
//
// COMPANY_CONTEXT.md の更新が必要な変更を検知したとき、
// 育野への内部メッセージを生成する（自動実行はしない）。
//
// 戻り値: { ok, msgText (育野への通知文) }
// ─────────────────────────────────────────────────────
function notifyUpdateCandidate(trigger, detail) {
  const safeTrigger = String(trigger || '').trim();
  const safeDetail  = redact(String(detail || '')).slice(0, 300);

  const triggerLabels = {
    new_member:   '新社員追加',
    role_change:  '役割変更',
    new_system:   '新システム完成',
    new_decision: '重要Decision',
    new_rule:     '新ルール',
    flow_change:  'フロー変更',
  };

  const label = triggerLabels[safeTrigger] || safeTrigger;

  const msgText = [
    `【COMPANY_CONTEXT.md 更新候補】`,
    ``,
    `トリガー: ${label}`,
    `詳細: ${safeDetail || '（詳細なし）'}`,
    ``,
    `→ docs/COMPANY_CONTEXT.md の該当セクションを更新してください。`,
    `→ 更新後は \`!company context\` で確認できます。`,
  ].join('\n');

  return { ok: true, trigger: safeTrigger, label, msgText };
}

module.exports = {
  getContextSummary,
  getContextFull,
  validateContextSecurity,
  notifyUpdateCandidate,
  CONTEXT_VERSION,
  CONTEXT_UPDATED,
  CONTEXT_FILE,
  UPDATE_TRIGGERS,
};
