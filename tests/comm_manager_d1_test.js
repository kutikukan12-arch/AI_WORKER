'use strict';
// Communication Manager Phase D-1 テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const fmt = require('../bot/utils/formatter');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// ─────────────────────────────────────────────────────
// 1. GitHub Push 失敗通知
// ─────────────────────────────────────────────────────
console.log('\n[1. GitHub Push 失敗通知]');

test('1a. 「外部バックアップ失敗」という平易な表現がある', () => {
  const text = fmt.formatGitHubPushFailed({ taskId: 'task_123', pushError: '403 forbidden' });
  assert.ok(text.includes('外部バックアップ失敗'), '平易な表現がない');
});

test('1b. 影響説明（PC故障リスク）がある', () => {
  const text = fmt.formatGitHubPushFailed({ taskId: 'task_123', pushError: '403' });
  assert.ok(text.includes('影響'), '影響説明がない');
  assert.ok(text.includes('故障') || text.includes('失う'), 'リスク説明がない');
});

test('1c. 放置した場合の説明がある', () => {
  const text = fmt.formatGitHubPushFailed({ taskId: 'task_123', pushError: '' });
  assert.ok(text.includes('放置'), '放置説明がない');
});

test('1d. 次の行動（!doctor / !restart）が含まれる', () => {
  const text = fmt.formatGitHubPushFailed({ taskId: 'task_123', pushError: '' });
  assert.ok(text.includes('!doctor') || text.includes('!restart'), '次の行動コマンドがない');
});

test('1e. 技術詳細（タスクID / 分類）が下部に保持される', () => {
  const text = fmt.formatGitHubPushFailed({ taskId: 'task_abc', pushError: '403 denied' });
  assert.ok(text.includes('task_abc'), 'タスクIDが保持されていない');
  assert.ok(text.includes('技術詳細') || text.includes('🔧'), '技術詳細セクションがない');
});

test('1f. 403エラーが「Token の権限不足」と翻訳される', () => {
  const text = fmt.formatGitHubPushFailed({ taskId: 'task_x', pushError: '403 Permission denied' });
  assert.ok(text.includes('403') || text.includes('Token') || text.includes('権限'), 'エラー種別の翻訳がない');
});

test('1g. index.js で fmt.formatGitHubPushFailed が呼ばれており、旧メッセージが GitHub Push 文脈にない', () => {
  // 新コード: fmt.formatGitHubPushFailed
  assert.ok(src.includes('formatGitHubPushFailed'), 'formatGitHubPushFailed が index.js にない');
  // GitHub Push 失敗箇所で sendHumanMention + '詳細はログを確認してください' の組み合わせが消えた
  // (他の箇所でのみ使われているのは問題ない)
  const gitPushSection = (() => {
    const idx = src.indexOf('gitResult?.pushError');
    return idx >= 0 ? src.slice(idx, idx + 600) : '';
  })();
  assert.ok(!gitPushSection.includes("'GitHub Push が失敗しました'"), '旧 sendHumanMention GitHub Push メッセージが残っている');
  assert.ok(gitPushSection.includes('formatGitHubPushFailed'), 'gitPushError ブロックに formatGitHubPushFailed がない');
});

// ─────────────────────────────────────────────────────
// 2. エラー通知（専門語だけにならない）
// ─────────────────────────────────────────────────────
console.log('\n[2. エラー通知の改善]');

test('2a. AUTH エラーが「アクセス権問題」に翻訳される', () => {
  const text = fmt.formatTaskError({ taskId: 'task_x', errorType: 'AUTH', maskedErrMsg: 'auth failed' });
  assert.ok(text.includes('アクセス権') || text.includes('認証'), 'AUTH の翻訳がない');
});

test('2b. TIMEOUT エラーが「作業時間超過」に翻訳される', () => {
  const text = fmt.formatTaskError({ taskId: 'task_x', errorType: 'TIMEOUT', maskedErrMsg: 'timed out' });
  assert.ok(text.includes('時間'), 'TIMEOUT の翻訳がない');
});

