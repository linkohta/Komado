/*
 * アプリ（MainActivity.onBridgeMessage）へ送るメッセージ。
 * type ごとのフィールドは Kotlin 側（PlaybackState.fromJson など）と揃える。
 */

/** <video> の状態。PlaybackState.kt の fromJson が読む */
export interface StateMessage {
  type: 'state';
  videoId: string | null;
  title: string;
  artist: string;
  artwork: string | null;
  playing: boolean;
  position: number; // ms
  duration: number; // ms
  width: number;
  height: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export type BridgeMessage =
  | StateMessage
  /** この動画の SponsorBlock 区間を取ってほしい（応答は setSegments で返ってくる） */
  | { type: 'segments'; videoId: string }
  /** 区間をスキップした（アプリがトーストを出す） */
  | { type: 'skipped'; category: string };

export function post(message: BridgeMessage): void {
  try {
    if (window.KomadoBridge) window.KomadoBridge.postMessage(JSON.stringify(message));
  } catch {
    // ブリッジが無い・切れている（古い WebView）ときは何もしない
  }
}
