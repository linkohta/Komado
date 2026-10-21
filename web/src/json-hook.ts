/*
 * YouTube が受け取る JSON（JSON.parse / Response.json / ytInitialPlayerResponse）を横取りする。
 * 広告除去（adblock.ts）とライブ判定（livechat）が同じフックを共有する（二重にフックしない）。
 * リスナーは登録順に呼ばれ、値を書き換えてもよい（広告除去は最初に登録する）。
 */

type JsonListener = (value: unknown) => void;

const listeners: JsonListener[] = [];

export function onJson(listener: JsonListener): void {
  listeners.push(listener);
}

function observe<T>(value: T): T {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // 1 つのリスナーの失敗で YouTube 側の処理を止めない
    }
  }
  return value;
}

export function installJsonHook(): void {
  const nativeParse = JSON.parse;
  JSON.parse = function (this: JSON, ...args: Parameters<typeof JSON.parse>) {
    return observe(nativeParse.apply(this, args));
  };

  const nativeJson = Response.prototype.json;
  Response.prototype.json = function (this: Response) {
    return nativeJson.call(this).then(observe);
  };

  // HTML に埋め込まれた初期プレイヤー情報（var ytInitialPlayerResponse = {...}）
  let initial: unknown;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initial,
      set: (value: unknown) => {
        initial = observe(value);
      },
    });
  } catch {
    // 既に定義済み（再注入）なら諦める
  }
}
