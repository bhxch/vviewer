//! 运行时挂载域业务体（多端发布阶段二 Task 2 自适配层迁入）：`POST/GET/DELETE
//! /api/mounts` 三 API 与挂载配置构造面（[`MountKind`]/[`MountConfig`]/
//! [`build_mount`]/指纹幂等）。
//!
//! 配置构造面原属 bin 侧 config.rs/main.rs，此前已下沉适配层 state.rs：运行时
//! 注册（本模块 [`register`]）与静态 TOML 装配（main.rs build_mount_roots）必须
//! 消费同一构造，否则两路 backend 行为会漂移；本任务随域整体收编 core，适配层
//! 经 re-export 保持既有路径。
//!
//! 鉴权口径（spec §3 字面，台账裁决）：与 tree/file 同一 Bearer 中间件组——
//! **有 token 时需 Bearer；无 token 部署免鉴权**。⚠ 风险注记：无 token 部署
//! （LAN 信任模型）下本组是写面（注册/删除内存态挂载），同网段未认证对端可
//! 调用——按 spec 字面实现、不另设门，风险在任务报告显著记录。
//!
//! 脱敏：GET 清单与 health mounts 摘要同源（[`crate::state::MountMeta`] 结构面
//! 即无凭据字段，endpoint 已在构造期剥 userinfo）；凭据三不纪律的 GET/错误/
//! 日志三面由 [`build_mount`] 错误消息（仅字段名）、本模块无 body 打印、
//! tracing 仅记请求行共同保证。

use std::sync::Arc;

use http::{header, HeaderMap, HeaderValue, StatusCode};
use serde::{Deserialize, Serialize};

use vviewer_storage::display_endpoint;
use vviewer_storage::s3::{S3Backend, S3MountConfig};
use vviewer_storage::transport::HttpTransport;
use vviewer_storage::webdav::{WebDavBackend, WebDavMountConfig};
use vviewer_storage::MountCapabilities;

use crate::error::CoreError;
use crate::state::{CoreState, MountMeta};
use crate::{CoreBody, CoreResponse};

// ---------- 挂载配置与后端构造 ----------

/// `[[mount]].kind` / `POST /api/mounts` 的 `kind`（spec §2：s3 | webdav）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MountKind {
    /// S3 兼容对象存储
    S3,
    /// WebDAV
    WebDav,
}

/// 挂载配置节：TOML `[[mount]]` 与 `POST /api/mounts` 请求体同一形态（spec §3：
/// body = 阶段一 MountConfig 形态）。除 `kind`（枚举，解析期把关合法值）外全部
/// 可选：per-kind 必填校验在 [`build_mount`]。
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MountConfig {
    pub kind: MountKind,
    pub label: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub prefix: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub path_style: Option<bool>,
    /// S3 签名 region（台账 3-17）：None → us-east-1 现状缺省（storage 侧
    /// `S3MountConfig` 消费）；WebDAV 挂载忽略。解析语义参数非身份面——
    /// 不入 [`mount_fingerprint`]（同 endpoint 换 region 不改对账键）。
    #[serde(default)]
    pub region: Option<String>,
}

/// Debug 手工实现：凭证字段脱敏（原 config.rs 实现原样下沉——FileConfig/
/// ResolvedConfig 均 derive Debug，嵌套打印配置是常见排障形态，明文凭据不得
/// 经 Debug 外泄；脱敏值保留 Some/None 存在性供排障）。非敏感字段原样。
impl std::fmt::Debug for MountConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redacted = |v: &Option<String>| v.as_ref().map(|_| "[redacted]");
        f.debug_struct("MountConfig")
            .field("kind", &self.kind)
            .field("label", &self.label)
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("prefix", &self.prefix)
            .field("access_key_id", &redacted(&self.access_key_id))
            .field("secret_access_key", &redacted(&self.secret_access_key))
            .field("username", &redacted(&self.username))
            .field("password", &redacted(&self.password))
            .field("path_style", &self.path_style)
            .field("region", &self.region)
            .finish()
    }
}

/// 配置指纹（plan Global Constraints：kind+endpoint+bucket/prefix+label 规范化
/// 串）：字段 trim 后以单元分隔符（U+001F）拼接，直接串比较（免 hash 碰撞面）。
/// **凭据（access_key_id/secret_access_key/username/password）不入指纹**——指纹
/// 是对账键（前端 IndexedDB 持久化配置与服务端清单比对），语义是「同一挂载
/// 目标」而非「同一份凭据」。
pub fn mount_fingerprint(cfg: &MountConfig) -> String {
    let kind = match cfg.kind {
        MountKind::S3 => "s3",
        MountKind::WebDav => "webdav",
    };
    [
        kind,
        cfg.endpoint.as_deref().unwrap_or("").trim(),
        cfg.bucket.as_deref().unwrap_or("").trim(),
        cfg.prefix.as_deref().unwrap_or("").trim(),
        cfg.label.as_deref().unwrap_or("").trim(),
    ]
    .join("\u{1f}")
}

