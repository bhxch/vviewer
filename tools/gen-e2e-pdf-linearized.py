#!/usr/bin/env python3
"""生成 e2e PDF-RANGE 域夹具：确定性线性化多页 PDF（qpdf/pikepdf，io-streaming plan5 Task 2）。

产物：apps/web/e2e/fixtures/corpus/pdf-linearized/progressive.pdf
  - 12 页 600×900pt，每页 ~131KB 原始内容流（compress_streams=False 存原样 → 体量确定），
    总体量 >1MB——dispatcher 读策略（FULL_LIMIT=1MB）对 size>1MB 的 capable 远端来源交付
    8KB 探测块 + StreamCtx，pdf 渲染器方入 PDFDataRangeTransport 分支（e2e transport 锚的
    夹具前提）。
  - linearize=True（qpdf 线性化）：首页对象/内容流聚于文件头、线性化参数字典在偏移 0——
    pdfjs worker 对 linearized 文件自文件头首个 endobj 后取 startxref（不走文件尾扫描），
    hang-tail 式渐进锚（首屏先于全量到达）的夹具前提；/N=12 使 numPages 免尾区读取。
  - 确定性：固定内容 + deterministic_id=True（/ID 派生自内容）+ 无时间戳元数据，
    同参数重跑字节等值（本脚本自身以 sha256 断言自证）。

用法（需 python3 + pikepdf；本机经 uv 免装直跑）：
    uv run --with pikepdf tools/gen-e2e-pdf-linearized.py

夹具不入库（apps/web/e2e/fixtures/corpus/ 整目录 gitignore，多源语料同款惯例）：
本地与统一验证阶段先跑本脚本再跑 playwright；b-pdf-range.spec.ts 以 existsSync 守卫
容错缺失（skip 不炸收集）。
"""

import hashlib
from pathlib import Path

import pikepdf

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "apps" / "web" / "e2e" / "fixtures" / "corpus" / "pdf-linearized"
OUT = OUT_DIR / "progressive.pdf"

PAGES = 12
PAGE_W, PAGE_H = 600, 900
# 每页内容流目标字节数（原始未压缩）：12 × ~131KB ≈ 1.57MB 总体量
TARGET_STREAM_BYTES = 131_000
# transport 分支前提：总体量必须 >1MB（dispatcher FULL_LIMIT）且各页数据量足够大，
# 首页渲染只需文件头数个 64KB 窗段（e2e 悬挂带 [340KB, 1.45MB) 的确定性余量来源）
MIN_TOTAL = 1_200_000


def page_content_stream(page_no: int) -> bytes:
    """单页内容流：页标题 + 固定模式填充行（确定性字节，不依赖随机/时间）。"""
    parts = [
        f"BT /F1 28 Tf 40 850 Td (PDF-RANGE linearized fixture - page {page_no} of {PAGES}) Tj ET\n".encode()
    ]
    total = len(parts[0])
    line_no = 0
    while total < TARGET_STREAM_BYTES:
        # ~100B/行（BT..ET 骨架 26B + 文本 ~74B），页内行号固定宽度防对齐漂移
        text = f"p{page_no:02d}-l{line_no:05d} " + "x" * 63
        line = f"BT /F1 11 Tf 40 {820 - (line_no % 70) * 11} Td ({text}) Tj ET\n".encode()
        parts.append(line)
        total += len(line)
        line_no += 1
    return b"".join(parts)


def build() -> bytes:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
            Encoding=pikepdf.Name.WinAnsiEncoding,
        )
    )
    for n in range(1, PAGES + 1):
        page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pikepdf.Stream(pdf, page_content_stream(n))
    pdf.save(
        OUT,
        linearize=True,
        deterministic_id=True,
        compress_streams=False,
        object_stream_mode=pikepdf.ObjectStreamMode.disable,
        normalize_content=False,
    )
    pdf.close()
    return OUT.read_bytes()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data = build()
    # 幂等自证：重跑一遍并比对字节（qpdf 线性化输出确定性）
    again = build()
    if data != again:
        raise SystemExit("non-deterministic output: two runs differ")
    sha = hashlib.sha256(data).hexdigest()
    if len(data) < MIN_TOTAL:
        raise SystemExit(f"fixture too small: {len(data)} bytes (< {MIN_TOTAL}, transport 锚前提失效)")
    if b"/Linearized" not in data[:1024]:
        raise SystemExit("linearization dict not at file head（线性化未生效）")
    print(f"fixture : {OUT}")
    print(f"size    : {len(data)} bytes")
    print(f"sha256  : {sha}")


if __name__ == "__main__":
    main()