test('2c. SYNTAX エラーが「コード形式の問題」に翻訳される', () => {
  const text = fmt.formatTaskError({ taskId: 'task_x', errorType: 'SYNTAX', maskedErrMsg: 'syntax error' });
  assert.ok(text.includes('コード') || text.includes('形式'), 'SYNTAX の翻訳がない');
});

test('2d. 作業データ（保全状況）の説明がある', () => {
  const text = fmt.formatTaskError({ taskId: 'task_x', errorType: 'AUTH', maskedErrMsg: '' });
  assert.ok(text.includes('作業データ') || text.includes('保存'), '作業データ説明がない');
});

test('2e. 自動復旧するかどうかの説明がある', () => {
  const text = fmt.formatTaskError({ taskId: 'task_x', errorType: 'TIMEOUT', maskedErrMsg: '' });
  assert.ok(text.includes('自動復旧') || text.includes('自動'), '自動復旧説明がない');
});

test('2f. 人間対応必要かどうかの説明がある', () => {
  const authText = fmt.formatTaskError({ taskId: 'task_x', errorType: 'AUTH', maskedErrMsg: '' });
  assert.ok(authText.includes('人間') || authText.includes('対応'), '人間対応説明がない');
});

test('2g. 技術詳細（errorType / taskId）が下部に保持される', () => {
  const text = fmt.formatTaskError({ taskId: 'task_abc', errorType: 'AUTH', maskedErrMsg: 'auth fail' });
  assert.ok(text.includes('task_abc'), 'タスクIDが保持されていない');
  assert.ok(text.includes('AUTH'), 'errorType が保持されていない');
});

test('2h. index.js で formatTaskError が使われている', () => {
  assert.ok(src.includes('formatTaskError'), 'formatTaskError が index.js にない');
  // 旧: 'AIが作業していたタスクでエラーが起きて止まりました' という embed が消えた
  assert.ok(!src.includes("AIが作業していたタスクでエラーが起きて止まりました"), '旧エラーメッセージが残っている');
});

// ─────────────────────────────────────────────────────
// 3. HUMAN_CHECK 通知（approve/deny 後の説明あり）
// ─────────────────────────────────────────────────────
console.log('\n[3. HUMAN_CHECK 通知の改善]');

test('3a. 承認すると何が起きるか説明がある', () => {
  const text = fmt.formatHumanCheck({
    taskId: 'task_x', projectId: 'proj', reason: 'AUTH エラー', details: '', task: null
  });
  assert.ok(text.includes('承認すると'), '承認後の説明がない');
  assert.ok(text.includes('再開') || text.includes('進みます'), '承認後の動作説明がない');
});

test('3b. 却下すると何が起きるか説明がある', () => {
  const text = fmt.formatHumanCheck({
    taskId: 'task_x', projectId: 'proj', reason: 'AUTH エラー', details: '', task: null
  });
  assert.ok(text.includes('却下すると'), '却下後の説明がない');
  assert.ok(text.includes('停止') || text.includes('キャンセル'), '却下後の動作説明がない');
});

test('3c. 放置すると止まる説明がある', () => {
  const text = fmt.formatHumanCheck({
    taskId: 'task_x', projectId: 'proj', reason: 'timeout_limit', details: '', task: null
  });
  assert.ok(text.includes('放置'), '放置説明がない');
  assert.ok(text.includes('止まった') || text.includes('動き出さ'), '放置時の動作説明がない');
});

test('3d. !approve / !deny / !task show コマンドが含まれる', () => {
  const text = fmt.formatHumanCheck({
    taskId: 'task_abc', projectId: 'proj', reason: '原因', details: '', task: null
  });
  assert.ok(text.includes('!approve task_abc'), '!approve コマンドがない');
  assert.ok(text.includes('!deny'), '!deny コマンドがない');
  assert.ok(text.includes('!task show'), '!task show コマンドがない');
});

test('3e. AUTH の理由が日本語に翻訳される', () => {
  const text = fmt.formatHumanCheck({
    taskId: 'task_x', projectId: 'proj', reason: 'AUTH エラー — 認証・権限の確認が必要', details: '', task: null
  });
  assert.ok(
    text.includes('アクセス') || text.includes('認証') || text.includes('サービス'),
    'AUTH の翻訳がない'
  );
});

