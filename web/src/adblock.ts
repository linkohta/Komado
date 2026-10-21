/*
 * 広告の除去（uBlock Origin の json-prune 相当）と、すり抜けた広告のスキップ。
 * ネットワーク単位のブロックはアプリ側（AdBlocker.kt）が行う。
 */
import { onJson } from './json-hook.ts';

const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];

const SKIP_BUTTONS =
  '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object';
}

/** プレイヤー応答（またはそれを playerResponse に持つ応答）に広告データが入っているか */
export function hasAds(value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const key of AD_KEYS) if (key in value) return true;
  return !!(value.playerResponse && hasAds(value.playerResponse));
}

/** 広告データを取り除く（その場で書き換える） */
export function prune(value: JsonObject): JsonObject {
  for (const key of AD_KEYS) delete value[key];
  if (isObject(value.playerResponse)) prune(value.playerResponse);
  return value;
}

export function installAdBlock(): void {
  onJson((value) => {
    if (hasAds(value)) prune(value as JsonObject);
  });
}

let adMuted = false;

/** 広告のために自動でミュートしている最中か（自動ミュート解除と取り合わないため） */
export function isMutedForAd(): boolean {
  return adMuted;
}

/** 広告が流れていたら消音して末尾まで早送りし、スキップボタンを押す。終わったら消音を戻す */
export function handleAds(video: HTMLVideoElement | null): void {
  const player = document.querySelector('.html5-video-player');
  if (!player || !video) return;
  if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
    if (!video.muted) {
      video.muted = true;
      adMuted = true;
    }
    if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
      video.currentTime = video.duration - 0.05;
    }
    const skip = document.querySelector<HTMLElement>(SKIP_BUTTONS);
    if (skip) skip.click();
  } else if (adMuted) {
    video.muted = false;
    adMuted = false;
  }
}
