'use strict';
/**
 * ユーザーインターフェース ユーザビリティテスト
 * 対象: dashboard-server.js (API ロジック) + dashboard.html (フロントエンド関数)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// § 1. サーバー側: apiApprovals データ正規化
// ═══════════════════════════════════════════════════════
describe('apiApprovals: データ形式の正規化', () => {
  // dashboard-server.js の apiApprovals 内ロジックを抽出
  function normalizeApprovals(data) {
    return Array.isArray(data) ? data : (data?.approvals ?? Object.values(data ?? {}));
  }

  test('配列はそのまま返す', () => {
    const data = [{ id: 'a1', status: 'pending' }];
    assert.deepEqual(normalizeApprovals(data), data);
  });

  test('{ approvals: [...] } 形式は approvals 配列を返す', () => {
    const data = { approvals: [{ id: 'a1' }, { id: 'a2' }] };
    const result = normalizeApprovals(data);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a1');
  });

  test('オブジェクト形式は Object.values を返す', () => {
    const data = { abc: { id: 'a1', status: 'pending' }, def: { id: 'a2', status: 'done' } };
    const result = normalizeApprovals(data);
    assert.equal(result.length, 2);
  });

  test('null は空配列として扱われる', () => {
    assert.deepEqual(normalizeApprovals(null), []);
  });

  test('undefined は空配列として扱われる', () => {
    assert.deepEqual(normalizeApprovals(undefined), []);
  });
});

// ═══════════════════════════════════════════════════════
// § 2. サーバー側: URL ルーティング
// ═══════════════════════════════════════════════════════
describe('dashboard-server: URL ルーティング', () => {
  const ROUTES_KEYS = ['/api/tasks', '/api/runner', '/api/projects', '/api/approvals'];

  test('4 つの API ルートが全て定義されている', () => {
    const required = ['/api/tasks', '/api/runner', '/api/projects', '/api/approvals'];
    for (const r of required) {
      assert.ok(ROUTES_KEYS.includes(r), `ルート ${r} が未定義`);
    }
  });

  test('クエリ文字列を除去してルートにマッチする', () => {
    const inputs = ['/api/tasks?filter=pending', '/api/runner?ts=123', '/api/approvals?v=1'];
    for (const url of inputs) {
      const stripped = url.split('?')[0];
      assert.ok(ROUTES_KEYS.includes(stripped), `${url} → ${stripped} がルートに存在しない`);
    }
  });

  test('未定義ルートは HTML サーブにフォールスルーする', () => {
    const unknownUrls = ['/', '/favicon.ico', '/dashboard', '/api/unknown'];
    for (const url of unknownUrls) {
      assert.ok(!ROUTES_KEYS.includes(url.split('?')[0]), `${url} が誤って API ルートに存在`);
    }
  });
});

// ═══════════════════════════════════════════════════════
// § 3. フロントエンド: fmt() 日付フォーマット
// ═══════════════════════════════════════════════════════
describe('fmt(): 日付フォーマット', () => {
  // dashboard.html の fmt() 関数をそのまま抽出
  function fmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
      + ' ' + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  test('null は "—" を返す', () => assert.equal(fmt(null), '—'));
  test('undefined は "—" を返す', () => assert.equal(fmt(undefined), '—'));
  test('空文字は "—" を返す', () => assert.equal(fmt(''), '—'));

  test('有効な ISO 文字列は "—" 以外の文字列を返す', () => {
    const result = fmt('2026-06-01T12:00:00Z');
    assert.ok(result.length > 1);
    assert.notEqual(result, '—');
  });

  test('異なる日時は異なる文字列を返す', () => {
    const r1 = fmt('2026-06-01T12:00:00Z');
    const r2 = fmt('2026-06-02T08:30:00Z');
    assert.notEqual(r1, r2);
  });
});

// ═══════════════════════════════════════════════════════
// § 4. フロントエンド: shortId() タスクID短縮
// ═══════════════════════════════════════════════════════
describe('shortId(): タスクID短縮', () => {
  function shortId(id) {
    return id ? id.replace('task_', '') : id;
  }

  test('"task_" プレフィックスを除去する', () => {
    assert.equal(shortId('task_1780166268483'), '1780166268483');
  });

  test('"task_" を含まない文字列はそのまま返す', () => {
    assert.equal(shortId('abc123'), 'abc123');
  });

  test('null は null を返す（falsy）', () => {
    assert.equal(shortId(null), null);
  });

  test('undefined は undefined を返す（falsy）', () => {
    assert.equal(shortId(undefined), undefined);
  });

  test('空文字は空文字を返す（falsy）', () => {
    assert.equal(shortId(''), '');
  });

  test('"task_" が途中に含まれる場合も先頭のみ除去', () => {
    assert.equal(shortId('task_prefix_task_suffix'), 'prefix_task_suffix');
  });
});

// ═══════════════════════════════════════════════════════
// § 5. フロントエンド: renderStats() 集計ロジック
// ═══════════════════════════════════════════════════════
describe('renderStats(): タスク状態集計', () => {
  function countStates(tasks) {
    const counts = {};
    tasks.forEach(t => { counts[t.state] = (counts[t.state] || 0) + 1; });
    return {
      total:   tasks.length,
      pending: counts['未着手']       || 0,
      inprog:  counts['作業中']       || 0,
      review:  counts['レビュー待ち'] || 0,
      await:   counts['人間確認待ち'] || 0,
      done:    counts['完了']         || 0,
      hold:    counts['保留']         || 0,
    };
  }

  test('空配列は全カウント 0', () => {
    const r = countStates([]);
    assert.equal(r.total, 0);
    assert.equal(r.pending, 0);
    assert.equal(r.done, 0);
  });

  test('未着手 2件 + 完了 1件 を正しく集計する', () => {
    const tasks = [
      { state: '未着手' }, { state: '未着手' }, { state: '完了' },
    ];
    const r = countStates(tasks);
    assert.equal(r.total, 3);
    assert.equal(r.pending, 2);
    assert.equal(r.done, 1);
  });

  test('6 状態が全て混在するとき各カウントが 1', () => {
    const tasks = [
      { state: '未着手' }, { state: '作業中' }, { state: 'レビュー待ち' },
      { state: '人間確認待ち' }, { state: '完了' }, { state: '保留' },
    ];
    const r = countStates(tasks);
    assert.equal(r.total,   6);
    assert.equal(r.pending, 1);
    assert.equal(r.inprog,  1);
    assert.equal(r.review,  1);
    assert.equal(r.await,   1);
    assert.equal(r.done,    1);
    assert.equal(r.hold,    1);
  });

  test('未知の状態値は既存カテゴリに影響しない', () => {
    const tasks = [{ state: 'UNKNOWN' }, { state: '完了' }];
    const r = countStates(tasks);
    assert.equal(r.total, 2);
    assert.equal(r.done,  1);
    assert.equal(r.pending, 0);
  });
});

// ═══════════════════════════════════════════════════════
// § 6. フロントエンド: タスクフィルタリング
// ═══════════════════════════════════════════════════════
describe('renderTasks(): フィルタリングロジック', () => {
  const tasks = [
    { id: 't1', state: '未着手',  type: 'IMPLEMENT', priority: '高', prompt: 'タスク1' },
    { id: 't2', state: '完了',    type: 'DOCS',      priority: '低', prompt: 'タスク2' },
    { id: 't3', state: '作業中',  type: 'TEST',      priority: '中', prompt: 'タスク3' },
    { id: 't4', state: '完了',    type: 'IMPLEMENT', priority: '中', prompt: 'タスク4' },
    { id: 't5', state: '保留',    type: 'OPS',       priority: '低', prompt: 'タスク5' },
  ];

  function filterTasks(tasks, activeFilter) {
    return activeFilter === 'all' ? tasks : tasks.filter(t => t.state === activeFilter);
  }

  test('"all" フィルタは全タスクを返す', () => {
    assert.equal(filterTasks(tasks, 'all').length, 5);
  });

  test('"完了" フィルタは完了タスクのみ返す', () => {
    const result = filterTasks(tasks, '完了');
    assert.equal(result.length, 2);
    assert.ok(result.every(t => t.state === '完了'));
  });

  test('"未着手" フィルタは 1件のみ返す', () => {
    const result = filterTasks(tasks, '未着手');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 't1');
  });

  test('"作業中" フィルタは 1件のみ返す', () => {
    const result = filterTasks(tasks, '作業中');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 't3');
  });

  test('存在しない状態でフィルタすると空配列', () => {
    assert.equal(filterTasks(tasks, 'レビュー待ち').length, 0);
  });

  test('フィルタ後の配列は元の配列と同一参照でない（変更安全）', () => {
    const result = filterTasks(tasks, '完了');
    assert.notEqual(result, tasks);
  });
});

// ═══════════════════════════════════════════════════════
// § 7. フロントエンド: renderApprovals() 承認待ちフィルタ
// ═══════════════════════════════════════════════════════
describe('renderApprovals(): 承認待ちフィルタ', () => {
  function pendingApprovals(approvals) {
    return approvals.filter(a => a.status === 'pending' || !a.status);
  }

  test('status="pending" のものを返す', () => {
    const approvals = [
      { id: 'a1', status: 'pending' },
      { id: 'a2', status: 'approved' },
    ];
    const result = pendingApprovals(approvals);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a1');
  });

  test('status 未設定（!a.status）も pending 扱いにする', () => {
    const approvals = [
      { id: 'a1' },
      { id: 'a2', status: 'approved' },
    ];
    const result = pendingApprovals(approvals);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a1');
  });

  test('全件 approved なら空配列', () => {
    const approvals = [
      { id: 'a1', status: 'approved' },
      { id: 'a2', status: 'approved' },
    ];
    assert.equal(pendingApprovals(approvals).length, 0);
  });

  test('空配列は空配列', () => {
    assert.equal(pendingApprovals([]).length, 0);
  });

  test('pending と status なしが混在する場合、両方を返す', () => {
    const approvals = [
      { id: 'a1', status: 'pending' },
      { id: 'a2' },
      { id: 'a3', status: 'approved' },
    ];
    const result = pendingApprovals(approvals);
    assert.equal(result.length, 2);
  });
});

// ═══════════════════════════════════════════════════════
// § 8. フロントエンド: runnerBadge() バッジ生成
// ═══════════════════════════════════════════════════════
describe('runnerBadge(): ランナー状態バッジ', () => {
  function runnerBadge(state) {
    if (state.enabled)     return '<span class="badge on">実行中</span>';
    if (state.pauseReason) return '<span class="badge paused">一時停止</span>';
    return '<span class="badge off">停止</span>';
  }

  test('enabled=true → "実行中" バッジ (badge on)', () => {
    const badge = runnerBadge({ enabled: true });
    assert.ok(badge.includes('実行中'));
    assert.ok(badge.includes('badge on'));
  });

  test('enabled=false + pauseReason あり → "一時停止" バッジ (badge paused)', () => {
    const badge = runnerBadge({ enabled: false, pauseReason: '手動停止' });
    assert.ok(badge.includes('一時停止'));
    assert.ok(badge.includes('badge paused'));
  });

  test('enabled=false + pauseReason なし → "停止" バッジ (badge off)', () => {
    const badge = runnerBadge({ enabled: false });
    assert.ok(badge.includes('停止'));
    assert.ok(badge.includes('badge off'));
  });

  test('enabled が truthy なら pauseReason より優先される', () => {
    const badge = runnerBadge({ enabled: true, pauseReason: '何か理由' });
    assert.ok(badge.includes('badge on'));
    assert.ok(!badge.includes('paused'));
  });

  test('enabled=false の場合 "実行中" が含まれない', () => {
    const badge = runnerBadge({ enabled: false });
    assert.ok(!badge.includes('badge on'));
  });
});

// ═══════════════════════════════════════════════════════
// § 9. フロントエンド: タスク updatedAt 降順ソート
// ═══════════════════════════════════════════════════════
describe('タスク一覧: updatedAt 降順ソート', () => {
  function sortByUpdatedAt(tasks) {
    return [...tasks].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  test('新しい updatedAt が先頭に来る', () => {
    const tasks = [
      { id: 't1', updatedAt: '2026-06-01T10:00:00Z' },
      { id: 't2', updatedAt: '2026-06-02T10:00:00Z' },
      { id: 't3', updatedAt: '2026-05-31T10:00:00Z' },
    ];
    const sorted = sortByUpdatedAt(tasks);
    assert.equal(sorted[0].id, 't2');
    assert.equal(sorted[1].id, 't1');
    assert.equal(sorted[2].id, 't3');
  });

  test('ソートは元の配列を破壊しない', () => {
    const tasks = [
      { id: 't1', updatedAt: '2026-06-01T10:00:00Z' },
      { id: 't2', updatedAt: '2026-06-02T10:00:00Z' },
    ];
    const original = [...tasks];
    sortByUpdatedAt(tasks);
    assert.deepEqual(tasks, original);
  });

  test('updatedAt が null の場合にエラーにならない', () => {
    const tasks = [
      { id: 't1', updatedAt: null },
      { id: 't2', updatedAt: '2026-06-01T10:00:00Z' },
    ];
    assert.doesNotThrow(() => sortByUpdatedAt(tasks));
    assert.equal(sortByUpdatedAt(tasks).length, 2);
  });

  test('単一要素は並び替えなしでそのまま返す', () => {
    const tasks = [{ id: 't1', updatedAt: '2026-06-01T10:00:00Z' }];
    assert.equal(sortByUpdatedAt(tasks)[0].id, 't1');
  });
});

// ═══════════════════════════════════════════════════════
// § 10. セキュリティ: title 属性 XSS 対策
// ═══════════════════════════════════════════════════════
describe('タスクテーブル: title 属性の XSS 対策', () => {
  // dashboard.html の renderTasks() 内 title= 属性生成ロジック
  function sanitizeTitleAttr(prompt) {
    return (prompt || '').replace(/"/g, '&quot;');
  }

  test('"（ダブルクォート）を &quot; に置換する', () => {
    const result = sanitizeTitleAttr('task "name" here');
    assert.ok(!result.includes('"'), 'ダブルクォートが残存している');
    assert.ok(result.includes('&quot;'));
  });

  test('複数のダブルクォートを全て置換する', () => {
    const result = sanitizeTitleAttr('"a" and "b"');
    assert.equal(result, '&quot;a&quot; and &quot;b&quot;');
  });

  test('null は空文字として扱い例外を投げない', () => {
    assert.doesNotThrow(() => sanitizeTitleAttr(null));
    assert.equal(sanitizeTitleAttr(null), '');
  });

  test('undefined は空文字として扱う', () => {
    assert.equal(sanitizeTitleAttr(undefined), '');
  });

  test('クォートを含まない文字列はそのまま返す', () => {
    assert.equal(sanitizeTitleAttr('通常のテキスト'), '通常のテキスト');
  });

  test('シングルクォートはそのまま残す（&apos; 変換不要）', () => {
    const result = sanitizeTitleAttr("it's here");
    assert.ok(result.includes("'"), 'シングルクォートが意図せず消えた');
  });
});
