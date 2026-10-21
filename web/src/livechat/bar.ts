/*
 * プレイヤー直下に差し込む入力バー（弾幕 ON/OFF・入力欄・送信）。
 * 表示内容は毎回 view() から組み立てるので、バー自身はセッションの状態を持たない。
 */
import { setStyle } from '../styles.ts';

const CSS = [
  '.komado-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #0f0f0f; color: #f1f1f1;',
  '  border-bottom: 1px solid #303030; font-family: Roboto, sans-serif; font-size: 14px; box-sizing: border-box; width: 100%; }',
  '.komado-bar[hidden] { display: none; }',
  '.komado-bar button { flex: none; height: 32px; min-width: 32px; padding: 0 10px; border: 0; border-radius: 16px;',
  '  background: #272727; color: #f1f1f1; font: inherit; }',
  '.komado-bar button.komado-toggle.off { color: #717171; text-decoration: line-through; }',
  '.komado-bar button.komado-send { background: #3ea6ff; color: #0f0f0f; font-weight: 700; }',
  '.komado-bar button:disabled { opacity: 0.5; }',
  '.komado-bar input { flex: 1; min-width: 0; height: 32px; padding: 0 12px; border: 1px solid #303030; border-radius: 16px;',
  '  background: #121212; color: #f1f1f1; font: inherit; outline: none; }',
  '.komado-bar input:focus { border-color: #3ea6ff; }',
  '.komado-bar .komado-status { flex: 1; min-width: 0; color: #aaa; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
].join('\n');

const FLASH_MS = 3000;

export interface BarView {
  enabled: boolean;
  canPost: boolean;
  maxLength: number;
  /** 投稿できないときに入力欄の代わりに出す文言 */
  status: string;
}

export interface BarHandlers {
  onToggle(): void;
  onSubmit(): void;
}

interface Elements {
  bar: HTMLDivElement;
  toggle: HTMLButtonElement;
  input: HTMLInputElement;
  send: HTMLButtonElement;
  status: HTMLDivElement;
}

export class ChatBar {
  private els: Elements | null = null;
  private visible = false;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly view: () => BarView;
  private readonly handlers: BarHandlers;

  constructor(view: () => BarView, handlers: BarHandlers) {
    this.view = view;
    this.handlers = handlers;
  }

  /** 入力欄の文字列（前後の空白を除く） */
  get text(): string {
    return this.els ? this.els.input.value.trim() : '';
  }

  clearText(): void {
    if (this.els) this.els.input.value = '';
  }

  /** 送信中は送信ボタンを押せなくする（解除は次の update で） */
  setSending(): void {
    if (this.els) this.els.send.disabled = true;
  }

  /** プレイヤーの直後に差し込む（YouTube が DOM を作り直したら付け直す）。差し込み先が無ければ false */
  place(): boolean {
    setStyle('komado-chatbar', CSS);
    let els = this.els;
    if (!els) {
      els = this.els = this.build();
      // show(true) がバーを作る前に呼ばれていることがある（プローブ・再試行のタイマーからセッションが始まったとき）。
      // 作った時点の状態で描画しないと、次に update が呼ばれるまで（アーカイブでは呼ばれない）非表示のまま残る
      this.update();
    }
    // モバイル版はプレイヤー本体が position: fixed で、本文側に同じ高さの placeholder が置かれる。その直後に入れる
    const anchor = document.querySelector('ytm-watch .player-placeholder') ||
      document.getElementById('player-container-id') || document.getElementById('player');
    if (!anchor) return false;
    if (els.bar.previousElementSibling !== anchor || els.bar.parentNode !== anchor.parentNode) {
      anchor.insertAdjacentElement('afterend', els.bar);
    }
    return true;
  }

  show(on: boolean): void {
    this.visible = on;
    this.update();
  }

  /** view() の内容で表示を作り直す */
  update(): void {
    const els = this.els;
    if (!els) return;
    els.bar.hidden = !this.visible;
    if (!this.visible) return;
    const view = this.view();
    els.toggle.classList.toggle('off', !view.enabled);
    els.toggle.title = view.enabled ? 'コメントを流す: ON' : 'コメントを流す: OFF';
    els.input.disabled = !view.canPost;
    els.input.maxLength = view.maxLength;
    els.send.disabled = !view.canPost;
    els.input.hidden = !view.canPost;
    els.status.hidden = view.canPost;
    if (!view.canPost) els.status.textContent = view.status;
  }

  /** 入力欄の位置に一時的にメッセージを出す（送信エラーなど） */
  flash(message: string): void {
    const els = this.els;
    if (!els) return;
    els.input.hidden = true;
    els.status.hidden = false;
    els.status.textContent = message;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.update(), FLASH_MS);
  }

  private build(): Elements {
    const bar = document.createElement('div');
    bar.className = 'komado-bar';
    bar.hidden = true;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'komado-toggle';
    toggle.textContent = '弾幕';
    toggle.addEventListener('click', () => this.handlers.onToggle());

    const input = document.createElement('input');
    input.type = 'text';
    input.enterKeyHint = 'send';
    input.autocomplete = 'off';
    input.placeholder = 'コメントを入力';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.handlers.onSubmit();
      }
    });
    // YouTube 側のキーボードショートカットに食われないようにする
    for (const type of ['keydown', 'keyup', 'keypress']) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }

    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'komado-send';
    send.textContent = '送信';
    send.addEventListener('click', () => this.handlers.onSubmit());

    const status = document.createElement('div');
    status.className = 'komado-status';

    bar.appendChild(toggle);
    bar.appendChild(input);
    bar.appendChild(status);
    bar.appendChild(send);
    return { bar, toggle, input, send, status };
  }
}
