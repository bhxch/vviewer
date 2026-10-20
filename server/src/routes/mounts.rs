//! 阶段二运行时挂载三 API（spec §3）：POST/GET/DELETE /api/mounts。
//!
//! 鉴权口径（spec §3 字面，台账裁决）：与 tree/file 同一 Bearer 中间件组——
//! **有 token 时需 Bearer；无 token 部署免鉴权**。⚠ 风险注记：无 token 部署
//! （LAN 信任模型）下本组是写面（注册/删除内存态挂载），同网段未认证对端可
//! 调用——按 spec 字面实现、不另设门，风险在任务报告显著记录。
//!
//! 脱敏：GET 清单与 health mounts 摘要同源（[`MountMeta`] 结构面即无凭据字段，
//! endpoint 已在构造期剥 userinfo）；凭据三不纪律的 GET/错误/日志三面由
//! [`crate::state::build_mount`] 错误消息（仅字段名）、本模块无 body 打印、
//! tracing 仅记请求行共同保证。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use vviewer_storage::MountCapabilities;

use crate::error::AppError;
use crate::state::{AppState, MountConfig, MountMeta, RegistrationError, UnregisterError};

/// POST /api/mounts：注册运行时挂载 → 201 `{rootIndex}`；同指纹幂等命中既有项
/// → 200 `{rootIndex}`（不重复分配——spec §3 对账幂等）。
pub async fn register(
    State(state): State<AppState>,
    Json(cfg): Json<MountConfig>,
) -> Result<Response, AppError> {
    let (root_index, created) = state.register_mount(&cfg).map_err(|e| match e {
        RegistrationError::Invalid(msg) => AppError::bad_request(msg),
        RegistrationError::Transport(msg) => AppError::internal(msg),
    })?;
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    Ok((status, Json(serde_json::json!({ "rootIndex": root_index }))).into_response())
}

/// GET /api/mounts：静态 + 运行时脱敏清单（fsRoots 边界、static/runtime 分段、
/// 全量 mounts 汇总含 rootIndex 与 per-root 能力）。
pub async fn manifest(State(state): State<AppState>) -> Json<MountsManifest> {
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
        // search:false}（S3/WebDAV 后端能力位）
        let guard = state.runtime_mounts.lock().unwrap();
        let runtime: Vec<MountEntry> = guard
            .iter()
            .enumerate()
            .map(|(pos, rm)| {
                MountEntry::new(
                    state.roots.len() + pos,
                    &rm.root.meta,
                    rm.root.backend.capabilities(),
                )
            })
            .collect();
        let mut all = static_mounts.clone();
        all.extend(runtime.iter().cloned());
        (runtime, all)
    };
    Json(MountsManifest { fs_roots: state.fs_roots, static_mounts, runtime_mounts, mounts })
}

/// DELETE /api/mounts/:index：运行时项 204 + 移除；静态项（fs 根/静态 TOML
/// 挂载）405（该资源类不支持 DELETE——语义裁决记录任务报告）；越界 404。
pub async fn remove(
    State(state): State<AppState>,
    Path(index): Path<usize>,
) -> Result<StatusCode, AppError> {
    match state.unregister_mount(index) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(UnregisterError::Static) => Err(AppError(
            StatusCode::METHOD_NOT_ALLOWED,
            format!(
                "root index {index} is a static root (fs root or config mount) and cannot be deleted"
            ),
        )),
        Err(UnregisterError::NotFound) => Err(AppError::not_found(format!(
            "no runtime mount at root index {index}"
        ))),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{mount_fingerprint, MountKind};

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
        }
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
}
