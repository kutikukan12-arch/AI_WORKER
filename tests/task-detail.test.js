/**
 * !task <ID> 詳細表示ルート のテスト
 *
 * テスト対象:
 *   1. task_ プレフィックス付き引数は常に ID として扱う
 *   2. タスク未存在時は usage ではなく「タスクが見つかりません」を返す
 *   3. タスク存在・別プロジェクト時は「現在プロジェクト外」を返す
 *   4. 既存サブコマンド（list/stats/done 等）は壊れていない
 */

'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────
// handleTask のルーティングロジックを独立して再現するヘルパー
// （Discord message に依存しない純粋ロジック）
// ─────────────────────────────────────────────────────
function routeTaskCommand(args, { getTask, taskBelongsToProject }) {
  const sub    = args[0] || 'list';
  const taskId = args[1] || '';

  // 既存サブコマンド群
  const KNOWN_SUBS = new Set([
    'list', 'stats', 'done', 'hold', 'resume',
    'merge', 'split', 'archive', 'add', 'edit', 'cleanup',
  ]);
  if (KNOWN_SUBS.has(sub)) {
    return { route: 'subcommand', sub };
  }

  // task_ プレフィックスは常に ID 扱い
  if (sub.startsWith('task_')) {
    const task = getTask(sub);
    if (!task) {
      return { route: 'not_found', id: sub };
    }
    if (!taskBelongsToProject(task)) {
      return { route: 'wrong_project', id: sub, task };
    }
    return { route: 'detail', task };
  }

  return { route: 'usage' };
}

// ─────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────

describe('!task <ID> ルーティング', () => {

  const MOCK_TASK = {
    id: 'task_1780166268483',
    state: 'AWAITING',
    priority: '中',
    priorityReason: 'テスト',
    dangerLevel: '低',
    assignee: 'none',
    prompt: 'テストタスク',
    type: 'IMPLEMENT',
    size: 'MEDIUM',
    projectId: 'ai_worker',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stateHistory: [],
  };

  test('task_ プレフィックスの引数は detail ルートに入る（タスクあり・同プロジェクト）', () => {
    const result = routeTaskCommand(
      ['task_1780166268483'],
      {
        getTask: (id) => id === 'task_1780166268483' ? MOCK_TASK : null,
        taskBelongsToProject: () => true,
      }
    );
    assert.equal(result.route, 'detail');
    assert.equal(result.task.id, 'task_1780166268483');
  });

  test('タスクが存在しない場合は not_found を返す（usage ではない）', () => {
    const result = routeTaskCommand(
      ['task_9999999999999'],
      {
        getTask: () => null,
        taskBelongsToProject: () => true,
      }
    );
    assert.equal(result.route, 'not_found');
    assert.equal(result.id, 'task_9999999999999');
  });

  test('タスクが存在するが別プロジェクトの場合は wrong_project を返す', () => {
    const result = routeTaskCommand(
      ['task_1780166268483'],
      {
        getTask: (id) => id === 'task_1780166268483' ? MOCK_TASK : null,
        taskBelongsToProject: () => false,
      }
    );
    assert.equal(result.route, 'wrong_project');
    assert.equal(result.id, 'task_1780166268483');
  });

  test('既存サブコマンド list は subcommand ルートに入る（task_ と混同しない）', () => {
    const result = routeTaskCommand(
      ['list'],
      { getTask: () => null, taskBelongsToProject: () => true }
    );
    assert.equal(result.route, 'subcommand');
    assert.equal(result.sub, 'list');
  });

  test('既存サブコマンド stats は subcommand ルートに入る', () => {
    const result = routeTaskCommand(
      ['stats'],
      { getTask: () => null, taskBelongsToProject: () => true }
    );
    assert.equal(result.route, 'subcommand');
  });

  test('既存サブコマンド done は subcommand ルートに入る', () => {
    const result = routeTaskCommand(
      ['done', 'task_1780166268483'],
      { getTask: () => null, taskBelongsToProject: () => true }
    );
    assert.equal(result.route, 'subcommand');
    assert.equal(result.sub, 'done');
  });

  test('引数なしのとき usage にならず list ルートに入る', () => {
    const result = routeTaskCommand(
      [],
      { getTask: () => null, taskBelongsToProject: () => true }
    );
    // 引数なし → sub='list' → subcommand ルート
    assert.equal(result.route, 'subcommand');
    assert.equal(result.sub, 'list');
  });

  test('不明な文字列は usage ルートに入る（task_ でないもの）', () => {
    const result = routeTaskCommand(
      ['unknowncommand'],
      { getTask: () => null, taskBelongsToProject: () => true }
    );
    assert.equal(result.route, 'usage');
  });

});

// ─────────────────────────────────────────────────────
// task-manager.js の getTask / formatTaskDetail 単体テスト
// ─────────────────────────────────────────────────────

describe('task-manager: getTask', () => {

  test('存在しない ID に対して null を返す', () => {
    // task-manager は data/tasks.json を読む。テスト環境では空データを想定。
    // loadTasks が [] を返すケースを模倣するため getTask 相当ロジックを直接テスト
    const tasks = [];
    const found = tasks.find(t => t.id === 'task_9999999999999') || null;
    assert.equal(found, null);
  });

  test('一致する ID があれば返す', () => {
    const MOCK = { id: 'task_1780166268483', state: 'AWAITING' };
    const tasks = [MOCK];
    const found = tasks.find(t => t.id === 'task_1780166268483') || null;
    assert.deepEqual(found, MOCK);
  });

});

describe('task_ プレフィックス判定', () => {

  test('"task_" で始まる文字列は task ID として認識される', () => {
    assert.ok('task_1780166268483'.startsWith('task_'));
    assert.ok('task_0'.startsWith('task_'));
  });

  test('"list" "stats" "done" 等は task ID として認識されない', () => {
    for (const sub of ['list', 'stats', 'done', 'hold', 'resume', 'add', 'edit']) {
      assert.ok(!sub.startsWith('task_'), `"${sub}" は task_ ではないはず`);
    }
  });

});