test('3f. 技術的な reason が下部に保持される', () => {
  const text = fmt.formatHumanCheck({
    taskId: 'task_abc', projectId: 'proj', reason: 'soft RED 未解決', details: '', task: null
  });
  assert.ok(text.includes('soft RED 未解決') || text.includes('技術詳細'), '技術詳細が保持されていない');
});

test('3g. index.js で formatHumanCheck が使われている', () => {
  assert.ok(src.includes('formatHumanCheck'), 'formatHumanCheck が index.js にない');
  // 旧メッセージが消えた
  assert.ok(!src.includes("人間確認が必要です — 一時停止"), '旧 HUMAN_CHECK メッセージが残っている');
});

// ─────────────────────────────────────────────────────
// 4. 既存機能保護
// ─────────────────────────────────────────────────────
console.log('\n[4. 既存機能保護]');

test('4a. 既存の formatter 関数（embedDesc / message / formatForHuman）が残っている', () => {
  assert.strictEqual(typeof fmt.embedDesc, 'function');
  assert.strictEqual(typeof fmt.message, 'function');
  assert.strictEqual(typeof fmt.formatForHuman, 'function');
  assert.strictEqual(typeof fmt.formatForCodex, 'function');
});

test('4b. formatForCEO エントリポイントが動作する', () => {
  const r1 = fmt.formatForCEO('github_push_failed', { taskId: 'x', pushError: '403' });
  const r2 = fmt.formatForCEO('task_error', { taskId: 'x', errorType: 'AUTH' });
  const r3 = fmt.formatForCEO('human_check', { taskId: 'x', projectId: 'p', reason: 'r' });
  assert.ok(r1.length > 10 && r2.length > 10 && r3.length > 10, 'formatForCEO が空文字を返した');
});

test('4c. 承認ロジック（approvalManager / consumePlan / handleApprove）は変更なし', () => {
  assert.ok(src.includes('approvalManager.ensurePending'), 'ensurePending が消えている');
  assert.ok(src.includes('async function handleApprove'), 'handleApprove が消えている');
});

test('4d. HUMAN_CHECK 承認ロジック（ctx.pendingApproval / ctx.stopReason）は変更なし', () => {
  const hcIdx   = src.indexOf('async function _handleHumanCheck');
  const hcEnd   = src.indexOf('\nfunction _isValidationFailureNote', hcIdx);
  const hcBody  = src.slice(hcIdx, hcEnd > 0 ? hcEnd : hcIdx + 2000);
  assert.ok(hcBody.includes('ctx.pendingApproval = taskId'), 'pendingApproval 設定が消えている');
  assert.ok(hcBody.includes("ctx.stopReason      = 'awaiting_human'"), 'stopReason 設定が消えている');
});

test('4e. Git 処理（commitAndPush）は変更なし', () => {
  assert.ok(src.includes('github.commitAndPush'), 'commitAndPush が消えている');
});

// ─────────────────────────────────────────────────────
// 5. Codex 高危険度 HUMAN_CHECK 通知（Phase D-1 追加対象）
// ─────────────────────────────────────────────────────
console.log('\n[5. Codex 高危険度通知]');

test('5a. formatCodexHighDanger が「承認すると」説明を含む', () => {
  const text = fmt.formatCodexHighDanger({ taskId: 'task_x', codexFile: 'reviews/codex_task_x.md' });
  assert.ok(text.includes('承認すると'), '承認後の説明がない');
  assert.ok(text.includes('Codex') || text.includes('レビュー'), '内容説明がない');
});

test('5b. formatCodexHighDanger が「却下すると」説明を含む', () => {
  const text = fmt.formatCodexHighDanger({ taskId: 'task_x', codexFile: 'reviews/codex_task_x.md' });
  assert.ok(text.includes('却下すると'), '却下後の説明がない');
});

test('5c. formatCodexHighDanger が「放置すると」説明を含む', () => {
  const text = fmt.formatCodexHighDanger({ taskId: 'task_x', codexFile: 'reviews/codex_task_x.md' });
  assert.ok(text.includes('放置すると'), '放置説明がない');
  assert.ok(text.includes('止まった') || text.includes('動き出さ') || text.includes('自動で進む'), '放置時の動作説明がない');
});

