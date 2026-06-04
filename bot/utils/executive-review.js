'use strict';
// =====================================================
// executive-review.js — 神崎 Executive Review
//
// !vp review company
//
// 目的:
//   会社全体を部門別に確認し、社長への判断材料を提供する。
//   神崎は整理・提案のみ。CEO判断の代行は禁止。
//
// 確認部門:
//   開発(宮城) / 品質(守谷) / 運営(白石) / 商品(市川)
//   費用(金森) / 顧客(相沢) / 学習(育野) / 進行(黒川)
//
// 出力:
//   1. 今良いところ
//   2. 問題
//   3. 放置すると危険なこと
//   4. 次のCEO判断候補
//
// 禁止:
//   ❌ CEO判断代行
//   ❌ 承認・タスク変更・Decision確定
//   ❌ eval / exec
// =====================================================

const { redact } = require('./redact');

// ─────────────────────────────────────────────────────
// 部門別情報収集
// ─────────────────────────────────────────────────────

// 開発 (宮城): タスク・実装状況
function _reviewDevelopment() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const tm     = require('./task-manager');
    const tasks  = tm.listTasks();
    const done   = tasks.filter(t => t.state === '完了' || t.state === 'DONE').length;
    const inProg = tasks.filter(t => t.state === '作業中' || t.state === 'IN_PROGRESS');
    const review = tasks.filter(t => t.state === 'レビュー待ち' || t.state === 'REVIEWING');
    const on_hold= tasks.filter(t => t.state === '保留' || t.state === 'ON_HOLD');

    if (done > 0)      items.goods.push(`タスク完了: ${done}件`);
    if (inProg.length) items.goods.push(`実装進行中: ${inProg.length}件`);
    if (review.length >= 3) items.problems.push(`レビュー待ち積み残し: ${review.length}件`);
    if (on_hold.length > 2) items.critical.push(`保留タスク過多: ${on_hold.length}件 — 再確認が必要`);
    if (review.length > 0) items.decisions.push(`レビュー待ちを守谷 CTO に確認依頼`);
  } catch { /* ignore */ }
  return items;
}

// 品質 (守谷): レビュー・セキュリティ
function _reviewQuality() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const tm    = require('./task-manager');
    const tasks = tm.listTasks();
    const needFix = tasks.filter(t =>
      String(t.prompt || '').toLowerCase().includes('need_fix') ||
      String(t.errorType || '').includes('NEED_FIX')
    );
    if (needFix.length === 0) items.goods.push('未解決 NEED_FIX なし');
    else {
      items.problems.push(`NEED_FIX 対応中: ${needFix.length}件`);
      if (needFix.length > 2) items.critical.push('NEED_FIX が蓄積している — 守谷レビューが必要');
    }

    // Incident 品質
    const im      = require('./incident-manager');
    const open    = im._load().filter(i => i.status === 'OPEN' || i.status === 'INVESTIGATING');
    const critInc = open.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH');
    if (!open.length) items.goods.push('未解決インシデントなし');
    if (critInc.length) {
      items.critical.push(`高重要度インシデント: ${critInc.length}件 — 即時対応が必要`);
      items.decisions.push('インシデント対応の優先度判断が必要');
    }
  } catch { /* ignore */ }
  return items;
}

// 運営 (白石): ワークフロー・リソース
function _reviewOperations() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const wstate  = require('./workflow-state');
    const waiting = wstate.detectWaiting(2 * 60 * 60 * 1000); // 2時間
    if (!waiting.length) items.goods.push('ワークフロー正常 — 長待ちなし');
    else {
      items.problems.push(`未処理ハンドオフ: ${waiting.length}件`);
      if (waiting.length > 3) items.critical.push('ハンドオフが詰まっている — 黒川に配送確認依頼');
    }

    const wsm     = require('./worker-status');
    const data    = wsm._load();
    const blocked = wsm.VALID_WORKERS.filter(w => data[w]?.status === 'blocked');
    if (!blocked.length) items.goods.push('ブロック社員なし');
    else {
      const names = blocked.map(w => wsm.WORKER_DISPLAY[w] || w).join(', ');
      items.critical.push(`ブロック社員: ${names} — 即時確認が必要`);
      items.decisions.push('ブロック原因の確認と対処判断');
    }
  } catch { /* ignore */ }
  return items;
}

