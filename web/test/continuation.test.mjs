// 継続トークン書き換え（トップチャット → すべてのチャット）のテスト
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allChatToken,
  fromBase64Url,
  readFields,
  toBase64Url,
  writeFields,
} from '../src/livechat/continuation.ts';

const bytes = (s) => new TextEncoder().encode(s);

/** 本体 field の中に表示設定 field（sub-field 1 = 4: トップチャット, 5 = 0）を持つトークンを作る */
function token(bodyField, viewField) {
  const view = writeFields([
    { field: 1, wire: 0, value: 4 },
    { field: 5, wire: 0, value: 0 },
  ]);
  const body = writeFields([
    { field: 3, wire: 2, bytes: bytes('channel-and-video') },
    { field: viewField, wire: 2, bytes: view },
  ]);
  return toBase64Url(writeFields([{ field: bodyField, wire: 2, bytes: body }]));
}

/** トークンから表示設定 field の中身を取り出す */
function viewSettings(tok, bodyField, viewField) {
  const body = readFields(fromBase64Url(tok)).find((f) => f.field === bodyField);
  const view = readFields(body.bytes).find((f) => f.field === viewField);
  return Object.fromEntries(readFields(view.bytes).map((f) => [f.field, f.value]));
}

test('配信中のトークンを「すべてのチャット」に書き換える', () => {
  const original = token(119693434, 16);
  const rewritten = allChatToken(original);
  assert.notEqual(rewritten, original);
  assert.deepEqual(viewSettings(original, 119693434, 16), { 1: 4, 5: 0 });
  assert.deepEqual(viewSettings(rewritten, 119693434, 16), { 1: 1, 5: 1 });
});

test('アーカイブのトークンは別の field 番号で書き換える', () => {
  const rewritten = allChatToken(token(156074452, 14));
  assert.deepEqual(viewSettings(rewritten, 156074452, 14), { 1: 1, 5: 1 });
});

test('想定外の形なら元のトークンを返す', () => {
  const unknownBody = token(42, 16);
  assert.equal(allChatToken(unknownBody), unknownBody);
  const wrongView = token(119693434, 99);
  assert.equal(allChatToken(wrongView), wrongView);
  assert.equal(allChatToken('%%% not base64 %%%'), '%%% not base64 %%%');
});

test('protobuf の読み書きは往復で一致する（32 ビットを超える varint も）', () => {
  const fields = [
    { field: 1, wire: 0, value: 2 ** 40 + 5 },
    { field: 156074452, wire: 2, bytes: bytes('x') },
  ];
  const decoded = readFields(writeFields(fields));
  assert.equal(decoded[0].value, 2 ** 40 + 5);
  assert.equal(decoded[1].field, 156074452);
  assert.deepEqual([...decoded[1].bytes], [...bytes('x')]);
});

test('base64url は = を %3D にして往復できる', () => {
  const data = Uint8Array.from([0xfb, 0xff, 0x01]);
  const encoded = toBase64Url(Uint8Array.from([0xfb, 0xff]));
  assert.match(encoded, /%3D$/);
  assert.ok(!/[+/]/.test(encoded));
  assert.deepEqual([...fromBase64Url(toBase64Url(data))], [...data]);
});
