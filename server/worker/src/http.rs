//! 纯 HTTP 语义件（跨目标编译，native 单测覆盖）：Range 头解析与 base-path
//! 裁剪。Range 解析属 HTTP 语义（计划裁决）留适配层——本模块与 native 适配层
//! `routes/file.rs` 的 `parse_range`/`has_multiple_ranges` 逐行同源（语义锚：
//! 该模块单测同款用例在此复刻，双向防漂移）。

/// 多区间 Range 检测（BUG-47）：`bytes=` 后含多个非空区间即视为多区间。
/// 服务器不实现 multipart/byteranges：按 RFC 9110 §14.2 允许的「忽略 Range」
/// 回 200 全量，不再静默丢弃第二区间伪装成单区间 206。
pub fn has_multiple_ranges(h: &str) -> bool {
    match h.strip_prefix("bytes=") {
        Some(spec) => spec.split(',').filter(|p| !p.trim().is_empty()).count() > 1,
        None => false,
    }
}

/// 解析 Range 头（单区间；多区间取第一个）→ Some((start, len))。
/// None = 无 Range；Err = 非法或越界（→ 416）。
/// 语义：bytes=a-b / a- / -suffix；end 超界钳制；start ≥ size、suffix 0、
/// 起止倒挂、非数字均不可满足。
// result_unit_err：Err(()) 即「Range 不可满足 → 416」的既定语义（模块文档声明，
// 无需携带信息），引入错误类型属公开 API 改形，非本任务（清零）语义。
#[allow(clippy::result_unit_err)]
pub fn parse_range(h: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let spec = h.strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().ok_or(())?.trim();
    let (start_s, end_s) = first.split_once('-').ok_or(())?;
    let (start_s, end_s) = (start_s.trim(), end_s.trim());

    let (start, end) = if start_s.is_empty() {
        // -suffix
        let suffix: u64 = end_s.parse().map_err(|_| ())?;
        if suffix == 0 || size == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start: u64 = start_s.parse().map_err(|_| ())?;
        if start >= size {
            return Err(());
        }
        if end_s.is_empty() {
            (start, size - 1)
        } else {
            let end: u64 = end_s.parse().map_err(|_| ())?;
            if start > end {
                return Err(());
            }
            (start, end.min(size - 1))
        }
    };
    Ok(Some((start, end - start + 1)))
}

/// 资产路径判定（C1 SPA-fallback 前科纪律，Workers 面）：缺失路径按扩展名
/// 分流——清单内资产路径缺失必须 404，不得以 200 index.html 兜底（HTML 被误
/// 载为字节/查询资产：grammar `.scm`/`.wasm` 使 query loader 编译失败静默
/// 降级 hljs——终审 C1 双层修之 server 层 `.scm`/`.wasm` 两类；`.mjs`/`.css`
/// 为计划资产纪律的全集扩展，plan Global Constraints「资产缺失 404 不回
/// HTML」）。SPA 路由（无扩展名形态）不受影响。
pub fn is_asset_path(path: &str) -> bool {
    // 1-8：大小写不敏感（ASCII 恒可——扩展名集全 ASCII）
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".wasm") || lower.ends_with(".scm")
        || lower.ends_with(".mjs") || lower.ends_with(".css")
}

/// 1-10 累计闸：消费一块前判定，累计超 cap 即 false（调用方 413）。
pub fn payload_fits(acc: &mut usize, chunk_len: usize, cap: usize) -> bool {
    let next = acc.saturating_add(chunk_len);
    if next > cap { return false; }
    *acc = next;
    true
}

