import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TreeSitterEngine } from '../src/core-parse';

/**
 * BUG-06b 回归：python/java 本地 worker 路径此前「静默回退 hljs」——wasm 与查询
 * 资产均在位（manifest 34 项含 python/java；queries/ 含两语言），但单 grammar
 * 加载/查询编译失败被 prepare().catch(() => null) 吞掉，零用户可见线索。
 * Node 侧与浏览器同构（同一 assets/queries 源、同一 manifest/runtime 产物），
 * 锁死两语言本地引擎可用；若失败，断言消息即真实加载错误。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '../assets/queries');
const staticDir = path.join(here, '../../../apps/web/static');
const grammarsDir = path.join(staticDir, 'grammars');
const grammarAssetsReady =
  existsSync(path.join(grammarsDir, 'manifest.json')) && existsSync(path.join(staticDir, 'tree-sitter.wasm'));

/** 语言级在位判定：CI 以显式最小语言集自建（manifest 可能不含 java），缺 wasm 是环境
 * 裁剪而非 BUG-06b 的「在位却静默回退」——按语言跳过，全集（本地 lite）下两语言都锁。 */
const availableLangs = (() => {
  if (!grammarAssetsReady) return new Set<string>();
  try {
    const m = JSON.parse(readFileSync(path.join(grammarsDir, 'manifest.json'), 'utf8')) as {
      grammars?: Record<string, unknown>;
    };
    return new Set(Object.keys(m.grammars ?? {}));
  } catch {
    return new Set<string>();
  }
})();

describe.skipIf(!grammarAssetsReady)('本地 tree-sitter 引擎：python/java 可用（BUG-06b 回归）', () => {
  let engine: TreeSitterEngine;
  beforeAll(async () => {
    engine = await TreeSitterEngine.create({ queriesDir, grammarsDir, runtimeDir: staticDir });
  }, 60_000);
  afterAll(() => engine.dispose());

  const samples: Record<string, string> = {
    python: 'def f(x):\n    return x + 1\n',
    java: 'class A { int x = 1; }\n',
  };
  for (const [lang, src] of Object.entries(samples)) {
    it.skipIf(!availableLangs.has(lang))(`${lang}：本地高亮成功且产生区间`, async () => {
      const r = await engine.highlight(src, lang, 0);
      expect(`${lang}:${r.ok ? `ok(${r.intervals.length})` : `FAIL:${r.error}`}`).toMatch(new RegExp(`^${lang}:ok\\(\\d+\\)$`));
      if (!r.ok) return;
      expect(r.intervals.length).toBeGreaterThan(0);
      // 层级捕获词法（上游查询同步伴生变化）：python def→keyword.function、java class→keyword。
      // 钉死具体 capture 名（ledger H4：前缀匹配弱于精确名）；与 theme.ts 最长前缀回退
      // 同构的设计意图由该回退自身承担，此处断言查询产出的精确层级
      const expected = lang === 'python' ? 'keyword.function' : 'keyword';
      expect(r.intervals.some((i) => i.capture === expected), `${lang} 应产出 ${expected}`).toBe(true);
    }, 30_000);
  }
});
