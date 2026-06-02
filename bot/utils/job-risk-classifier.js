'use strict';
// =====================================================
// job-risk-classifier.js — ココナラ案件リスク分類
//
// 目的:
//   フリーランス案件の内容を分析し、
//   受注リスクを4段階で分類してCEOが判断できる形式で出力する。
//
// 分類:
//   LOW    🟢 — 受けてOK。小規模ツール・業務改善・Excel補助など。
//   MEDIUM 🟡 — 質問してから判断。スコープ確認が必要。
//   HIGH   🟠 — 慎重に検討。契約書・要件確認が必須。
//   REJECT 🔴 — 断ることを推奨。法的リスク・技術的に不適切。
//
// 方針:
//   ・過剰 REJECT を避ける（疑問があれば MEDIUM で質問する方向）
//   ・「受ける / 質問する / 断る」がCEOに伝わる文章を出力
//   ・個人情報・決済・医療・金融・法律・本番DBを危険扱い
//   ・小規模ツール・業務効率化・Excel補助はLOW寄り
// =====================================================

const RISK_LEVEL = {
  LOW:    'LOW',
  MEDIUM: 'MEDIUM',
  HIGH:   'HIGH',
  REJECT: 'REJECT',
};

const RISK_EMOJI = {
  LOW:    '🟢',
  MEDIUM: '🟡',
  HIGH:   '🟠',
  REJECT: '🔴',
};

const RISK_ACTION = {
  LOW:    '受けてOK',
  MEDIUM: '質問してから判断',
  HIGH:   '慎重に検討・契約確認必須',
  REJECT: '断ることを推奨',
};

// ─────────────────────────────────────────────────────
// リスクシグナル定義
// ─────────────────────────────────────────────────────

// REJECT シグナル（1つでも該当なら REJECT 候補）
const REJECT_SIGNALS = [
  { pattern: /違法|脱税|詐欺|フィッシング|ハッキング|不正アクセス|クラッキング/i,
    reason: '違法行為・不正操作の疑いがある内容' },
  { pattern: /マルウェア|ランサムウェア|スパム|ボット.*攻撃|DoS|DDoS/i,
    reason: '攻撃ツール・マルウェア関連' },
  { pattern: /著作権侵害|無断コピー|コピーサイト|海賊版/i,
    reason: '著作権侵害のリスク' },
  { pattern: /出会い系|アダルト|風俗|成人向け/i,
    reason: '成人向けコンテンツ関連' },
  { pattern: /秘密情報.*横流し|内部情報.*漏洩|情報売買/i,
    reason: '機密情報の不正取得・売買' },
  { pattern: /フォロワー.*自動.*増|自動.*いいね|SNS.*規約.*無視|利用規約.*違反.*Bot|bot.*垢作成|アカウント.*量産/i,
    reason: 'SNS利用規約違反・アカウント操作ツール' },
  { pattern: /不正.*ログイン|パスワード.*クラック|ブルートフォース/i,
    reason: '不正ログイン・パスワード攻撃ツール' },
];

// HIGH シグナル（複数該当でHIGH、または単独でHIGH相当）
const HIGH_SIGNALS = [
  { pattern: /決済.*実装|payment.*system|stripe|payjp|クレジットカード.*処理|課金.*システム/i,
    reason: '決済処理の実装（PCI DSS準拠・セキュリティリスク）', weight: 3 },
  { pattern: /個人情報.*管理|マイナンバー|住所.*氏名.*電話|個人情報.*DB/i,
    reason: '個人情報の管理・処理（個人情報保護法）', weight: 3 },
  { pattern: /本番.*DB|production.*database|本番環境.*直接|本番.*サーバー.*操作/i,
    reason: '本番DBへの直接アクセス・操作', weight: 3 },
  { pattern: /医療.*システム|電子カルテ|患者.*データ|診断.*AI|医療機器/i,
    reason: '医療系システム（医師法・薬機法リスク）', weight: 3 },
  { pattern: /金融.*取引|証券.*売買|FX.*システム|仮想通貨.*取引所|crypto.*exchange/i,
    reason: '金融取引システム（金融商品取引法リスク）', weight: 3 },
  { pattern: /法律.*相談.*AI|弁護士.*代替|法的.*判断.*自動/i,
    reason: '法律判断の自動化（弁護士法違反リスク）', weight: 3 },
  { pattern: /銀行.*API|口座.*連携|振込.*自動|fintech.*銀行/i,
    reason: '銀行API連携（資金決済法・セキュリティリスク）', weight: 2 },
  { pattern: /パスワード.*管理|認証.*システム.*実装|SSO|OAuth.*実装/i,
    reason: '認証システムの実装（セキュリティ要件が高い）', weight: 2 },
  { pattern: /大量.*個人情報|数万件.*顧客|会員.*データ.*移行/i,
    reason: '大量個人情報の処理・移行', weight: 2 },
  { pattern: /インフラ.*構築|AWS.*本番|サーバー.*移行|kubernetes.*本番/i,
    reason: 'インフラ本番環境の構築・移行（障害リスク）', weight: 1 },
];

