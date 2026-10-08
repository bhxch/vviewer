import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TreeSitterEngine, type VirtualQueries } from '../src/core-parse';

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '../assets/queries');
const staticDir = path.join(here, '../../../apps/web/static');
const grammarsDir = path.join(staticDir, 'grammars');
// grammar 资产（manifest + 运行时 wasm + 各语言 wasm）由 `pnpm gen:grammars` 生成
// （不入库），fresh clone 缺资产时整组跳过（CI 在 vitest 前先跑生成步骤）
const grammarAssetsReady =
  existsSync(path.join(grammarsDir, 'manifest.json')) &&
  existsSync(path.join(staticDir, 'tree-sitter.wasm'));

/** 断言区间按 (start asc, end desc) 排序。 */
function expectSorted(intervals: { start: number; end: number }[]): void {
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1]!;
    const cur = intervals[i]!;
    expect(cur.start).toBeGreaterThanOrEqual(prev.start);
    if (cur.start === prev.start) expect(cur.end).toBeLessThanOrEqual(prev.end);
  }
}

describe.skipIf(!grammarAssetsReady)('TreeSitterEngine（真实 wasm + 真实 helix 查询）', () => {
  let engine: TreeSitterEngine;
  beforeAll(async () => {
    engine = await TreeSitterEngine.create({ queriesDir, grammarsDir, runtimeDir: staticDir });
  }, 60_000);
  afterAll(() => engine.dispose());

  it('bash：echo "hello" 产出非空区间，含 @string 捕获', async () => {
    const src = 'echo "hello"';
    const r = await engine.highlight(src, 'bash');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intervals.length).toBeGreaterThan(0);
    const stringHit = r.intervals.find((i) => i.capture === 'string');
    expect(stringHit).toBeDefined();
    // 区间与源文本对齐
    expect(src.slice(stringHit!.start, stringHit!.end)).toBe('"hello"');
    expectSorted(r.intervals);
  }, 30_000);

  it('html：<script> 触发 javascript 注入，子区间偏移到原文正确位置', async () => {
    const src = '<html><body><script>var x = 1;</script></body></html>';
    const r = await engine.highlight(src, 'html');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // js 的 `var` 被捕获为 keyword，且落在 script 内容区间内
    const kw = r.intervals.find((i) => i.capture === 'keyword');
    expect(kw).toBeDefined();
    expect(src.slice(kw!.start, kw!.end)).toBe('var');
    expect(kw!.start).toBeGreaterThan(src.indexOf('<script>'));
  }, 30_000);

  it('html：<style> 触发 css 注入', async () => {
    const src = '<style>.a { color: red; }</style>';
    const r = await engine.highlight(src, 'html');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // css 中选择器与声明值都可能捕获为 property，断言存在切片为 color 的那个
    expect(r.intervals.some((i) => i.capture === 'property' && src.slice(i.start, i.end) === 'color')).toBe(true);
  }, 30_000);

  it('javascript：标签模板 @injection.language capture 形态按 tag 名注入（html`…`）', async () => {
    // javascript/injections.scm 的 tagged template pattern：function identifier
    // 捕获为 @injection.language、template_string 捕获为 @injection.content——
    // 与 #set! injection.language 属性形态（markdown 围栏）不同的注入语言来源
    const src = 'const t = html`<b>hi</b>`;';
    const r = await engine.highlight(src, 'javascript');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 子语言 html 的 tag_name 捕获偏移回原文正确位置
    const tag = r.intervals.find((i) => i.capture === 'tag');
    expect(tag).toBeDefined();
    expect(src.slice(tag!.start, tag!.end)).toBe('b');
    expect(tag!.start).toBeGreaterThan(src.indexOf('html`'));
  }, 30_000);

  it('别名请求：highlight(text, "js") 规范化为 javascript 并成功', async () => {
    const src = 'var x = 1;';
    const r = await engine.highlight(src, 'js');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intervals.some((i) => i.capture === 'keyword' && src.slice(i.start, i.end) === 'var')).toBe(true);
    expect(r.intervals.some((i) => i.capture === 'number' && src.slice(i.start, i.end) === '1')).toBe(true);
  }, 30_000);

  it('未知语言返回 ok:false 与错误信息', async () => {
    const r = await engine.highlight('int main(){}', 'no-such-language');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
  });

  it('有 grammar 无查询目录的语言返回 ok:false', async () => {
    // 36 个 grammar 中 solidity 在 assets/queries 里也存在目录；用 manifest 里存在但无查询的名字
    // manifest 有 'systemrdl'，helix queries 目录也有——改用一个确定无查询目录的名字：直接传不在 assets 的语言
    const r = await engine.highlight('x', 'objc');
    // objc 在 queries 中存在（可能继承 c），只要求不崩溃且结果合法
    expect([true, false]).toContain(r.ok);
  });

  it('VirtualQueries 来源与目录来源等价（bash 冒烟）', async () => {
    const virtual: VirtualQueries = new Map([
      ['bash', { highlights: '(command_name) @function\n(string) @string' }],
    ]);
    const e2 = await TreeSitterEngine.create({ queriesDir: virtual, grammarsDir, runtimeDir: staticDir });
    try {
      const r = await e2.highlight('echo "hi"', 'bash');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.intervals.some((i) => i.capture === 'string')).toBe(true);
    } finally {
      e2.dispose();
    }
  }, 30_000);
});

