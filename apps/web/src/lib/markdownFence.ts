// markdownFence.ts — markdown 正文 compute 路由的围栏启发式（BUG-22 细化，spec §2.5）。
// 从 viewer.ts 抽出为无 $app 依赖的纯模块：除接线外可被 vitest 直测
// （markdownImages.ts 同款抽出模式）；viewer.ts 转出口径一致 re-export。
import { resolveDiagramType } from '@bhxch/vviewer-render-diagram';

/**
 * BUG-22 启发式（细化后，spec §2.5）：存在「非图表语言或无语言」的围栏 → true
 * （强制留本地，保 hljs/tree-sitter 二级高亮语义不变）；纯图表/math 围栏文档 →
 * false（可路由服务端——服务端 comrak 原生图表直出，其余图表语言由客户端管线
 * 接管，无需本地正文引擎兜底）。行首 ≤3 空格容忍与 ```/~~~ 双标记照旧。
 * 开/闭围栏按标记类型 + 空 info 配对：闭围栏的空 info 不误判为「无语言围栏」
 * （否则纯图表文档恒判 true，细化失效）。代码块内假围栏、4+ 反引号围栏等边角
 * 仍按同类启发式近似——门控只损失远程机会、不损正确性（原 BUG-22 裁决语义）。
 */
export function hasNonDiagramFence(text: string): boolean {
  let open: string | null = null; // 当前未闭围栏的标记（'```' | '~~~'）
  let m: RegExpExecArray | null;
  const fence = /^[ \t]{0,3}(?:```|~~~)([^\n`]*)/gm;
  while ((m = fence.exec(text)) !== null) {
    const marker = m[0].trimStart().slice(0, 3);
    const info = (m[1] ?? '').trim();
    if (open === null) {
      const lang = info.split(/\s/)[0] ?? '';
      if (!resolveDiagramType(lang)) return true; // 非图表语言/无语言围栏 → 留本地
      open = marker;
    } else if (marker === open && info === '') {
      open = null; // 同类标记 + 空 info → 闭围栏
    }
  }
  return false;
}
