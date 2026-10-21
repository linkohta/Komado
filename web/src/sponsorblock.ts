/*
 * SponsorBlock の区間スキップ。区間の取得はアプリ側（SponsorBlockClient.kt）が行い、setSegments で渡される。
 */
import { post } from './bridge.ts';
import { currentVideoId } from './page.ts';

let segments: { videoId: string | null; list: Segment[] } = { videoId: null, list: [] };
let requestedFor: string | null = null;
let skipped: Record<number, boolean> = {};

/** アプリからの応答。動画が変わった後に届いた古い応答は捨てる */
export function setSegments(videoId: string, list: Segment[] | null | undefined): void {
  if (videoId === requestedFor) segments = { videoId, list: list || [] };
}

/** 動画が変わったら区間を要求し、区間内に入ったら末尾へ飛ばす */
export function checkSegments(video: HTMLVideoElement | null): void {
  const id = currentVideoId();
  if (id !== requestedFor) {
    requestedFor = id;
    segments = { videoId: id, list: [] };
    skipped = {};
    if (id) post({ type: 'segments', videoId: id });
  }
  if (!video || segments.videoId !== id) return;
  const t = video.currentTime;
  for (const s of segments.list) {
    if (t >= s.start && t < s.end - 0.5 && !skipped[s.start]) {
      skipped[s.start] = true; // 自分で巻き戻したときは再スキップしない
      video.currentTime = s.end;
      post({ type: 'skipped', category: s.category });
      break;
    }
  }
}
