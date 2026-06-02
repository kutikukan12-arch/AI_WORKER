'use strict';
// =====================================================
// store-growth.js — コトノハ Phase 4: Store Growth Manager
//
// ① auditStorePage     — 出品ページ監査 (!store audit)
// ② buildPersona       — 顧客ペルソナ分析 (!persona)
// ③ buildFAQ           — FAQ 生成 (!faq)
// ④ analyzeInquiry     — 問い合わせ分析 (!inquiry)
// ⑤ recordSalesLesson  — 営業経験保存 (!sales learn)
//
// 共通ルール:
//   ・売上より信用優先
//   ・嘘の実績・架空レビュー・誇大表現は禁止
//   ・過剰営業禁止
//   ・CEO 判断補助のみ（勝手に顧客送信しない）
//   ・個人情報保存禁止（redact 必須）
// =====================================================

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const SALES_FILE  = path.join(DATA_DIR, 'sales-learning.json');

// ─────────────────────────────────────────────────────
// ① auditStorePage — 出品ページ監査
// ─────────────────────────────────────────────────────

/** 出品文から「誰向けか」キーワードを抽出 */
function _extractTarget(text) {
  const hits = [];
  const t = text.toLowerCase();
  if (/経営者|社長|オーナー/.test(t))          hits.push('経営者・オーナー向け');
  if (/個人|フリーランス|副業/.test(t))         hits.push('個人・フリーランス向け');
  if (/中小企業|小規模|スタートアップ/.test(t)) hits.push('中小企業向け');
  if (/エンジニア|プログラマー|開発者/.test(t)) hits.push('エンジニア向け');
  if (/初心者|入門|はじめて/.test(t))           hits.push('初心者向け');
  if (/業務|社内|バックオフィス/.test(t))        hits.push('業務担当者向け');
  return hits;
}

/** 強みキーワードを抽出 */
function _extractStrengths(text) {
  const t = text.toLowerCase();
  const strengths = [];
  if (/自動化|自動|効率/.test(t))               strengths.push('作業の自動化・効率化を訴求');
  if (/シンプル|簡単|直感|使いやす/.test(t))    strengths.push('使いやすさを訴求');
  if (/対応|サポート|丁寧/.test(t))             strengths.push('サポート対応を訴求');
  if (/安い|低価格|お手軽|格安/.test(t))         strengths.push('価格の手頃さを訴求');
  if (/経験|実績|年|案件/.test(t))              strengths.push('経験・実績を訴求');
  if (/スピード|速い|迅速|短期/.test(t))         strengths.push('スピード・納期を訴求');
  return strengths;
}

/** 問題点・改善ポイントを検出 */
function _detectIssues(text) {
  const issues = [];
  const t = text;
  const len = t.length;

  if (len < 100)
    issues.push({ type: 'short', msg: '説明が短すぎる。購入者が判断できる情報が不足している可能性' });
  if (!/誰|方|人|向け|対象|お悩み/.test(t))
    issues.push({ type: 'no_target', msg: '「誰向けか」が不明確。ターゲット設定を追加推奨' });
  if (!/できます|します|提供|作成|開発|実現/.test(t))
    issues.push({ type: 'no_action', msg: '何をするか（アウトプット）の説明が弱い' });
  if (!/サンプル|例|具体|納品物|成果物|ファイル/.test(t))
    issues.push({ type: 'no_example', msg: '具体的な成果物・サンプルの記載がない' });
  if (/絶対|必ず|保証|100%/.test(t))
    issues.push({ type: 'overstate', msg: '「絶対」「保証」等の過剰表現は信頼低下リスク' });
  if (/難しい|専門的|複雑|高度/.test(t))
    issues.push({ type: 'barrier', msg: '専門的・難しいという表現が購入ハードルになる可能性' });
  if (len > 1500)
    issues.push({ type: 'too_long', msg: '説明が長すぎる。重要情報が埋もれる可能性' });

  return issues;
}

/**
 * auditStorePage(pageText)
 * → 出品ページを分析して改善案を返す
 */
