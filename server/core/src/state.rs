//! 业务状态核：从 axum 侧 AppState 提取的非框架状态（配置/根列表/令牌），
//! 以及多根寻址的数据类型（RootSpec/MountMeta）。axum 特有面（web_dist/
//! cors_origin/watch hub/一次性 ticket 表）留在适配层 AppState。
//!
//! 迁移期兼容缝：适配层 AppState 经 Deref 直达本结构字段（`state.roots` 等
//! 调用点零改动）；挂载三 API 的 register/unregister 逻辑随 Task 2 域抽取
//! 整体迁入，本任务只迁数据类型。

use std::path::PathBuf;

use vviewer_storage::StorageBackend;
use vviewer_storage::LocalFs;

/// 挂载根的可宣告元信息：health 摘要与阶段二 `GET /api/mounts` 的数据源。
/// **凭据不入内**（spec §2 服务端纪律——不进 health/mounts 回显/日志），
/// Debug 派生安全。
#[derive(Clone, Debug)]
pub struct MountMeta {
    /// 后端类别字面（`"s3"` | `"webdav"`）。
    pub kind: &'static str,
    pub label: Option<String>,
    pub endpoint: String,
    /// S3 挂载的桶名；WebDAV 挂载为 None。
    pub bucket: Option<String>,
    /// 挂载子路径（配置原样；空串 = 端点根）。
    pub prefix: String,
}

/// 单个根的规格：原始路径 + canonicalize 结果（guard 越界校验基准）+ 存储后端。
#[derive(Clone)]
pub struct RootSpec {
    /// `--root` 原始路径；挂载根为展示形态（`s3:label` / `s3://endpoint`，无 fs 语义）。
    pub raw: PathBuf,
    /// canonicalize 结果（构造时一次，失败回退原路径）；挂载根与 raw 相同
    /// （guard 对挂载根不做 fs canonicalize，见 routes 的 mount 分支）。
    pub canonical: PathBuf,
    /// 该根的存储后端（fs 根 LocalFs；挂载根 S3/WebDAV）。
    pub backend: std::sync::Arc<dyn StorageBackend>,
    /// 挂载元信息；None = fs 根（根序 = fs 根 + 静态挂载序，spec §2）。
    pub mount: Option<MountMeta>,
}

impl RootSpec {
    /// fs 根构造：LocalFs 以 canonical 路径为基——路由层把 guard 解析出的
    /// canonical 绝对路径按根 strip 成相对路径传入，backend join 回来触达的
    /// 绝对路径与下沉前的直读形态逐字节一致。
    pub fn fs_root(raw: PathBuf, canonical: PathBuf, hidden: bool) -> Self {
        Self {
            backend: std::sync::Arc::new(LocalFs::new(canonical.clone(), hidden)),
            raw,
            canonical,
            mount: None,
        }
    }

    /// 挂载根构造：raw/canonical 为展示形态（无 fs 语义——guard 清洗 path 后
    /// 直接作为 backend 相对路径，不经 canonicalize/越界校验）。
    pub fn mount(meta: MountMeta, backend: std::sync::Arc<dyn StorageBackend>) -> Self {
        let raw = match &meta.label {
            Some(l) => PathBuf::from(format!("{}:{l}", meta.kind)),
            None => PathBuf::from(format!("{}://{}", meta.kind, meta.endpoint)),
        };
        Self { raw: raw.clone(), canonical: raw, backend, mount: Some(meta) }
    }
}

impl std::fmt::Debug for RootSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // backend 为 dyn 存储（无 Debug 语义），只暴露路径面
        f.debug_struct("RootSpec")
            .field("raw", &self.raw)
            .field("canonical", &self.canonical)
            .finish_non_exhaustive()
    }
}