/// base-path 裁剪（VV_BASE_PATH env，值形如 `/docs`；空串/缺省 = 不裁剪）：
/// 请求路径命中前缀即剥去，`/docs/api/health` → `/api/health`；前缀本身
/// （`/docs`）与未命中前缀的路径原样返回（交由后续 /api 匹配与 Assets 边界
/// 自然 404）。仅剥完整段（`/docsx` 不误剥 `/docs`）。
pub fn strip_base_path<'a>(base: &str, path: &'a str) -> &'a str {
    if base.is_empty() || base == "/" {
        return path;
    }
    match path.strip_prefix(base) {
        Some("") => "/",
        Some(rest) if rest.starts_with('/') => rest,
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Range 单区间语义锁测（与 native routes/file.rs 同款用例——语义锚）。
    #[test]
    fn parse_range_single_range_semantics_unchanged() {
        assert_eq!(parse_range("bytes=0-1", 256), Ok(Some((0, 2))));
        assert_eq!(parse_range("bytes=-4", 256), Ok(Some((252, 4))));
        assert_eq!(parse_range("bytes=250-", 256), Ok(Some((250, 6))));
        // end 超界钳制
        assert_eq!(parse_range("bytes=250-999", 256), Ok(Some((250, 6))));
        // start ≥ size / suffix 0 / 倒挂 / 非法：不可满足（→ 416）
        assert_eq!(parse_range("bytes=256-", 256), Err(()));
        assert_eq!(parse_range("bytes=-0", 256), Err(()));
        assert_eq!(parse_range("bytes=5-4", 256), Err(()));
        assert_eq!(parse_range("bytes=x-y", 256), Err(()));
        assert_eq!(parse_range("units=0-1", 256), Err(()));
    }

    /// 多区间检测锁测（BUG-47 同款用例）。
    #[test]
    fn multiple_range_specs_are_detected() {
        assert!(has_multiple_ranges("bytes=0-1,3-4"));
        assert!(has_multiple_ranges("bytes=100-105,200-205"));
        assert!(has_multiple_ranges("bytes=0-1,,3-4"));
        assert!(!has_multiple_ranges("bytes=0-1"));
        assert!(!has_multiple_ranges("bytes=0-1,"));
        assert!(!has_multiple_ranges("bytes=-4"));
        assert!(!has_multiple_ranges("bytes=0-"));
        assert!(!has_multiple_ranges("items=0-1,3-4"));
    }

    /// base-path 裁剪：命中剥段、未命中/近邻前缀不误剥、空与根不裁。
    #[test]
    fn strip_base_path_strips_exact_segment_only() {
        assert_eq!(strip_base_path("/docs", "/docs/api/health"), "/api/health");
        assert_eq!(strip_base_path("/docs", "/docs"), "/");
        assert_eq!(strip_base_path("/docs", "/docsx/api"), "/docsx/api");
        assert_eq!(strip_base_path("/docs", "/api/health"), "/api/health");
        assert_eq!(strip_base_path("", "/api/health"), "/api/health");
        assert_eq!(strip_base_path("/", "/api/health"), "/api/health");
    }

    /// 资产路径判定（C1 纪律锁测）：清单内扩展名命中与大小写敏感性（扩展名
    /// 按字面比较——URL path 大小写敏感，Assets 查找同口径）、SPA 路由形态
    /// （无扩展名/查询串不在本层——strip 前的 path 不含 query）不误判。
    #[test]
    fn asset_path_matches_discipline_extension_set() {
        assert!(is_asset_path("/grammars/rust.wasm"));
        assert!(is_asset_path("/grammars/113/injections.scm"));
        assert!(is_asset_path("/_app/immutable/chunks/diagram.mjs"));
        assert!(is_asset_path("/_app/immutable/assets/layout.css"));
        // SPA 路由与目录形态不命中（应回 index.html 的面）
        assert!(!is_asset_path("/"));
        assert!(!is_asset_path("/workspace/docs"));
        assert!(!is_asset_path("/grammars/manifest.json"));
        // 近邻形态不误判（非结尾/仅词段后缀）
        assert!(!is_asset_path("/wasm"));
        assert!(!is_asset_path("/file.cssx"));
        assert!(!is_asset_path("/a.wasm/b"));
    }

    /// 1-8：扩展名大小写不敏感（C1 纪律的补网——`.WASM` 误载 HTML 的同型风险）。
    #[test]
    fn asset_path_is_case_insensitive() {
        for p in ["/grammars/rust.WASM", "/grammars/Rust.Wasm", "/x.SCM", "/a.Mjs", "/s.Css"] {
            assert!(is_asset_path(p), "{p}");
        }
        assert!(!is_asset_path("/plain.WASMX"), "非尾扩展不算");
    }

    /// 1-10：累计闸语义——边界恰等允许、超一即拒（分块到达序无关）。
    #[test]
    fn payload_gate_bounds_accumulation() {
        let mut n = 0usize;
        assert!(payload_fits(&mut n, 100, 100) && n == 100);
        assert!(!payload_fits(&mut n, 1, 100));
        let mut m = 99usize;
        assert!(payload_fits(&mut m, 1, 100) && m == 100);
    }
}