function auditStorePage(pageText) {
  if (!pageText || !pageText.trim())
    return { ok: false, text: '出品文を入力してください。\n使い方: `!store audit <出品文>`' };

  const targets   = _extractTarget(pageText);
  const strengths = _extractStrengths(pageText);
  const issues    = _detectIssues(pageText);

  // 優先修正（最大3件）
  const topFixes = issues
    .filter(i => ['no_target', 'short', 'no_example'].includes(i.type))
    .slice(0, 3)
    .map((i, n) => `  ${n + 1}. ${i.msg}`);

  if (topFixes.length === 0 && issues.length > 0) {
    topFixes.push(`  1. ${issues[0].msg}`);
  }

  const lines = [
    `🏪 **出品ページ監査レポート**`,
    `> ⚠️ AI の分析結果です。嘘の実績・架空レビューの追加は禁止です。`,
    ``,
    `**✅ 良い点:**`,
    ...(strengths.length > 0
      ? strengths.map(s => `  ・${s}`)
      : ['  ・特記すべき強みが見つかりませんでした（強みを追記することを推奨）']),
    ``,
    `**👤 想定読者:**`,
    ...(targets.length > 0
      ? targets.map(t => `  ・${t}`)
      : ['  ・ターゲットが不明確です。「〜にお困りの方へ」など追記推奨']),
    ``,
    `**⚠️ 改善ポイント:**`,
    ...(issues.length > 0
      ? issues.map(i => `  ・${i.msg}`)
      : ['  ・大きな問題は見当たりません']),
    ``,
    `**🔧 優先修正（Top3）:**`,
    ...(topFixes.length > 0
      ? topFixes
      : ['  ・特になし（現状維持も可）']),
    ``,
    `**📋 追加推奨要素:**`,
    `  ・「こんな方にオススメ」セクション`,
    `  ・納品物・成果物の具体例`,
    `  ・よくある質問（!faq コマンドで自動生成可）`,
    ``,
    `> 💡 改善後は !persona で想定購入者を確認してください。`,
  ];

  return { ok: true, text: lines.join('\n'), issues, strengths, targets };
}

// ─────────────────────────────────────────────────────
// ② buildPersona — 顧客ペルソナ分析
// ─────────────────────────────────────────────────────

/**
 * buildPersona(serviceText)
 * → 想定購入者・困りごと・刺さる文章を生成
 */
