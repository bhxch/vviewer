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
    /// 与 /api/search 同一选择链（Task 3 起 core 内直调
    /// [`crate::search::resolve_paths`]——适配层注入缝退役），测试经
    /// rg_path/grep_path 注入覆盖。
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

/// 能力宣告：`file-server` 恒有；`--compute` 且 native feature 时追加
/// `compute`（前端连接时缓存，compute 路由据此判定是否走远程）。compute 域随
/// Task 3 收编 core，`computeLanguages` 宣告缝（Task 1 预埋 fn 指针）退役为
/// core 内直调 [`crate::compute::queries::supported_languages`]；无 native
/// feature（worker 形态）时即使 `--compute` 也不宣告（路由不存在，plan 门控
/// 语义：语言表随 tree-sitter 编译裁剪）。
pub fn handle(state: &CoreState) -> CoreResponse {
    // 1-5：version 由适配层装配注入（CARGO_PKG_VERSION）；空串=旁路构造，
    // debug 构建立即暴露，release 宣告空串行为不变（既有 wire 不改）
    debug_assert!(!state.version.is_empty(), "version 未注入（旁路构造？）");
    #[cfg_attr(not(feature = "native"), allow(unused_mut))]
    let (mut capabilities, mut compute_languages, mut diagrams) =
        (vec!["file-server"], None, None);
    // 双门控合一：编译期（native feature）× 运行时（--compute 旗标）。
    // compute 域随 Task 3 收编 core，`computeLanguages` 宣告缝（Task 1 预埋
    // fn 指针）退役为 core 内直调 [`crate::compute::queries`]。
    #[cfg(feature = "native")]
    if state.compute {
        capabilities.push("compute");
        compute_languages = Some(crate::compute::queries::supported_languages());
        diagrams = Some(vec!["graphviz", "svgbob"]);
    }
    // searchEngine 与 /api/search 消费同一选择链（Task 3 缝退役为 core 内直调）
    let search_engine = crate::search::resolve_paths(state.rg_path.as_deref(), state.grep_path.as_deref())
        .map(|(engine, _)| engine.name());
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
        // CoreBody 流变体随 Task 2 落地后的编译适配（health 恒聚合 JSON，
        // 断言面零变化）
        let CoreBody::Full(bytes) = res.body else { panic!("health body must be full bytes") };
        serde_json::from_slice(&bytes).expect("json")
    }

    fn base_state() -> CoreState {
        // 1-5 装置适配（非行为变更）：CoreState::new 是旁路构造（version=""），
        // 真实装配点由适配层注入 CARGO_PKG_VERSION（server/src/state.rs:89、
        // worker/src/state.rs:84 同缝）；debug_assert 上线后既有测试统一补注入。
        let mut state = CoreState::new(PathBuf::from("."), None, false);
        state.version = "test";
        state
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

    /// 1-5：旁路构造的空 version 在 debug 构建即暴露（装配点必然注入的
    /// 不变式锚；release 无断言、行为不变）。
    /// 装置适配：盘上 `handle` 为单参 `(&CoreState)`（简报两参形态按现状
    /// 仲裁）；`test_state_with_version` 不存在，按简报 fallback 以
    /// `base_state()` 构造后显式置空 version。
    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "version 未注入")]
    fn health_rejects_uninjected_version_in_debug() {
        let mut state = base_state();
        state.version = ""; // 旁路构造：装配点未注入 version
        let _ = handle(&state);
    }

    /// 裁剪形态（worker，--no-default-features）锚测（修复轮 1 评审 L1）：
    /// `--compute` 旗标不得翻出 compute 能力/语言表/图表宣告——实现体经
    /// native feature 编译裁剪（plan 门控语义：无 feature 时 handler 编译不
    /// 存在、路由不挂载、health 不宣告），运行时旗标失效于无实现体。
    /// `cargo test -p vviewer-core --no-default-features` 可跑（native 形态
    /// 不编译本锚测，与上方 native 行为锚测互斥互补）。
    #[cfg(not(feature = "native"))]
    #[test]
    fn trimmed_form_omits_compute_announcement_even_when_flagged() {
        let mut state = base_state();
        state.compute = true;
        let v = health_json(&state);
        assert_eq!(v["capabilities"], serde_json::json!(["file-server"]));
        assert!(v.get("computeLanguages").is_none(), "裁剪形态不得宣告语言表: {v}");
        assert!(v.get("diagrams").is_none(), "裁剪形态不得宣告图表: {v}");
        // searchEngine 宣告链（rg/grep PATH 探测）非 native 重依赖、不随裁剪：
        // 存在性与否随测试环境 PATH 而定（无注入时本机探测），不纳入本锚测
        // （存在性断言由 native 侧 health 集成测试经 rg_path/grep_path 注入覆盖）
    }
}
