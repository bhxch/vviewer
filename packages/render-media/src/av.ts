import type { Renderer } from '@vviewer/core';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  oga: 'audio/ogg', opus: 'audio/ogg'
};

export const avRenderer: Renderer = {
  id: 'av',
  label: '音视频',
  extensions: ['mp4', 'm4v', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'm4a', 'oga', 'opus'],
  async render(buffer, target, _source, det) {
    const isVideo = ['mp4', 'm4v', 'webm', 'ogg'].includes(det.ext);
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.setAttribute('controls', '');
    if (isVideo) (el as HTMLVideoElement).playsInline = true;
    // buffer 实际由普通 ArrayBuffer 支持；断言绕开 TS 5.9 BlobPart 的 ArrayBuffer 泛型收窄，避免大文件复制
    const url = URL.createObjectURL(new Blob([buffer as Uint8Array<ArrayBuffer>], { type: MIME[det.ext] ?? '' }));
    el.src = url;
    el.className = 'vv-av';
    target.replaceChildren(el);
    return { destroy() { el.pause(); URL.revokeObjectURL(url); el.remove(); } };
  }
};