/// 挂载根装配产物（main 装配链产出、测试注入共用形态）：已构造 backend +
/// 可宣告元信息。测试可注入 MockTransport 构造的后端（适配层 AppState 的
/// with_mounts builder）。
pub struct MountRoot {
    pub backend: Arc<dyn vviewer_storage::StorageBackend>,
    pub meta: MountMeta,
}

impl std::fmt::Debug for MountRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // backend 为 dyn 存储（无 Debug 语义），只暴露元信息面（凭据不入 MountMeta）
        f.debug_struct("MountRoot")
            .field("meta", &self.meta)
            .finish_non_exhaustive()
    }
}

/// 挂载后端构造（spec §2/§3 共用）：MountConfig → (backend, 元信息)。per-kind
/// 必填校验在此——错误消息含字段名、不含凭据值（spec §6 错误面纪律）。静态
/// 装配（main.rs build_mount_roots，配置错误 exit 2）与运行时注册
/// （[`CoreState::register_mount`]，配置错误 400）消费同一函数。
pub fn build_mount(
    cfg: &MountConfig,
    transport: Arc<dyn HttpTransport>,
) -> Result<MountRoot, String> {
    /// Option 字段必填校验（错误消息含字段名）。
    fn required<T>(field: Option<T>, name: &str, kind: &str) -> Result<T, String> {
        field.ok_or_else(|| format!("{kind} mount: missing required field `{name}`"))
    }
    match cfg.kind {
        MountKind::S3 => {
            let kind = "s3";
            let endpoint = required(cfg.endpoint.clone(), "endpoint", kind)?;
            let bucket = required(cfg.bucket.clone(), "bucket", kind)?;
            let access_key_id = required(cfg.access_key_id.clone(), "access_key_id", kind)?;
            let secret_access_key =
                required(cfg.secret_access_key.clone(), "secret_access_key", kind)?;
            let prefix = cfg.prefix.clone().unwrap_or_default();
            // path_style 缺省 true（Global Constraints 的 path-style URL 形态）
            let path_style = cfg.path_style.unwrap_or(true);
            // region 可选透传（台账 3-17）：None → storage 侧 us-east-1 现状缺省
            let backend = S3Backend::new(
                S3MountConfig {
                    endpoint: endpoint.clone(),
                    bucket: bucket.clone(),
                    prefix: prefix.clone(),
                    access_key_id,
                    secret_access_key,
                    path_style,
                    region: cfg.region.clone(),
                },
                transport,
            );
            Ok(MountRoot {
                backend: Arc::new(backend),
                meta: MountMeta {
                    kind: "s3",
                    label: cfg.label.clone(),
                    // 展示面脱敏（评审 M1）；连接面（上方 backend）用原值
                    endpoint: display_endpoint(&endpoint),
                    bucket: Some(bucket),
                    prefix,
                },
            })
        }
        MountKind::WebDav => {
            let kind = "webdav";
            let endpoint = required(cfg.endpoint.clone(), "endpoint", kind)?;
            let username = required(cfg.username.clone(), "username", kind)?;
            let password = required(cfg.password.clone(), "password", kind)?;
            let prefix = cfg.prefix.clone().unwrap_or_default();
            let backend = WebDavBackend::new(
                WebDavMountConfig {
                    endpoint: endpoint.clone(),
                    prefix: prefix.clone(),
                    username,
                    password,
                },
                transport,
            );
            Ok(MountRoot {
                backend: Arc::new(backend),
                meta: MountMeta {
                    kind: "webdav",
                    label: cfg.label.clone(),
                    // 展示面脱敏（评审 M1）；连接面（上方 backend）用原值
                    endpoint: display_endpoint(&endpoint),
                    bucket: None,
                    prefix,
                },
            })
        }
    }
}

/// 运行时注册错误分类（handler 映射 HTTP 状态）：Invalid → 400（请求侧配置
/// 缺陷：缺必填字段，消息仅含字段名）；Transport → 500（服务端 HTTP 客户端
/// 初始化失败，非请求方可修复）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationError {
    Invalid(String),
    Transport(String),
}

