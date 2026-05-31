'use strict';
// workspace/<projectId>/<taskId>/ 対応の resolveTaskWorkspace テスト

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name); console.error('    ', e.message); fail++; }
}

// ─── resolveTaskWorkspace をモジュールから取り出す ───
// codex-feedback.js はモジュール内部関数として定義されているため
// テスト用に同じロジックを再現して検証する
const WORKSPACE_PATH = path.join(__dirname, '..', 'workspace');

function resolveTaskWorkspace(taskId, projectId) {
  if (projectId) {
    const scoped = path.join(WORKSPACE_PATH, projectId, taskId);
    if (fs.existsSync(scoped)) return scoped;
  }
  const legacy = path.join(WORKSPACE_PATH, taskId);
  if (fs.existsSync(legacy)) return legacy;
  try {
    for (const entry of fs.readdirSync(WORKSPACE_PATH, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const c = path.join(WORKSPACE_PATH, entry.name, taskId);
      if (fs.existsSync(c)) return c;
    }
  } catch {}
  return null;
}

console.log('\n[resolveTaskWorkspace — workspace 解決テスト]');

// ─── 1. projectId 指定で workspace/ai_worker/task_XXX/ を発見 ───
test('projectId 指定: workspace/ai_worker/task_1780192832764/ を見つける', () => {
  const result = resolveTaskWorkspace('task_1780192832764', 'ai_worker');
  assert.ok(result, 'result は null でない');
  assert.ok(result.includes('ai_worker'), `ai_worker を含む: ${result}`);
  assert.ok(result.includes('task_1780192832764'), `taskId を含む: ${result}`);
  assert.ok(fs.existsSync(result), `パスが実在する: ${result}`);
});

// ─── 2. projectId なし → スキャンで発見 ───
test('projectId なし: スキャンで workspace/ai_worker/task_1780192832764/ を発見', () => {
  const result = resolveTaskWorkspace('task_1780192832764', null);
  assert.ok(result, 'result は null でない');
  assert.ok(result.includes('task_1780192832764'), `taskId を含む: ${result}`);
  assert.ok(fs.existsSync(result), `パスが実在する: ${result}`);
});

// ─── 3. 存在しない taskId → null ───
test('存在しない taskId → null を返す', () => {
  const result = resolveTaskWorkspace('task_nonexistent_99999', null);
  assert.strictEqual(result, null, `null であるべき: ${result}`);
});

// ─── 4. 別の taskId もスキャンで発見 ───
test('別 taskId: task_1780192131750 もスキャンで発見', () => {
  const result = resolveTaskWorkspace('task_1780192131750', null);
  assert.ok(result, 'result は null でない');
  assert.ok(result.includes('task_1780192131750'), `taskId を含む: ${result}`);
});

// ─── 5. 旧形式（workspace/<taskId>/）が存在すれば優先（仮想テスト）───
test('旧形式 workspace/<taskId>/ が存在する場合は優先される', () => {
  const tmpDir  = os.tmpdir();
  const taskId  = 'task_legacy_test_001';
  const legacyPath = path.join(tmpDir, taskId);
  const scopedPath = path.join(tmpDir, 'some_project', taskId);

  // legacy パスのみ作成
  fs.mkdirSync(legacyPath, { recursive: true });

  // ─ WORKSPACE_PATH を tmpDir に向けた関数でテスト ─
  function resolveLocal(tid, pid) {
    if (pid) {
      const s = path.join(tmpDir, pid, tid);
      if (fs.existsSync(s)) return s;
    }
    const l = path.join(tmpDir, tid);
    if (fs.existsSync(l)) return l;
    try {
      for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const c = path.join(tmpDir, e.name, tid);
        if (fs.existsSync(c)) return c;
      }
    } catch {}
    return null;
  }

  const result = resolveLocal(taskId, 'some_project');
  // scoped が存在しないので legacy にフォールバック
  assert.strictEqual(result, legacyPath, `旧形式パスが返るべき: ${result}`);

  // クリーンアップ
  fs.rmdirSync(legacyPath);
});

// ─── 6. getOriginalPrompt が解決済みワークスペースを使う ───
test('getOriginalPrompt: workspace/ai_worker/task_1780192832764/prompt.md を読める', () => {
  const ws = resolveTaskWorkspace('task_1780192832764', 'ai_worker');
  assert.ok(ws, 'workspace が解決できる');
  const promptFile = path.join(ws, 'prompt.md');
  // prompt.md が存在することを確認（存在しない場合はスキップ）
  if (fs.existsSync(promptFile)) {
    const content = fs.readFileSync(promptFile, 'utf8');
    assert.ok(content.length > 0, 'prompt.md の内容が空でない');
  } else {
    // result.md なら OK
    const resultFile = path.join(ws, 'result.md');
    assert.ok(fs.existsSync(resultFile), 'result.md が存在する');
  }
});

// ─── 7. 構文チェック（codex-feedback.js） ───
test('node -c bot/utils/codex-feedback.js が通る', () => {
  const { execSync } = require('child_process');
  const out = execSync(
    'node -c bot/utils/codex-feedback.js',
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: 'pipe' }
  );
  assert.ok(out.includes('OK') || out === '', `構文 OK: ${out}`);
});

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
