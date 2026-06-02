'use strict';
// =====================================================
// client-ops.js — コトノハ初案件対応 Phase 1
//
// ① analyzeRequest    — 要件整理 (!request)
// ② buildProposal     — 返信案作成 (!proposal)
// ③ checkScopeCreep   — 作業範囲肥大防止 (!scope)
// ④ buildDeliveryChecklist — 納品チェック (!delivery check)
// ⑤ buildClosingSummary   — 日次引継ぎ (!close)
//
// 共通ルール:
//   ・全部助言系（勝手に顧客送信・契約・納期断言しない）
//   ・CEO 最終判断
// =====================================================

// ─────────────────────────────────────────────────────
// ① analyzeRequest — 要件整理
// ─────────────────────────────────────────────────────

/** 依頼テキストから機能キーワードを抽出（簡易ルールベース） */
function _extractFeatures(text) {
  const features = [];
  const t = text.toLowerCase();
  if (/自動化|自動|バッチ|定期/.test(t))          features.push('自動化・バッチ処理');
  if (/通知|メール|slack|discord|line/.test(t))    features.push('通知機能');
  if (/管理.*画面|ダッシュボード|一覧/.test(t))    features.push('管理画面・一覧表示');
  if (/csv|excel|スプレッドシート/.test(t))        features.push('CSV / Excel 連携');
  if (/api|連携|webhookwebhook/.test(t))           features.push('外部API連携');
  if (/登録|編集|削除|crud/.test(t))               features.push('データ登録・編集・削除（CRUD）');
  if (/検索|フィルタ|絞り込み/.test(t))            features.push('検索・フィルタ機能');
  if (/ログイン|認証|ユーザー管理/.test(t))        features.push('ログイン・認証');
  if (/レポート|集計|グラフ|分析/.test(t))         features.push('レポート・集計');
  if (/スクレイピング|収集|クローリング/.test(t))  features.push('データ収集・スクレイピング');
  return features;
}

/** 不足情報・確認質問を生成 */
function _generateQuestions(text) {
  const questions = [];
  const t = text.toLowerCase();

  // 規模不明
  if (!/[0-9]件|[0-9]人|[0-9]万|大規模|小規模|少量/.test(t))
    questions.push({ q: 'どのくらいのデータ量・利用人数を想定していますか？\n   例: 月100件程度 / 社内5名で使用', why: 'スコープ見積もりに必要' });

  // 環境不明
  if (!/windows|mac|linux|aws|azure|gcp|heroku|vps|レンタルサーバー/.test(t))
    questions.push({ q: 'どこで動かしたいですか？\n   例: 自分のPC / レンタルサーバー / クラウド', why: '技術選定に関わる' });

  // 既存システム
  if (/改修|追加|連携|既存/.test(t) && !/ゼロから|新規/.test(t))
    questions.push({ q: '現在使っているシステムやコードはありますか？\n   例: Excelファイル / 既存のWebシステム', why: '影響範囲の把握に必要' });

  // 納期不明
  if (!/[0-9]月|[0-9]週|[0-9]日以内|急ぎ|余裕/.test(t))
    questions.push({ q: 'いつまでに欲しいですか？（目安で構いません）\n   例: 2週間後 / 来月末', why: '作業計画に必要' });

  // 予算不明（提案時に重要）
  if (!/円|万円|予算|[0-9]k/.test(t))
    questions.push({ q: '予算のご希望はありますか？（なければ概算見積もりを出します）', why: '提案内容の調整に必要' });

  return questions.slice(0, 4); // 最大4問
}

/** リスクを検出 */
function _detectRisks(text) {
  const risks = [];
  const t = text.toLowerCase();
  if (/個人情報|氏名|住所|電話番号|メールアドレス.*大量/.test(t))
    risks.push('個人情報を扱う → セキュリティ要件を事前確認');
  if (/決済|クレジット|stripe|paypal/.test(t))
    risks.push('決済処理 → PCI DSS / 責任範囲を明確化');
  if (/スクレイピング|自動収集/.test(t))
    risks.push('スクレイピング → 対象サイトの利用規約を確認');
  if (/追加.*仕様|要件.*変更|後で.*変える/.test(t))
    risks.push('要件変更リスク → 変更時の追加費用ルールを決める');
  if (/急ぎ|急いで|今すぐ|すぐに/.test(t))
    risks.push('短納期リスク → 実現可能なスコープを絞る');
  if (/全部.*やって|なんでも|何でも/.test(t))
    risks.push('スコープ肥大リスク → 機能一覧を文書化して合意');
  return risks;
}