// 商品 (市川): Decision・Product 方針
function _reviewProduct() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const dl      = require('./decision-log');
    const active  = dl.listActiveDecisions(20);
    const product = active.filter(d => d.category === 'product' || d.tags?.includes('product'));
    if (product.length) items.goods.push(`商品関連 Decision: ${product.length}件 active`);

    // VP Review から未学習のものを確認
    const vpPath = require('path').join(__dirname, '..', '..', 'data', 'vp-reviews.json');
    const fs = require('fs');
    if (fs.existsSync(vpPath)) {
      const reviews = JSON.parse(fs.readFileSync(vpPath, 'utf8'));
      const unlearned = reviews.filter(r => !r.learning);
      if (unlearned.length > 2) {
        items.problems.push(`VP Review 未学習: ${unlearned.length}件 — CEOのフィードバックが必要`);
        items.decisions.push('!vp decide で VP Review へのフィードバックを記録');
      }
    }
  } catch { /* ignore */ }
  return items;
}

// 費用 (金森): コスト状況
function _reviewFinance() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const fm  = require('./finance-manager');
    const rep = fm.getTodaySummary ? fm.getTodaySummary() : null;
    if (rep) {
      const actualUsd = rep.actual?.usd || 0;
      if (actualUsd === 0) items.goods.push('本日の外部APIコスト: $0');
      else if (actualUsd < 1) items.goods.push(`本日の外部APIコスト: $${actualUsd.toFixed(4)}`);
      else {
        items.problems.push(`外部APIコスト: $${actualUsd.toFixed(2)}/日 — 確認推奨`);
        if (actualUsd > 5) items.critical.push('APIコストが高騰している — 金森 CFO に確認依頼');
      }
    } else {
      items.goods.push('コスト情報: 通常範囲内（詳細は !cost で確認）');
    }
  } catch {
    items.goods.push('コスト情報: 取得中（!cost で確認）');
  }
  return items;
}

// 顧客 (相沢): フィードバック・β
function _reviewCustomer() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const im   = require('./incident-manager');
    const list = im._load();
    const userFb = list.filter(i =>
      i.tags?.includes('feedback') || i.tags?.includes('user') ||
      String(i.title).includes('フィードバック')
    );
    if (!userFb.length) items.goods.push('顧客フィードバック由来のインシデントなし');

    // ユーザーフィードバック候補 (workflow)
    const wstate   = require('./workflow-state');
    const state    = wstate._load();
    const fbHandoffs = (state.handoffs || []).filter(h =>
      h.event === 'USER_FEEDBACK' && !h.resolvedAt
    );
    if (fbHandoffs.length > 0) {
      items.problems.push(`USER_FEEDBACK ハンドオフ: ${fbHandoffs.length}件 未処理`);
      items.decisions.push('ユーザーフィードバックの優先対応を検討');
    }
  } catch { /* ignore */ }
  return items;
}

// 学習 (育野): Decision・Lesson 状態
function _reviewLearning() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const dl      = require('./decision-log');
    const all     = dl._load();
    const active  = all.filter(d => dl._isActive(d));
    const archived= all.filter(d => !dl._isActive(d));
    items.goods.push(`Decision 管理: active ${active.length}件 / archived ${archived.length}件`);

    // 重複チェック
    const dups = dl.findDuplicates(active);
    if (dups.length > 0) {
      items.problems.push(`Decision 重複候補: ${dups.length}グループ`);
      items.decisions.push('!decision cleanup で整理を育野へ依頼');
    }

    // LESSONS.md 確認
    const fs   = require('fs');
    const path = require('path');
    const lp   = path.join(__dirname, '..', '..', 'LESSONS.md');
    if (fs.existsSync(lp)) {
      const size = fs.statSync(lp).size;
      if (size > 100) items.goods.push(`LESSONS.md: ${size} bytes 蓄積`);
      else items.problems.push('LESSONS.md がほぼ空です — Lesson 登録を促進');
    }
  } catch { /* ignore */ }
  return items;
}

