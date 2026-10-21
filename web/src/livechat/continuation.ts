/*
 * チャットの継続トークンの書き換え。
 *
 * /next が返すトークンは「トップチャット」用。「チャット（すべて）」用のトークンは
 * 本体（配信中: field 119693434 / アーカイブ: field 156074452）の中の表示設定
 * （配信中: field 16 / アーカイブ: field 14）のうち sub-field 1 を 4→1、sub-field 5 を 1 にしたもの。
 * 形が想定と違えば元のトークン（トップチャット）をそのまま使う。
 */

const VIEW_FIELD: Record<number, number> = { 119693434: 16, 156074452: 14 };

export function allChatToken(token: string): string {
  try {
    const outer = readFields(fromBase64Url(token));
    let changed = false;
    for (const f of outer) {
      const viewField = VIEW_FIELD[f.field];
      if (!viewField || f.wire !== 2) continue;
      const inner = readFields(f.bytes);
      for (const g of inner) {
        if (g.field !== viewField || g.wire !== 2) continue;
        const sub = readFields(g.bytes);
        for (const h of sub) {
          if (h.wire !== 0) continue;
          if (h.field === 1) {
            h.value = 1;
            changed = true;
          }
          if (h.field === 5) h.value = 1;
        }
        g.bytes = writeFields(sub);
      }
      f.bytes = writeFields(inner);
    }
    return changed ? toBase64Url(writeFields(outer)) : token;
  } catch {
    return token;
  }
}

// ------------------------------------------------------------------ base64url（YouTube は = を %3D にする）

export function fromBase64Url(s: string): Uint8Array {
  const bin = atob(decodeURIComponent(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '%3D');
}

// ------------------------------------------------------------------ protobuf（varint と length-delimited だけ）

export type Field =
  | { field: number; wire: 0; value: number }
  | { field: number; wire: 2; bytes: Uint8Array };

/** 他のワイヤタイプが出たら例外（呼び出し側で元のトークンに戻す） */
export function readFields(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= bytes.length) throw new Error('eof');
      b = bytes[i++];
      result += (b & 0x7f) * Math.pow(2, shift); // 32 ビットを超える値があるのでビット演算で組み立てない
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  while (i < bytes.length) {
    const key = varint();
    const wire = key & 7;
    const field = Math.floor(key / 8);
    if (wire === 0) {
      fields.push({ field, wire: 0, value: varint() });
    } else if (wire === 2) {
      const len = varint();
      fields.push({ field, wire: 2, bytes: bytes.slice(i, i + len) });
      i += len;
    } else {
      throw new Error('wire ' + wire);
    }
  }
  return fields;
}

export function writeFields(fields: Field[]): Uint8Array {
  const out: number[] = [];
  const varint = (v: number): void => {
    while (v >= 128) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
  };
  for (const f of fields) {
    varint(f.field * 8 + f.wire);
    if (f.wire === 0) {
      varint(f.value);
    } else {
      varint(f.bytes.length);
      for (let i = 0; i < f.bytes.length; i++) out.push(f.bytes[i]);
    }
  }
  return Uint8Array.from(out);
}
