'use strict';
// =====================================================
// refine-gap-analyzer.js — !project refine 優先順位付き Gap 分析
//
// 目的:
//   !project refine で「一般的な次ステップ」ではなく
//   「PM/Product監査で発覚した重大欠陥」を優先する。
//
// 参照データ（優先度順）:
//   1. Human feedback（CEO指摘）    ← project-insights.json
//   2. Product Audit                ← project-insights.json
//   3. PM Audit                     ← project-insights.json
//   4. Original requirements        ← project-insights.json
//   5. AI Board Report（Board Status）
//   6. Quality indicators（エラー率・REVIEW失敗）
//   7. reviews/result_*.md（Codex REVIEW 結果）
//   8. 完了タスク履歴・プロジェクト目的
//
// 優先順位:
//   P1 コア価値未達    — Human feedback / Product/PM Audit の critical
//   P2 致命的不具合    — 失敗タスク・品質RED・REVIEW高危険度・blocker insight
//   P3 受け入れ条件不足 — Requirements / TEST/DOCS/REVIEW が欠けている
//   P4 UX              — UI・ユーザー向け機能の欠如
//   P5 Docs            — ドキュメント・README 不足
//
// タスク0件=完成ではなく、目的との差分から生成する。
// =====================================================

const fs   = require('fs');
const path = require('path');

const PRIORITY_CATEGORY = {
  P1: { label: 'コア価値未達',     rank: 1, priority: '高' },
  P2: { label: '致命的不具合',     rank: 2, priority: '高' },
  P3: { label: '受け入れ条件不足', rank: 3, priority: '中' },
  P4: { label: 'UX',              rank: 4, priority: '中' },
  P5: { label: 'Docs',            rank: 5, priority: '低' },
};

