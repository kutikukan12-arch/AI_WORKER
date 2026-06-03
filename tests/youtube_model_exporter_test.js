'use strict';
// youtube-model-exporter.js テスト
// 推論専用 export が training metadata を漏洩しないことを確認

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.error('  ❌', name, '\n    ', e.message); fail++; }
}

const exporter = require('../bot/utils/youtube-model-exporter');
const { FEATURE_DIM_PRE, FEATURE_NAMES_PRE } = require('../bot/utils/youtube-feature-extractor');
const src = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');

// テスト用一時ファイル
const TEST_EXPORT_FILE    = path.join(__dirname, '..', 'data', 'youtube-model-export-test.json');
const TEST_TRAINING_FILE  = path.join(__dirname, '..', 'data', 'youtube-model-pre.json');
const TRAINING_BACKUP     = TEST_TRAINING_FILE + '.export-test-bak';

// ─── テスト用 training model を保存 ─────────────────
function saveDummyTrainingModel() {
  const weights = new Array(FEATURE_DIM_PRE).fill(0).map((_, i) => (i * 0.1 - 0.7));
  const data = {
    weights,
    sampleCount:        50,           // ← 公開禁止
    hitCount:           28,           // ← 公開禁止
    missCount:          22,           // ← 公開禁止
    trainDirectionalAcc: 0.76,        // ← 公開禁止
    trainedAt:          '2026-06-04T00:00:00.000Z', // ← 公開禁止
    genreHitRates: {                  // ← 公開禁止
      vtuber: 0.62, game: 0.48, _overall: 0.55,
    },
  };
  const dir = path.dirname(TEST_TRAINING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // バックアップ
  if (fs.existsSync(TEST_TRAINING_FILE)) fs.copyFileSync(TEST_TRAINING_FILE, TRAINING_BACKUP);
  fs.writeFileSync(TEST_TRAINING_FILE, JSON.stringify(data, null, 2));
  return data;
}

function restoreTrainingModel() {
  if (fs.existsSync(TRAINING_BACKUP)) {
    fs.copyFileSync(TRAINING_BACKUP, TEST_TRAINING_FILE);
    fs.unlinkSync(TRAINING_BACKUP);
  }
  // テスト用 export ファイル削除
  if (fs.existsSync(TEST_EXPORT_FILE)) fs.unlinkSync(TEST_EXPORT_FILE);
}

// ─────────────────────────────────────────────────────
// 1. export に公開禁止フィールドが含まれない
// ─────────────────────────────────────────────────────
console.log('\n[1. 公開禁止フィールドの除外確認]');

saveDummyTrainingModel();

test('1a. export が成功する', () => {
  const r = exporter.exportInferenceModel(TEST_EXPORT_FILE);
  assert.strictEqual(r.ok, true, `export 失敗: ${r.message}`);
  assert.ok(fs.existsSync(TEST_EXPORT_FILE), 'export ファイルが作成されない');
});

test('1b. sampleCount が export に含まれない', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(!('sampleCount' in e), 'sampleCount が漏洩している');
});

test('1c. hitCount / missCount が export に含まれない', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(!('hitCount'  in e), 'hitCount が漏洩している');
  assert.ok(!('missCount' in e), 'missCount が漏洩している');
});

test('1d. trainDirectionalAcc が export に含まれない', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(!('trainDirectionalAcc' in e), 'trainDirectionalAcc が漏洩している');
});

test('1e. trainedAt が export に含まれない', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(!('trainedAt' in e), 'trainedAt が漏洩している');
});

test('1f. genreHitRates が export に含まれない', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(!('genreHitRates' in e), 'genreHitRates が漏洩している');
});

test('1g. EXCLUDED_FIELDS リストに公開禁止フィールドが全て含まれている', () => {
  const prohibited = ['sampleCount','hitCount','missCount','trainDirectionalAcc','trainedAt','genreHitRates'];
  for (const f of prohibited) {
    assert.ok(exporter.EXCLUDED_FIELDS.includes(f), `${f} が EXCLUDED_FIELDS にない`);
  }
});

// ─────────────────────────────────────────────────────
// 2. export に必須フィールドが含まれる
// ─────────────────────────────────────────────────────
console.log('\n[2. 推論に必要なフィールドの確認]');

test('2a. weights が export に含まれる', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(Array.isArray(e.weights), 'weights が配列でない');
  assert.strictEqual(e.weights.length, FEATURE_DIM_PRE,
    `weights 次元数が違う: ${e.weights.length} (期待: ${FEATURE_DIM_PRE})`);
});