function buildPersona(serviceText) {
  if (!serviceText || !serviceText.trim())
    return { ok: false, text: 'サービス説明を入力してください。\n使い方: `!persona <サービス説明>`' };

  const t = serviceText.toLowerCase();

  // サービス種別を推測
  let category = 'general';
  if (/excel|csv|集計|表計算|スプレッドシート/i.test(t)) category = 'excel';
  if (/web.*サイト|ホームページ|lp|ランディング/i.test(t)) category = 'web';
  if (/bot|discord|slack|line.*bot|自動.*通知/i.test(t)) category = 'bot';
  if (/scraping|スクレイピング|データ収集/i.test(t)) category = 'scraping';
  if (/python|プログラム|スクリプト/i.test(t)) category = 'script';

  const PERSONA_MAP = {
    excel: {
      who:     '中小企業・個人事業主の事務担当者、毎月 Excel 作業に時間を取られている方',
      pain:    '「毎月同じ集計を手動でやっていて時間がかかる」「関数が苦手」「引き継ぎが大変」',
      reason:  '「同じ作業を自動化したい」「残業を減らしたい」',
      good:    '「毎月3時間かかる集計をボタン1つに」「Excel 苦手でも安心」',
      bad:     '「Python で高度な処理ができます」「機械学習で最適化」',
    },
    web: {
      who:     '開業したばかりの個人事業主、ネットショップを始めたい方',
      pain:    '「ホームページがない」「SNS だけでは集客できない」',
      reason:  '「信頼性を高めたい」「問い合わせを増やしたい」',
      good:    '「スマホでも見やすい集客サイトを低コストで」',
      bad:     '「React/Vue で高度なSPAを構築」「SEO対策完全網羅」',
    },
    bot: {
      who:     'Discord/Slack を使っているチームや個人',
      pain:    '「毎回同じお知らせを手動で送っている」「メンバー管理が面倒」',
      reason:  '「通知を自動化したい」「管理を楽にしたい」',
      good:    '「投稿・通知・管理を Bot に任せて手間ゼロに」',
      bad:     '「WebSocket 接続・分散処理対応」',
    },
    scraping: {
      who:     'ECサイト運営者、市場調査が必要なビジネスパーソン',
      pain:    '「競合の価格を毎日手動でチェックしている」',
      reason:  '「情報収集を自動化したい」',
      good:    '「競合100社の価格を毎日自動で取得」',
      bad:     '「分散クローラーで大規模データ収集」',
    },
    script: {
      who:     'IT 担当者がいない中小企業・個人事業主',
      pain:    '「繰り返し作業に時間を使っている」「専門家に頼むほどでもない」',
      reason:  '「小さな自動化で時間を節約したい」',
      good:    '「小さな自動化で月10時間の節約」',
      bad:     '「高度なアルゴリズムで最適化」',
    },
    general: {
      who:     '非エンジニアのビジネスパーソン',
      pain:    '「技術的に難しくてできない」「外注するのが初めてで不安」',
      reason:  '「手軽に解決したい」「初めてでも安心して頼みたい」',
      good:    '「難しいことはお任せ。使うだけでOK」',
      bad:     '「高度な技術スタックを使用」',
    },
  };

  const p = PERSONA_MAP[category];

  const lines = [
    `🎯 **顧客ペルソナ分析**`,
    ``,
    `**👤 想定購入者:**`,
    `  ${p.who}`,
    ``,
    `**😥 困りごと:**`,
    `  ${p.pain}`,
    ``,
    `**💡 購入理由:**`,
    `  ${p.reason}`,
    ``,
    `**✅ 刺さる表現:**`,
    `  ⭕ 「${p.good}」`,
    ``,
    `**❌ 刺さらない表現（技術用語はNG）:**`,
    `  ❌ 「${p.bad}」`,
    ``,
    `**🔧 ペルソナに合わせた改善ポイント:**`,
    `  1. タイトルに「時間・手間・コスト」を数値で表現する`,
    `  2. 「〜にお困りの方へ」という書き出しにする`,
    `  3. 技術名ではなく「できること」を前面に出す`,
    ``,
    `> 💡 !faq コマンドで購入前 FAQ を自動生成できます。`,
  ];

  return { ok: true, text: lines.join('\n'), category };
}

// ─────────────────────────────────────────────────────
// ③ buildFAQ — FAQ 生成
// ─────────────────────────────────────────────────────

/**
 * buildFAQ(serviceText)
 * → よくある質問と回答案を生成
 */
