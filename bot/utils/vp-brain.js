'use strict';
// =====================================================
// vp-brain.js — 神崎 VP Brain (Phase1)
//
// 目的:
//   神崎を単なる役職から、社長の判断補佐AIへ育成する。
//   トピックを受け取り、各AI社員の視点を整理し、
//   A/B案比較と推奨を提示する。
//
// 禁止:
//   ❌ 自動実行（タスク追加・Decision確定・承認）
//   ❌ CEO最終判断の代行
//   ❌ LLM/外部API呼び出し（ルールベース生成のみ）
//   ❌ eval / exec
//
// 学習:
//   CEOが選んだ案・選ばなかった案・理由を保存し
//   将来の判断品質向上に使う（自動適用しない）
//
// データ: data/vp-reviews.json (gitignore)
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR      = path.join(__dirname, '..', '..', 'data');
const REVIEWS_FILE  = path.join(DATA_DIR, 'vp-reviews.json');

// ─── ID 生成 ──────────────────────────────────────────
function _generateId(list) {
  const existing = new Set(list.map(r => r.id));
  for (let i = 0; i < 100; i++) {
    const suffix = Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
    const id     = `vpr_${Date.now()}${suffix}`;
    if (!existing.has(id)) return id;
  }
  return `vpr_${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
}

// ─────────────────────────────────────────────────────
// ファイル操作
// ─────────────────────────────────────────────────────
function _load() {
  try {
    if (!fs.existsSync(REVIEWS_FILE)) return [];
    return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  } catch { return []; }
}

function _save(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = REVIEWS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, REVIEWS_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────
// キーワードベースの視点生成
//
// 各AI社員の役割視点からトピックを分析し
// テンプレートベースの意見文を返す。
// LLM不使用・ルールベースのみ。
// ─────────────────────────────────────────────────────
const TOPIC_MATCHERS = {
  product:  /商品|機能|ユーザー|顧客|MVP|リリース|公開|β|販売|収益|課金|サービス/,
  cost:     /コスト|費用|予算|API|token|課金|月額|円|ROI|利益|損失|外部/,
  ops:      /運用|保守|スケール|肥大|複雑|工数|リソース|削除|整理|統合/,
  tech:     /実装|開発|設計|セキュリティ|品質|バグ|テスト|パフォーマンス|アーキ|依存/,
  strategy: /方針|優先|ロードマップ|戦略|長期|短期|判断|方向/,
};

function _detectTopics(text) {
  const lower = text.toLowerCase();
  return Object.entries(TOPIC_MATCHERS)
    .filter(([, re]) => re.test(text) || re.test(lower))
    .map(([k]) => k);
}

// 市川 PM の視点
function _ichikawaPerspective(topic, topics) {
  const parts = [];
  if (topics.includes('product')) {
    parts.push('ユーザーにとっての価値を最優先に検討すべき');
    parts.push('MVP範囲を絞ることで早期検証が可能になる');
  } else {
    parts.push('商品価値・ユーザーニーズの観点での影響を確認が必要');
  }
  if (topics.includes('strategy')) {
    parts.push('現在のMVP方針との整合性を確認すること');
  }
  return parts.slice(0, 2).join('\n  ');
}

// 金森 CFO の視点
function _kanemoriPerspective(topic, topics) {
  const parts = [];
  if (topics.includes('cost')) {
    parts.push('費用対効果の試算が必要。継続的コストに注意');
    parts.push('外部API依存はランニングコストとなる点を考慮');
  } else {
    parts.push('コスト発生・ROI・予算影響の試算が必要');
  }
  if (topics.includes('product')) {
    parts.push('収益化タイミングと費用回収の見通しを確認');
  }
  return parts.slice(0, 2).join('\n  ');
}

// 白石 COO の視点
function _shiraishiPerspective(topic, topics) {
  const parts = [];
  if (topics.includes('ops')) {
    parts.push('運用負荷と肥大化リスクを評価すること');
    parts.push('既存フローへの影響と移行コストを考慮');
  } else {
    parts.push('実行可能性と運用継続性の観点からの評価が必要');
  }
  if (topics.includes('strategy')) {
    parts.push('優先順位と現リソース配分との整合性を確認');
  }
  return parts.slice(0, 2).join('\n  ');
}

// 育野 Learning Manager の視点（過去 Decision 参照）
function _ikunoPerspective(topic, topics) {
  try {
    const dl      = require('./decision-log');
    const active  = dl.listActiveDecisions(30);
    // トピックと関連する過去 Decision を検索
    const related = active.filter(d =>
      topics.some(t => {
        const lower = d.title.toLowerCase() + ' ' + (d.summary || '').toLowerCase();
        return lower.includes(t);
      })
    ).slice(-2);
    if (related.length > 0) {
      return related.map(d => `過去Decision「${d.title.slice(0, 40)}」が参考になります`).join('\n  ');
    }
  } catch { /* ignore */ }
  return '関連する過去の Decision を確認し、整合性を保ってください';
}

// 守谷 CTO の視点
function _moriyaPerspective(topic, topics) {
  const parts = [];
  if (topics.includes('tech')) {
    parts.push('技術的負債・セキュリティリスクの評価が必要');
    parts.push('品質基準・テストカバレッジへの影響を確認');
  } else {
    parts.push('技術的実現性・品質・セキュリティへの影響を評価');
  }
  if (topics.includes('cost')) {
    parts.push('外部API依存によるセキュリティ境界の変化に注意');
  }
  return parts.slice(0, 2).join('\n  ');
}

// ─────────────────────────────────────────────────────
// 選択肢生成
//
// トピックのキーワードから A案/B案 を生成する。
// 汎用的に: A案=積極推進 / B案=段階的・保留
// ─────────────────────────────────────────────────────
function _buildOptions(topic, topics) {
  // A案: 積極推進系
  const aOption = {
    label:   'A案: 推進・実装を進める',
    merit:   [],
    risk:    [],
  };
  // B案: 慎重・段階系
  const bOption = {
    label:   'B案: 段階的対応または保留',
    merit:   [],
    risk:    [],
  };

  if (topics.includes('product')) {
    aOption.merit.push('ユーザー価値を早期提供できる');
    aOption.risk.push('範囲が広がりMVPから逸脱するリスク');
    bOption.merit.push('MVP検証を先行させてから追加判断できる');
    bOption.risk.push('競合優位性を失う可能性');
  }
  if (topics.includes('cost')) {
    aOption.merit.push('機能充実により収益機会が拡大する');
    aOption.risk.push('コスト増加・ROI回収が遅れるリスク');
    bOption.merit.push('コストリスクを最小化できる');
    bOption.risk.push('機能不足でユーザー離脱の可能性');
  }
  if (topics.includes('tech')) {
    aOption.merit.push('技術的課題を先行解決できる');
    aOption.risk.push('品質・テスト工数が増加する');
    bOption.merit.push('既存実装を安定させてから対応できる');
    bOption.risk.push('技術負債が蓄積するリスク');
  }
  if (topics.includes('ops')) {
    aOption.merit.push('運用効率が長期的に向上する');
    aOption.risk.push('移行・整理工数が発生する');
    bOption.merit.push('現状維持でリスクを最小化できる');
    bOption.risk.push('肥大化が継続するリスク');
  }

  // デフォルト（キーワードなし）
  if (!aOption.merit.length) aOption.merit.push('目標達成に向けて前進できる');
  if (!aOption.risk.length)  aOption.risk.push('リソース集中によるリスクが伴う');
  if (!bOption.merit.length) bOption.merit.push('リスクを抑えた慎重な対応ができる');
  if (!bOption.risk.length)  bOption.risk.push('機会損失や遅延のリスクがある');

  return { aOption, bOption };
}

// ─────────────────────────────────────────────────────
// 神崎の推奨生成
//
// 注意: 推奨はあくまで「材料提示」であり「決定」ではない。
// ─────────────────────────────────────────────────────
function _buildRecommendation(topic, topics, opts) {
  // 技術リスクや大コストが伴う場合はB案推奨傾向
  const isRisky  = topics.includes('tech') && topics.includes('cost');
  const isUrgent = /緊急|早急|急|今すぐ|先行|競合/.test(topic);

  if (isUrgent) {
    return {
      recommend: 'A案を優先的に検討',
      reason:    '緊急性・競合対応の観点から早期推進が望ましい。ただし品質・コストの段階的確認を推奨。',
    };
  }
  if (isRisky) {
    return {
      recommend: 'B案を優先的に検討',
      reason:    '技術リスクとコスト双方を抱えるため、段階的アプローチで検証を先行させることを推奨。',
    };
  }
  // デフォルト: 状況依存
  return {
    recommend: 'A案・B案の兼用（段階的A案）',
    reason:    `当面はB案でリスクを抑えつつ、検証後にA案へ移行する段階的アプローチを推奨。${
      topics.includes('product') ? 'ユーザー価値の早期確認が判断の鍵。' : ''
    }`,
  };
}

// ─────────────────────────────────────────────────────
// buildReview(topic) — VP レビューを生成・保存
//
// topic: 相談テーマ
// 戻り値: { ok, id, text, review }
// ─────────────────────────────────────────────────────
function buildReview(topic) {
  if (!topic || !String(topic).trim()) {
    return {
      ok:   false,
      text: '❌ トピックは必須です。\n`!vp review <相談テーマ>` で実行してください。',
    };
  }

  const safeTopic = redact(String(topic).trim()).slice(0, 300);
  const topics    = _detectTopics(safeTopic);
  const { aOption, bOption } = _buildOptions(safeTopic, topics);
  const recommendation       = _buildRecommendation(safeTopic, topics, { aOption, bOption });

  // 各社員の視点
  const perspectives = {
    ichikawa:  _ichikawaPerspective(safeTopic, topics),
    kanemori:  _kanemoriPerspective(safeTopic, topics),
    shiraishi: _shiraishiPerspective(safeTopic, topics),
    moriya:    _moriyaPerspective(safeTopic, topics),
    ikuno:     _ikunoPerspective(safeTopic, topics),
  };

  // Discord 表示テキスト生成
  const now   = new Date().toLocaleString('ja-JP');
  const text  = [
    `🅸 **神崎 VP Review**`,
    `生成: ${now}`,
    ``,
    `**【状況整理】**`,
    ``,
    `テーマ: ${safeTopic}`,
    ``,
    `現在: このテーマについて社長の判断が必要な状況です。`,
    `各AI社員の視点を整理し、判断材料を提供します。`,
    ``,
    `**【社員意見】**`,
    ``,
    `🅴 市川 PM（商品観点）:`,
    `  ${perspectives.ichikawa}`,
    ``,
    `🅵 金森 CFO（費用観点）:`,
    `  ${perspectives.kanemori}`,
    ``,
    `🅲 白石 COO（運用観点）:`,
    `  ${perspectives.shiraishi}`,
    ``,
    `🅱️ 守谷 CTO（技術リスク）:`,
    `  ${perspectives.moriya}`,
    ``,
    `🅷 育野 Learning（過去 Decision）:`,
    `  ${perspectives.ikuno}`,
    ``,
    `**【選択肢】**`,
    ``,
    `**${aOption.label}**`,
    `  メリット: ${aOption.merit.join(' / ')}`,
    `  リスク:   ${aOption.risk.join(' / ')}`,
    ``,
    `**${bOption.label}**`,
    `  メリット: ${bOption.merit.join(' / ')}`,
    `  リスク:   ${bOption.risk.join(' / ')}`,
    ``,
    `**【神崎提案】**`,
    ``,
    `推奨: **${recommendation.recommend}**`,
    `理由: ${recommendation.reason}`,
    ``,
    `⚠️ これは「提案」です。**決定ではありません。**`,
    `   最終判断: **CEO（社長）**`,
    ``,
    `> 判断後: \`!vp decide <review_id> <A|B|none> [理由]\` で学習記録ができます。`,
  ].join('\n');

  // 保存
  const list = _load();
  const review = {
    id:           _generateId(list),
    createdAt:    new Date().toISOString(),
    topic:        safeTopic,
    detectedTopics: topics,
    perspectives,
    options: { a: aOption, b: bOption },
    recommendation,
    learning:     null,  // CEOが !vp learn で記録する
  };
  list.push(review);
  // 直近100件を保持
  if (list.length > 100) list.splice(0, list.length - 100);
  _save(list);

  return { ok: true, id: review.id, text, review };
}