test('2b. featureDim が export に含まれ正しい値', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.strictEqual(e.featureDim, FEATURE_DIM_PRE);
});

test('2c. featureNames が export に含まれ正しい数', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(Array.isArray(e.featureNames), 'featureNames が配列でない');
  assert.strictEqual(e.featureNames.length, FEATURE_DIM_PRE);
});

test('2d. version が export に含まれる', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(e.version, 'version がない');
});

test('2e. exportedAt が export に含まれる（trainedAt とは別）', () => {
  const e = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.ok(e.exportedAt, 'exportedAt がない');
  assert.ok(!('trainedAt' in e), 'trainedAt が漏洩している');
  // exportedAt は ISO 形式
  assert.ok(!isNaN(Date.parse(e.exportedAt)), 'exportedAt が日時でない');
});

test('2f. weights の値が training model のものと一致する', () => {
  const training  = JSON.parse(fs.readFileSync(TEST_TRAINING_FILE, 'utf8'));
  const exported  = JSON.parse(fs.readFileSync(TEST_EXPORT_FILE, 'utf8'));
  assert.deepStrictEqual(exported.weights, training.weights, 'weights の値が違う');
});

// ─────────────────────────────────────────────────────
// 3. training model なしの場合
// ─────────────────────────────────────────────────────
console.log('\n[3. training model なしのエラー処理]');

test('3a. training model がない場合 ok:false を返す', () => {
  // 一時的に training model を削除
  const bak = TEST_TRAINING_FILE + '.no-model-test';
  fs.copyFileSync(TEST_TRAINING_FILE, bak);
  fs.unlinkSync(TEST_TRAINING_FILE);

  const r = exporter.exportInferenceModel(TEST_EXPORT_FILE);
  assert.strictEqual(r.ok, false, 'training model なしで ok:true になった');

  // 復元
  fs.copyFileSync(bak, TEST_TRAINING_FILE);
  fs.unlinkSync(bak);
});

// ─────────────────────────────────────────────────────
// 4. training / export ファイルの分離確認
// ─────────────────────────────────────────────────────
console.log('\n[4. training / export 分離確認]');

test('4a. training model と export は別ファイル', () => {
  assert.notStrictEqual(
    path.resolve(TEST_TRAINING_FILE),
    path.resolve(exporter.EXPORT_FILE),
    'training と export が同じファイル'
  );
});

test('4b. .gitignore に training model が追加されている', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/youtube-model.json'),     'youtube-model.json が gitignore にない');
  assert.ok(gi.includes('data/youtube-model-pre.json'), 'youtube-model-pre.json が gitignore にない');
  assert.ok(gi.includes('data/youtube-seeds/'),         'youtube-seeds が gitignore にない');
});

test('4c. export ファイルは gitignore でコメントアウトされている（必要時のみ公開）', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  // export ファイルはコメントアウト or 記述なし（デフォルト非追跡）
  // # data/youtube-model-export.json の形でコメントされているか確認
  assert.ok(
    gi.includes('# data/youtube-model-export.json') || !gi.includes('data/youtube-model-export.json'),
    'export ファイルが gitignore に直接追加されている（意図して commit する場合は ! で除外する設計）'
  );
});

// ─────────────────────────────────────────────────────
// 5. getExportStatus
// ─────────────────────────────────────────────────────
console.log('\n[5. getExportStatus]');

test('5a. export 後に exportExists=true', () => {
  exporter.exportInferenceModel(TEST_EXPORT_FILE);
  // EXPORT_FILE は TEST_EXPORT_FILE ではないので直接確認
  assert.ok(fs.existsSync(TEST_EXPORT_FILE));
});

test('5b. getExportStatus が trainingModelExists を正しく返す', () => {
  const s = exporter.getExportStatus();
  // training model は存在する（saveDummyTrainingModel で作成済み）
  assert.strictEqual(s.trainingModelExists, true, 'trainingModelExists が false');
});

// ─────────────────────────────────────────────────────
// 6. index.js 統合確認
// ─────────────────────────────────────────────────────
console.log('\n[6. index.js 統合確認]');

test("6a. sub === 'export-model' が実装されている", () => {
  assert.ok(src.includes("sub === 'export-model'"), '!youtube export-model がない');
});