/// 业务状态核（[`health::handle`] 等域 handler 的消费面）：配置 + 多根容器 +
/// 鉴权令牌。Clone 廉价（roots 内 backend 为 Arc 共享）。
#[derive(Clone)]
pub struct CoreState {
    /// `--root` 原始路径（兼容视图 = [`CoreState::roots`]）。
    pub root: PathBuf,
    /// root 的 canonicalize 结果（构造时一次），guard 越界校验基准（兼容视图 = roots[0]）。
    pub root_canonical: PathBuf,
    /// 多根列表（workspace 阶段 1 + 挂载阶段一）：**根序 = fs 根 + 静态挂载序**
    /// （spec §2）；单根部署时恒为 1 项。rootIndex < [`CoreState::fs_roots`]
    /// 为 fs 根，≥ 为挂载根。
    pub roots: Vec<RootSpec>,
    /// fs 根数量（roots 前缀段长度）：挂载根寻址边界（health.fsRoots 宣告源）。
    pub fs_roots: usize,
    /// 访问令牌；None 表示免鉴权（仅默认 127.0.0.1 绑定时允许）。
    pub token: Option<String>,
    /// `--hidden`：隐藏 dot 开头条目。
    pub hidden: bool,
    /// `--compute`：启用服务端计算端点（/api/compute/*；health 能力追加 "compute"）。
    pub compute: bool,
    /// rg 可执行路径覆盖：None = 请求时 PATH 探测；Some(可执行) = 直接绑定；
    /// Some(不可执行) = rg 不可用（跳过 PATH 探测——测试模拟 rg 缺失，A 项降级链）。
    pub rg_path: Option<String>,
    /// grep 路径覆盖：语义同 `rg_path`（rg 不可用时的 fallback 引擎，探测链第二位）。
    pub grep_path: Option<String>,
    /// 服务端版本宣告（health.version 数据源）：由适配层注入 vviewer 主 crate
    /// 的 `CARGO_PKG_VERSION`——health 对外版本面随主 crate，不随本 crate。
    pub version: &'static str,
    /// compute 语言清单宣告源（依赖倒置缝，Task 3 compute 域收编 core 后退役为
    /// core 内直接调用）：语言注册表随 tree-sitter 留在 vviewer crate，core 不
    /// 依赖重依赖——适配层注入实现，core 只消费宣告结果。
    pub compute_languages: fn() -> Vec<&'static str>,
    /// searchEngine 宣告源（依赖倒置缝，Task 3 search 域收编 core 后退役）：
    /// rg/grep 探测链当前在适配层 routes/search，注入实现在适配层——与
    /// /api/search 同一选择链（零漂移），core 只消费引擎名。
    pub search_engine: fn(&CoreState) -> Option<&'static str>,
}

impl CoreState {
    /// fs 单根状态构造（与迁移前 AppState::new 的核内构造逐语句一致）。
    /// version 与两个宣告缝由适配层装配时注入。
    pub fn new(root: PathBuf, token: Option<String>, hidden: bool) -> Self {
        // main 启动前已校验目录存在；canonicalize 失败时退回原路径（保持可测）
        let root_canonical: PathBuf = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let roots = vec![RootSpec::fs_root(root.clone(), root_canonical.clone(), hidden)];
        Self {
            root,
            root_canonical,
            roots,
            fs_roots: 1,
            token,
            hidden,
            compute: false,
            rg_path: None,
            grep_path: None,
            version: "",
            compute_languages: || Vec::new(),
            search_engine: |_| None,
        }
    }
}

/// 供 Path 转发的便捷引用（迁移前位于适配层 AppState 的同款形态）。
impl AsRef<std::path::Path> for CoreState {
    fn as_ref(&self) -> &std::path::Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_single_fs_root_with_canonical_fallback() {
        // canonicalize 失败（不存在路径）回退原路径——与迁移前 AppState::new 同款
        let raw = PathBuf::from("/nonexistent/vviewer-core-test-root");
        let cs = CoreState::new(raw.clone(), Some("tok".into()), false);
        assert_eq!(cs.roots.len(), 1);
        assert_eq!(cs.fs_roots, 1);
        assert_eq!(cs.root_canonical, raw);
        assert_eq!(cs.token.as_deref(), Some("tok"));
        assert!(!cs.compute);
    }
}
