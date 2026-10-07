// pptx.ts — PowerPoint 渲染器（M4 Task 5，降级路径：文本提纲）。
// 选库实测结论（详见任务报告）：pptx-preview@1.0.7 license 为 ISC（超出计划书
// pptx 库 MIT/Apache 门槛）、npm 无仓库主页且单一维护者（来源不可考）、强依赖
// echarts（仅为图表页服务，+1MB 级产物）；pptxjs 无维护。按 SDD 裁决降级：
// jszip 读 ppt/slides/slideN.xml 提取 <a:t> 文本，每页一张提纲卡片（不还原版式）。
// 页序以 slideN 文件名数字序近似（真实页序在 presentation.xml 的 rels 链中，
// 常见生成器按此命名，偏差已在任务报告记录）。
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';
import { sniffOoxml } from './ooxml';
import { extractSlideLines } from './pptxText';

type ZipModule = typeof import('jszip');

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

export const pptxRenderer: Renderer = {
  id: 'pptx',
  label: 'PowerPoint（文本提纲）',
  extensions: ['pptx'],
  sniff: sniffOoxml,
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, _det: Detection) {
    const mod = await import('jszip');
    const JSZip = ((mod as { default?: ZipModule }).default ?? mod) as ZipModule;
    const zip = await JSZip.loadAsync(buffer);
    const slides = Object.keys(zip.files)
      .map((path) => ({ path, m: SLIDE_RE.exec(path) }))
      .filter((e): e is { path: string; m: RegExpExecArray } => e.m !== null)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
    if (slides.length === 0) {
      throw new Error('不是有效的 pptx（PowerPoint）文件：缺少 ppt/slides 幻灯片部件');
    }

    const root = document.createElement('div');
    root.className = 'vv-pptx';
    const notice = document.createElement('div');
    notice.className = 'vv-pptx-notice';
    notice.textContent = '文本提纲视图：仅提取幻灯片文本，不还原原始版式';
    const list = document.createElement('div');
    list.className = 'vv-pptx-slides';
    root.append(notice, list);

    for (const [idx, slide] of slides.entries()) {
      const card = document.createElement('section');
      card.className = 'vv-pptx-slide';
      const head = document.createElement('span');
      head.className = 'vv-pptx-slide-no';
      head.textContent = `第 ${idx + 1} 页`;
      card.append(head);
      const file = zip.file(slide.path);
      if (!file) continue;
      const xml = await file.async('string');
      const lines = extractSlideLines(xml).filter((line) => line !== '');
      if (lines.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'vv-pptx-empty';
        empty.textContent = '（本页无文本）';
        card.append(empty);
      } else {
        for (const line of lines) {
          const p = document.createElement('p');
          p.textContent = line; // textContent：无注入面
          card.append(p);
        }
      }
      list.append(card);
    }

    target.replaceChildren(root);
    const instance: RenderedInstance = {
      destroy() {
        root.remove();
      }
    };
    return instance;
  }
};