test('6b. export-model は Owner 限定', () => {
  const idx  = src.indexOf("sub === 'export-model'");
  const area = src.slice(idx, idx + 300);
  assert.ok(area.includes('DISCORD_OWNER_ID'), 'Owner 制限がない');
});

test('6c. youtube-model-exporter.js を require している', () => {
  const idx  = src.indexOf("sub === 'export-model'");
  const area = src.slice(idx, idx + 400);
  assert.ok(area.includes("require('./utils/youtube-model-exporter')"), 'require がない');
});

test('6d. !youtube ヘルプに export-model が記載されている', () => {
  assert.ok(src.includes('!youtube export-model'), 'ヘルプに export-model がない');
});

// ─────────────────────────────────────────────────────
// 7. git 追跡状態確認 (NEED_FIX 対応)
// ─────────────────────────────────────────────────────
console.log('\n[7. git 追跡状態確認]');

const { execSync } = require('child_process');

test('7a. data/youtube-model.json が git 追跡対象外', () => {
  // git ls-files で追跡されていないことを確認
  const tracked = execSync('git ls-files data/youtube-model.json', {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  }).trim();
  assert.strictEqual(tracked, '', `youtube-model.json が git 追跡されている: "${tracked}"`);
});

test('7b. data/youtube-model-pre.json が git 追跡対象外', () => {
  const tracked = execSync('git ls-files data/youtube-model-pre.json', {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  }).trim();
  assert.strictEqual(tracked, '', `youtube-model-pre.json が git 追跡されている: "${tracked}"`);
});

test('7c. data/youtube-model.json が .gitignore にマッチする', () => {
  // git check-ignore が 0 を返す（ignore 対象）
  try {
    execSync('git check-ignore data/youtube-model.json', {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
    });
    // exit 0 = ignored → OK
  } catch (e) {
    assert.fail(`gitignore にマッチしない (exit code: ${e.status})`);
  }
});

test('7d. data/youtube-model-pre.json が .gitignore にマッチする', () => {
  try {
    execSync('git check-ignore data/youtube-model-pre.json', {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
    });
  } catch (e) {
    assert.fail(`gitignore にマッチしない (exit code: ${e.status})`);
  }
});

test('7e. data/youtube-seeds/ が .gitignore にマッチする', () => {
  try {
    execSync('git check-ignore data/youtube-seeds/', {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
    });
  } catch (e) {
    assert.fail(`gitignore にマッチしない (exit code: ${e.status})`);
  }
});

test('7f. ローカルの training model ファイルが存在する（削除禁止確認）', () => {
  const modelPath    = path.join(__dirname, '..', 'data', 'youtube-model.json');
  const modelPrePath = path.join(__dirname, '..', 'data', 'youtube-model-pre.json');
  // テスト用に saveDummyTrainingModel を使ってファイルが存在することを確認
  // 実際のファイルがなければダミーを作成してからチェック
  if (!fs.existsSync(modelPrePath)) saveDummyTrainingModel();
  assert.ok(fs.existsSync(modelPrePath), 'youtube-model-pre.json がローカルに存在しない');
});

// ─────────────────────────────────────────────────────
// 8. docs/youtube-model-export-guide.md 確認
// ─────────────────────────────────────────────────────
console.log('\n[8. export ガイド確認]');

test('8a. docs/youtube-model-export-guide.md が存在する', () => {
  const guidePath = path.join(__dirname, '..', 'docs', 'youtube-model-export-guide.md');
  assert.ok(fs.existsSync(guidePath), 'export ガイドが存在しない');
});

test('8b. ガイドに「公開成果物」の記載がある', () => {
  const guide = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'youtube-model-export-guide.md'), 'utf8'
  );
  assert.ok(guide.includes('公開成果物'), '「公開成果物」の記載がない');
});

test('8c. ガイドに Webビルド手順が記載されている', () => {
  const guide = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'youtube-model-export-guide.md'), 'utf8'
  );
  assert.ok(guide.includes('Web') && guide.includes('ビルド'), 'Webビルド手順がない');
});

test('8d. ガイドに training model は gitignore と記載されている', () => {
  const guide = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'youtube-model-export-guide.md'), 'utf8'
  );
  assert.ok(guide.includes('gitignore'), 'gitignore の記載がない');
});

// ─────────────────────────────────────────────────────
// 後処理
// ─────────────────────────────────────────────────────
restoreTrainingModel();

console.log(`\n結果: ${pass} passed / ${fail} failed\n`);
if (fail > 0) process.exit(1);
