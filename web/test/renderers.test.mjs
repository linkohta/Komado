// InnerTube 応答 → 文字列・コメントへの変換のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argbToCss, find, runsText, toComment } from '../src/livechat/renderers.ts';

test('runsText は simpleText・runs・絵文字ショートカットを文字列にする', () => {
  assert.equal(runsText({ simpleText: '¥500' }), '¥500');
  assert.equal(runsText({ runs: [{ text: 'こんにちは' }, { emoji: { shortcuts: [':wave:'] } }] }), 'こんにちは:wave:');
  assert.equal(runsText(null), '');
  assert.equal(runsText('文字列'), '');
});

test('find は入れ子の奥のキーを深さ制限つきで探す', () => {
  const data = { a: { b: [{ c: { target: 1 } }] } };
  assert.equal(find(data, 'target'), 1);
  assert.equal(find(data, 'target', 2), undefined);
  assert.equal(find(data, 'missing'), undefined);
});

test('argbToCss はアルファを捨てて rgb() にする', () => {
  assert.equal(argbToCss(0xff1e88e5), 'rgb(30,136,229)');
});

const text = (renderer) => ({ liveChatTextMessageRenderer: { id: 'id1', timestampUsec: '1700000000123456', ...renderer } });
const badge = (iconType, customThumbnail) => ({ liveChatAuthorBadgeRenderer: { icon: iconType && { iconType }, customThumbnail } });

test('通常コメントはバッジで色を変える（配信者 > モデレーター > メンバー）', () => {
  const message = { runs: [{ text: 'hi' }] };
  assert.equal(toComment(text({ message })).color, '#fff');
  assert.equal(toComment(text({ message, authorBadges: [badge('OWNER')] })).color, '#ffd600');
  assert.equal(toComment(text({ message, authorBadges: [badge('MODERATOR')] })).color, '#5e84f1');
  assert.equal(toComment(text({ message, authorBadges: [badge(null, {})] })).color, '#2ba640');
  assert.equal(toComment(text({ message, authorBadges: [badge(null, {}), badge('MODERATOR')] })).color, '#5e84f1');
});

test('通常コメントの ID・時刻（ms）・本文を取り出す', () => {
  const c = toComment(text({ message: { runs: [{ text: 'hi' }] } }));
  assert.equal(c.id, 'id1');
  assert.equal(c.ts, 1700000000123.456);
  assert.deepEqual(c.runs, [{ text: 'hi' }]);
});

test('スーパーチャットは金額を前に付け、背景色で流す', () => {
  const c = toComment({
    liveChatPaidMessageRenderer: {
      id: 'p', purchaseAmountText: { simpleText: '¥1,000' }, bodyBackgroundColor: 0xffe62117,
      message: { runs: [{ text: 'ありがとう' }] },
    },
  });
  assert.equal(c.color, 'rgb(230,33,23)');
  assert.deepEqual(c.runs, [{ text: '¥1,000 ' }, { text: 'ありがとう' }]);
});

test('スーパーステッカーは「スタンプ」として流す', () => {
  const c = toComment({ liveChatPaidStickerRenderer: { id: 's', purchaseAmountText: { simpleText: '¥200' } } });
  assert.equal(c.color, '#ffca28');
  assert.deepEqual(c.runs, [{ text: '¥200 ' }, { text: 'スタンプ' }]);
});

test('メンバー加入は本文が無ければ見出しを使う', () => {
  const c = toComment({ liveChatMembershipItemRenderer: { id: 'm', headerSubtext: { runs: [{ text: 'メンバーになりました' }] } } });
  assert.equal(c.color, '#2ba640');
  assert.deepEqual(c.runs, [{ text: 'メンバーになりました' }]);
});

test('流さない種類・本文が空のものは null', () => {
  assert.equal(toComment({ liveChatViewerEngagementMessageRenderer: {} }), null);
  assert.equal(toComment(text({ message: { runs: [] } })), null);
  assert.equal(toComment({ liveChatMembershipItemRenderer: { headerSubtext: { simpleText: 'only simple' } } }), null);
});
