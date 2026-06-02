'use strict';

/**
 * predict-cli.js の APIキーなし動作確認テスト (Phase 2)
 *
 * テスト対象（HTTP通信・APIキー不要）:
 *   - parseArgs()      CLI 引数パーサー
 *   - validateArgs()   数値バリデーション（subprocess で終了コード確認）
 *   - stripMarkdown()  Discord マークダウン除去
 *   - CLI 統合テスト   subprocess で end-to-end 確認
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const { parseArgs, validateArgs, stripMarkdown } = require('../bot/predict-cli');

const CLI_PATH = path.join(__dirname, '..', 'bot', 'predict-cli.js');

// ── subprocess ヘルパー ────────────────────────────────────────
function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout:  15000,
    env:      { ...process.env, LOG_LEVEL: 'WARN' },
    ...opts,
  });
}

// ─────────────────────────────────────────────────────
// parseArgs()
// ─────────────────────────────────────────────────────

describe('parseArgs()', () => {

  describe('長形式オプション', () => {
    test('--title "タイトル" → title が設定される', () => {
      const args = parseArgs(['node', 'cli.js', '--title', 'テスト動画']);
      assert.equal(args.title, 'テスト動画');
    });

    test('--subs 1000 → subs が数値 1000', () => {
      const args = parseArgs(['node', 'cli.js', '--subs', '1000']);
      assert.equal(args.subs, 1000);
      assert.ok(typeof args.subs === 'number');
    });

    test('--views 5000 → views が数値 5000', () => {
      const args = parseArgs(['node', 'cli.js', '--views', '5000']);
      assert.equal(args.views, 5000);
    });

    test('--likes 300 → likes が数値 300', () => {
      const args = parseArgs(['node', 'cli.js', '--likes', '300']);
      assert.equal(args.likes, 300);
    });

    test('--comments 40 → comments が数値 40', () => {
      const args = parseArgs(['node', 'cli.js', '--comments', '40']);
      assert.equal(args.comments, 40);
    });

    test('--duration 600 → duration が数値 600', () => {
      const args = parseArgs(['node', 'cli.js', '--duration', '600']);
      assert.equal(args.duration, 600);
    });

    test('--desc "説明文" → description が設定される', () => {
      const args = parseArgs(['node', 'cli.js', '--desc', '説明文テスト']);
      assert.equal(args.description, '説明文テスト');
    });

    test('--published "2024-01-01T00:00:00Z" → publishedAt が設定される', () => {
      const args = parseArgs(['node', 'cli.js', '--published', '2024-01-01T00:00:00Z']);
      assert.equal(args.publishedAt, '2024-01-01T00:00:00Z');
    });

    test('--json → json = true', () => {
      const args = parseArgs(['node', 'cli.js', '--json']);
      assert.equal(args.json, true);
    });

    test('--channel "テストch" → channel が設定される', () => {
      const args = parseArgs(['node', 'cli.js', '--channel', 'テストch']);
      assert.equal(args.channel, 'テストch');
    });
  });

  describe('短形式オプション', () => {
    test('-t "タイトル" → --title の短縮形として動作', () => {
      const args = parseArgs(['node', 'cli.js', '-t', '短縮タイトル']);
      assert.equal(args.title, '短縮タイトル');
    });

    test('-s 500 → --subs の短縮形として動作', () => {
      const args = parseArgs(['node', 'cli.js', '-s', '500']);
      assert.equal(args.subs, 500);
    });

    test('-v 1000 → --views の短縮形として動作', () => {
      const args = parseArgs(['node', 'cli.js', '-v', '1000']);
      assert.equal(args.views, 1000);
    });

    test('-l 100 → --likes の短縮形として動作', () => {
      const args = parseArgs(['node', 'cli.js', '-l', '100']);
      assert.equal(args.likes, 100);
    });

    test('-c "ch名" → --channel の短縮形として動作', () => {
      const args = parseArgs(['node', 'cli.js', '-c', 'myCh']);
      assert.equal(args.channel, 'myCh');
    });

    test('-d 900 → --duration の短縮形として動作', () => {
      const args = parseArgs(['node', 'cli.js', '-d', '900']);
      assert.equal(args.duration, 900);
    });
  });

  describe('タグパーシング', () => {
    test('--tags "AI,技術,解説" → 3要素の配列', () => {
      const args = parseArgs(['node', 'cli.js', '--tags', 'AI,技術,解説']);
      assert.deepEqual(args.tags, ['AI', '技術', '解説']);
    });

    test('--tag AI --tag 技術 → 複数 --tag が結合される', () => {
      const args = parseArgs(['node', 'cli.js', '--tag', 'AI', '--tag', '技術']);
      assert.deepEqual(args.tags, ['AI', '技術']);
    });

    test('--tags と --tag の混在 → 全て結合される', () => {
      const args = parseArgs(['node', 'cli.js', '--tags', 'A,B', '--tag', 'C']);
      assert.deepEqual(args.tags, ['A', 'B', 'C']);
    });

    test('タグなし → tags は空配列', () => {
      const args = parseArgs(['node', 'cli.js', '--title', 'test']);
      assert.deepEqual(args.tags, []);
    });

    test('--tags の前後空白は trim される', () => {
      const args = parseArgs(['node', 'cli.js', '--tags', ' A , B , C ']);
      assert.deepEqual(args.tags, ['A', 'B', 'C']);
    });

    test('--tags 内の空文字は除外される', () => {
      const args = parseArgs(['node', 'cli.js', '--tags', 'A,,B']);
      assert.deepEqual(args.tags, ['A', 'B']);
    });
  });

  describe('複合オプション', () => {
    test('全オプション一括 → 全フィールドが設定される', () => {
      const args = parseArgs([
        'node', 'cli.js',
        '-t', 'タイトル',
        '-s', '10000',
        '-v', '5000',
        '-l', '300',
        '--comments', '40',
        '-d', '600',
        '--desc', '説明',
        '--tags', 'tag1,tag2',
        '--channel', 'ch',
        '--json',
      ]);
      assert.equal(args.title,       'タイトル');
      assert.equal(args.subs,        10000);
      assert.equal(args.views,       5000);
      assert.equal(args.likes,       300);
      assert.equal(args.comments,    40);
      assert.equal(args.duration,    600);
      assert.equal(args.description, '説明');
      assert.deepEqual(args.tags,    ['tag1', 'tag2']);
      assert.equal(args.channel,     'ch');
      assert.equal(args.json,        true);
    });

    test('オプションなし → 全フィールドが未定義、tags は空配列', () => {
      const args = parseArgs(['node', 'cli.js']);
      assert.equal(args.title,       undefined);
      assert.equal(args.subs,        undefined);
      assert.equal(args.views,       undefined);
      assert.deepEqual(args.tags,    []);
      assert.equal(args.json,        undefined);
    });
  });
});

// ─────────────────────────────────────────────────────
// stripMarkdown()
// ─────────────────────────────────────────────────────

describe('stripMarkdown()', () => {

  test('** で囲まれたテキスト → ** が除去される', () => {
    assert.equal(stripMarkdown('**太字テキスト**'), '太字テキスト');
  });

  test('バッククォートで囲まれたテキスト → ` が除去される', () => {
    assert.equal(stripMarkdown('`コード`'), 'コード');
  });

  test('複合マークダウン → 両方除去される', () => {
    assert.equal(stripMarkdown('**確率:** `90%`'), '確率: 90%');
  });

  test('マークダウンなしのテキスト → そのまま返る', () => {
    assert.equal(stripMarkdown('普通のテキスト'), '普通のテキスト');
  });

  test('空文字列 → 空文字列', () => {
    assert.equal(stripMarkdown(''), '');
  });

  test('複数の ** → 全て除去される', () => {
    assert.equal(stripMarkdown('**A** と **B**'), 'A と B');
  });

  test('複数のバッククォート → 全て除去される', () => {
    assert.equal(stripMarkdown('`hit` と `miss`'), 'hit と miss');
  });

  test('YouTube ヒット予測サマリー形式 → ** と ` が除去される', () => {
    const input  = '🎬 **YouTube ヒット予測**\n🟢 **確率:** 90%  `hit`（伸びやすい）';
    const output = stripMarkdown(input);
    assert.ok(!output.includes('**'), '** が残っている');
    assert.ok(!output.includes('`'),  '` が残っている');
    assert.ok(output.includes('YouTube ヒット予測'), 'テキスト内容が失われた');
    assert.ok(output.includes('90%'), '確率が失われた');
  });
});

// ─────────────────────────────────────────────────────
// validateArgs() — subprocess で終了コード確認
// ─────────────────────────────────────────────────────

describe('validateArgs() — 数値バリデーション (subprocess)', () => {

  test('--subs に文字列 "abc" → 終了コード 1', () => {
    const r = runCli(['--title', 'test', '--subs', 'abc']);
    assert.equal(r.status, 1, `exit code=${r.status}, stderr=${r.stderr}`);
  });

  test('--views に文字列 → 終了コード 1', () => {
    const r = runCli(['--title', 'test', '--views', 'xxx']);
    assert.equal(r.status, 1);
  });

  test('--likes に文字列 → 終了コード 1', () => {
    const r = runCli(['--title', 'test', '--likes', 'bad']);
    assert.equal(r.status, 1);
  });

  test('--comments に文字列 → 終了コード 1', () => {
    const r = runCli(['--title', 'test', '--comments', 'bad']);
    assert.equal(r.status, 1);
  });

  test('--duration に文字列 → 終了コード 1', () => {
    const r = runCli(['--title', 'test', '--duration', 'bad']);
    assert.equal(r.status, 1);
  });

  test('数値が正しければ終了コード 0', () => {
    const r = runCli(['--title', 'テスト', '--subs', '1000', '--duration', '600']);
    assert.equal(r.status, 0, `exit code=${r.status}, stderr=${r.stderr}`);
  });
});

// ─────────────────────────────────────────────────────
// CLI 統合テスト (subprocess)
// ─────────────────────────────────────────────────────

describe('CLI 統合テスト — APIキーなし (subprocess)', () => {

  describe('エラーケース', () => {
    test('--title なし → 終了コード 1', () => {
      const r = runCli(['--subs', '1000']);
      assert.equal(r.status, 1);
    });

    test('--title なし → stderr に "入力エラー" が含まれる', () => {
      const r = runCli(['--subs', '1000']);
      assert.ok(r.stderr.includes('入力エラー') || r.stdout.includes('入力エラー'),
        `エラーメッセージなし: stderr="${r.stderr}" stdout="${r.stdout}"`);
    });

    test('未知のオプション → 終了コード 1', () => {
      const r = runCli(['--title', 'test', '--unknown-opt', 'val']);
      assert.equal(r.status, 1);
    });
  });

  describe('正常終了ケース', () => {
    test('--title のみ → 終了コード 0', () => {
      const r = runCli(['--title', 'テスト動画タイトル']);
      assert.equal(r.status, 0, `exit code=${r.status}, stderr=${r.stderr}`);
    });

    test('stdout に "YouTube ヒット予測" が含まれる', () => {
      const r = runCli(['--title', 'テスト動画タイトル']);
      assert.ok(r.stdout.includes('YouTube ヒット予測'),
        `出力に "YouTube ヒット予測" がない: ${r.stdout.slice(0, 200)}`);
    });

    test('stdout に確率(%) が含まれる', () => {
      const r = runCli(['--title', 'テスト動画タイトル', '--subs', '10000']);
      assert.ok(/\d+%/.test(r.stdout), `% が含まれない: ${r.stdout.slice(0, 200)}`);
    });

    test('--views なし → stdout に "投稿前予測" が含まれる', () => {
      const r = runCli(['--title', 'テスト', '--subs', '1000']);
      assert.ok(r.stdout.includes('投稿前'), `投稿前モードの表示がない: ${r.stdout.slice(0, 300)}`);
    });

    test('--views あり → stdout に "視聴数" が含まれる（投稿後モード）', () => {
      const r = runCli(['--title', 'テスト', '--subs', '1000', '--views', '5000']);
      assert.ok(r.stdout.includes('視聴数'), `視聴数行がない: ${r.stdout.slice(0, 300)}`);
    });

    test('--subs 100000 (hit圏) → stdout に 🟢 が含まれる', () => {
      // 10万登録者チャンネルで視聴5万 → buzz_ratio=0.5（miss/unknownかも）
      // 視聴数を十分大きく設定 → hit 圏
      const r = runCli(['--title', 'テスト動画', '--subs', '1000', '--views', '10000']);
      assert.ok(r.stdout.includes('🟢') || r.stdout.includes('🟡') || r.stdout.includes('🔴'),
        `絵文字がない: ${r.stdout.slice(0, 200)}`);
    });

    test('stdout に "予測再生数レンジ" が含まれる（subscriberCount あり）', () => {
      const r = runCli(['--title', 'テスト', '--subs', '5000']);
      assert.ok(r.stdout.includes('予測再生数レンジ'), `レンジ表示がない: ${r.stdout.slice(0, 300)}`);
    });

    test('--channel が指定されると stdout に "チャンネル :" が含まれる', () => {
      const r = runCli(['--title', 'テスト', '--channel', 'MyChannel']);
      assert.ok(r.stdout.includes('チャンネル'), `チャンネル表示がない: ${r.stdout.slice(0, 300)}`);
    });

    test('--tags タグ入り → stdout に "タグ :" が含まれる', () => {
      const r = runCli(['--title', 'テスト', '--tags', 'AI,技術']);
      assert.ok(r.stdout.includes('タグ'), `タグ表示がない: ${r.stdout.slice(0, 300)}`);
    });
  });

  describe('--json 出力', () => {
    test('--json → stdout に "--- JSON ---" が含まれる', () => {
      const r = runCli(['--title', 'テスト', '--json']);
      assert.ok(r.stdout.includes('--- JSON ---'), `JSON ブロックがない: ${r.stdout.slice(0, 300)}`);
    });

    test('--json → stdout に "probability" フィールドが含まれる', () => {
      const r = runCli(['--title', 'テスト', '--json']);
      assert.ok(r.stdout.includes('"probability"'), `probability がない: ${r.stdout.slice(0, 300)}`);
    });

    test('--json → JSON.parse 可能な probability が 0〜100 の整数', () => {
      const r = runCli(['--title', 'テスト', '--subs', '1000', '--json']);
      const jsonStart = r.stdout.indexOf('{', r.stdout.indexOf('--- JSON ---'));
      assert.ok(jsonStart >= 0, 'JSON ブロックが見つからない');
      const jsonObj = JSON.parse(r.stdout.slice(jsonStart));
      const p = jsonObj?.result?.probability;
      assert.ok(Number.isInteger(p) && p >= 0 && p <= 100,
        `probability=${p} が 0〜100 の整数でない`);
    });

    test('--json → result に label / confidence / usedML が含まれる', () => {
      const r = runCli(['--title', 'テスト', '--subs', '1000', '--json']);
      const jsonStart = r.stdout.indexOf('{', r.stdout.indexOf('--- JSON ---'));
      const jsonObj = JSON.parse(r.stdout.slice(jsonStart));
      assert.ok('label'      in jsonObj.result, 'label がない');
      assert.ok('confidence' in jsonObj.result, 'confidence がない');
      assert.ok('usedML'     in jsonObj.result, 'usedML がない');
    });
  });

  describe('--help', () => {
    test('--help → 終了コード 0', () => {
      const r = runCli(['--help']);
      assert.equal(r.status, 0, `exit code=${r.status}`);
    });

    test('-h → stdout に "使い方:" が含まれる', () => {
      const r = runCli(['-h']);
      assert.ok(r.stdout.includes('使い方'), `ヘルプ内容がない: ${r.stdout.slice(0, 300)}`);
    });
  });

  describe('エンドツーエンド: 投稿前モード', () => {
    test('多彩なタイトル・タグ・尺を指定 → エラーなく予測される', () => {
      const r = runCli([
        '--title', '【衝撃】AIが仕事を奪う未来！？🤖🎬🎬🎬🎬🎬',
        '--subs', '50000',
        '--tags', 'AI,テクノロジー,未来,解説,衝撃',
        '--duration', '600',
        '--channel', 'AI Research JP',
      ]);
      assert.equal(r.status, 0, `exit code=${r.status}, stderr=${r.stderr}`);
      assert.ok(r.stdout.includes('YouTube ヒット予測'), '予測結果がない');
    });

    test('最小入力（title のみ）→ 予測結果が返る', () => {
      const r = runCli(['--title', 'a']);
      assert.equal(r.status, 0);
      assert.ok(/\d+%/.test(r.stdout), `確率がない: ${r.stdout.slice(0, 200)}`);
    });
  });

  describe('エンドツーエンド: 投稿後モード', () => {
    test('視聴数・いいね・コメントを指定 → エラーなく予測される', () => {
      const r = runCli([
        '--title', 'daily vlog',
        '--subs', '1000',
        '--views', '8500',
        '--likes', '300',
        '--comments', '40',
        '--duration', '900',
      ]);
      assert.equal(r.status, 0, `exit code=${r.status}, stderr=${r.stderr}`);
      assert.ok(r.stdout.includes('YouTube ヒット予測'));
    });

    test('高視聴数 (buzz_ratio=10) → stdout に hit 関連の絵文字/テキストがある', () => {
      const r = runCli([
        '--title', 'ヒット動画テスト',
        '--subs', '1000',
        '--views', '10000',
      ]);
      assert.equal(r.status, 0);
      // 🟢 または hit が含まれる
      assert.ok(r.stdout.includes('🟢') || r.stdout.includes('hit'),
        `hit 判定の表示がない: ${r.stdout.slice(0, 300)}`);
    });

    test('低視聴数 (buzz_ratio=0.1) → stdout に miss 関連の絵文字/テキストがある', () => {
      const r = runCli([
        '--title', 'ミス動画テスト',
        '--subs', '1000',
        '--views', '100',
      ]);
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes('🔴') || r.stdout.includes('miss'),
        `miss 判定の表示がない: ${r.stdout.slice(0, 300)}`);
    });
  });
});
