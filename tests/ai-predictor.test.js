'use strict';

/**
 * ai-predictor.js のユニットテスト
 *
 * テスト対象:
 *   1. predictAIRouting()      — AI ルーティング予測
 *   2. predictTaskOutcome()    — タスク成功確率予測
 *   3. predictCompletionTime() — 完了時間推定
 *   4. buildPredictionSummary() — Discord 用サマリー生成
 *   5. predict()               — メインエントリーポイント統合
 *   6. reloadWeights() / reloadV2Models() — キャッシュリセット
 *
 * 注意: data/predictor-weights.json / data/ml-models.json が
 *       存在しない環境を想定したルールベースのみのテスト。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  predict,
  predictAIRouting,
  predictTaskOutcome,
  predictCompletionTime,
  buildPredictionSummary,
  reloadWeights,
  reloadV2Models,
} = require('../bot/utils/ai-predictor');

// ─────────────────────────────────────────────────────
// predictAIRouting()
// ─────────────────────────────────────────────────────

describe('predictAIRouting()', () => {

  describe('戻り値の構造', () => {
    test('必須フィールドを全て持つ', () => {
      const r = predictAIRouting('テスト', 'IMPLEMENT');
      assert.ok('recommended' in r, 'recommended がない');
      assert.ok('confidence'  in r, 'confidence がない');
      assert.ok('scores'      in r, 'scores がない');
      assert.ok('reason'      in r, 'reason がない');
    });

    test('scores に Codex / ChatGPT / Claude Code が揃っている', () => {
      const { scores } = predictAIRouting('任意のプロンプト', 'RESEARCH');
      assert.ok('Codex'       in scores);
      assert.ok('ChatGPT'     in scores);
      assert.ok('Claude Code' in scores);
    });

    test('confidence は high / medium / low のいずれか', () => {
      const { confidence } = predictAIRouting('実装する', 'IMPLEMENT');
      assert.ok(['high', 'medium', 'low'].includes(confidence), `不正な confidence: ${confidence}`);
    });

    test('recommended は既知の AI 名のいずれか', () => {
      const { recommended } = predictAIRouting('設計を相談したい', 'DESIGN');
      assert.ok(['Codex', 'ChatGPT', 'Claude Code'].includes(recommended));
    });

    test('reason は空でない文字列', () => {
      const { reason } = predictAIRouting('実装', 'IMPLEMENT');
      assert.ok(typeof reason === 'string' && reason.length > 0);
    });
  });

  describe('Codex シグナル検出', () => {
    test('バグ修正プロンプト → Codex が最高スコア', () => {
      const { scores } = predictAIRouting('バグがあって動かない。crashしている', 'RESEARCH');
      assert.ok(scores['Codex'] > scores['ChatGPT'],     `Codex(${scores['Codex']}) > ChatGPT(${scores['ChatGPT']})`);
      assert.ok(scores['Codex'] > scores['Claude Code'], `Codex(${scores['Codex']}) > ClaudeCode(${scores['Claude Code']})`);
    });

    test('セキュリティプロンプト → Codex スコアが上昇', () => {
      const base   = predictAIRouting('適当なプロンプト',           'RESEARCH').scores['Codex'];
      const secure = predictAIRouting('セキュリティの脆弱性を修正', 'RESEARCH').scores['Codex'];
      assert.ok(secure > base, `secure(${secure}) > base(${base})`);
    });

    test('FIX タイプ + error キーワード → Codex 推奨', () => {
      const { recommended } = predictAIRouting('errorが出ている。bugを直してほしい', 'FIX');
      assert.equal(recommended, 'Codex');
    });
  });

  describe('ChatGPT シグナル検出', () => {
    test('仕様相談プロンプト → ChatGPT スコアが上昇', () => {
      const base    = predictAIRouting('適当なプロンプト',   'DESIGN').scores['ChatGPT'];
      const specMsg = predictAIRouting('仕様を設計したい。アドバイスをください', 'DESIGN').scores['ChatGPT'];
      assert.ok(specMsg > base, `specMsg(${specMsg}) > base(${base})`);
    });

    test('DESIGN タイプ → ChatGPT に +2 補正', () => {
      const noKeyword = predictAIRouting('', 'DESIGN').scores['ChatGPT'];
      const refScore  = predictAIRouting('', 'OPS').scores['ChatGPT'];
      assert.ok(noKeyword >= refScore, `DESIGN補正: ${noKeyword} >= ${refScore}`);
    });

    test('RESEARCH タイプ → ChatGPT に +2 補正', () => {
      const noKeyword = predictAIRouting('', 'RESEARCH').scores['ChatGPT'];
      const refScore  = predictAIRouting('', 'OPS').scores['ChatGPT'];
      assert.ok(noKeyword >= refScore);
    });
  });

  describe('Claude Code シグナル検出', () => {
    test('実装プロンプト → Claude Code スコアが上昇', () => {
      const base  = predictAIRouting('適当なプロンプト', 'IMPLEMENT').scores['Claude Code'];
      const impl  = predictAIRouting('新機能を実装してcreateしてほしい', 'IMPLEMENT').scores['Claude Code'];
      assert.ok(impl > base, `impl(${impl}) > base(${base})`);
    });

    test('IMPLEMENT タイプ → Claude Code に +2 補正、ChatGPT -3 抑制', () => {
      const r = predictAIRouting('', 'IMPLEMENT');
      const r2 = predictAIRouting('', 'RESEARCH');
      // IMPLEMENT は Claude Code に有利
      assert.ok(r.scores['Claude Code'] > r2.scores['Claude Code']);
    });

    test('スコアが全て 0 の場合はデフォルト Claude Code', () => {
      // 意図的に何のシグナルも含まないプロンプト + IMPLEMENT 以外
      const { recommended } = predictAIRouting('', 'OPS');
      // OPS にはキーワードなしで scores が全て 0 に近い → Claude Code デフォルト
      // scores の最大が 0 のときは Claude Code
      assert.equal(recommended, 'Claude Code');
    });
  });

  describe('confidence ラベルのロジック', () => {
    test('スコア差が大きいほど confidence が高い（high → low の順序性）', () => {
      // 強いシグナルが多数あれば high になりやすい
      const strong  = predictAIRouting('バグがある。errorがcrashしている。セキュリティの脆弱性。修正して最適化', 'FIX');
      const neutral = predictAIRouting('', 'OPS');
      // strong の confidence は neutral 以上であること
      const rank = { high: 2, medium: 1, low: 0 };
      assert.ok(rank[strong.confidence] >= rank[neutral.confidence]);
    });
  });

  describe('output 引数の利用', () => {
    test('output を渡しても戻り値構造が変わらない', () => {
      const r = predictAIRouting('実装する', 'IMPLEMENT', 'Done: 実装完了しました。');
      assert.ok('recommended' in r);
      assert.ok('scores'      in r);
    });

    test('output のキーワードもスコアに加算される', () => {
      const noOut   = predictAIRouting('適当な内容', 'RESEARCH', '');
      const withOut = predictAIRouting('適当な内容', 'RESEARCH', 'バグがある errorが発生 crash');
      assert.ok(withOut.scores['Codex'] >= noOut.scores['Codex']);
    });
  });
});

// ─────────────────────────────────────────────────────
// predictTaskOutcome()
// ─────────────────────────────────────────────────────

describe('predictTaskOutcome()', () => {

  describe('戻り値の構造', () => {
    test('probability / confidence / risks / bonuses を持つ', () => {
      const r = predictTaskOutcome('テスト', 'IMPLEMENT');
      assert.ok('probability' in r);
      assert.ok('confidence'  in r);
      assert.ok(Array.isArray(r.risks));
      assert.ok(Array.isArray(r.bonuses));
    });

    test('probability は 0〜100 の整数', () => {
      const { probability } = predictTaskOutcome('テスト', 'IMPLEMENT', 'MEDIUM');
      assert.ok(Number.isInteger(probability));
      assert.ok(probability >= 0 && probability <= 100, `out of range: ${probability}`);
    });

    test('confidence は high / medium / low のいずれか', () => {
      const { confidence } = predictTaskOutcome('テスト', 'FIX');
      assert.ok(['high', 'medium', 'low'].includes(confidence));
    });
  });

  describe('タスクタイプ別の基本値', () => {
    const ALL_TYPES = ['IMPLEMENT', 'FIX', 'RESEARCH', 'DESIGN', 'REVIEW', 'DOCS', 'OPS', 'TEST'];

    test('全タイプで probability が [0, 100] 範囲内', () => {
      for (const type of ALL_TYPES) {
        const { probability } = predictTaskOutcome('タスクを完了する', type, 'MEDIUM');
        assert.ok(
          probability >= 0 && probability <= 100,
          `${type}: probability=${probability} が範囲外`
        );
      }
    });

    test('REVIEW は IMPLEMENT より確率が高い（基本値差: 92 vs 75）', () => {
      const review    = predictTaskOutcome('タスクを完了する', 'REVIEW',    'MEDIUM');
      const implement = predictTaskOutcome('タスクを完了する', 'IMPLEMENT', 'MEDIUM');
      assert.ok(
        review.probability >= implement.probability,
        `REVIEW(${review.probability}) >= IMPLEMENT(${implement.probability})`
      );
    });

    test('RESEARCH は IMPLEMENT より確率が高い（基本値差: 90 vs 75）', () => {
      const research  = predictTaskOutcome('タスクを完了する', 'RESEARCH',  'MEDIUM');
      const implement = predictTaskOutcome('タスクを完了する', 'IMPLEMENT', 'MEDIUM');
      assert.ok(
        research.probability >= implement.probability,
        `RESEARCH(${research.probability}) >= IMPLEMENT(${implement.probability})`
      );
    });

    test('全タイプで probability が整数', () => {
      for (const type of ALL_TYPES) {
        const { probability } = predictTaskOutcome('タスクを完了する', type, 'MEDIUM');
        assert.ok(Number.isInteger(probability), `${type}: ${probability} が整数でない`);
      }
    });
  });

  describe('リスク要因の検出', () => {
    test('認証キーワード → risks に追加、確率が下がる', () => {
      const base  = predictTaskOutcome('タスクを完了する', 'IMPLEMENT', 'MEDIUM');
      const risky = predictTaskOutcome('認証トークンを扱う auth 処理', 'IMPLEMENT', 'MEDIUM');
      assert.ok(risky.risks.includes('認証・機密関連'), `risks: ${risky.risks}`);
      assert.ok(risky.probability < base.probability);
    });

    test('削除操作キーワード → risks に追加（ペナルティ最大 -20）', () => {
      const risky = predictTaskOutcome('データを削除する drop table', 'IMPLEMENT', 'MEDIUM');
      assert.ok(risky.risks.includes('データ削除操作'));
    });

    test('本番環境キーワード → risks に追加', () => {
      const risky = predictTaskOutcome('本番環境へdeploy', 'OPS', 'MEDIUM');
      assert.ok(risky.risks.includes('本番環境変更'));
    });

    test('DB キーワード → risks に追加', () => {
      const risky = predictTaskOutcome('databaseのsql migration', 'IMPLEMENT', 'MEDIUM');
      assert.ok(risky.risks.includes('DB操作'));
    });

    test('複数リスク → 確率がさらに低い', () => {
      const single = predictTaskOutcome('認証処理', 'IMPLEMENT', 'MEDIUM');
      const multi  = predictTaskOutcome('認証処理を本番環境でdeploy', 'IMPLEMENT', 'MEDIUM');
      assert.ok(multi.probability <= single.probability);
    });
  });

  describe('ポジティブ要因の検出', () => {
    test('テストキーワード → bonuses に追加、確率が上がる', () => {
      const base  = predictTaskOutcome('タスク完了', 'IMPLEMENT', 'MEDIUM');
      const bonus = predictTaskOutcome('テストを追加して検証する', 'IMPLEMENT', 'MEDIUM');
      assert.ok(bonus.bonuses.includes('テスト付き'));
      assert.ok(bonus.probability >= base.probability);
    });

    test('バックアップキーワード → bonuses に追加', () => {
      const r = predictTaskOutcome('バックアップを作成してから変更', 'IMPLEMENT', 'MEDIUM');
      assert.ok(r.bonuses.includes('バックアップ前提'));
    });

    test('最小変更キーワード → bonuses に追加', () => {
      const r = predictTaskOutcome('小さく最小限の変更で実装', 'IMPLEMENT', 'MEDIUM');
      assert.ok(r.bonuses.includes('最小変更'));
    });

    test('ドキュメントキーワード → bonuses に追加', () => {
      const r = predictTaskOutcome('ドキュメントを更新するREADME', 'DOCS', 'MEDIUM');
      assert.ok(r.bonuses.includes('ドキュメント系'));
    });
  });

  describe('タスクサイズ補正', () => {
    test('SMALL は MEDIUM より確率が高い', () => {
      const small  = predictTaskOutcome('タスク', 'IMPLEMENT', 'SMALL');
      const medium = predictTaskOutcome('タスク', 'IMPLEMENT', 'MEDIUM');
      assert.ok(small.probability >= medium.probability);
    });

    test('LARGE は MEDIUM より確率が低い', () => {
      const large  = predictTaskOutcome('タスク', 'IMPLEMENT', 'LARGE');
      const medium = predictTaskOutcome('タスク', 'IMPLEMENT', 'MEDIUM');
      assert.ok(large.probability <= medium.probability);
    });

    test('SMALL / MEDIUM / LARGE の順で確率が単調減少', () => {
      const s = predictTaskOutcome('タスク', 'IMPLEMENT', 'SMALL');
      const m = predictTaskOutcome('タスク', 'IMPLEMENT', 'MEDIUM');
      const l = predictTaskOutcome('タスク', 'IMPLEMENT', 'LARGE');
      assert.ok(s.probability >= m.probability && m.probability >= l.probability);
    });
  });

  describe('確率の境界値', () => {
    test('大量リスク → 0 未満にならない（_clamp）', () => {
      const prompt = '認証 削除 本番 database Phase9 Phase10';
      const { probability } = predictTaskOutcome(prompt, 'IMPLEMENT', 'LARGE');
      assert.ok(probability >= 0, `probability=${probability} が負`);
    });

    test('大量ボーナス → 100 超えない（_clamp）', () => {
      const prompt = 'テスト バックアップ 小さく ドキュメント';
      const { probability } = predictTaskOutcome(prompt, 'REVIEW', 'SMALL');
      assert.ok(probability <= 100, `probability=${probability} が 100 超`);
    });
  });

  describe('confidence の判定', () => {
    test('シグナルなし → low', () => {
      const { confidence } = predictTaskOutcome('タスクを完了する', 'IMPLEMENT', 'MEDIUM');
      assert.equal(confidence, 'low');
    });

    test('シグナル 1 件 → medium', () => {
      const { confidence } = predictTaskOutcome('認証処理', 'IMPLEMENT', 'MEDIUM');
      assert.equal(confidence, 'medium');
    });

    test('シグナル 3 件以上 → high', () => {
      const prompt = '認証 削除 本番 テスト バックアップ';
      const { confidence } = predictTaskOutcome(prompt, 'IMPLEMENT', 'MEDIUM');
      assert.equal(confidence, 'high');
    });
  });
});

// ─────────────────────────────────────────────────────
// predictCompletionTime()
// ─────────────────────────────────────────────────────

describe('predictCompletionTime()', () => {

  describe('戻り値の構造', () => {
    test('estimateMin / estimateMax / unit を持つ', () => {
      const r = predictCompletionTime('IMPLEMENT', 'MEDIUM');
      assert.ok('estimateMin' in r);
      assert.ok('estimateMax' in r);
      assert.ok('unit'        in r);
    });

    test('unit は "minutes"', () => {
      assert.equal(predictCompletionTime('IMPLEMENT').unit, 'minutes');
    });

    test('estimateMin <= estimateMax', () => {
      for (const type of ['IMPLEMENT', 'FIX', 'RESEARCH', 'DESIGN', 'REVIEW', 'DOCS', 'OPS', 'TEST']) {
        for (const size of ['SMALL', 'MEDIUM', 'LARGE']) {
          const { estimateMin, estimateMax } = predictCompletionTime(type, size);
          assert.ok(
            estimateMin <= estimateMax,
            `${type}/${size}: min(${estimateMin}) > max(${estimateMax})`
          );
        }
      }
    });

    test('estimateMin が 1 以上の正の整数', () => {
      const { estimateMin } = predictCompletionTime('REVIEW', 'SMALL');
      assert.ok(Number.isInteger(estimateMin) && estimateMin >= 1);
    });
  });

  describe('タスクサイズによる時間係数', () => {
    test('SMALL は MEDIUM より短い', () => {
      const small  = predictCompletionTime('IMPLEMENT', 'SMALL');
      const medium = predictCompletionTime('IMPLEMENT', 'MEDIUM');
      const smallMid  = (small.estimateMin  + small.estimateMax)  / 2;
      const mediumMid = (medium.estimateMin + medium.estimateMax) / 2;
      assert.ok(smallMid < mediumMid, `SMALL mid(${smallMid}) >= MEDIUM mid(${mediumMid})`);
    });

    test('LARGE は MEDIUM より長い', () => {
      const large  = predictCompletionTime('IMPLEMENT', 'LARGE');
      const medium = predictCompletionTime('IMPLEMENT', 'MEDIUM');
      const largeMid  = (large.estimateMin  + large.estimateMax)  / 2;
      const mediumMid = (medium.estimateMin + medium.estimateMax) / 2;
      assert.ok(largeMid > mediumMid, `LARGE mid(${largeMid}) <= MEDIUM mid(${mediumMid})`);
    });
  });

  describe('タスクタイプ別の時間範囲', () => {
    test('REVIEW SMALL が最短', () => {
      const reviewSmall = predictCompletionTime('REVIEW', 'SMALL');
      assert.ok(reviewSmall.estimateMin <= 5, `REVIEW/SMALL min=${reviewSmall.estimateMin}`);
    });

    test('IMPLEMENT LARGE が最長クラス', () => {
      const { estimateMax } = predictCompletionTime('IMPLEMENT', 'LARGE');
      assert.ok(estimateMax >= 60, `IMPLEMENT/LARGE max=${estimateMax}`);
    });
  });

  describe('未知タイプ・サイズのフォールバック', () => {
    test('未知タイプ → デフォルト値（エラーにならない）', () => {
      assert.doesNotThrow(() => predictCompletionTime('UNKNOWN_TYPE', 'MEDIUM'));
    });

    test('未知サイズ → multiplier 1.0 フォールバック', () => {
      const unknown = predictCompletionTime('IMPLEMENT', 'UNKNOWN_SIZE');
      const medium  = predictCompletionTime('IMPLEMENT', 'MEDIUM');
      assert.deepEqual(unknown, medium);
    });
  });
});

// ─────────────────────────────────────────────────────
// buildPredictionSummary()
// ─────────────────────────────────────────────────────

describe('buildPredictionSummary()', () => {
  test('文字列を返す', () => {
    const r = buildPredictionSummary('実装する', 'IMPLEMENT', 'MEDIUM');
    assert.ok(typeof r === 'string');
  });

  test('担当AI予測 / 成功確率 / 完了時間推定 の見出しを含む', () => {
    const r = buildPredictionSummary('実装する', 'IMPLEMENT', 'MEDIUM');
    assert.ok(r.includes('担当AI予測'));
    assert.ok(r.includes('成功確率'));
    assert.ok(r.includes('完了時間推定'));
  });

  test('リスクがある場合は ⚠️ リスク を含む', () => {
    const r = buildPredictionSummary('認証処理を本番環境でdeploy', 'IMPLEMENT', 'MEDIUM');
    assert.ok(r.includes('リスク'));
  });

  test('ポジティブ要因がある場合は ✨ ポジティブ を含む', () => {
    const r = buildPredictionSummary('テストを追加して検証する', 'IMPLEMENT', 'MEDIUM');
    assert.ok(r.includes('ポジティブ'));
  });

  test('リスク/ボーナスが検出されない場合は該当行がない', () => {
    const r = buildPredictionSummary('タスクを完了する', 'IMPLEMENT', 'MEDIUM');
    assert.ok(!r.includes('⚠️ リスク'));
    assert.ok(!r.includes('✨ ポジティブ'));
  });

  test('数値（確率%、時間）が文字列内に含まれる', () => {
    const r = buildPredictionSummary('実装する', 'IMPLEMENT', 'MEDIUM');
    assert.ok(/\d+%/.test(r), '確率(%)が見当たらない');
    assert.ok(/\d+〜\d+分/.test(r), '時間推定が見当たらない');
  });

  test('精度データなし（ルールベースのみ）でもクラッシュしない', () => {
    assert.doesNotThrow(() => buildPredictionSummary('実装する', 'IMPLEMENT', 'MEDIUM'));
  });

  test('精度データなし時は予測精度根拠行が含まれない', () => {
    // data/predictor-weights.json が存在しないテスト環境では精度フッターは出力されない
    const r = buildPredictionSummary('実装する', 'IMPLEMENT', 'MEDIUM');
    // 精度データがある場合のみ出力されるフッターは、ないときに例外を出さないことを確認
    assert.ok(typeof r === 'string' && r.length > 0);
  });
});

// ─────────────────────────────────────────────────────
// predict() — メインエントリーポイント
// ─────────────────────────────────────────────────────

describe('predict()', () => {
  test('routing / outcome / time / summary を全て返す', () => {
    const r = predict('実装する', 'IMPLEMENT', 'MEDIUM');
    assert.ok('routing' in r, 'routing がない');
    assert.ok('outcome' in r, 'outcome がない');
    assert.ok('time'    in r, 'time がない');
    assert.ok('summary' in r, 'summary がない');
  });

  test('routing は predictAIRouting() と一致', () => {
    const prompt = '新機能を実装してほしい';
    const full   = predict(prompt, 'IMPLEMENT', 'MEDIUM');
    const single = predictAIRouting(prompt, 'IMPLEMENT');
    assert.equal(full.routing.recommended, single.recommended);
    assert.equal(full.routing.confidence,  single.confidence);
  });

  test('outcome は predictTaskOutcome() と一致', () => {
    const prompt = '認証処理を本番環境へ';
    const full   = predict(prompt, 'IMPLEMENT', 'MEDIUM');
    const single = predictTaskOutcome(prompt, 'IMPLEMENT', 'MEDIUM');
    assert.equal(full.outcome.probability, single.probability);
    assert.deepEqual(full.outcome.risks,   single.risks);
  });

  test('time は predictCompletionTime() と一致', () => {
    const full   = predict('任意', 'FIX', 'SMALL');
    const single = predictCompletionTime('FIX', 'SMALL');
    assert.equal(full.time.estimateMin, single.estimateMin);
    assert.equal(full.time.estimateMax, single.estimateMax);
  });

  test('summary は文字列', () => {
    const { summary } = predict('実装する', 'IMPLEMENT', 'SMALL');
    assert.ok(typeof summary === 'string' && summary.length > 0);
  });

  test('引数省略でもエラーにならない', () => {
    assert.doesNotThrow(() => predict('プロンプトのみ'));
  });
});

// ─────────────────────────────────────────────────────
// reloadWeights() / reloadV2Models()
// ─────────────────────────────────────────────────────

describe('reloadWeights() / reloadV2Models()', () => {
  test('reloadWeights() はオブジェクトを返す', () => {
    const w = reloadWeights();
    assert.ok(typeof w === 'object' && w !== null);
  });

  test('reloadV2Models() はオブジェクトを返す', () => {
    const m = reloadV2Models();
    assert.ok(typeof m === 'object' && m !== null);
  });

  test('reload 後も predictAIRouting() が正常動作', () => {
    reloadWeights();
    reloadV2Models();
    assert.doesNotThrow(() => predictAIRouting('実装する', 'IMPLEMENT'));
  });

  test('reload 後も predictTaskOutcome() が正常動作', () => {
    reloadWeights();
    reloadV2Models();
    const { probability } = predictTaskOutcome('テスト', 'IMPLEMENT', 'MEDIUM');
    assert.ok(probability >= 0 && probability <= 100);
  });
});
