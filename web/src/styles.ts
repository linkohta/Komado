/*
 * ページに差し込む CSS: フィルターリストの要素非表示と、PiP 中は動画だけを見せる表示。
 */

const PIP_CSS = [
  'html.komado-pip, html.komado-pip body { background: #000 !important; overflow: hidden !important; }',
  // 弾幕（livechat/danmaku.ts の .komado-dm）だけは動画の上に残す
  // :where() は詳細度 0 なので、video を表示するルールとの優先順位を変えずに弾幕だけ除外できる
  'html.komado-pip body *:where(:not(.komado-dm, .komado-dm *)) { visibility: hidden !important; transform: none !important; contain: none !important; filter: none !important; }',
  'html.komado-pip video { visibility: visible !important; position: fixed !important; top: 0 !important; left: 0 !important;' +
    ' width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important;' +
    ' margin: 0 !important; object-fit: contain !important; background: #000 !important; z-index: 2147483647 !important; }',
].join('\n');

let selectors: string[] = [];

/** id 付きの <style> を作るか中身を差し替える。document-start 直後で <html> が無ければ何もしない */
export function setStyle(id: string, css: string): void {
  const root = document.head || document.documentElement;
  if (!root) return;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    root.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

function applyStyles(): void {
  // 1 セレクタ 1 ルールにして、解釈できないセレクタがあっても他が効くようにする
  setStyle('komado-cosmetic', selectors.map((s) => s + ' { display: none !important; }').join('\n'));
  setStyle('komado-pip', PIP_CSS);
}

export function installStyles(initialSelectors: string[]): void {
  selectors = initialSelectors;
  if (document.documentElement) applyStyles();
  document.addEventListener('DOMContentLoaded', applyStyles);
}

/** フィルター更新時にアプリから呼ばれる */
export function setSelectors(list: string[] | null | undefined): void {
  selectors = list || [];
  applyStyles();
}

export function setPip(on: boolean): void {
  document.documentElement.classList.toggle('komado-pip', !!on);
}
