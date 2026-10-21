/*
 * YouTube のページから「今どの動画を見ているか」を読む。
 */

/** メインプレイヤーの <video>（おすすめ欄のインライン再生などは含めない） */
export function currentVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('.html5-video-player video') || document.querySelector('video');
}

/** URL から現在の動画 ID（/watch?v= と /shorts/ /live/）。動画ページでなければ null */
export function currentVideoId(): string | null {
  try {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function isVideo(target: EventTarget | null): target is HTMLVideoElement {
  return !!target && (target as Element).tagName === 'VIDEO';
}