// MEDIUM シグナル
const MEDIUM_SIGNALS = [
  { pattern: /スクレイピング|クローリング|自動収集/i,
    reason: 'Webスクレイピング（利用規約・robots.txt確認が必要）', weight: 2 },
  { pattern: /API.*連携|外部サービス.*連携|webhook/i,
    reason: '外部API連携（仕様変更・レートリミットリスク）', weight: 1 },
  { pattern: /データ移行|DB.*マイグレーション|既存.*システム.*改修/i,
    reason: 'データ移行・既存システム改修（影響範囲確認が必要）', weight: 1 },
  { pattern: /自動化|RPA|バッチ処理|定期実行/i,
    reason: '自動化処理（エラー時の影響確認が必要）', weight: 1 },
  { pattern: /機械学習|AI.*開発|モデル.*作成|深層学習/i,
    reason: 'AI/ML開発（精度保証・学習データの権利確認が必要）', weight: 1 },
  { pattern: /Webシステム|管理画面|ダッシュボード.*開発/i,
    reason: 'Webシステム開発（スコープが広がりやすい）', weight: 1 },
  { pattern: /アプリ.*開発|iOS|Android|スマホ.*アプリ/i,
    reason: 'アプリ開発（申請リジェクトリスク・ストア規約確認）', weight: 1 },
  { pattern: /要件.*不明|詳細.*後日|追加.*仕様|仕様.*変更/i,
    reason: '要件・仕様が不明確（スコープクリープリスク）', weight: 2 },
];

// LOW シグナル（安全方向に引き下げる）
const LOW_SIGNALS = [
  { pattern: /Excel|スプレッドシート|Google.*Sheets|VBA|マクロ/i,
    label: 'Excel・スプレッドシート作業' },
  { pattern: /業務効率化|作業自動化|単純作業.*自動|繰り返し.*作業/i,
    label: '業務効率化ツール' },
  { pattern: /ツール.*作成|小規模.*ツール|スクリプト.*作成|CLI.*ツール/i,
    label: '小規模ツール・スクリプト' },
  { pattern: /データ整理|データ加工|CSV.*処理|データ.*クレンジング/i,
    label: 'データ整理・加工' },
  { pattern: /Bot.*Discord|Bot.*Slack|チャット.*Bot|通知.*Bot/i,
    label: 'チャットBot（小規模）' },
  { pattern: /テスト.*作成|テストコード|unit.*test|テスト.*自動化/i,
    label: 'テストコード作成' },
  { pattern: /ランディングページ|LP.*制作|静的.*サイト|HTML.*CSS/i,
    label: '静的サイト・LP制作' },
  { pattern: /コードレビュー|リファクタリング|バグ修正.*小規模/i,
    label: 'コードレビュー・小規模修正' },
];