/**
 * analyzeRequest(requestText)
 * → 依頼内容を分析して要件整理テキストを返す
 */
function analyzeRequest(requestText) {
  if (!requestText || !requestText.trim())
    return { ok: false, text: '依頼内容が空です。' };

  const features   = _extractFeatures(requestText);
  const questions  = _generateQuestions(requestText);
  const risks      = _detectRisks(requestText);

  const lines = [
    `📋 **要件整理レポート**`,
    ``,
    `**📌 依頼の要点（推測）:**`,
    `  ${requestText.slice(0, 120)}${requestText.length > 120 ? '…' : ''}`,
    ``,
  ];

  if (features.length > 0) {
    lines.push(`**⚙️ 想定機能:**`);
    features.forEach(f => lines.push(`  ・${f}`));
    lines.push('');
  }

  if (questions.length > 0) {
    lines.push(`**❓ 顧客への確認質問（${questions.length}件・優先順）:**`);
    questions.forEach((q, i) => {
      lines.push(``, `  **Q${i + 1}.** ${q.q}`);
    });
    lines.push('');
  } else {
    lines.push(`**❓ 確認質問:** 特になし（情報が十分です）`, '');
  }

  if (risks.length > 0) {
    lines.push(`**⚠️ リスク:**`);
    risks.forEach(r => lines.push(`  ・${r}`));
    lines.push('');
  }

  lines.push(`> ⚠️ これは AI の分析結果です。顧客送信前に内容を確認・編集してください。`);

  return { ok: true, text: lines.join('\n'), features, questions, risks };
}

// ─────────────────────────────────────────────────────
// ② buildProposal — 返信案作成
// ─────────────────────────────────────────────────────

/**
 * buildProposal(projectContent)
 * → 顧客への最初の返信案を生成（CEO 確認前提）
 */
function buildProposal(projectContent) {
  if (!projectContent || !projectContent.trim())
    return { ok: false, text: '案件内容が空です。' };

  const lines = [
    `📝 **返信案（下書き）**`,
    `> ⚠️ CEO 確認後に送信してください。価格・納期は記載していません。`,
    ``,
    `---`,
    ``,
    `この度はご依頼いただき、ありがとうございます。`,
    ``,
    `いただいた内容を確認しました。`,
    `【ご依頼内容の理解】`,
    `${projectContent.slice(0, 200)}${projectContent.length > 200 ? '…' : ''}`,
    ``,
    `スムーズに進めるために、いくつか確認させてください。`,
    ``,
  ];

  // 案件内容から確認ポイントを生成
  const questions = _generateQuestions(projectContent);
  if (questions.length > 0) {
    questions.slice(0, 3).forEach((q, i) => {
      lines.push(`${i + 1}. ${q.q}`);
      lines.push('');
    });
  } else {
    lines.push(`1. どのような環境で動かす予定ですか？`);
    lines.push('');
  }

  lines.push(
    `上記をご確認いただけますと、より正確な見積もりと提案ができます。`,
    ``,
    `どうぞよろしくお願いいたします。`,
    ``,
    `---`,
    ``,
    `> ✏️ 編集箇所: 確認質問の内容、自己紹介、署名などを追加してください。`,
    `> ❌ 禁止: 納期・金額の断言、契約確定の表現`
  );

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// ③ checkScopeCreep — 作業範囲肥大防止
// ─────────────────────────────────────────────────────

const SCOPE_LEVEL = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };
const SCOPE_EMOJI = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🔴' };
const SCOPE_ACTION = {
  LOW:    '軽微な変更 — 対応可。作業記録を残してください。',
  MEDIUM: '追加見積もり候補 — 元の見積もりに含まれるか確認を。',
  HIGH:   '別案件化を推奨 — 現行契約の範囲外として別途提案を。',
};

