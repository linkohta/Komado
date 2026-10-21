/*
 * ページの window に生えるもの（アプリ側が付けるもの・YouTube が持っているもの・このスクリプトが公開するもの）。
 */
export {};

declare global {
  interface Window {
    /** 要素非表示フィルターのセレクタ。アプリ（ScriptInjector.kt）がスクリプトの先頭に付ける */
    __KOMADO_CSS?: string[];
    /** アプリから evaluateJavascript で呼ばれる API（main.ts） */
    __komado?: KomadoApi;
    /** ライブチャットのデバッグ用 API（livechat/index.ts）。DevTools から使う */
    __komadoLive?: LiveChatDebugApi;
    /** アプリへのメッセージ送信口（WebViewCompat.addWebMessageListener） */
    KomadoBridge?: { postMessage(message: string): void };
    /** YouTube の設定ストア */
    ytcfg?: { get?(key: string): unknown };
    ytInitialPlayerResponse?: unknown;
  }

  /** アプリ（Kotlin）から呼ぶ操作。名前と引数は ScriptInjector.kt / MainActivity.kt と揃える */
  interface KomadoApi {
    control(action: ControlAction, arg?: number): void;
    setPip(on: boolean): void;
    addSelectors(list: string[] | null | undefined): void;
    setSegments(videoId: string, list: Segment[] | null | undefined): void;
  }

  type ControlAction = 'play' | 'pause' | 'toggle' | 'seekBy' | 'seekTo' | 'next' | 'prev';

  /** SponsorBlock のスキップ区間（秒）。SponsorBlockClient.kt が作る */
  interface Segment {
    start: number;
    end: number;
    category: string;
  }

  interface LiveChatDebugApi {
    setEnabled(on: boolean): void;
    isEnabled(): boolean;
    debug(): Record<string, unknown>;
  }
}