// 進行 (黒川): Workflow・Inbox 全体
function _reviewProgress() {
  const items = { goods: [], problems: [], critical: [], decisions: [] };
  try {
    const km  = require('./kurokawa-report');
    const rep = km.generateReport();
    const { taskTotal, bottleneckCount } = rep.summary || {};
    if (taskTotal !== undefined) {
      if (bottleneckCount === 0) items.goods.push(`全体進行: ボトルネックなし (タスク${taskTotal}件)`);
      else items.problems.push(`ボトルネック: ${bottleneckCount}件 — !kurokawa report で確認`);
    }

    // sync 状況
    const fs   = require('fs');
    const path = require('path');
    const syncPath = path.join(__dirname, '..', '..', 'data', 'sync-history.json');
    if (!fs.existsSync(syncPath)) {
      items.problems.push('Company Memory Sync 未実行 — 社員の認識が古い可能性');
      items.decisions.push('!company sync で全社員に最新情報を配信');
    } else {
      const hist = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
      const last = hist.syncs?.slice(-1)[0];
      if (last) {
        const ageDays = (Date.now() - new Date(last.at).getTime()) / (24 * 60 * 60 * 1000);
        if (ageDays > 7) {
          items.problems.push(`Company Memory Sync: ${Math.floor(ageDays)}日前 — 再実行推奨`);
        } else {
          items.goods.push(`Company Memory Sync 最新 (${Math.floor(ageDays)}日前)`);
        }
      }
    }
  } catch { /* ignore */ }
  return items;
}

// ─────────────────────────────────────────────────────
// buildExecutiveReview() — 会社全体エグゼクティブレビューを生成
//
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function buildExecutiveReview() {
  const now = new Date().toLocaleString('ja-JP');

  // 8部門収集
  const dept = {
    development: _reviewDevelopment(),
    quality:     _reviewQuality(),
    operations:  _reviewOperations(),
    product:     _reviewProduct(),
    finance:     _reviewFinance(),
    customer:    _reviewCustomer(),
    learning:    _reviewLearning(),
    progress:    _reviewProgress(),
  };

  const LABELS = {
    development: '🅰️ 開発（宮城）',
    quality:     '🅱️ 品質（守谷）',
    operations:  '🅲 運営（白石）',
    product:     '🅴 商品（市川）',
    finance:     '🅵 費用（金森）',
    customer:    '🅳 顧客（相沢）',
    learning:    '🅷 学習（育野）',
    progress:    '🅶 進行（黒川）',
  };

  // 全部門から集約
  const allGoods    = [];
  const allProblems = [];
  const allCritical = [];
  const allDecisions= [];

  for (const [key, items] of Object.entries(dept)) {
    const label = LABELS[key];
    // 全カテゴリが空の部門には「情報取得中」を goods に追加（部門名を必ず出力に含める）
    const total = items.goods.length + items.problems.length + items.critical.length + items.decisions.length;
    if (total === 0) items.goods.push('（情報取得中）');
    items.goods.forEach(g    => allGoods.push(`${label}: ${g}`));
    items.problems.forEach(p => allProblems.push(`${label}: ${p}`));
    items.critical.forEach(c => allCritical.push(`${label}: ${c}`));
    items.decisions.forEach(d=> allDecisions.push(`${label}: ${d}`));
  }

  const lines = [
    `🅸 **神崎 Executive Review — 会社全体**`,
    `生成: ${now}`,
    ``,
    `**1️⃣ 今良いところ**`,
    allGoods.length
      ? allGoods.map(g => `✅ ${g}`).join('\n')
      : '（情報取得中）',
    ``,
    `**2️⃣ 問題**`,
    allProblems.length
      ? allProblems.map(p => `⚠️ ${p}`).join('\n')
      : '✅ 現在確認された問題なし',
    ``,
    `**3️⃣ 放置すると危険なこと**`,
    allCritical.length
      ? allCritical.map(c => `🔴 ${c}`).join('\n')
      : '✅ 危険な放置事項なし',
    ``,
    `**4️⃣ 次のCEO判断候補**`,
    allDecisions.length
      ? allDecisions.map((d, i) => `${i + 1}. ${d}`).join('\n')
      : '（現時点での優先判断候補なし）',
    ``,
    `---`,
    `⚠️ これは判断材料です。**CEO判断の代行ではありません。**`,
    `   最終決定: **社長（CEO）**`,
  ];

  return { ok: true, text: lines.join('\n').slice(0, 1900) };
}

module.exports = {
  buildExecutiveReview,
  // テスト用
  _reviewDevelopment,
  _reviewQuality,
  _reviewOperations,
  _reviewProduct,
  _reviewFinance,
  _reviewCustomer,
  _reviewLearning,
  _reviewProgress,
};