// ─────────────────────────────────────────────────────
// recordLearning(id, chosen, reason) — CEOの選択を記録
//
// id:     vpr_ 形式の review ID
// chosen: 'A' / 'B' / 'none'
// reason: 選んだ理由（任意）
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function recordLearning(id, chosen, reason) {
  if (!id) return { ok: false, text: '使い方: `!vp learn <id> <A|B|none> [理由]`' };

  const upper = String(chosen || '').toUpperCase().trim();
  if (!['A', 'B', 'NONE'].includes(upper)) {
    return {
      ok:   false,
      text: `❌ chosen は A / B / none のいずれかを指定してください。`,
    };
  }

  const list = _load();
  const idx  = list.findIndex(r => r.id === id || r.id.endsWith(id));
  if (idx < 0) {
    return {
      ok:   false,
      text: `❌ \`${id}\` が見つかりません。\`!vp list\` で確認してください。`,
    };
  }

  const safeReason = redact(String(reason || '').trim()).slice(0, 300);
  list[idx].learning = {
    chosen:     upper,
    reason:     safeReason,
    recordedAt: new Date().toISOString(),
  };
  _save(list);

  return {
    ok:   true,
    text: [
      `📚 **VP Learning 記録済み**`,
      ``,
      `Review ID: \`${list[idx].id}\``,
      `テーマ: ${list[idx].topic.slice(0, 60)}`,
      `選択: **${upper}案**`,
      safeReason ? `理由: ${safeReason}` : '',
      ``,
      `> この選択は神崎の将来判断品質向上に使われます（自動適用しません）。`,
    ].filter(l => l !== '').join('\n'),
  };
}