function _estimateScopeRisk(original, newReq) {
  const t = newReq.toLowerCase();
  let score = 0;
  const reasons = [];

  // 新技術・新機能
  if (/新しい|追加.*機能|新機能|別.*機能/.test(t)) { score += 2; reasons.push('新機能の追加要求'); }
  if (/画面.*追加|ページ.*追加|新しい.*画面/.test(t)) { score += 2; reasons.push('画面・ページの追加'); }
  if (/api|連携.*新しい|別.*サービス/.test(t)) { score += 2; reasons.push('新しいAPI連携'); }

  // 仕様変更
  if (/変更|変えて|修正.*大きい|やり直し/.test(t)) { score += 2; reasons.push('大きな仕様変更'); }
  if (/最初.*違う|話が違う|聞いてない/.test(t)) { score += 3; reasons.push('当初要件との乖離'); }

  // 緊急度・工数
  if (/急ぎ|至急|すぐ|今日中/.test(t)) { score += 1; reasons.push('緊急対応'); }
  if (/全部|全て|すべて|なんでも/.test(t)) { score += 2; reasons.push('「全部やって」系の曖昧な要求'); }

  // 元の要件との差分（文字数ベースの簡易比較）
  const addedLength = newReq.length;
  if (addedLength > 300) { score += 2; reasons.push('追加依頼の内容が多い'); }
  else if (addedLength > 100) { score += 1; reasons.push('追加依頼あり'); }

  let level = SCOPE_LEVEL.LOW;
  if (score >= 5) level = SCOPE_LEVEL.HIGH;
  else if (score >= 2) level = SCOPE_LEVEL.MEDIUM;

  return { level, score, reasons };
}

/**
 * checkScopeCreep(original, newRequest)
 * → 追加依頼が元の範囲に収まるかを判定
 */
function checkScopeCreep(original, newRequest) {
  if (!original || !newRequest)
    return { ok: false, text: '元の仕様と追加依頼の両方を入力してください。' };

  const { level, score, reasons } = _estimateScopeRisk(original, newRequest);
  const emoji  = SCOPE_EMOJI[level];
  const action = SCOPE_ACTION[level];

  const lines = [
    `${emoji} **スコープ判定: ${level}**`,
    ``,
    `**📋 元の依頼:**`,
    `  ${original.slice(0, 100)}${original.length > 100 ? '…' : ''}`,
    ``,
    `**➕ 追加依頼:**`,
    `  ${newRequest.slice(0, 100)}${newRequest.length > 100 ? '…' : ''}`,
    ``,
    `**判定:** ${action}`,
    ``,
  ];

  if (reasons.length > 0) {
    lines.push(`**⚠️ 判定根拠:**`);
    reasons.forEach(r => lines.push(`  ・${r}`));
    lines.push('');
  }

  if (level === SCOPE_LEVEL.MEDIUM) {
    lines.push(
      `**💡 推奨アクション:**`,
      `  1. 当初見積もりに含まれるか確認`,
      `  2. 含まれない場合は追加費用として提示`,
      `  3. 口頭で「含まれます」と言わず文面で確認`,
      ``
    );
  } else if (level === SCOPE_LEVEL.HIGH) {
    lines.push(
      `**💡 推奨アクション:**`,
      `  1. 「ご要望は新しい案件としてお受けします」と返信`,
      `  2. 別途見積もりを提示`,
      `  3. 現行の作業は元の仕様通り完了`,
      ``
    );
  }

  lines.push(`> ⚠️ 判定はあくまで参考です。最終判断は社長が行ってください。`);

  return { ok: true, text: lines.join('\n'), level, reasons };
}

// ─────────────────────────────────────────────────────
// ④ buildDeliveryChecklist — 納品チェック
// ─────────────────────────────────────────────────────

/**
 * buildDeliveryChecklist(projectName)
 * → 納品前チェックリストを返す（助言のみ・自動納品しない）
 */