/// 运行时删除错误分类：Static → 405（fs 根/静态 TOML 挂载不可删——该资源类
/// 不支持 DELETE，响应补 `Allow` 头）；NotFound → 404（运行时段越界或已删
/// tombstone 空洞）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnregisterError {
    Static,
    NotFound,
}

/// 运行时挂载项（spec §3）：`POST /api/mounts` 注册的内存态挂载，重启失效
/// （服务端无状态、凭据不落盘——spec 已拍板决策）。fingerprint 无凭据面，
/// Debug 派生安全。
#[derive(Debug)]
pub struct RuntimeMount {
    /// [`mount_fingerprint`] 规范化串：幂等对账键（同指纹重注册返回既有项）。
    pub fingerprint: String,
    /// 装配产物（backend + 脱敏 meta）——root 寻址与 GET 清单共用。
    pub root: MountRoot,
}

// ---------- 响应形态 ----------

/// 清单条目（脱敏面 = [`MountMeta`] 同源——health mounts 摘要消费同一结构；
/// capabilities 宣告 per-root 能力，挂载根恒 watch/search=false，spec §3）。
#[derive(Serialize, Clone)]
pub struct MountEntry {
    #[serde(rename = "rootIndex")]
    pub root_index: usize,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    pub prefix: String,
    pub capabilities: CapabilityFlags,
}

/// 能力位（watch/search）——与 storage crate [`MountCapabilities`] 的 HTTP 形态。
#[derive(Serialize, Clone)]
pub struct CapabilityFlags {
    pub watch: bool,
    pub search: bool,
}

impl MountEntry {
    fn new(root_index: usize, meta: &MountMeta, caps: MountCapabilities) -> Self {
        Self {
            root_index,
            kind: meta.kind,
            label: meta.label.clone(),
            endpoint: meta.endpoint.clone(),
            bucket: meta.bucket.clone(),
            prefix: meta.prefix.clone(),
            capabilities: CapabilityFlags { watch: caps.watch, search: caps.search },
        }
    }
}

/// GET /api/mounts 清单：凭据永不回显——条目结构面无凭据字段（spec §3/§6）。
#[derive(Serialize)]
pub struct MountsManifest {
    #[serde(rename = "fsRoots")]
    pub fs_roots: usize,
    #[serde(rename = "staticMounts")]
    pub static_mounts: Vec<MountEntry>,
    #[serde(rename = "runtimeMounts")]
    pub runtime_mounts: Vec<MountEntry>,
    /// 全量汇总（静态 + 运行时，rootIndex 升序）：前端对账的消费面。
    pub mounts: Vec<MountEntry>,
}

// ---------- 三 API 业务体 ----------

/// `POST /api/mounts`：注册运行时挂载 → 201 `{rootIndex}`；同指纹幂等命中既有
/// 项 → 200 `{rootIndex}`（不重复分配——spec §3 对账幂等）。
pub fn register(state: &CoreState, cfg: MountConfig) -> Result<CoreResponse, CoreError> {
    let (root_index, created) = state.register_mount(&cfg).map_err(|e| match e {
        RegistrationError::Invalid(msg) => CoreError::bad_request(msg),
        RegistrationError::Transport(msg) => CoreError::internal(msg),
    })?;
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    Ok(CoreResponse::json(status, &serde_json::json!({ "rootIndex": root_index })))
}

/// `GET /api/mounts`：静态 + 运行时脱敏清单（fsRoots 边界、static/runtime 分段、
/// 全量 mounts 汇总含 rootIndex 与 per-root 能力）。
pub fn manifest(state: &CoreState) -> CoreResponse {
    // 静态段：roots 里 mount: Some 的项，rootIndex = 其在 roots 的位置
    let static_mounts: Vec<MountEntry> = state
        .roots
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            r.mount.as_ref().map(|m| MountEntry::new(i, m, r.backend.capabilities()))
        })
        .collect();
    let (runtime_mounts, mounts) = {
        // 锁内只做克隆/构造（无 IO/await）；挂载根能力恒 {watch:false,
        // search:false}（S3/WebDAV 后端能力位）。tombstone 空洞（已删槽位）
        // 跳过——清单不含已删项，且条目 rootIndex 按槽位序保持原值不移位
        let guard = state.runtime_mounts.lock().unwrap();
        let runtime: Vec<MountEntry> = guard
            .iter()
            .enumerate()
            .filter_map(|(pos, rm)| {
                rm.as_ref().map(|rm| {
                    MountEntry::new(
                        state.roots.len() + pos,
                        &rm.root.meta,
                        rm.root.backend.capabilities(),
                    )
                })
            })
            .collect();
        let mut all = static_mounts.clone();
        all.extend(runtime.iter().cloned());
        (runtime, all)
    };
    CoreResponse::json(
        StatusCode::OK,
        &MountsManifest { fs_roots: state.fs_roots, static_mounts, runtime_mounts, mounts },
    )
}

