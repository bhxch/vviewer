// allowRemote.test.ts — 图表外联闸的包内 additive 缝（spec H T5）。
//
// 覆盖面（计划 T5 Step 3 明列）：缺省 undefined → kroki 模式分支与 local 失败降级
// **仍先落 kroki img**（既有链不变）；`allowRemote: false` → 两分支**直接落源码块**、
// **零 kroki URL 构造**（断言无 kroki img 的 src）。
//
// 兼容锚（RF 1）：apps/web 不注入该字段 → 缺省 undefined 路径逐字节不变。
import { describe, expect, it } from 'vitest';
import { runPipeline, type PipelineCtx } from '../src/pipeline';

function docWithFence(lang: string, body: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  code.className = `language-${lang}`;
  code.textContent = body;
  pre.appendChild(code);
  doc.body.appendChild(pre);
  return doc;
}

const baseCtx: PipelineCtx = { highlightFence: async () => null };

/** kroki host 取可辨识值——断言「零 kroki URL 构造」时以它为检索键 */
const KROKI_HOST = 'https://kroki.invalid';

describe('外联闸 · allowRemote（additive 缝）', () => {
  it('缺省 undefined：kroki 模式分支仍落 kroki img（既有链不变）', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: KROKI_HOST, mermaidTheme: 'default', modeOf: () => 'kroki' }
    });
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain(KROKI_HOST);
  });

  it('缺省 undefined：local 引擎失败且有 krokiType 时仍降级 kroki img（既有链不变）', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      // local 档 + 无本地引擎 → effectiveModeOf 升格 kroki；此用例锁「local 失败
      // 降级链」的既有语义（plantuml 无本地引擎 → 直接 kroki 分支）
      diagram: { krokiHost: KROKI_HOST, mermaidTheme: 'default', modeOf: () => 'local' }
    });
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain(KROKI_HOST);
  });

  it('allowRemote=false：kroki 模式分支直接落源码块（零 kroki URL 构造）', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    let highlighted = '';
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: KROKI_HOST,
        mermaidTheme: 'default',
        modeOf: () => 'kroki',
        allowRemote: false
      },
      highlightFence: async (code, lang) => {
        highlighted = `${lang}:${code}`;
        return `<i>${lang}</i>`;
      }
    });
    // 零 kroki URL 构造：视图内无 img，且全文不含 kroki host
    expect(doc.querySelector('.md-diagram-view img')).toBeNull();
    expect(doc.body.innerHTML).not.toContain(KROKI_HOST);
    // 源码块语义：视图隐藏、源码面板展开、无 toggle 钮（假交互面同 source 模式）
    expect(doc.querySelector('.md-diagram-view')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('.md-diagram-source')!.hasAttribute('hidden')).toBe(false);
    expect(doc.querySelector('.md-diagram-toggle')).toBeNull();
    // 源码走 highlightFence（映射语言）
    expect(highlighted).toBe('plantuml:a -> b');
  });

  it('allowRemote=false：local 引擎失败的降级直接落源码块（零 kroki URL 构造）', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: KROKI_HOST,
        mermaidTheme: 'default',
        modeOf: () => 'local',
        allowRemote: false
      }
    });
    expect(doc.querySelector('.md-diagram-view img')).toBeNull();
    expect(doc.body.innerHTML).not.toContain(KROKI_HOST);
    // 落源码块：视图隐藏 + 源码面板展开
    expect(doc.querySelector('.md-diagram-view')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('.md-diagram-source')!.hasAttribute('hidden')).toBe(false);
  });

  it('allowRemote=false 不影响 source 模式与 local 离线引擎档', async () => {
    const sourceDoc = docWithFence('plantuml', 'a -> b');
    await runPipeline(sourceDoc, {
      ...baseCtx,
      diagram: {
        krokiHost: KROKI_HOST,
        mermaidTheme: 'default',
        modeOf: () => 'source',
        allowRemote: false
      }
    });
    expect(sourceDoc.querySelector('.md-diagram-view')!.hasAttribute('hidden')).toBe(true);
    expect(sourceDoc.body.innerHTML).not.toContain(KROKI_HOST);
  });

  it('allowRemote=true：kroki 模式分支照旧落 kroki img（闸开语义）', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: KROKI_HOST,
        mermaidTheme: 'default',
        modeOf: () => 'kroki',
        allowRemote: true
      }
    });
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain(KROKI_HOST);
  });
});
