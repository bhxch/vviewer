// M2 样例：TypeScript（tree-sitter 可用语言，E2E 断言 ts-* 高亮 span 与主题零重解析）
interface Point {
  x: number;
  y: number;
}

const ORIGIN: Point = { x: 0, y: 0 };

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x; // 水平差
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export { distance, ORIGIN };
