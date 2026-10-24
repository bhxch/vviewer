//! Range 头解析域（BE-2 单源收敛）：纯字符串解析，零框架依赖——native
//! `routes/file.rs` 与 worker `src/http.rs` 的同源复刻（两侧曾以「逐行同源
//! 双向防漂移」注释 + 复刻同款单测人肉维持一致）收敛为本模块一份，双适配
//! 层改 `use vviewer_core::range`。`has_multiple_ranges` 的 BUG-47 语义与
//! `parse_range_syntax`/`resolve_range` 的 C2 parity 拆分（语法面不依赖
//! size、定界面依赖 size——Range 语法非法在 locate 前即可判 416）随迁不变。
//!
//! 合并单测为防漂移锚：原双侧同款用例在此一份（断言逐字保留），适配层各自
//! 的 Range 单测已随复刻删除。

/// 多区间 Range 检测（BUG-47）：`bytes=` 后含多个非空区间即视为多区间。
/// 服务器不实现 multipart/byteranges：按 RFC 9110 §14.2 允许的「忽略 Range」
/// 回 200 全量，不再静默丢弃第二区间伪装成单区间 206。
pub fn has_multiple_ranges(h: &str) -> bool {
    match h.strip_prefix("bytes=") {
        Some(spec) => spec.split(',').filter(|p| !p.trim().is_empty()).count() > 1,
        None => false,
    }
}

/// Range 语法面（C2 parity，不依赖 size）：`bytes=` 前缀 + 首段 `a-b`/`a-`/`-n`
/// 数字解析。Err = 语法非法（RFC 9110 §14.2 请求语法错误，locate 前即可判
/// 416）；Ok(None) = 空串（无 Range 头形态由调用方保证非空，防御性放行）。
#[allow(clippy::result_unit_err)]
pub fn parse_range_syntax(h: &str) -> Result<Option<RawRange>, ()> {
    if h.is_empty() {
        return Ok(None);
    }
    let spec = h.strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().ok_or(())?.trim();
    let (start_s, end_s) = first.split_once('-').ok_or(())?;
    let (start_s, end_s) = (start_s.trim(), end_s.trim());

    let raw = if start_s.is_empty() {
        // -suffix：后缀形态 first=None
        RawRange { first: None, last: Some(end_s.parse().map_err(|_| ())?) }
    } else {
        let first = Some(start_s.parse().map_err(|_| ())?);
        let last = if end_s.is_empty() {
            // a-：开区间 last=None
            None
        } else {
            Some(end_s.parse().map_err(|_| ())?)
        };
        RawRange { first, last }
    };
    Ok(Some(raw))
}

/// Range 定界面（C2 parity，依赖 size）：钳制与不可满足判定——suffix 0 /
/// size 0 后缀 / start ≥ size / 起止倒挂均不可满足。
fn resolve_range(raw: RawRange, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let (start, end) = match (raw.first, raw.last) {
        // -suffix
        (None, Some(suffix)) => {
            if suffix == 0 || size == 0 {
                return Err(());
            }
            (size.saturating_sub(suffix), size - 1)
        }
        (Some(start), last) => {
            if start >= size {
                return Err(());
            }
            match last {
                // a-
                None => (start, size - 1),
                Some(end) => {
                    if start > end {
                        return Err(());
                    }
                    (start, end.min(size - 1))
                }
            }
        }
        // 语法面保证形态必为 a-b/a-/-n 之一（`bytes=-` 已在语法面判否）
        (None, None) => return Err(()),
    };
    Ok(Some((start, end - start + 1)))
}

/// Range 语法解析的中间形态（first/last 的 None 语义：`bytes=a-` 开区间
/// last=None、`bytes=-n` 后缀形态 first=None；pub 字段——测试字面量构造）。
#[derive(Debug, PartialEq, Eq)]
pub struct RawRange {
    pub first: Option<u64>,
    pub last: Option<u64>,
}

/// 解析 Range 头（单区间；多区间取第一个）→ Some((start, len))。
/// None = 无 Range；Err = 非法或越界（→ 416）。
/// 语义：bytes=a-b / a- / -suffix；end 超界钳制；start ≥ size、suffix 0、
/// 起止倒挂、非数字均不可满足。
// result_unit_err：Err(()) 即「Range 不可满足 → 416」的既定语义（模块文档声明，
// 无需携带信息），引入错误类型属公开 API 改形，非本任务（清零）语义。
#[allow(clippy::result_unit_err)]
pub fn parse_range(h: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    // C2：syntax + resolve 组合；空串防御性 None 与旧 strip_prefix 失败同型 Err
    match parse_range_syntax(h)? {
        None => Err(()),
        Some(raw) => resolve_range(raw, size),
    }
}

/// C2 parity：locate 前置语法闸纯判定（双适配层 file 入口同序同语义）。
/// dispatch 面被 wasm 门控、不可 host 单测——判定式抽纯函数使次序语义可锚。
pub fn should_pre_reject_range(if_range_present: bool, range_header: Option<&str>) -> bool {
    match range_header {
        Some(h) => !if_range_present && !has_multiple_ranges(h) && parse_range_syntax(h).is_err(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Range 单区间语义锁测（原双侧同款用例合并，断言逐字保留）。
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

    /// 多区间检测锁测（BUG-47 同款用例，原双侧同款用例合并）。
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

    /// C2 parity：语法面锁测（原双侧同款用例合并——非法集逐项 + 三形态合法集
    /// + 空串防御 None）。
    #[test]
    fn parse_range_syntax_faces_mirror_native() {
        assert!(parse_range_syntax("bytes=x-y").is_err());
        assert!(parse_range_syntax("units=0-1").is_err());
        assert!(parse_range_syntax("bytes=-").is_err());
        assert_eq!(
            parse_range_syntax("bytes=0-1"),
            Ok(Some(RawRange { first: Some(0), last: Some(1) }))
        );
        assert_eq!(
            parse_range_syntax("bytes=-4"),
            Ok(Some(RawRange { first: None, last: Some(4) }))
        );
        assert_eq!(
            parse_range_syntax("bytes=250-"),
            Ok(Some(RawRange { first: Some(250), last: None }))
        );
        assert_eq!(parse_range_syntax(""), Ok(None));
    }

    /// C2 parity：前置闸纯判定——语法非法即拒（与文件存在性无关，
    /// invalid_range_wins_over_missing_file 的判定式）；if-range 在场 / 多区间 /
    /// 无头 / 越界合法语法均不拒（后三者交 locate 后既有链）。
    #[test]
    fn should_pre_reject_range_gates_syntax_only() {
        assert!(should_pre_reject_range(false, Some("bytes=x-y")));
        assert!(should_pre_reject_range(false, Some("units=0-1")));
        assert!(!should_pre_reject_range(false, Some("bytes=0-1")));
        // 越界是 size 相关判定：语法合法不前置拒（416 带 size 由 locate 后路径答）
        assert!(!should_pre_reject_range(false, Some("bytes=999999-")));
        assert!(!should_pre_reject_range(true, Some("bytes=x-y")));
        assert!(!should_pre_reject_range(false, Some("bytes=0-1,3-4")));
        assert!(!should_pre_reject_range(false, None));
    }
}