function buildFAQ(serviceText) {
  if (!serviceText || !serviceText.trim())
    return { ok: false, text: 'サービス説明を入力してください。\n使い方: `!faq <サービス説明>`' };

  const t = serviceText.toLowerCase();
  const hasData   = /データ|csv|excel|db/i.test(t);
  const hasBug    = /バグ|不具合|エラー/i.test(t);
  const hasWeb    = /web|サイト|ページ/i.test(t);
  const hasBatch  = /自動|定期|バッチ/i.test(t);

  const faqs = [
    {
      q: '料金や追加費用はありますか？',
      a: '記載の料金に含まれる作業範囲は出品ページ通りです。追加機能や大きな仕様変更が発生した場合は事前に見積もりをお伝えします。',
    },
    {
      q: '納品まで何日かかりますか？',
      a: '内容により異なります。ご要望のヒアリング後に目安をお伝えします。急ぎの案件はご相談ください。',
    },
    {
      q: '修正はできますか？',
      a: '納品後〇日以内に1〜2回程度の軽微な修正に対応します（大幅な仕様変更は別途ご相談）。',
    },
    {
      q: '初めて外注するのですが大丈夫ですか？',
      a: 'はい、丁寧にヒアリングしながら進めますのでご安心ください。不明点はいつでも質問してください。',
    },
    {
      q: 'どこまで対応してもらえますか？',
      a: '出品ページに記載の範囲内でご対応します。範囲外の対応も相談可能ですが、別途見積もりになります。',
    },
    ...(hasData ? [{
      q: 'データは安全に扱ってもらえますか？',
      a: '納品後は受け取ったデータを当方で保持しません。必要に応じてNDA（秘密保持契約）も対応します。',
    }] : []),
    ...(hasBug ? [{
      q: 'バグが出た場合はどうなりますか？',
      a: '納品後一定期間内のバグ修正は無償対応します。期間・範囲は事前にご確認ください。',
    }] : []),
    ...(hasWeb ? [{
      q: 'スマホでも見られますか？',
      a: 'スマホ対応（レスポンシブ）が必要な場合は事前にお知らせください。',
    }] : []),
    ...(hasBatch ? [{
      q: '自動実行はどこで動きますか？',
      a: '動作環境（Windows PC / クラウド / レンタルサーバー等）によって方法が異なります。事前にご確認ください。',
    }] : []),
  ];

  const lines = [
    `❓ **購入前 FAQ（よくある質問）**`,
    `> ⚠️ 価格・納期の固定断言はしていません。状況に応じて調整してください。`,
    ``,
  ];
  faqs.slice(0, 8).forEach((f, i) => {
    lines.push(`**Q${i + 1}. ${f.q}**`);
    lines.push(`  A: ${f.a}`);
    lines.push('');
  });

  lines.push(
    `**📋 出品ページへの追加推奨:**`,
    `  ・上記 FAQ をサービス説明文の末尾に追加する`,
    `  ・「お気軽にメッセージください」と最後に一言添える`,
    ``,
    `> 💡 !store audit で出品ページ全体のチェックも行えます。`,
  );

  return { ok: true, text: lines.join('\n'), faqCount: faqs.length };
}

// ─────────────────────────────────────────────────────
// ④ analyzeInquiry — 問い合わせ分析
// ─────────────────────────────────────────────────────

/**
 * analyzeInquiry(inquiryText)
 * → 問い合わせの購入可能性・不安点・返信方針を返す
 */
function analyzeInquiry(inquiryText) {
  if (!inquiryText || !inquiryText.trim())
    return { ok: false, text: '問い合わせ文を入力してください。\n使い方: `!inquiry <問い合わせ文>`' };

  const t = inquiryText;

  // 購入可能性シグナル
  let buyScore = 0;
  const buySignals   = [];
  const warnSignals  = [];

  if (/いくら|金額|料金|費用|予算/.test(t))        { buyScore += 2; buySignals.push('価格を確認している（前向きサイン）'); }
  if (/いつ|納期|期間|いつまで|何日/.test(t))       { buyScore += 2; buySignals.push('納期を確認している（具体的に検討中）'); }
  if (/できますか|可能ですか|お願い/.test(t))        { buyScore += 1; buySignals.push('依頼意向を示す言葉がある'); }
  if (/詳しく|もう少し|教えて/.test(t))              { buyScore += 1; buySignals.push('追加情報を求めている'); }
  if (/むずかしい|難しい|複雑|わからない/.test(t))   { warnSignals.push('不安・不明点がある可能性（丁寧な説明が効果的）'); }
  if (/他にも|比較|見積もり|検討中/.test(t))         { warnSignals.push('複数業者を比較中の可能性'); }
  if (/急ぎ|すぐ|今すぐ|至急/.test(t))              { buyScore += 1; warnSignals.push('急ぎ案件（スコープ確認が重要）'); }

  // 購入可能性ラベル（参考値）
  const likelihood = buyScore >= 4 ? '高め（参考値）' : buyScore >= 2 ? 'やや高め（参考値）' : '不明（情報不足）';

  // 確認すべきこと
  const nextQuestions = [];
  if (!/具体|詳細|どんな|何を/.test(t))       nextQuestions.push('どのような作業を自動化・解決したいか');
  if (!/環境|ツール|使って/.test(t))           nextQuestions.push('現在使っている環境・ツール（Excel/Python等）');
  if (!/いつ|期限|納期/.test(t))              nextQuestions.push('完成希望時期のイメージ');
  if (nextQuestions.length === 0)             nextQuestions.push('ご要望の詳細をお聞かせください');

  const lines = [
    `📨 **問い合わせ分析**`,
    `> ⚠️ 購入可能性は参考値です。断定はできません。`,
    ``,
    `**🔍 問い合わせ要約:**`,
    `  ${inquiryText.slice(0, 100)}${inquiryText.length > 100 ? '…' : ''}`,
    ``,
    `**📊 購入可能性（参考値）:** ${likelihood}`,
    buySignals.length > 0 ? `  前向きシグナル:\n${buySignals.map(s => '  ・' + s).join('\n')}` : '',
    warnSignals.length > 0 ? `  注意点:\n${warnSignals.map(s => '  ・' + s).join('\n')}` : '',
    ``,
    `**❓ 次に確認すること:**`,
    ...nextQuestions.map((q, i) => `  ${i + 1}. ${q}`),
    ``,
    `**✉️ 返信方針:**`,
    `  1. お問い合わせへのお礼を一言`,
    `  2. 上記の確認質問を1〜2件（多すぎない）`,
    `  3. 「お気軽にご相談ください」で締める`,
    `  ※ 料金・納期はヒアリング前に断言しない`,
    ``,
    `> 💡 返信案は !proposal コマンドでも作成できます。`,
  ].filter(l => l !== '');

  return { ok: true, text: lines.join('\n'), likelihood, buyScore };
}

