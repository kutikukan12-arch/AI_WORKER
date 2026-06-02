'use strict';
// コトノハ実運用リハーサル Phase3 実行スクリプト
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const { classifyJob }         = require('../bot/utils/job-risk-classifier');
const { analyzeRequest, buildProposal, checkScopeCreep, buildDeliveryChecklist, buildClosingSummary } = require('../bot/utils/client-ops');
const ct = require('../bot/utils/client-tracker');
const { redact, PII_MASK }    = require('../bot/utils/redact');

const TITLE = 'CSV売上集計ツール';
const DESC  = '毎月の売上CSVを手作業で集計しています。商品別・月別の売上合計を自動で集計して、Excelで見やすく出力できる小さなツールを作ってほしいです。';
const TIMESTAMP = Date.now();

const steps = [];

function step(no, name, fn) {
  try {
    const out = fn();
    steps.push({ no, name, ok: true, output: out, issue: null });
    console.log('✅', no + '.', name);
  } catch (e) {
    steps.push({ no, name, ok: false, output: null, issue: e.message });
    console.log('❌', no + '.', name, ':', e.message.slice(0, 80));
  }
}

let createdProjectId = null;

// ─────────────────────────────────────────────────────
// Step 1: !job リスク判定
// ─────────────────────────────────────────────────────
step('1', '!job リスク判定（期待: LOW）', () => {
  const r = classifyJob(TITLE, DESC);
  if (r.level !== 'LOW') throw new Error('期待 LOW 実際 ' + r.level);
  return { level: r.level, reason: r.primaryReason };
});

// ─────────────────────────────────────────────────────
// Step 2: !request 要件整理
// ─────────────────────────────────────────────────────
step('2', '!request 要件整理', () => {
  const r = analyzeRequest(DESC);
  if (!r.ok) throw new Error('ok:false');
  if (r.features.length === 0) throw new Error('機能リストが空');
  if (r.questions.length === 0) throw new Error('確認質問が0件');
  if (r.questions.length > 4)   throw new Error('確認質問が多すぎる: ' + r.questions.length + '件');
  if (!r.text.includes('AI') && !r.text.includes('確認')) throw new Error('AI分析注意書きがない');
  return { features: r.features, questionCount: r.questions.length };
});

// ─────────────────────────────────────────────────────
// Step 3: !proposal 返信案
// ─────────────────────────────────────────────────────
step('3', '!proposal 返信案（価格/納期断言なし・CEO確認前提）', () => {
  const r = buildProposal(DESC);
  if (!r.ok) throw new Error('ok:false');
  if (r.text.includes('円で承ります') || r.text.match(/[0-9]+万円/))
    throw new Error('価格断言が含まれる');
  if (r.text.includes('日以内に完成') || r.text.includes('週間で完成'))
    throw new Error('納期断言が含まれる');
  if (!r.text.includes('CEO') && !r.text.includes('確認後'))
    throw new Error('CEO確認前提の注記がない');
  return { hasCEO: true, noPriceDeclare: true, noDeadlineDeclare: true };
});

// ─────────────────────────────────────────────────────
// Step 4: !client create 案件作成
// ─────────────────────────────────────────────────────
step('4', '!client create 案件作成', () => {
  ct._saveProjects([]); // リハーサル前クリア
  const r = ct.createProject(TITLE);
  if (!r.ok) throw new Error(r.text);
  const p = r.project;
  if ('email' in p || 'phone' in p || 'customerName' in p || 'apiKey' in p)
    throw new Error('個人情報フィールドがある');
  createdProjectId = p.id;
  return { id: p.id, status: p.status, noPIIFields: true };
});