// ─────────────────────────────────────────────────────
// listReviews(limit) — 最近の VP Review 一覧
// ─────────────────────────────────────────────────────
function listReviews(limit = 5) {
  const list = _load();
  if (!list.length) {
    return { ok: true, text: '📋 VP Review はまだありません。\n`!vp review <テーマ>` で実行してください。' };
  }
  const recent = [...list].reverse().slice(0, limit);
  const lines  = [`📋 **VP Review 一覧** (直近 ${recent.length} 件 / 合計 ${list.length} 件)`, ``];
  for (const r of recent) {
    const date    = new Date(r.createdAt).toLocaleDateString('ja-JP');
    const learned = r.learning ? `✅ ${r.learning.chosen}案` : '⏳ 未学習';
    lines.push(`${learned} \`${r.id}\``);
    lines.push(`   ${r.topic.slice(0, 60)}  (${date})`);
    lines.push('');
  }
  return { ok: true, text: lines.join('\n').trimEnd() };
}

// Phase3: !vp decide は !vp learn の別名（同じ機能）
const decideVP = recordLearning;

module.exports = {
  buildReview,
  recordLearning,
  decideVP,
  listReviews,
  REVIEWS_FILE,
  // テスト用
  _load,
  _save,
  _detectTopics,
  _buildOptions,
  _buildRecommendation,
  _ikunoPerspective,
};
