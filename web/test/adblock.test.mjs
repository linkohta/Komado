// プレイヤー応答からの広告データ除去（json-prune 相当）のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasAds, prune } from '../src/adblock.ts';

test('トップレベルと playerResponse の中の広告キーを見つける', () => {
  assert.equal(hasAds({ adPlacements: [] }), true);
  assert.equal(hasAds({ playerResponse: { playerAds: [] } }), true);
  assert.equal(hasAds({ videoDetails: {} }), false);
  assert.equal(hasAds(null), false);
  assert.equal(hasAds('adPlacements'), false);
});

test('広告キーだけを取り除き、他の値は残す', () => {
  const response = {
    adPlacements: [1], adSlots: [2], videoDetails: { videoId: 'x' },
    playerResponse: { playerAds: [3], adBreakHeartbeatParams: 'p', streamingData: {} },
  };
  prune(response);
  assert.deepEqual(response, { videoDetails: { videoId: 'x' }, playerResponse: { streamingData: {} } });
  assert.equal(hasAds(response), false);
});