// ─────────────────────────────────────────────────────
// ⑤ recordSalesLesson — 営業経験保存
// ─────────────────────────────────────────────────────

function _loadSalesLessons() {
  try {
    if (!fs.existsSync(SALES_FILE)) return [];
    return JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
  } catch { return []; }
}

function _saveSalesLessons(lessons) {
  const dir = path.dirname(SALES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SALES_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(lessons, null, 2), 'utf8');
    fs.renameSync(tmp, SALES_FILE);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * recordSalesLesson(resultText, opts)
 * → 営業結果を学習データとして保存（個人情報は redact 必須）
 */
function recordSalesLesson(resultText, opts = {}) {
  if (!resultText || !resultText.trim())
    return { ok: false, text: '結果内容を入力してください。\n使い方: `!sales learn <結果>`' };

  // 保存前に redact を適用（個人情報・秘密情報を除去）
  const sanitized = redact(resultText.trim());

  const lessons  = _loadSalesLessons();
  const now      = new Date().toISOString();
  const lesson   = {
    id:        `sl_${Date.now()}`,
    savedAt:   now,
    type:      opts.type || 'general',    // 'win' / 'lose' / 'general'
    content:   sanitized.slice(0, 400),   // redact 済みテキスト
    tags:      opts.tags || [],
  };
  lessons.push(lesson);
  _saveSalesLessons(lessons);

  return {
    ok:   true,
    text: (
      `📚 **営業学習データを保存しました**\n\n` +
      `ID: \`${lesson.id}\`\n` +
      `内容（redact 済み）: ${sanitized.slice(0, 80)}${sanitized.length > 80 ? '…' : ''}\n\n` +
      `蓄積件数: ${lessons.length}件\n\n` +
      `> ✅ 個人情報・秘密情報は自動的にマスクされています。\n` +
      `> 💡 蓄積したデータを参考に !store audit で出品ページを改善できます。`
    ),
    lesson,
    totalCount: lessons.length,
  };
}

/** 営業学習データの一覧を返す */
function listSalesLessons() {
  const lessons = _loadSalesLessons();
  if (lessons.length === 0)
    return { ok: true, text: `📚 **営業学習データ** — まだデータがありません。\n\`!sales learn <結果>\` で追加できます。` };

  const lines = [`📚 **営業学習データ** (${lessons.length}件)`, ''];
  lessons.slice(-10).reverse().forEach(l => {
    lines.push(`  \`${l.id}\` ${l.savedAt.slice(0, 10)} — ${l.content.slice(0, 50)}`);
  });
  return { ok: true, text: lines.join('\n'), count: lessons.length };
}

module.exports = {
  auditStorePage,
  buildPersona,
  buildFAQ,
  analyzeInquiry,
  recordSalesLesson,
  listSalesLessons,
  // テスト用
  _loadSalesLessons,
  _saveSalesLessons,
};