function buildDeliveryChecklist(projectName = '（プロジェクト名未指定）') {
  const lines = [
    `📦 **納品チェックリスト** — ${projectName}`,
    `> ⚠️ これは助言チェックリストです。自動納品は行いません。`,
    ``,
    `**📄 ドキュメント**`,
    `  □ README.md（セットアップ手順・使い方）`,
    `  □ 起動方法・実行コマンドが明記されている`,
    `  □ 必要な設定値（.env 項目など）の説明がある`,
    `  □ 外部サービスが必要な場合は取得方法を説明`,
    ``,
    `**🔒 セキュリティ**`,
    `  □ APIキー・トークンがコードに直書きされていない`,
    `  □ .env ファイルがコード・納品物に含まれていない`,
    `  □ Secret Guardian を通過している（\`node scripts/security-scan.js\`）`,
    `  □ .gitignore が適切に設定されている`,
    ``,
    `**✅ 品質**`,
    `  □ 最低限の動作確認済み（バグなし）`,
    `  □ テストコードがある場合はすべて通過`,
    `  □ エラー時のメッセージが分かりやすい`,
    `  □ 依頼内容の機能が全て実装されている`,
    ``,
    `**📁 納品ファイル**`,
    `  □ 不要なファイル（デバッグログ・一時ファイル）を削除`,
    `  □ node_modules / .git は納品に含めない`,
    `  □ 納品形式の確認（zip / GitHub リンク / ファイル直接）`,
    ``,
    `**💬 顧客確認**`,
    `  □ 納品前に動作確認を依頼・承認を得る`,
    `  □ 修正対応の範囲を事前に合意している`,
    `  □ 質問窓口・サポート期間を伝える`,
    ``,
    `> ✅ 全項目確認後、社長の最終判断で納品してください。`,
  ];

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// ⑤ buildClosingSummary — 日次引継ぎ
// ─────────────────────────────────────────────────────

/**
 * buildClosingSummary(opts)
 * → 今日の作業まとめ・明日の引継ぎを生成
 *
 * opts: { taskManager, projectManager, projectId? }
 */
function buildClosingSummary(opts = {}) {
  const { taskManager, projectManager, projectId } = opts;

  let doneToday  = [];
  let remaining  = [];
  let blockItems = [];

  try {
    if (taskManager) {
      const all   = taskManager.listTasks();
      const tasks = projectId && projectManager
        ? projectManager.filterTasksByProject(all, projectId)
        : all;

      // 直近の ON_HOLD（完了・失敗）をざっくり「今日対処」として扱う
      const recentOnHold = tasks
        .filter(t => t.state === taskManager.STATES.ON_HOLD)
        .slice(-5)
        .map(t => `[${t.type||'?'}] ${(t.prompt||'').slice(0, 40)}`);
      doneToday = recentOnHold;

      // PENDING が残タスク
      remaining = tasks
        .filter(t => t.state === taskManager.STATES.PENDING)
        .slice(0, 8)
        .map(t => `[${t.type||'?'}/優先度:${t.priority||'?'}] ${(t.prompt||'').slice(0, 40)}`);

      // AWAITING・IN_PROGRESS がブロック
      blockItems = tasks
        .filter(t => [taskManager.STATES.AWAITING, taskManager.STATES.IN_PROGRESS].includes(t.state))
        .map(t => `\`${t.id}\` [${t.state}]`);
    }
  } catch { /* タスク取得失敗はスキップ */ }

  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });

  const lines = [
    `📅 **日次クロージング — ${today}**`,
    ``,
  ];

  if (doneToday.length > 0) {
    lines.push(`**✅ 今日完了・対処:**`);
    doneToday.forEach(t => lines.push(`  ・${t}`));
    lines.push('');
  } else {
    lines.push(`**✅ 今日完了・対処:** （ログなし / 直接 !task list で確認）`, '');
  }

  if (blockItems.length > 0) {
    lines.push(`**⚠️ ブロック中（要確認）:**`);
    blockItems.forEach(t => lines.push(`  ・${t}`));
    lines.push('');
  }

  if (remaining.length > 0) {
    lines.push(`**📋 残タスク（明日の候補）:**`);
    remaining.slice(0, 5).forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
    lines.push('');
  } else {
    lines.push(`**📋 残タスク:** なし（または !task list で確認）`, '');
  }

  lines.push(
    `**🤖 明日の AI 分担（案）:**`,
    `  🅰️ Claude A: 実装・コード修正・テスト`,
    `  🅱️ Claude B: レビュー・監査・品質確認`,
    `  🅲 Claude C: 設計・提案・ドキュメント`,
    ``,
    `**⚡ 明日のおすすめ最優先 Top 3:**`,
    `  1. 残タスクの上位を \`!project run\` で実行`,
    `  2. HUMAN_CHECK 案件があれば \`!approve\` / \`!deny\``,
    `  3. ブロック案件の解決`,
    ``,
    `> 💡 コトノハ案件があれば \`!job\` でリスク確認、\`!request\` で要件整理をどうぞ。`
  );

  return { ok: true, text: lines.join('\n') };
}

module.exports = {
  analyzeRequest,
  buildProposal,
  checkScopeCreep,
  buildDeliveryChecklist,
  buildClosingSummary,
  SCOPE_LEVEL,
};
