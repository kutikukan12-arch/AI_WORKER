// ─────────────────────────────────────────────────────
// vp-advisor.js — 神崎 VP (Vice President / Strategy Officer)
//
// 神崎は「判断者」ではない。CEO(社長)が最終判断者。
// このモジュールは社長が良い判断をできる状態を作るための
// 「判断材料」を整理して提示するだけ。
//
// 禁止（コードレベルで担保）:
//   - 決定 / 承認代理を一切出力しない（「提案」止まり）
//   - READY / NEED_FIX 技術判定を生成しない（守谷専権）
//   - 支出決定をしない（金森専権）
//   - 自動実行・eval/exec なし（純粋なテキスト整形のみ）
//
// 全入力は redact() を通してから整形する（secret混入防止）。
// ─────────────────────────────────────────────────────

const { redact } = require('./redact');

// 出力末尾に必ず添える「神崎は決めない」注記。
const NON_DECISION_NOTE =
  '⚠️ これは神崎 VP からの**提案（判断材料）**です。**決定ではありません**。\n' +
  '最終判断は社長（CEO）が行います。';

// ─────────────────────────────────────────────────────
// buildAskBrief(topic) — !vp ask <内容>
//
// 社長が神崎へ相談したテーマについて、判断材料の枠組みを整理する。
// 出力: 状況整理 / 選択肢 / メリット / リスク / 推奨案（提案）
//
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function buildAskBrief(topic) {
  const clean = redact(String(topic || '').trim());
  if (!clean) {
    return {
      ok:   false,
      text:
        '**!vp ask — 神崎 VP に相談**\n\n' +
        '```\n!vp ask <相談内容>\n```\n\n' +
        '例: `!vp ask YouTube診断AIを有料化すべきか`\n\n' +
        '神崎は状況・選択肢・メリット・リスク・推奨案を整理します。\n' +
        '（決定は社長が行います。神崎は判断材料を出すだけです）',
    };
  }

  const lines = [
    `🅸 **神崎 VP — 判断材料の整理**`,
    ``,
    `**相談テーマ**`,
    `> ${clean}`,
    ``,
    `**1. 状況整理**`,
    `- 何を判断しようとしているか: ${clean}`,
    `- 関係する部門・社員の論点を集約してください（各担当の意見を統合）`,
    `- 事業フェーズ・現在の優先順位との整合を確認`,
    ``,
    `**2. 選択肢**`,
    `- 案A: （現状維持 / 見送り）`,
    `- 案B: （実行する）`,
    `- 案C: （条件付き・段階的に実行する）`,
    ``,
    `**3. メリット（各案ごと）**`,
    `- 案A: 低リスク・コスト維持`,
    `- 案B: 事業前進・機会獲得`,
    `- 案C: リスクを抑えつつ前進`,
    ``,
    `**4. リスク（各案ごと）**`,
    `- 案A: 機会損失`,
    `- 案B: コスト/品質/運用負荷の増加`,
    `- 案C: 判断の先送りによる遅延`,
    ``,
    `**5. 推奨案（提案）**`,
    `- 神崎の推奨: 案C（条件付き・段階的）を基本線として検討を推奨`,
    `- 理由: 事業と開発のバランスを保ち、リスクを限定できるため`,
    `- 確認すべき担当: 守谷CTO(品質) / 金森CFO(費用) / 市川PM(商品価値) / 白石COO(運用)`,
    ``,
    NON_DECISION_NOTE,
  ];

  return { ok: true, text: lines.join('\n') };
}

// ─────────────────────────────────────────────────────
// buildSummary({ projects, currentProjectId, decisions, incidents })
//   — !vp summary
//
// 経営状況を整理して提示する。データは呼び出し側が渡す（テスト容易性）。
//   projects:        [{ id, name, description }]
//   currentProjectId: string|null
//   decisions:       [{ id, title, createdAt, category }]   (active)
//   incidents:       [{ id, title, severity, status }]      (open)
//
// 表示: 現在プロジェクト / 重要Decision / リスク / 次の判断候補
//
// 戻り値: { ok, text }
// ─────────────────────────────────────────────────────
function buildSummary({ projects = [], currentProjectId = null, decisions = [], incidents = [] } = {}) {
  const lines = [
    `🅸 **神崎 VP — 経営状況の整理**`,
    ``,
    `**■ 現在プロジェクト**`,
  ];

  if (projects.length === 0) {
    lines.push(`- （登録プロジェクトなし）`);
  } else {
    for (const p of projects.slice(0, 10)) {
      const cur  = p.id === currentProjectId ? ' ← 現在' : '';
      const name = redact(String(p.name || p.id));
      const desc = p.description ? ` — ${redact(String(p.description))}` : '';
      lines.push(`- \`${p.id}\` ${name}${cur}${desc}`);
    }
  }

  lines.push(``, `**■ 重要Decision（直近 active）**`);
  if (decisions.length === 0) {
    lines.push(`- （記録された意思決定なし）`);
  } else {
    for (const d of decisions.slice(-5).reverse()) {
      const date = d.createdAt ? new Date(d.createdAt).toLocaleDateString('ja-JP') : '';
      lines.push(`- \`${d.id}\` ${redact(String(d.title || ''))}${date ? ` (${date})` : ''}`);
    }
  }

  lines.push(``, `**■ リスク（未解決インシデント）**`);
  if (incidents.length === 0) {
    lines.push(`- ✅ 未解決インシデントなし`);
  } else {
    for (const i of incidents.slice(0, 5)) {
      lines.push(`- \`${i.id}\` [${i.severity || '?'}] ${redact(String(i.title || ''))} (${i.status || '?'})`);
    }
  }

  lines.push(
    ``,
    `**■ 次の判断候補（社長へ）**`,
    `- 上記の重要Decision・リスクのうち、社長の判断が必要なものを確認`,
    `- 大型機能追加 / 新規事業 / 課金方針 / 会社ルール変更 は STRATEGY_REVIEW 対象`,
    `- 必要なら \`!vp ask <テーマ>\` で個別に判断材料を整理します`,
    ``,
    NON_DECISION_NOTE,
  );

  return { ok: true, text: lines.join('\n') };
}

module.exports = {
  buildAskBrief,
  buildSummary,
  NON_DECISION_NOTE,
};