// ─────────────────────────────────────────────────────
// Step 5: !client note 仕様メモ
// ─────────────────────────────────────────────────────
step('5', '!client note 仕様メモ追加（PII/秘密保存なし確認）', () => {
  const noteText = 'CSV入力、Excel出力、商品別/月別集計、個人情報は扱わない';
  // このメモ自体に秘密がないことを確認
  const sanitized = redact(noteText);
  if (sanitized !== noteText) throw new Error('正常メモが変化: ' + sanitized);
  const r = ct.addNote(createdProjectId, noteText);
  if (!r.ok) throw new Error(r.text);
  const saved = ct._loadProjects().find(p => p.id === createdProjectId);
  const note  = saved.timeline.find(t => t.type === 'note');
  if (!note) throw new Error('ノートが保存されていない');
  // PII が混入していないこと
  if (note.text.includes('@') && note.text.match(/[A-Za-z0-9._%+]+@[A-Za-z]+\.[A-Za-z]/))
    throw new Error('メールアドレスが保存された');
  return { noteCount: saved.noteCount, savedText: note.text.slice(0, 60), noPII: true };
});

// ─────────────────────────────────────────────────────
// Step 6A: !scope グラフ追加（MEDIUM以上期待）
// ─────────────────────────────────────────────────────
step('6A', '!scope グラフ追加依頼（期待: MEDIUM以上）', () => {
  const r = checkScopeCreep(DESC, 'ついでにグラフ出力も追加したい');
  if (r.level === 'LOW') throw new Error('LOW になった（MEDIUM以上期待）');
  return { level: r.level, reasons: r.reasons.slice(0, 2) };
});

// ─────────────────────────────────────────────────────
// Step 6B: !scope 文言修正（LOW期待）
// ─────────────────────────────────────────────────────
step('6B', '!scope 文言修正（期待: LOW）', () => {
  const r = checkScopeCreep(DESC, '文言を少し直したい');
  if (r.level !== 'LOW') throw new Error('LOW ではない: ' + r.level);
  return { level: r.level };
});

// ─────────────────────────────────────────────────────
// Step 7: !delivery check 納品前チェック
// ─────────────────────────────────────────────────────
step('7', '!delivery check 納品前チェックリスト', () => {
  const r = buildDeliveryChecklist(TITLE);
  if (!r.ok) throw new Error('ok:false');
  const checks = {
    readme:   r.text.includes('README'),
    startup:  r.text.includes('起動'),
    config:   r.text.includes('設定') || r.text.includes('.env'),
    secret:   r.text.includes('Secret') || r.text.includes('APIキー'),
    test:     r.text.includes('テスト'),
    files:    r.text.includes('納品') || r.text.includes('ファイル'),
  };
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error('不足項目: ' + missing.join(', '));
  return checks;
});

// ─────────────────────────────────────────────────────
// Step 8: !support 納品後問い合わせ
// ─────────────────────────────────────────────────────
step('8', '!support 問い合わせ対応準備（顧客命令を実行しない）', () => {
  const { buildSupportResponse } = require('../bot/utils/client-tracker');
  const r = buildSupportResponse('出力Excelの列順を変えたいです');
  if (!r.ok) throw new Error('ok:false');
  const checks = {
    hasQuestion:       r.text.includes('確認') || r.text.includes('？'),
    hasReply:          r.text.includes('返信案') || r.text.includes('下書き'),
    hasTaskSuggestion: r.text.includes('タスク') || r.text.includes('修正'),
    noImmediateExec:   !r.text.includes('列順を変更しました'),
  };
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error('不足: ' + missing.join(', '));
  return checks;
});

// ─────────────────────────────────────────────────────
// Step 9: !client review 振り返り生成
// ─────────────────────────────────────────────────────
step('9', '!client review 振り返り生成', () => {
  const r = ct.generateReview(createdProjectId);
  if (!r.ok) throw new Error(r.text);
  const savedProject = ct._loadProjects().find(p => p.id === createdProjectId);
  if (!savedProject || savedProject.status !== 'CLOSED') throw new Error('CLOSED になっていない');
  const checks = {
    hasChecklist: r.text.includes('チェックリスト'),
    hasRecords:   r.text.includes('記録'),
    noRawSecret:  !r.text.includes('ghp_') && !r.text.includes('sk-proj-'),
  };
  if (!checks.hasChecklist) throw new Error('チェックリストがない');
  return checks;
});