/// `DELETE /api/mounts/{index}`：运行时项 204 + 槽位 tombstone（不压缩不移位，
/// 见 [`CoreState::unregister_mount`]）；静态项（fs 根/静态 TOML 挂载）405（该
/// 资源类不支持 DELETE——语义裁决记录任务报告；响应补 `Allow: GET, POST` 头，
/// RFC 9110 §15.5.5 对 405 的 MUST）；越界或已删 404。
pub fn unregister(state: &CoreState, index: usize) -> CoreResponse {
    match state.unregister_mount(index) {
        Ok(()) => CoreResponse {
            status: StatusCode::NO_CONTENT,
            headers: HeaderMap::new(),
            body: CoreBody::Full(bytes::Bytes::new()),
        },
        Err(UnregisterError::Static) => {
            let mut res = CoreResponse::json(
                StatusCode::METHOD_NOT_ALLOWED,
                &serde_json::json!({ "error": format!(
                    "root index {index} is a static root (fs root or config mount) and cannot be deleted"
                ) }),
            );
            res.headers
                .insert(header::ALLOW, HeaderValue::from_static("GET, POST"));
            res
        }
        Err(UnregisterError::NotFound) => CoreResponse::json(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": format!("no runtime mount at root index {index}") }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(kind: MountKind) -> MountConfig {
        MountConfig {
            kind,
            label: Some("docs".into()),
            endpoint: Some("http://127.0.0.1:9000".into()),
            bucket: Some("b1".into()),
            prefix: Some("sub".into()),
            access_key_id: Some("ak-value".into()),
            secret_access_key: Some("sk-value".into()),
            username: Some("user-value".into()),
            password: Some("pass-value".into()),
            path_style: Some(true),
            region: None,
        }
    }

    // ---------- C3：手工 Debug 字段清单同步锚 ----------

    const MOUNT_CONFIG_DEBUG_FIELDS: &[&str] = &[
        "kind", "label", "endpoint", "bucket", "prefix", "access_key_id",
        "secret_access_key", "username", "password", "path_style", "region",
    ];

    #[test]
    fn mount_config_debug_field_inventory_locked() {
        // ① 编译期字段全集锚
        let probe = cfg(MountKind::S3);
        assert_eq!(MOUNT_CONFIG_DEBUG_FIELDS.len(), 11);
        // ③ 脱敏面只遮值不遮名——凭据字段名必须在场
        let dbg = format!("{probe:?}");
        for name in MOUNT_CONFIG_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    const MOUNT_ROOT_DEBUG_FIELDS: &[&str] = &["meta"];

    #[test]
    fn mount_root_debug_field_inventory_locked() {
        use vviewer_storage::transport::MockTransport;
        // build_mount 通道构造（backend 为 dyn 无字面量形态）；断言面锚
        // 「meta 在场 + backend 故意不暴露 + non_exhaustive 标记在场」——
        // backend 的省略是 impl 注释的在案裁决，不得静默回归。
        let transport: std::sync::Arc<dyn HttpTransport> =
            std::sync::Arc::new(MockTransport::new());
        let root = build_mount(&cfg(MountKind::S3), transport).unwrap();
        let dbg = format!("{root:?}");
        assert_eq!(MOUNT_ROOT_DEBUG_FIELDS.len(), 1);
        for name in MOUNT_ROOT_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
        assert!(!dbg.contains("backend:"), "backend 不得经 Debug 暴露: {dbg}");
        // non_exhaustive 标记锚定结尾（实测形态 `MountRoot { meta: …, .. }`）：
        // contains("..") 在未来某字段值恰含 ".." 子串时假绿，ends_with 只认
        // finish_non_exhaustive 的收尾标记
        assert!(dbg.ends_with(".. }"), "non_exhaustive 标记须在场: {dbg}");
    }

    /// 指纹覆盖「同一挂载目标」面（kind/endpoint/bucket/prefix/label），不含
    /// 凭据：仅凭据不同的两份配置同指纹；目标字段逐一区分；指纹串本身无凭据值。
    #[test]
    fn fingerprint_covers_target_fields_not_credentials() {
        let base = mount_fingerprint(&cfg(MountKind::S3));

        // 仅凭据不同 → 同指纹（对账幂等的语义根基）
        let mut creds = cfg(MountKind::S3);
        creds.access_key_id = Some("other-ak".into());
        creds.secret_access_key = Some("other-sk".into());
        creds.username = Some("other-user".into());
        creds.password = Some("other-pass".into());
        assert_eq!(base, mount_fingerprint(&creds));

        // 指纹串不含凭据值/字段名（无凭据面）
        for leaked in ["ak-value", "sk-value", "pass-value", "access_key", "password"] {
            assert!(!base.contains(leaked), "leaked={leaked} fp={base:?}");
        }

        // 目标字段逐一区分（endpoint/bucket/prefix/label/kind）
        for (field, value) in [
            ("endpoint", "http://other:9000"),
            ("bucket", "b2"),
            ("prefix", "other"),
            ("label", "other"),
        ] {
            let mut m = cfg(MountKind::S3);
            match field {
                "endpoint" => m.endpoint = Some(value.into()),
                "bucket" => m.bucket = Some(value.into()),
                "prefix" => m.prefix = Some(value.into()),
                "label" => m.label = Some(value.into()),
                _ => unreachable!(),
            }
            assert_ne!(base, mount_fingerprint(&m), "field={field}");
        }
        assert_ne!(base, mount_fingerprint(&cfg(MountKind::WebDav)), "kind 区分");
    }

    /// 规范化：字段 trim 后拼接——空白差异不产生新指纹（前端持久化形态与请求
    /// 形态的意外空白不分裂对账键）。
    #[test]
    fn fingerprint_trims_whitespace() {
        let mut spaced = cfg(MountKind::S3);
        spaced.endpoint = Some("  http://127.0.0.1:9000 ".into());
        spaced.bucket = Some(" b1\t".into());
        spaced.prefix = Some(" sub ".into());
        spaced.label = Some(" docs ".into());
        assert_eq!(mount_fingerprint(&cfg(MountKind::S3)), mount_fingerprint(&spaced));
    }

    /// None 字段与空串同指纹（对账两侧「未配置」形态归一）。
    #[test]
    fn fingerprint_normalizes_none_to_empty() {
        let mut absent = cfg(MountKind::WebDav);
        absent.label = None;
        absent.prefix = None;
        let mut blank = cfg(MountKind::WebDav);
        blank.label = Some("".into());
        blank.prefix = Some("".into());
        assert_eq!(mount_fingerprint(&absent), mount_fingerprint(&blank));
    }

    /// 3-17：region 字段 serde 往返——TOML `[[mount]]`/VV_MOUNTS JSON/POST
    /// body 三通道同一反序列化形态：显式 region → Some；缺省 → None
    ///（deny_unknown_fields 下新增可选字段向后兼容，既有配置零漂移）。
    #[test]
    fn region_field_roundtrips_via_serde() {
        let with: MountConfig =
            serde_json::from_str(r#"{"kind":"s3","region":"eu-central-1"}"#).unwrap();
        assert_eq!(with.region.as_deref(), Some("eu-central-1"));
        let without: MountConfig = serde_json::from_str(r#"{"kind":"s3"}"#).unwrap();
        assert_eq!(without.region, None, "缺省 → None（None → us-east-1 现状）");
    }

    /// 3-17：Debug 面原样列出 region（非敏感解析参数，Global Constraints
    /// 脱敏口径裁决），凭据字段仍 [redacted]。
    #[test]
    fn region_lists_plain_in_debug() {
        let mut m = cfg(MountKind::S3);
        m.region = Some("eu-central-1".into());
        let dbg = format!("{m:?}");
        assert!(dbg.contains("eu-central-1"), "{dbg}");
        assert!(!dbg.contains("ak-value") && !dbg.contains("pass-value"), "{dbg}");
    }

    /// 3-17：指纹不含 region（裁决：region 是解析语义参数非身份面，对账幂等
    /// 语义不变——同 endpoint 换 region 不改对账键、不触发重注册，知情接受）。
    #[test]
    fn region_not_in_fingerprint() {
        let mut eu = cfg(MountKind::S3);
        eu.region = Some("eu-central-1".into());
        assert_eq!(mount_fingerprint(&cfg(MountKind::S3)), mount_fingerprint(&eu));
        assert!(
            !mount_fingerprint(&eu).contains("eu-central-1"),
            "指纹串不含 region 值：{fp}",
            fp = mount_fingerprint(&eu)
        );
    }
}