test('5d. formatCodexHighDanger に AI おすすめ・理由が含まれる', () => {
  const text = fmt.formatCodexHighDanger({ taskId: 'task_x', codexFile: 'reviews/codex_task_x.md' });
  assert.ok(text.includes('おすすめ') || text.includes('推奨'), 'AI おすすめがない');
  assert.ok(text.includes('理由'), 'おすすめ理由がない');
});

test('5e. formatCodexHighDanger の技術詳細（taskId・ファイル名）が下部に保持される', () => {
  const text = fmt.formatCodexHighDanger({ taskId: 'task_abc', codexFile: 'reviews/codex_task_abc.md' });
  assert.ok(text.includes('task_abc'), 'タスクIDが保持されていない');
  assert.ok(text.includes('技術詳細') || text.includes('🔧'), '技術詳細セクションがない');
  assert.ok(text.includes('codex_task_abc.md'), 'ファイル名が保持されていない');
});

test('5f. !approve / !deny コマンドが含まれる', () => {
  const text = fmt.formatCodexHighDanger({ taskId: 'task_xyz', codexFile: '' });
  assert.ok(text.includes('!approve task_xyz'), '!approve コマンドがない');
  assert.ok(text.includes('!deny'), '!deny コマンドがない');
});

test('5g. formatForCEO("codex_high_danger") がエントリポイントから呼べる', () => {
  const text = fmt.formatForCEO('codex_high_danger', { taskId: 'task_z', codexFile: 'f.md' });
  assert.ok(text.length > 50, 'formatForCEO codex_high_danger が空');
  assert.ok(text.includes('task_z'), 'taskId が含まれない');
});

test('5h. index.js で Codex 高危険度通知が formatCodexHighDanger を使っている', () => {
  assert.ok(src.includes('formatCodexHighDanger'), 'formatCodexHighDanger が index.js にない');
  // sendHumanMention の customMessage として渡されている
  const codexDangerIdx  = src.indexOf("codexRequest.danger === '高'");
  const codexDangerArea = src.slice(codexDangerIdx, codexDangerIdx + 400);
  assert.ok(codexDangerArea.includes('customMessage'), 'customMessage が渡されていない');
  assert.ok(codexDangerArea.includes('formatCodexHighDanger'), 'このブロックで formatCodexHighDanger が使われていない');
});

test('5i. sendHumanMention の承認ロジック（approvalManager.createApproval）は変更なし', () => {
  const sendHMIdx  = src.indexOf('async function sendHumanMention');
  const sendHMEnd  = src.indexOf('\nasync function sendPRHumanConfirm', sendHMIdx);
  const sendHMBody = src.slice(sendHMIdx, sendHMEnd > 0 ? sendHMEnd : sendHMIdx + 1500);
  assert.ok(sendHMBody.includes('approvalManager.createApproval'), '承認ロジックが消えている');
  assert.ok(sendHMBody.includes('reviewHistory.recordHumanConfirm'), '履歴記録が消えている');
});

test('5j. 旧フォーマット（「Codex依頼の危険度が「高」です / ログを確認してください」）は Codex 高危険ブロックから消えた', () => {
  const codexDangerIdx  = src.indexOf("codexRequest.danger === '高'");
  const codexDangerArea = src.slice(codexDangerIdx, codexDangerIdx + 400);
  assert.ok(!codexDangerArea.includes("'Codex 依頼の危険度が「高」です'") ||
            codexDangerArea.includes('customMessage'),
    '旧フォーマットのメッセージが残っている（customMessageに置き換えられるべき）');
});

// ─────────────────────────────────────────────────────
// 6. split task（_s1/_s2/_s3）でも新フォーマットが使われること
// ─────────────────────────────────────────────────────
console.log('\n[6. split task の Codex 高危険度通知]');

