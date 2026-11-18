// designDocAnchors.test.ts — 语义组件清单的 file:line 锚点守卫（表 1 / 表 2）。
//
// 语义组件清单（docs/design/semantic-components.md）的表 1（读屏可达通道成员）与
// 表 2（原生轻确认成员）是**现状实测**登记（每条带 file:行号）——评审 minor：锚点随
// 代码漂移失准（本轮实测 MountsManager 三处偏移 11 行：role=status 实为 :623/:761、
// 凭据删除 confirm 实为 :513，文档写 :612/:750/:502），且无任何报警面。
//
// 本测试按**语义**反查锚点（不锚行号本身，只锚该行仍承载该语义）：
//   表 1 → 该行仍含 `role="status"` 或 `aria-live="polite"`；
//   表 2 → 该行仍含 `confirm(` 调用。
// 代码一动、锚点即红 → 逼文档同步（单源防漂移）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');
const docPath = path.join(repoRoot, 'docs/design/semantic-components.md');
const doc = readFileSync(docPath, 'utf8');

/** 表 1 / 表 2 的行（首个单元格含 file:行号 锚点） */
interface AnchorRow {
  /** 文件名（相对 apps/web/src/lib） */
  file: string;
  /** 行号（1-based） */
  line: number;
  /** 表格语义（用于反查该行应含的内容） */
  kind: 'status' | 'confirm';
}

/** 取表 N 的数据行（表头行与分隔行跳过） */
function tableRows(headerMarker: string, endMarker: string, kind: AnchorRow['kind']): AnchorRow[] {
  const start = doc.indexOf(headerMarker);
  expect(start, `文档缺表头标记：${headerMarker}`).toBeGreaterThan(-1);
  const end = doc.indexOf(endMarker, start);
  const block = doc.slice(start, end === -1 ? undefined : end);
  const rows: AnchorRow[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    const memberCell = cells[1] ?? '';
    const m = /([\w.-]+\.(?:svelte|ts)):(\d+)((?:\s*\/\s*:\d+)*)/.exec(memberCell);
    if (!m) continue;
    const file = m[1]!;
    const lines = [Number(m[2]), ...[...m[3]!.matchAll(/:\d+/g)].map((x) => Number(x[0].slice(1)))];
    for (const ln of lines) rows.push({ file, line: ln, kind });
  }
  return rows;
}

/** 递归查找 apps/web/src/lib 下的同名文件（表内成员分布于 lib/ 与 lib/settings/） */
function findInLib(fileName: string): string | null {
  const root = path.join(repoRoot, 'apps/web/src/lib');
  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        const hit = walk(abs);
        if (hit) return hit;
      } else if (entry === fileName) {
        return abs;
      }
    }
    return null;
  };
  return walk(root);
}

const statusRows = tableRows('**表 1：读屏可达通道成员', '> 口径注：', 'status');
const confirmRows = tableRows('**表 2：原生轻确认成员', '**规则**：', 'confirm');

describe('语义组件清单 · file:line 锚点守卫（评审 minor：锚点漂移无报警面）', () => {
  it('表 1 锚点非空（读屏可达通道成员在册）', () => {
    expect(statusRows.length).toBeGreaterThanOrEqual(20);
  });

  it('表 2 锚点非空（原生轻确认成员在册）', () => {
    expect(confirmRows.length).toBeGreaterThanOrEqual(8);
  });

  it('表 1 每条锚点行仍承载读屏通道语义（role="status" / aria-live="polite"）', () => {
    for (const row of statusRows) {
      const abs = findInLib(row.file);
      expect(abs, `锚点文件不存在：${row.file}`).not.toBeNull();
      const lines = readFileSync(abs!, 'utf8').split('\n');
      const text = lines[row.line - 1] ?? '';
      expect(
        text,
        `${row.file}:${row.line} 不再承载读屏通道语义（锚点漂移）→ ${text.trim().slice(0, 80)}`
      ).toMatch(/role="status"|aria-live="polite"/);
    }
  });

  it('表 2 每条锚点行仍承载原生轻确认语义（confirm( 调用）', () => {
    for (const row of confirmRows) {
      const abs = findInLib(row.file);
      expect(abs, `锚点文件不存在：${row.file}`).not.toBeNull();
      const lines = readFileSync(abs!, 'utf8').split('\n');
      const text = lines[row.line - 1] ?? '';
      expect(
        text,
        `${row.file}:${row.line} 不再承载 confirm 调用（锚点漂移）→ ${text.trim().slice(0, 80)}`
      ).toContain('confirm(');
    }
  });

  it('锚点所引文件在仓内存在（文件改名即红）', () => {
    for (const row of [...statusRows, ...confirmRows]) {
      expect(existsSync(findInLib(row.file) ?? ''), `锚点文件缺失：${row.file}`).toBe(true);
    }
  });
});