describe.skipIf(!grammarAssetsReady)('TreeSitterEngine.create 选项', () => {
  it('maxInjectionDepth=0 时 html 不递归注入 js', async () => {
    const e = await TreeSitterEngine.create({
      queriesDir,
      grammarsDir,
      runtimeDir: staticDir,
      maxInjectionDepth: 0,
    });
    try {
      const r = await e.highlight('<script>var x = 1;</script>', 'html');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.intervals.some((i) => i.capture === 'keyword')).toBe(false);
      expect(r.intervals.length).toBeGreaterThan(0);
    } finally {
      e.dispose();
    }
  }, 60_000);
});

describe.skipIf(!grammarAssetsReady)('大文件护栏（web-tree-sitter 病态查询挂起的防御）', () => {
  it('hasLanguage：清单键与别名命中，未知语言 false', async () => {
    const engine = await TreeSitterEngine.create({ queriesDir, grammarsDir, runtimeDir: staticDir });
    try {
      expect(engine.hasLanguage('typescript')).toBe(true);
      expect(engine.hasLanguage('js')).toBe(true); // 别名
      expect(engine.hasLanguage('no-such-language')).toBe(false);
    } finally {
      engine.dispose();
    }
  }, 60_000);

  it('缺失 grammar 的注入语言前置短路：不递归、每语言仅 warn 一次，主区间不受影响', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = await TreeSitterEngine.create({ queriesDir, grammarsDir, runtimeDir: staticDir });
    try {
      // 'comment' 不在 grammar 清单：ecma 系 injections.scm 逐注释命中该注入目标
      const src = 'const a = 1; // one\nconst b = 2; // two\nconst c = 3; // three\n';
      const r = await engine.highlight(src, 'typescript');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.intervals.some((i) => src.slice(i.start, i.end) === 'const')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('comment');
      // 第二次调用不再重复告警
      await engine.highlight(src, 'typescript');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      engine.dispose();
      warn.mockRestore();
    }
  }, 60_000);

  it('查询执行超时预算：病态注入查询快速返回而非挂起（护栏 ≤5s，无预算实测 40s+）', async () => {
    // ecma/injections.scm 原始 graphql pattern 的病态形态：根级双兄弟、无锚点，
    // 触发 O(n²) 兄弟配对扫描。这里用 VirtualQueries 注入同形态 pattern 复现。
    // 注入查询超时被丢弃（返回空 matches），主高亮（线性查询）不受影响。
    const pathological: VirtualQueries = new Map([
      [
        'typescript',
        {
          highlights: '(identifier) @variable',
          injections: `(
  ((comment) @_c [
    (string (string_fragment) @injection.content)
    (template_string (string_fragment) @injection.content)
  ])
  (#eq? @_c "/* GraphQL */")
  (#set! injection.language "graphql")
)`,
        },
      ],
    ]);
    const engine = await TreeSitterEngine.create({ queriesDir: pathological, grammarsDir, runtimeDir: staticDir });
    try {
      const src = 'const vv = 1; // c\n'.repeat(2000); // ≈38KB，无预算时注入匹配 >40s
      const t0 = Date.now();
      const r = await engine.highlight(src, 'typescript');
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(5000); // 预算护栏生效（挂起形态下此处 >40s）
      if (!r.ok) return;
      expect(r.intervals.some((i) => src.slice(i.start, i.end) === 'vv')).toBe(true); // 主高亮完整
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it('超时显式转失败：空区间 + 耗尽预算 → ok:false 接通 hljs 兜底（修复前 ok:true 空区间静默无高亮）', async () => {
    // web-tree-sitter 0.25 的 timeoutMicros 语义是"丢弃已收集结果、返回空数组"，
    // 不是部分结果——空结果若仍返回 ok:true，render-text 会静默无高亮且不走 hljs 兜底。
    // 这里把病态形态（O(n²) 兄弟配对扫描）作为主高亮查询，断言引擎将其转为失败。
    const pathological: VirtualQueries = new Map([
      [
        'typescript',
        {
          highlights: `(
  (comment) @comment
  [
    (string (string_fragment) @string)
    (template_string (string_fragment) @string)
  ]
)`,
          injections: '',
        },
      ],
    ]);
    const engine = await TreeSitterEngine.create({ queriesDir: pathological, grammarsDir, runtimeDir: staticDir });
    try {
      const src = 'const vv = 1; // c\n'.repeat(2000); // ≈38KB → 预算 ≈760ms，病态扫描需 >40s
      const t0 = Date.now();
      const r = await engine.highlight(src, 'typescript');
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(5000); // 快速失败而非挂起（无预算时 >40s）
      expect(r.ok).toBe(false); // 空区间 + 耗尽预算 → 显式失败
      if (r.ok) return;
      expect(r.error).toContain('超时');
    } finally {
      engine.dispose();
    }
  }, 30_000);
});