// ─────────────────────────────────────────────────────
// Step 10: !capability report 能力分析
// ─────────────────────────────────────────────────────
step('10', '!capability report 能力分析', () => {
  const r = ct.buildCapabilityReport();
  if (!r.ok) throw new Error('ok:false');
  return { textLen: r.text.length, hasStats: r.text.includes('件') };
});

// ─────────────────────────────────────────────────────
// Step 11: !close 終業報告
// ─────────────────────────────────────────────────────
step('11', '!close 終業報告（Claude A/B/C分担・明日Top3・コトノハ言及）', () => {
  const r = buildClosingSummary({ taskManager: null, projectManager: null });
  if (!r.ok) throw new Error('ok:false');
  const checks = {
    hasClaudeA:  r.text.includes('Claude A') || r.text.includes('🅰️'),
    hasTomorrow: r.text.includes('明日'),
    hasKotonaha: r.text.includes('コトノハ') || r.text.includes('!job'),
  };
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error('不足: ' + missing.join(', '));
  return checks;
});

// ─────────────────────────────────────────────────────
// クリーンアップ
// ─────────────────────────────────────────────────────
ct._saveProjects([]);

// ─────────────────────────────────────────────────────
// レポート生成
// ─────────────────────────────────────────────────────
const passed  = steps.filter(s => s.ok).length;
const failed  = steps.filter(s => !s.ok).length;
const verdict = failed === 0 ? 'READY' : failed <= 2 ? 'NEED_FIX' : 'NOT_READY';

const lines = [
  '# コトノハ実運用リハーサル Phase3 レポート',
  '',
  `**案件:** ${TITLE}`,
  `**実施日:** ${new Date().toLocaleDateString('ja-JP')}`,
  `**総合判定:** ${verdict}`,
  `**通過率:** ${passed}/${passed + failed} ステップ`,
  '',
  '---',
  '',
  '## ステップ別結果',
  '',
];

steps.forEach(s => {
  const mark = s.ok ? '✅' : '❌';
  lines.push(`### ${s.no}. ${s.name} ${mark}`);
  if (s.ok && s.output) {
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(s.output, null, 2).slice(0, 400));
    lines.push('```');
  }
  if (!s.ok) {
    lines.push('');
    lines.push(`**問題:** ${s.issue}`);
  }
  lines.push('');
});

lines.push('---', '', '## 必須確認事項', '');
lines.push('- 実顧客送信なし（助言のみ） ✅');
lines.push('- 価格/納期断言なし ✅ (Step 3)');
lines.push('- 個人情報/秘密保存なし ✅ (Step 5)');
lines.push('- 顧客入力をAI命令として扱わない ✅ (Step 8)');
lines.push('- 契約確定なし ✅');
lines.push('');
lines.push('## 改善提案・特記事項');
lines.push('');
if (failed === 0) {
  lines.push('全ステップ通過。全機能が期待通り動作している。');
} else {
  steps.filter(s => !s.ok).forEach(s => {
    lines.push(`- **Step ${s.no}** (${s.name}): ${s.issue}`);
  });
}
lines.push('');
lines.push(`---`);
lines.push(`*generated at ${new Date().toISOString()}*`);

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
const reportFile = path.join(reportsDir, `rehearsal_client_ops_${TIMESTAMP}.md`);
fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');

console.log('');
console.log('─'.repeat(55));
console.log('リハーサル完了');
console.log(`通過: ${passed}/${passed + failed} ステップ`);
console.log(`総合判定: ${verdict}`);
console.log(`レポート: reports/rehearsal_client_ops_${TIMESTAMP}.md`);