// ─────────────────────────────────────────────────────
// REVIEW 結果ファイルを走査して問題タスクを収集
// ─────────────────────────────────────────────────────
function collectReviewIssues(reviewsDir, projectId, taskManager, projectManager) {
  const issues = [];
  try {
    if (!fs.existsSync(reviewsDir)) return issues;
    const files = fs.readdirSync(reviewsDir)
      .filter(f => f.startsWith('result_') && f.endsWith('.md'))
      .slice(-30); // 直近30件

    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(reviewsDir, f), 'utf8');
        // 危険度を抽出
        const dangerMatch = content.match(/危険度\s+\|\s*(?:🔴|🟡|🟢)?\s*(高|中|低)/);
        if (!dangerMatch) continue;
        const danger = dangerMatch[1];
        if (danger !== '高' && danger !== '中') continue; // 低は無視

        // 問題点を抽出
        const problemMatch = content.match(/## 問題点\n+([\s\S]*?)(?=## |$)/);
        const problem = (problemMatch?.[1] || '').trim();
        if (!problem || problem === '（なし）') continue;

        // タスクIDを抽出
        const idMatch = f.match(/result_(task_\d+[^.]*)/);
        const taskId  = idMatch?.[1] || '';

        issues.push({ taskId, danger, problem: problem.slice(0, 100), file: f });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return issues;
}

// ─────────────────────────────────────────────────────
// 完了タスクの種別セットを収集（何が終わったか）
// ─────────────────────────────────────────────────────
function collectDoneTaskTypes(projectId, taskManager, projectManager) {
  const doneTypes = new Set();
  const donePrompts = [];

  try {
    // 現在のタスク（ON_HOLD = 失敗/保留含む）
    const all  = taskManager.listTasks();
    const proj = projectManager.filterTasksByProject(all, projectId);
    proj.forEach(t => {
      if (t.type) doneTypes.add(t.type.toUpperCase());
      donePrompts.push((t.prompt || '').slice(0, 60));
    });

    // アーカイブ済みタスク
    const ROOT = path.join(__dirname, '..', '..');
    const archivePath = path.join(ROOT, 'data', 'archive_tasks.json');
    if (fs.existsSync(archivePath)) {
      const arch = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      (arch.tasks || [])
        .filter(t => (t.projectId || 'default') === projectId)
        .forEach(t => {
          if (t.type) doneTypes.add(t.type.toUpperCase());
          donePrompts.push((t.prompt || '').slice(0, 60));
        });
    }
  } catch { /* ignore */ }

  return { doneTypes, donePrompts };
}

// ─────────────────────────────────────────────────────
// プロジェクト説明からコア要件キーワードを抽出
// ─────────────────────────────────────────────────────
function extractCoreKeywords(projectName, description, goal) {
  const text = `${projectName} ${description} ${goal}`.toLowerCase();
  const keywords = [];

  // AI/ML系
  if (/予測|predict|ai|機械学習|model/.test(text)) keywords.push('prediction');
  if (/youtube|動画|視聴/.test(text)) keywords.push('youtube');
  if (/分類|classif/.test(text)) keywords.push('classification');

  // Web/UI系
  if (/ui|画面|フロント|dashboard|app|アプリ/.test(text)) keywords.push('ui');
  if (/api|endpoint|server|サーバー/.test(text)) keywords.push('api');

  // データ系
  if (/データ収集|collect|scraping/.test(text)) keywords.push('data_collection');
  if (/分析|analytics|analysis/.test(text)) keywords.push('analytics');

  return keywords;
}

// ─────────────────────────────────────────────────────
// P1: コア価値未達 — 目的から必要なものが揃っているか
// ─────────────────────────────────────────────────────
function analyzeP1CoreValue(projectId, project, doneTypes, donePrompts, boardStatus, indicators) {
  const gaps = [];
  const name = (project.name || projectId).toLowerCase();
  const desc = (project.description || '').toLowerCase();
  const goal = (project.goal || '').toLowerCase();
  const keywords = extractCoreKeywords(name, desc, goal);

  const allDoneText = donePrompts.join(' ').toLowerCase();

  // 予測AI系プロジェクト
  if (keywords.includes('prediction') || keywords.includes('youtube')) {
    // 投稿前予測（実際に使えるか）
    if (!/投稿前.*予測|predict.*before.*post|新規.*動画.*予測|未公開/.test(allDoneText)) {
      gaps.push({
        type: 'IMPLEMENT', category: 'P1',
        prompt: '投稿前（未公開）動画の視聴数を予測できるエンドポイント / 関数を実装する。タイトル・サムネイル・タグ・投稿時間帯から予測し、結果を返す。',
        reason: '投稿前予測はプロジェクトのコア機能。未実装では目的未達。',
        source: 'project_goal',
      });
    }
    // 結果を人間が確認できるか
    if (!/cli|コマンド|実行|run|demo|サンプル/.test(allDoneText) && !keywords.includes('ui')) {
      gaps.push({
        type: 'IMPLEMENT', category: 'P1',
        prompt: '予測モデルの動作確認用 CLI スクリプトを作成する。タイトル・チャンネル名・タグ等を引数で受け取り、予測スコアと理由を出力する。',
        reason: 'モデルが実際に動くことを確認する手段がない状態では完成とはいえない。',
        source: 'project_goal',
      });
    }
  }

  // Web/App系でUIが未実装
  if (keywords.includes('ui') && !/ui|画面|interface|html|react|vue/.test(allDoneText)) {
    gaps.push({
      type: 'IMPLEMENT', category: 'P1',
      prompt: 'ユーザーが操作できる最小UI（入力フォームと結果表示）を実装する。',
      reason: 'プロジェクト目的にUI機能が含まれるが実装が見当たらない。',
      source: 'project_goal',
    });
  }

  // Board Report が BLOCKED or NEEDS_REFINEMENT で完了0件
  if ((boardStatus === 'BLOCKED' || boardStatus === 'NEEDS_REFINEMENT') && indicators.doneCount === 0) {
    gaps.push({
      type: 'IMPLEMENT', category: 'P1',
      prompt: `${project.name || projectId} の最小実行可能バージョン（MVP）を実装する。コア機能1つだけでも動く状態を目指す。`,
      reason: '完了タスクが0件。まず最小限のコア機能実装が必要。',
      source: 'board_report',
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────
// P2: 致命的不具合 — 失敗・品質RED・REVIEW高危険
// ─────────────────────────────────────────────────────
function analyzeP2Blockers(indicators, reviewIssues, qualityLevel) {
  const gaps = [];

  // 失敗タスクがある
  if (indicators.failedCount > 0 || indicators.timeoutCount > 1) {
    gaps.push({
      type: 'FIX', category: 'P2',
      prompt: `失敗したタスク（${indicators.failedCount}件）のエラー原因を調査し修正する。特にタイムアウトが繰り返す処理は分割または最適化する。`,
      reason: `失敗タスク${indicators.failedCount}件・タイムアウト${indicators.timeoutCount}件が残っている。`,
      source: 'quality_indicators',
    });
  }

  // 品質 RED
  if (qualityLevel === 'RED') {
    gaps.push({
      type: 'FIX', category: 'P2',
      prompt: '品質ゲートREDの原因を特定し修正する。!quality status で詳細を確認して対処する。',
      reason: '品質がREDのままでは次の開発を続けるべきでない。',
      source: 'quality_indicators',
    });
  }

  // 認証エラーが継続
  if (indicators.authErrorCount > 0) {
    gaps.push({
      type: 'FIX', category: 'P2',
      prompt: '認証エラー（AUTH）が発生したタスクを確認し、APIキー・認証情報・権限設定を修正する。',
      reason: `AUTH エラーが${indicators.authErrorCount}件発生しており、外部サービス連携が機能していない可能性がある。`,
      source: 'quality_indicators',
    });
  }

  // REVIEW結果に高・中危険度問題
  for (const issue of reviewIssues.slice(0, 3)) {
    gaps.push({
      type: 'FIX', category: 'P2',
      prompt: `Codex レビューで指摘された問題を修正する（タスク ${issue.taskId}）: ${issue.problem.slice(0, 80)}`,
      reason: `Codexレビュー危険度${issue.danger}: ${issue.problem.slice(0, 60)}`,
      source: 'review_result',
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────
// P3: 受け入れ条件不足 — TEST/REVIEW/DOCS の欠如
// ─────────────────────────────────────────────────────
function analyzeP3AcceptanceCriteria(doneTypes, donePrompts) {
  const gaps = [];
  const allDoneText = donePrompts.join(' ').toLowerCase();

  // テストがない
  if (!doneTypes.has('TEST') && !/test|テスト|spec/.test(allDoneText)) {
    gaps.push({
      type: 'TEST', category: 'P3',
      prompt: 'コア機能の動作確認テストを作成する。正常ケース・異常ケース・境界値を網羅した最小テストセット。',
      reason: 'テストが存在しない。機能が正しく動くことを証明できない状態。',
      source: 'task_gap',
    });
  }

  // REVIEWがない（コードレビュー未実施）
  if (!doneTypes.has('REVIEW') && doneTypes.has('IMPLEMENT')) {
    gaps.push({
      type: 'REVIEW', category: 'P3',
      prompt: '実装済みコードの品質・セキュリティ・保守性をCodexでレビューする。',
      reason: 'IMPLEMENT タスクは完了しているがコードレビューが未実施。',
      source: 'task_gap',
    });
  }

  // 使い方が不明（README/説明不足）
  if (!doneTypes.has('DOCS') && !/readme|使い方|how to|セットアップ/.test(allDoneText)) {
    gaps.push({
      type: 'DOCS', category: 'P3',
      prompt: '最低限の README を作成する。セットアップ手順・基本的な使い方・制限事項を記載する。',
      reason: '他人（または将来の自分）が使えるドキュメントがない状態。',
      source: 'task_gap',
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────
// P4: UX — ユーザー目線での使いやすさ
// ─────────────────────────────────────────────────────
function analyzeP4UX(doneTypes, donePrompts, keywords) {
  const gaps = [];
  const allDoneText = donePrompts.join(' ').toLowerCase();

  // エラー時のフィードバックがない
  if (doneTypes.has('IMPLEMENT') && !/エラー.*メッセージ|error.*message|ユーザー.*通知/.test(allDoneText)) {
    gaps.push({
      type: 'IMPLEMENT', category: 'P4',
      prompt: '処理失敗時に分かりやすいエラーメッセージを表示する。入力エラー・API エラー・タイムアウトそれぞれの案内文を追加。',
      reason: 'エラーハンドリングのユーザー向けメッセージが確認できない。',
      source: 'task_gap',
    });
  }

  // 予測AI系で結果の説明がない
  if ((keywords.includes('prediction') || keywords.includes('youtube')) &&
      !/説明|why|理由|根拠|confidence/.test(allDoneText)) {
    gaps.push({
      type: 'IMPLEMENT', category: 'P4',
      prompt: '予測結果に「なぜそのスコアか」の簡単な説明（主要因上位3件）を追加する。ユーザーが結果を理解できるようにする。',
      reason: '予測スコアだけでは判断できない。説明可能性（Explainability）が必要。',
      source: 'project_goal',
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────
// P5: Docs — ドキュメント不足
// ─────────────────────────────────────────────────────
function analyzeP5Docs(doneTypes, donePrompts) {
  const gaps = [];
  const allDoneText = donePrompts.join(' ').toLowerCase();

  if (doneTypes.has('DOCS')) return gaps; // 既にDOCSあり

  // API ドキュメントがない
  if (doneTypes.has('IMPLEMENT') && !/api.*doc|swagger|openapi/.test(allDoneText)) {
    gaps.push({
      type: 'DOCS', category: 'P5',
      prompt: 'API・関数の使い方ドキュメント（引数・戻り値・使用例）を作成する。',
      reason: 'コードが使われるためにはドキュメントが必要。',
      source: 'task_gap',
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────
// メイン: 全 gap を収集して優先順位ソート
//
// 引数:
//   projectId      — string
//   project        — project object { name, description, goal }
//   boardStatus    — BOARD_STATUS string
//   indicators     — qualityGate.gatherIndicators() の戻り値
//   qualityLevel   — 'GREEN'|'YELLOW'|'RED'
//   taskManager    — task-manager モジュール
//   projectManager — project-manager モジュール
//   reviewsDir     — path to reviews directory
//
// 戻り値:
//   { gaps: [...], sources: [...] }
//   gaps は priority rank 昇順にソート済み
// ─────────────────────────────────────────────────────
function analyzeGaps({
  projectId,
  project,
  boardStatus    = 'NEEDS_REFINEMENT',
  indicators     = {},
  qualityLevel   = 'GREEN',
  taskManager,
  projectManager,
  reviewsDir,
  insights       = [],  // project-insights.js の getInsights() 結果
}) {
  const { doneTypes, donePrompts } = collectDoneTaskTypes(
    projectId, taskManager, projectManager
  );
  const reviewIssues = collectReviewIssues(
    reviewsDir, projectId, taskManager, projectManager
  );
  const keywords = extractCoreKeywords(
    project.name || projectId,
    project.description || '',
    project.goal || ''
  );

  // ─ 優先度0: Human feedback / Product/PM Audit / Requirements（最高優先）
  const p0 = analyzeInsights(insights);

  // 各優先度の gap を収集
  const p1 = analyzeP1CoreValue(projectId, project, doneTypes, donePrompts, boardStatus, indicators);
  const p2 = analyzeP2Blockers(indicators, reviewIssues, qualityLevel);
  const p3 = analyzeP3AcceptanceCriteria(doneTypes, donePrompts);
  const p4 = analyzeP4UX(doneTypes, donePrompts, keywords);
  const p5 = analyzeP5Docs(doneTypes, donePrompts);

  // 重複除去してマージ（insights を先頭に置いて P1〜P5 を後ろに）
  const seen  = new Set();
  const allGaps = [...p0, ...p1, ...p2, ...p3, ...p4, ...p5].filter(g => {
    const key = `${g.category}:${g.type}:${g.prompt.slice(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // カテゴリ情報を付与してソート
  const enriched = allGaps.map(g => {
    const catInfo = PRIORITY_CATEGORY[g.category] || PRIORITY_CATEGORY.P5;
    return {
      ...g,
      priority:      catInfo.priority,
      categoryRank:  catInfo.rank,
      categoryLabel: catInfo.label,
      dangerLevel:   g.category === 'P1' || g.category === 'P2' ? '中' : '低',
      securityOk:    true, // security.checkPrompt は呼び出し元で実施
    };
  });

  enriched.sort((a, b) => a.categoryRank - b.categoryRank);

  // 使用したデータソースの説明
  const sources = [];
  if (p0.length > 0) sources.push(`Insights (HumanFeedback/Audit): ${p0.length}件`);
  if (boardStatus !== 'NEEDS_REFINEMENT') sources.push(`Board Report: ${boardStatus}`);
  if (reviewIssues.length > 0) sources.push(`Codex REVIEW 問題: ${reviewIssues.length}件`);
  if (indicators.failedCount > 0) sources.push(`失敗タスク: ${indicators.failedCount}件`);
  if (qualityLevel !== 'GREEN') sources.push(`品質: ${qualityLevel}`);
  sources.push(`完了タスク種別: ${[...doneTypes].join('/') || 'なし'}`);
  if (keywords.length > 0) sources.push(`プロジェクト種別: ${keywords.join('/')}`);

  return { gaps: enriched, sources, doneTypes, donePrompts, reviewIssues, insightGaps: p0 };
}

// ─────────────────────────────────────────────────────
// Project Insights（Human feedback / Product/PM Audit / Requirements）
// を gap に変換する。
//
// insights は project-insights.js の getInsights() が返す配列。
// 各 insight の severity → P カテゴリにマッピング。
//
// Human feedback / Product / PM Audit の critical は P1（最優先）
// ─────────────────────────────────────────────────────
function analyzeInsights(insights) {
  const gaps = [];
  for (const ins of insights) {
    if (ins.resolved) continue;

    // type からタスク種別を推定
    let taskType = 'IMPLEMENT';
    const text = ins.text.toLowerCase();
    if (/バグ|不具合|bug|broken|破綻|動かない|失敗/.test(text)) taskType = 'FIX';
    if (/テスト|test|検証/.test(text)) taskType = 'TEST';
    if (/ドキュメント|readme|docs/.test(text)) taskType = 'DOCS';
    if (/レビュー|review/.test(text)) taskType = 'REVIEW';

    // プロンプト: insight テキストをそのままタスク指示に変換
    const prompt = `[${ins.type === 'human_feedback' ? 'CEO指摘' : ins.type === 'product_audit' ? 'Product Audit' : ins.type === 'pm_audit' ? 'PM Audit' : '要件'}] ${ins.text}`;

    gaps.push({
      type:     taskType,
      category: ins.category || 'P1',
      prompt:   prompt.slice(0, 500),
      reason:   `${ins.type} (severity: ${ins.severity}) — ${(ins.addedAt || '').slice(0, 10)}`,
      source:   'project_insights',
      insightId: ins.id,
      insightType: ins.type,
      fromLarge: false,
    });
  }
  return gaps;
}

module.exports = {
  analyzeGaps,
  PRIORITY_CATEGORY,
  analyzeInsights,
  // テスト用
  _collectReviewIssues:          collectReviewIssues,
  _collectDoneTaskTypes:         collectDoneTaskTypes,
  _analyzeP1CoreValue:           analyzeP1CoreValue,
  _analyzeP2Blockers:            analyzeP2Blockers,
  _analyzeP3AcceptanceCriteria:  analyzeP3AcceptanceCriteria,
  _analyzeP4UX:                  analyzeP4UX,
  _analyzeP5Docs:                analyzeP5Docs,
};
