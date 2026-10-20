//! `GET /api/health`：免鉴权能力发现（业务体自适配层 routes/health.rs 原样
//! 迁入——axum 侧只留 State 提取与响应映射）。

use serde::Serialize;

use crate::state::CoreState;
use crate::{CoreResponse, StatusCode};

#[derive(Serialize)]
pub struct Health {
    pub name: &'static str,
    pub version: &'static str,
    pub capabilities: Vec<&'static str>,
    /// `--compute` 时宣告服务端高亮支持的 canonical 语言清单：客户端 auto 策略
    /// 据此路由（清单外语言直接本地，不再白发 400 再回退）；缺省（非 compute）
    /// 字段整体省略。客户端清单过期/缺失时按未知处理（保持既有先试远程行为）。
    #[serde(rename = "computeLanguages", skip_serializing_if = "Option::is_none")]
    pub compute_languages: Option<Vec<&'static str>>,
    /// 服务端图表渲染子集（spec §2.5；随 compute 门控，非 compute 省略）
    #[serde(rename = "diagrams", skip_serializing_if = "Option::is_none")]
    pub diagrams: Option<Vec<&'static str>>,
    /// 跨文件搜索引擎宣告（A 项）：rg/grep 择一；双缺时字段整体省略。
    /// 与 /api/search 同一选择链，测试经 rg_path/grep_path 注入覆盖。
    #[serde(rename = "searchEngine", skip_serializing_if = "Option::is_none")]
    pub search_engine: Option<&'static str>,
    /// 多根宣告（workspace 阶段 1）：数据根数量（**含挂载根**——rootIndex 寻址
    /// 面 = fs 根 + 挂载序）；=1（单根部署，历史形状）时字段整体省略。客户端据
    /// 命中帧的 root 索引定位所属根。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roots: Option<usize>,
    /// fs 根数边界（spec §2）：rootIndex < fsRoots 为 fs 根、≥ 为挂载根。
    /// 无挂载部署字段整体省略（历史形状零变化）。
    #[serde(rename = "fsRoots", skip_serializing_if = "Option::is_none")]
    pub fs_roots: Option<usize>,
    /// 静态挂载根摘要（spec §2，脱敏：kind/label/endpoint/bucket/prefix——
    /// **凭据不入内**，[`crate::state::MountMeta`] 结构面即保证）。无挂载时
    /// 整体省略。per-root 能力（watch/search）与运行时挂载的增删随阶段二
    /// `GET /api/mounts` 宣告，本字段只读摘要。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mounts: Option<Vec<MountSummary>>,
    /// 多根路径宣告（遗留项-UX）：与 fs 根多根同门槛按序宣告 canonical 路径，
    /// RemoteSourceModal 根选择显示真实路径而非「根 N」。挂载根不入列（endpoint
    /// 非 fs 路径，走 mounts 摘要通道）。仅免鉴权部署宣告——health 免鉴权可读，
    /// token 鉴权的局域网部署宣告路径会向未认证对端泄漏服务器目录结构，此时
    /// 字段整体省略（旧前端/受限部署回落「根 N」）。
    #[serde(rename = "rootPaths", skip_serializing_if = "Option::is_none")]
    pub root_paths: Option<Vec<String>>,
}

/// 挂载根摘要条目（脱敏面：无凭据字段——数据源 [`crate::state::MountMeta`]）。
#[derive(Serialize)]
pub struct MountSummary {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    pub prefix: String,
}

/// 能力宣告：`file-server` 恒有；`--compute` 时追加 `compute`
/// （前端连接时缓存，compute 路由据此判定是否走远程）。
pub fn handle(state: &CoreState) -> CoreResponse {
    let mut capabilities = vec!["file-server"];
    let mut compute_languages = None;
    let mut diagrams = None;
    if state.compute {
        capabilities.push("compute");
        compute_languages = Some((state.compute_languages)());
        diagrams = Some(vec!["graphviz", "svgbob"]);
    }
    let search_engine = (state.search_engine)(state);
    let root_count = state.roots.len();
    let fs_count = state.fs_roots;
    // 挂载根摘要（roots 的 fs 段之后即挂载序）：无挂载 → None（字段省略）
    let mounts = (root_count > fs_count).then(|| {
        state
            .roots
            .iter()
            .filter_map(|r| r.mount.as_ref())
            .map(|m| MountSummary {
                kind: m.kind,
                label: m.label.clone(),
                endpoint: m.endpoint.clone(),
                bucket: m.bucket.clone(),
                prefix: m.prefix.clone(),
            })
            .collect::<Vec<_>>()
    });
    // 路径宣告双门槛：fs 根多根（挂载根无 fs 路径不入列）+ 免鉴权
    let root_paths = (fs_count > 1 && state.token.is_none()).then(|| {
        state.roots[..fs_count]
            .iter()
            .map(|r| r.canonical.display().to_string())
            .collect::<Vec<_>>()
    });
    CoreResponse::json(
        StatusCode::OK,
        &Health {
            name: "vviewer",
            version: state.version,
            capabilities,
            compute_languages,
            diagrams,
            search_engine,
            roots: (root_count > 1).then_some(root_count),
            fs_roots: mounts.is_some().then_some(fs_count),
            mounts,
            root_paths,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreBody;
    use std::path::PathBuf;

    fn health_json(state: &CoreState) -> serde_json::Value {
        let res = handle(state);
        assert_eq!(res.status, StatusCode::OK);
        let CoreBody::Full(bytes) = res.body;
        serde_json::from_slice(&bytes).expect("json")
    }

    fn base_state() -> CoreState {
        CoreState::new(PathBuf::from("."), None, false)
    }

    #[test]
    fn no_compute_omits_language_list() {
        let v = health_json(&base_state());
        assert_eq!(v["capabilities"], serde_json::json!(["file-server"]));
        assert!(v.get("computeLanguages").is_none());
    }

    #[test]
    fn single_root_omits_roots_field() {
        let v = health_json(&base_state());
        assert!(v.get("roots").is_none(), "单根部署应省略 roots 字段: {v}");
        assert!(v.get("fsRoots").is_none(), "{v}");
        assert!(v.get("mounts").is_none(), "{v}");
    }

    #[test]
    fn json_content_type_is_axum_json_form() {
        let res = handle(&base_state());
        assert_eq!(
            res.headers.get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
    }
}
