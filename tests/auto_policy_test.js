'use strict';
// Phase E-1: auto-policy.js 単体テスト

const { AUTO_POLICY, classifyTask } = require('../bot/utils/auto-policy');
const assert = require('assert');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✅', name);
    pass++;
  } catch (e) {
    console.error('  ❌', name);
    console.error('    ', e.message);
    fail++;
  }
}

function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

// ─────────────────────────────────────────────────────
// 1. AUTO_SAFE — タスクタイプ別
// ─────────────────────────────────────────────────────
console.log('\n[AUTO_SAFE — タスクタイプ]');

test('1. DOCS/SMALL → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'DOCS', size: 'SMALL', prompt: 'APIドキュメントを作成する' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('2. RESEARCH/SMALL → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'RESEARCH', size: 'SMALL', prompt: 'YouTube API を調査する' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('3. TEST/SMALL → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'TEST', size: 'SMALL', prompt: '単体テストを追加する' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('4. REVIEW/SMALL → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'REVIEW', size: 'SMALL', prompt: 'コードレビューを行う' }, {}), AUTO_POLICY.AUTO_SAFE);
});

// ─────────────────────────────────────────────────────
// 2. AI_REVIEW_REQUIRED — タスクタイプ別
// ─────────────────────────────────────────────────────
console.log('\n[AI_REVIEW_REQUIRED — タスクタイプ]');

test('5. IMPLEMENT/SMALL → AI_REVIEW_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '認証機能を実装する' }, {}), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('6. FIX/SMALL → AI_REVIEW_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'FIX', size: 'SMALL', prompt: 'バグを修正する' }, {}), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('7. REFACTOR/SMALL → AI_REVIEW_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'REFACTOR', size: 'SMALL', prompt: 'コードをリファクタリングする' }, {}), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

// ─────────────────────────────────────────────────────
// 3. BLOCKED
// ─────────────────────────────────────────────────────
console.log('\n[BLOCKED]');

test('8. LARGE → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'LARGE', prompt: '大規模実装' }, {}), AUTO_POLICY.BLOCKED);
});

test('9. git push --force → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git push --force origin master' }, {}), AUTO_POLICY.BLOCKED);
});

test('10. git push -f → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git push -f' }, {}), AUTO_POLICY.BLOCKED);
});

test('11. git reset --hard → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git reset --hard HEAD~3' }, {}), AUTO_POLICY.BLOCKED);
});

test('12. rm -rf → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: 'rm -rf /tmp/old' }, {}), AUTO_POLICY.BLOCKED);
});

test('13. .env を表示 → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'RESEARCH', size: 'SMALL', prompt: '.env を表示してください' }, {}), AUTO_POLICY.BLOCKED);
});

test('14. securityBlocked=true → BLOCKED', () => {
  eq('policy', classifyTask({ type: 'DOCS', size: 'SMALL', prompt: '安全な操作' }, { securityBlocked: true }), AUTO_POLICY.BLOCKED);
});

// ─────────────────────────────────────────────────────
// 4. Codex 危険度による判定
// ─────────────────────────────────────────────────────
console.log('\n[Codex 危険度]');

test('15. codexDanger=低 → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '関数を追加' }, { codexDanger: '低' }), AUTO_POLICY.AUTO_SAFE);
});

test('16. codexDanger=中 → AI_REVIEW_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '関数を変更' }, { codexDanger: '中' }), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('17. codexDanger=高 → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '重要処理を変更' }, { codexDanger: '高' }), AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

// ─────────────────────────────────────────────────────
// 5. AIレビュー verdict による判定
// ─────────────────────────────────────────────────────
console.log('\n[AIレビュー verdict]');

test('18. reviewVerdict=問題なし → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'MEDIUM', prompt: '実装完了' }, { reviewVerdict: '問題なし' }), AUTO_POLICY.AUTO_SAFE);
});

