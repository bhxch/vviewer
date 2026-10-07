// xlsx.ts — Excel 渲染器（M4 Task 5）。SheetJS community（xlsx，Apache-2.0）动态
// import；read 同时支持 xlsx/xlsm（ZIP+OOXML）与旧版 xls（OLE/BIFF），故 render
// 不做 ZIP 签名早失败（与 docx/pptx 不同），非法输入由 read 抛错 → 错误卡。
// 每个 sheet 手动构建 <table>（SDD 裁决允许 sheet_to_html 或手动 row/cell 构建，
// 取后者：单元格经 textContent 写入，无 HTML 注入面，天然免净化），大 sheet 截断：
// 仅读前 200 行 × 前 200 列（按 !ref 范围直接寻址，不物化全部行）+ 提示条；多 sheet 页签切换。
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';
import { sniffOoxml } from './ooxml';

type XlsxModule = typeof import('xlsx');

/** 每 sheet 最大渲染行数（超出截断 + 提示条） */
export const MAX_ROWS_PER_SHEET = 200;
/** 每 sheet 最大渲染列数（超出截断 + 提示条，与行截断同构） */
export const MAX_COLS_PER_SHEET = 200;

/** xlsx 类型面的最小切片（避免整包 any 蔓延） */
interface CellObject {
  v?: unknown;
  w?: string;
}
interface WorkSheet {
  [addr: string]: unknown;
  '!ref'?: string;
}
interface WorkBook {
  SheetNames: string[];
  Sheets: Record<string, WorkSheet>;
}
interface Range {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

function cellText(sheet: WorkSheet, r: number, c: number, XLSX: XlsxModule): string {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[addr] as CellObject | undefined;
  if (!cell) return '';
  // w 为格式化文本（数字/日期显示值），缺省回退原始值
  return cell.w ?? (cell.v == null ? '' : String(cell.v));
}

function buildSheetDom(sheet: WorkSheet, XLSX: XlsxModule): DocumentFragment {
  const frag = document.createDocumentFragment();
  const table = document.createElement('table');
  const ref = sheet['!ref'];
  if (!ref) {
    const empty = document.createElement('div');
    empty.className = 'vv-xlsx-truncated';
    empty.textContent = '（空工作表）';
    frag.append(table, empty);
    return frag;
  }
  const range = XLSX.utils.decode_range(ref) as Range;
  const totalRows = range.e.r - range.s.r + 1;
  const totalCols = range.e.c - range.s.c + 1;
  const endRow = Math.min(range.e.r, range.s.r + MAX_ROWS_PER_SHEET - 1);
  const endCol = Math.min(range.e.c, range.s.c + MAX_COLS_PER_SHEET - 1);
  for (let r = range.s.r; r <= endRow; r++) {
    const tr = document.createElement('tr');
    for (let c = range.s.c; c <= endCol; c++) {
      const td = document.createElement('td');
      td.textContent = cellText(sheet, r, c, XLSX);
      tr.append(td);
    }
    table.append(tr);
  }
  frag.append(table);
  if (totalRows > MAX_ROWS_PER_SHEET || totalCols > MAX_COLS_PER_SHEET) {
    // 行/列超限合并为一条提示（同构措辞，实际触发哪项显示哪项）
    const parts: string[] = [];
    if (totalRows > MAX_ROWS_PER_SHEET) {
      parts.push(`共 ${totalRows} 行，仅显示前 ${MAX_ROWS_PER_SHEET} 行`);
    }
    if (totalCols > MAX_COLS_PER_SHEET) {
      parts.push(`共 ${totalCols} 列，仅显示前 ${MAX_COLS_PER_SHEET} 列`);
    }
    const note = document.createElement('div');
    note.className = 'vv-xlsx-truncated';
    note.textContent = `内容较长：${parts.join('；')}`;
    frag.append(note);
  }
  return frag;
}

export const xlsxRenderer: Renderer = {
  id: 'xlsx',
  label: 'Excel 表格',
  extensions: ['xlsx', 'xlsm', 'xls'],
  sniff: sniffOoxml,
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, _det: Detection) {
    const mod = await import('xlsx');
    const XLSX = ((mod as { default?: XlsxModule }).default ?? mod) as XlsxModule;
    // type:'array' 接受 Uint8Array；旧版 .xls（OLE/BIFF）同样由此解析
    const wb = XLSX.read(buffer, { type: 'array' }) as WorkBook;

    const root = document.createElement('div');
    root.className = 'vv-xlsx';
    const tabbar = document.createElement('div');
    tabbar.className = 'vv-xlsx-tabbar';
    const tabs: HTMLButtonElement[] = [];
    const hosts: HTMLDivElement[] = [];

    function select(i: number): void {
      for (const [j, host] of hosts.entries()) host.hidden = j !== i;
      for (const [j, tab] of tabs.entries()) tab.classList.toggle('active', j === i);
    }

    for (const [i, name] of wb.SheetNames.entries()) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'vv-xlsx-tab';
      tab.textContent = name;
      tab.onclick = () => select(i);
      tabs.push(tab);
      tabbar.append(tab);

      const host = document.createElement('div');
      host.className = 'vv-xlsx-sheet';
      host.append(buildSheetDom(wb.Sheets[name] ?? {}, XLSX));
      hosts.push(host);
      root.append(host);
    }
    root.prepend(tabbar);
    if (hosts.length > 0) select(0);

    target.replaceChildren(root);
    const instance: RenderedInstance = {
      destroy() {
        root.remove();
      }
    };
    return instance;
  }
};