// ─────────────────────────────────────────────────────
// 分類ロジック
// ─────────────────────────────────────────────────────
function classifyJob(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  const fullText = `${title} ${description}`;

  const rejectReasons  = [];
  const highReasons    = [];
  const mediumReasons  = [];
  const lowLabels      = [];

  let highScore = 0;
  let mediumScore = 0;

  // REJECT チェック
  for (const sig of REJECT_SIGNALS) {
    if (sig.pattern.test(fullText)) rejectReasons.push(sig.reason);
  }

  // HIGH チェック
  for (const sig of HIGH_SIGNALS) {
    if (sig.pattern.test(fullText)) {
      highReasons.push(sig.reason);
      highScore += sig.weight;
    }
  }

  // MEDIUM チェック
  for (const sig of MEDIUM_SIGNALS) {
    if (sig.pattern.test(fullText)) {
      mediumReasons.push(sig.reason);
      mediumScore += sig.weight;
    }
  }

  // LOW シグナル
  for (const sig of LOW_SIGNALS) {
    if (sig.pattern.test(fullText)) lowLabels.push(sig.label);
  }

  // ─ 総合判定 ─
  let level;
  let primaryReason;
  let questions = [];

  if (rejectReasons.length > 0) {
    level = RISK_LEVEL.REJECT;
    primaryReason = rejectReasons[0];
  } else if (highScore >= 3 || highReasons.length >= 2) {
    level = RISK_LEVEL.HIGH;
    primaryReason = highReasons[0];
  } else if (highScore >= 1 || mediumScore >= 3) {
    // HIGH シグナル weight>=3 かつ LOW 要素なし → HIGH
    // それ以外（LOW あり・軽量 HIGH・MEDIUM 多量）→ MEDIUM
    const hasHeavyHigh = highReasons.some(reason => {
      const sig = HIGH_SIGNALS.find(s => s.reason === reason);
      return sig && sig.weight >= 3;
    });
    if (hasHeavyHigh && lowLabels.length === 0) {
      level         = RISK_LEVEL.HIGH;
      primaryReason = highReasons[0];
    } else {
      level         = RISK_LEVEL.MEDIUM;
      primaryReason = highReasons[0] || mediumReasons[0] || '確認が必要';
    }
  } else if (mediumScore >= 1) {
    // MEDIUM シグナル 1つ + LOW あり → LOW に下げる
    if (lowLabels.length > 0 && mediumScore === 1) {
      level         = RISK_LEVEL.LOW;
      primaryReason = lowLabels[0];
    } else {
      level         = RISK_LEVEL.MEDIUM;
      primaryReason = mediumReasons[0];
    }
  } else {
    level = RISK_LEVEL.LOW;
    primaryReason = lowLabels.length > 0 ? lowLabels[0] : '特にリスクなし';
  }

  // 確認すべき質問を生成
  if (level === RISK_LEVEL.MEDIUM || level === RISK_LEVEL.HIGH) {
    if (highReasons.some(r => r.includes('決済')))
      questions.push('PCI DSS準拠や既存の決済代行サービス使用について確認');
    if (highReasons.some(r => r.includes('個人情報')))
      questions.push('個人情報保護方針・データの取り扱い範囲を確認');
    if (highReasons.some(r => r.includes('本番DB')))
      questions.push('本番DBへのアクセス方法・バックアップ有無を確認');
    if (mediumReasons.some(r => r.includes('スクレイピング')))
      questions.push('対象サイトの利用規約・robots.txtを確認');
    if (mediumReasons.some(r => r.includes('要件')))
      questions.push('仕様を文書化・確認してから作業開始');
    if (questions.length === 0)
      questions.push('作業スコープ・納品物・修正対応範囲を明確化');
  }

  return {
    level,
    emoji:   RISK_EMOJI[level],
    action:  RISK_ACTION[level],
    primaryReason,
    rejectReasons,
    highReasons,
    mediumReasons,
    lowLabels,
    questions,
    highScore,
    mediumScore,
  };
}

// ─────────────────────────────────────────────────────
// Discord 表示フォーマット
// ─────────────────────────────────────────────────────
function formatJobRiskReport(title, description, result) {
  const { level, emoji, action, primaryReason, rejectReasons, highReasons, mediumReasons, lowLabels, questions } = result;

  const lines = [
    `${emoji} **${level}** — ${action}`,
    ``,
    `📋 **案件:** ${title.slice(0, 60)}`,
    ``,
    `**主な判断理由:**`,
    `  ${primaryReason}`,
  ];

  if (rejectReasons.length > 0) {
    lines.push(``, `🔴 **拒否理由:**`);
    rejectReasons.forEach(r => lines.push(`  ・${r}`));
  }

  if (highReasons.length > 0) {
    lines.push(``, `🟠 **高リスク要素:**`);
    highReasons.forEach(r => lines.push(`  ・${r}`));
  }

  if (mediumReasons.length > 0 && level !== RISK_LEVEL.LOW) {
    lines.push(``, `🟡 **確認が必要な要素:**`);
    mediumReasons.slice(0, 3).forEach(r => lines.push(`  ・${r}`));
  }

  if (lowLabels.length > 0) {
    lines.push(``, `🟢 **安心要素:**`);
    lowLabels.forEach(l => lines.push(`  ・${l}`));
  }

  if (questions.length > 0) {
    lines.push(``, `❓ **受注前に確認すること:**`);
    questions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
  }

  return lines.join('\n');
}

module.exports = {
  RISK_LEVEL,
  RISK_EMOJI,
  RISK_ACTION,
  classifyJob,
  formatJobRiskReport,
};