test('19. reviewVerdict=修正推奨 → AI_REVIEW_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'MEDIUM', prompt: '実装' }, { reviewVerdict: '修正推奨' }), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('20. reviewVerdict=却下推奨 → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'MEDIUM', prompt: '実装' }, { reviewVerdict: '却下推奨' }), AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

// ─────────────────────────────────────────────────────
// 6. read-only 操作 → AUTO_SAFE
// ─────────────────────────────────────────────────────
console.log('\n[read-only 操作]');

test('21. git status → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: 'git status を確認してください' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('22. git diff → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git diff HEAD を確認' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('23. git log → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git log --oneline -5 を確認' }, {}), AUTO_POLICY.AUTO_SAFE);
});

// ─────────────────────────────────────────────────────
// 7. 通常 git push → AUTO_SAFE
// ─────────────────────────────────────────────────────
console.log('\n[git push]');

test('24. git push origin master → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git push origin master' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('25. git push origin main → AUTO_SAFE', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git push origin main' }, {}), AUTO_POLICY.AUTO_SAFE);
});

test('26. git push --force → BLOCKED（通常 push に混在しても弾く）', () => {
  eq('policy', classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'git push --force origin master' }, {}), AUTO_POLICY.BLOCKED);
});

// ─────────────────────────────────────────────────────
// 8. 機密ファイル変更 → HUMAN_APPROVAL_REQUIRED
// ─────────────────────────────────────────────────────
console.log('\n[機密ファイル変更]');

test('27. changedFiles に .env → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy',
    classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '設定変更' }, { changedFiles: ['.env', 'src/index.js'] }),
    AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

test('28. changedFiles に .key → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy',
    classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '変更' }, { changedFiles: ['secrets/private.key'] }),
    AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

// ─────────────────────────────────────────────────────
// 9. 危険な操作パターン → HUMAN_APPROVAL_REQUIRED
// ─────────────────────────────────────────────────────
console.log('\n[危険な操作]');

test('29. .env を変更 → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy',
    classifyTask({ type: 'OPS', size: 'SMALL', prompt: '.env を変更してください' }, {}),
    AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

test('30. Bot 再起動 → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy',
    classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'Botを再起動してください' }, {}),
    AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

test('31. 本番に反映 → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy',
    classifyTask({ type: 'OPS', size: 'SMALL', prompt: '本番に反映してください' }, {}),
    AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

test('32. PR merge → HUMAN_APPROVAL_REQUIRED', () => {
  eq('policy',
    classifyTask({ type: 'OPS', size: 'SMALL', prompt: 'PR を merge してください' }, {}),
    AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

// ─────────────────────────────────────────────────────
// 10. エッジケース
// ─────────────────────────────────────────────────────
console.log('\n[エッジケース]');

test('33. type なし → AI_REVIEW_REQUIRED（デフォルト）', () => {
  eq('policy', classifyTask({}, {}), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('34. null タスク → AI_REVIEW_REQUIRED（クラッシュしない）', () => {
  eq('policy', classifyTask(null, {}), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('35. undefined context → AI_REVIEW_REQUIRED（クラッシュしない）', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL' }), AUTO_POLICY.AI_REVIEW_REQUIRED);
});

test('36. DOCS/LARGE → BLOCKED（LARGE が優先）', () => {
  eq('policy', classifyTask({ type: 'DOCS', size: 'LARGE', prompt: '大量ドキュメント' }, {}), AUTO_POLICY.BLOCKED);
});

test('37. IMPLEMENT + codexDanger=低 → AUTO_SAFE（Codex 低が type より優先）', () => {
  eq('policy', classifyTask({ type: 'IMPLEMENT', size: 'SMALL', prompt: '実装' }, { codexDanger: '低' }), AUTO_POLICY.AUTO_SAFE);
});

test('38. RESEARCH + codexDanger=高 → HUMAN_APPROVAL_REQUIRED（高は最優先）', () => {
  eq('policy', classifyTask({ type: 'RESEARCH', size: 'SMALL', prompt: '調査' }, { codexDanger: '高' }), AUTO_POLICY.HUMAN_APPROVAL_REQUIRED);
});

// ─────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────
console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