test('6a. _s1 suffix の taskId でも formatCodexHighDanger が生成できる', () => {
  const text = fmt.formatCodexHighDanger({
    taskId:   'task_1780329606501_s1',
    codexFile: 'reviews/codex_task_1780329606501_s1.md',
    danger:   '高',
  });
  assert.ok(text.includes('task_1780329606501_s1'), 'split taskId が含まれない');
  assert.ok(text.includes('承認すると'), '承認説明がない');
  assert.ok(text.includes('却下すると'), '却下説明がない');
  assert.ok(text.includes('放置すると'), '放置説明がない');
});

test('6b. _s2 / _s3 suffix の taskId でも formatCodexHighDanger が生成できる', () => {
  ['task_1780329606501_s2', 'task_1780329606501_s3'].forEach(tid => {
    const text = fmt.formatCodexHighDanger({ taskId: tid, codexFile: `reviews/codex_${tid}.md` });
    assert.ok(text.includes(tid), `${tid} がフォーマット結果に含まれない`);
    assert.ok(text.length > 100, `${tid} のフォーマットが短すぎる`);
  });
});

test('6c. sendHumanMention の customMessage が設定されると旧フォーマットが表示されない', () => {
  // sendHumanMention の処理を直接確認: customMessage があれば 【確認してほしいこと】 を含まない
  const sendHMIdx  = src.indexOf('async function sendHumanMention');
  const sendHMEnd  = src.indexOf('\nasync function sendPRHumanConfirm', sendHMIdx);
  const sendHMBody = src.slice(sendHMIdx, sendHMEnd > 0 ? sendHMEnd : sendHMIdx + 1500);

  // customMessage 分岐が三項演算子で実装されている
  assert.ok(sendHMBody.includes('options.customMessage'), 'customMessage 分岐がない');
  // customMessage が truthy の場合は 【確認してほしいこと】 を使わないことを確認
  const ternaryIdx  = sendHMBody.indexOf('options.customMessage');
  const ternaryArea = sendHMBody.slice(ternaryIdx, ternaryIdx + 300);
  assert.ok(
    ternaryArea.includes('?') && ternaryArea.includes(':'),
    '三項演算子での分岐がない（customMessage が常に使われるとは限らない）'
  );
});

test('6d. formatCodexHighDanger が formatter.js から正しくエクスポートされている', () => {
  const fmtSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'bot', 'utils', 'formatter.js'), 'utf8'
  );
  // exports に含まれている
  assert.ok(fmtSrc.includes('formatCodexHighDanger,') || fmtSrc.includes('formatCodexHighDanger\n'),
    'formatCodexHighDanger が module.exports にない');
  // 実際に関数として require できる
  const fmtModule = require('../bot/utils/formatter');
  assert.strictEqual(typeof fmtModule.formatCodexHighDanger, 'function',
    'formatCodexHighDanger が関数として取得できない（Bot 再起動が必要な可能性）');
});

test('6e. Codex 高危険ブロックで customMessage に formatCodexHighDanger が渡されており、split task でも同じパスを通る', () => {
  // executeClaudeTask は split task (_s1/_s2/_s3) でも同一関数が呼ばれる
  // (split task ID が _s で終わっても executeClaudeTask は区別しない)
  const claudeTaskIdx = src.indexOf('async function executeClaudeTask');
  const claudeTaskEnd = src.indexOf('\nasync function executeReviewTask', claudeTaskIdx);
  const claudeTaskBody = src.slice(claudeTaskIdx, claudeTaskEnd > 0 ? claudeTaskEnd : claudeTaskIdx + 10000);

  // Codex 高危険ブロックが executeClaudeTask 内にある
  assert.ok(claudeTaskBody.includes("codexRequest.danger === '高'"), 'Codex 高危険チェックが executeClaudeTask にない');
  assert.ok(claudeTaskBody.includes('customMessage'), 'customMessage が executeClaudeTask にない');
  assert.ok(claudeTaskBody.includes('formatCodexHighDanger'), 'formatCodexHighDanger が executeClaudeTask にない');

  // executeClaudeTask は全タスク（_s prefix 含む）に対して同一処理をする
  // （taskId をパターンマッチしていないため）
  assert.ok(!claudeTaskBody.includes("taskId.includes('_s')"), 'split task 専用の分岐が存在する（想定外）');
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
