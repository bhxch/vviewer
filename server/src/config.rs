//! `--config` TOML 全参配置文件：解析、合并与优先级语义（spec 2026-10-19 §2.1）。
//!
//! - 优先级 CLI > 文件：文件提供默认值，CLI 显式值覆盖；`--root` 整体替换不合并。
//! - `--token-gen` 不进配置（动作型参数非配置值）；文件 token 与之共存时，合并产物
//!   保留文件 token，serve 阶段按覆盖语义生成新 token（既有行为，零改动）。
//! - 未知键一律报错（`deny_unknown_fields`，顶层与 `[[mount]]` 节均适用）：拼错静默
//!   忽略是安全反模式（`token` 误拼致无鉴权裸奔启动）。
//!
//! 本模块只做解析与合并；合并产物由 main.rs 喂给既有启动校验链（校验链零改动，
//! 仅数据来源多一路）。

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::assembly::ServeArgs;

/// CLI 与文件均未提供端口时的默认监听端口（与既有 clap 默认一致）。
pub const DEFAULT_PORT: u16 = 8321;

/// `[[mount]]` 节类型：阶段二下沉 lib（`vviewer::state`）——运行时注册
/// （POST /api/mounts）与静态 TOML 装配必须消费同一形态与同一后端构造
/// （`build_mount`），此处 re-export 供 FileConfig 与 assembly 装配链消费
/// （`MountKind` 随 build_mount 下沉，bin 侧不再直接使用）。
pub use crate::state::MountConfig;

/// TOML `[kroki]` 节（spec 2026-10-23 §8.2）：kroki 转发上游配置（可选节）。
/// `deny_unknown_fields` 与顶层同款纪律——拼错静默忽略是安全反模式。
#[derive(Clone, PartialEq, Default, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KrokiSection {
    /// kroki 上游 host（如 `https://kroki.io`）。合法性（非空 + http(s)://
    /// 前缀）在启动校验链统一裁决——非法 fail-closed（exit 2），与 CLI 通道
    /// 同一规则（SSRF 防线：host 只来自部署侧配置）。
    pub host: Option<String>,
}

/// 配置文件全参面：字段名即 TOML 键名（spec §2.1 示例块一一对应）。
#[derive(Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileConfig {
    #[serde(default)]
    pub root: Vec<String>,
    pub web_dist: Option<String>,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub allow_lan: Option<bool>,
    pub hidden: Option<bool>,
    pub cors_origin: Option<String>,
    pub compute: Option<bool>,
    pub log_file: Option<String>,
    /// TOML `[kroki]` 节（spec 2026-10-23 §8.2）：kroki 转发上游（可选）。
    pub kroki: Option<KrokiSection>,
    /// TOML 键为 `[[mount]]`（单数）；结构体字段按任务接口契约命名 `mounts`。
    #[serde(default, rename = "mount")]
    pub mounts: Vec<MountConfig>,
}

// 台账 1-1：token 明文不得经 Debug 外泄（日志/panic 消息面），存在性标记
// （Some("[redacted]")/None）保留供排障；其余字段原样。嵌套凭据由
// [`MountConfig`] 的手工 Debug 脱敏（姊妹实现，锁测互为邻位）。
impl std::fmt::Debug for FileConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileConfig")
            .field("root", &self.root)
            .field("web_dist", &self.web_dist)
            .field("port", &self.port)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field("allow_lan", &self.allow_lan)
            .field("hidden", &self.hidden)
            .field("cors_origin", &self.cors_origin)
            .field("compute", &self.compute)
            .field("log_file", &self.log_file)
            .field("kroki", &self.kroki)
            .field("mounts", &self.mounts)
            .finish()
    }
}

/// 合并产物：各字段为「CLI 显式值优先、文件补默认」后的最终值，直接喂给既有启动
/// 校验链与 serve 流程；`mounts` 原样透传（Task 5 挂载接线前仅承载不消费）。
#[derive(Clone, PartialEq)]
pub struct ResolvedConfig {
    pub root: Vec<PathBuf>,
    pub web_dist: Option<PathBuf>,
    pub port: u16,
    pub token: Option<String>,
    pub token_gen: bool,
    pub allow_lan: bool,
    pub hidden: bool,
    pub cors_origin: Option<String>,
    pub compute: bool,
    pub log_file: Option<PathBuf>,
    /// kroki 转发上游 host（spec 2026-10-23 §8.2）：合并已补 core 缺省
    /// （DEFAULT_KROKI_HOST）——进 serve 前恒为非空串，合法性由启动校验链裁决。
    pub kroki_host: String,
    /// 挂载配置原样透传（assembly 装配链经后端构造消费——per-kind 必填校验在
    /// `build_mount`，Debug 面脱敏见 [`MountConfig`]）。
    pub mounts: Vec<MountConfig>,
}

// 台账 1-1：同 [`FileConfig`] 的脱敏纪律——token 存在性标记保留，其余原样。
impl std::fmt::Debug for ResolvedConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedConfig")
            .field("root", &self.root)
            .field("web_dist", &self.web_dist)
            .field("port", &self.port)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field("token_gen", &self.token_gen)
            .field("allow_lan", &self.allow_lan)
            .field("hidden", &self.hidden)
            .field("cors_origin", &self.cors_origin)
            .field("compute", &self.compute)
            .field("log_file", &self.log_file)
            .field("kroki_host", &self.kroki_host)
            .field("mounts", &self.mounts)
            .finish()
    }
}

impl From<ResolvedConfig> for ServeArgs {
    fn from(r: ResolvedConfig) -> Self {
        ServeArgs {
            root: r.root,
            web_dist: r.web_dist,
            // 合并已补默认（DEFAULT_PORT），进 serve 前恒为 Some
            port: Some(r.port),
            token: r.token,
            token_gen: r.token_gen,
            allow_lan: r.allow_lan,
            hidden: r.hidden,
            cors_origin: r.cors_origin,
            compute: r.compute,
            log_file: r.log_file,
            // 合并已补 core 缺省（DEFAULT_KROKI_HOST），进 serve 前恒为 Some
            kroki_host: Some(r.kroki_host),
        }
    }
}

/// 读取并解析 `--config` 指向的 TOML 文件。
///
/// 错误消息含文件路径；未知键 / 类型不符 / 语法错误均在此拒绝（toml 错误自带
/// 行号与键名片段）。空文件合法（= 全默认）。
pub fn load_file_config(path: &Path) -> Result<FileConfig, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read --config {}: {e}", path.display()))?;
    toml::from_str(&text).map_err(|e| format!("failed to parse --config {}: {e}", path.display()))
}

/// 合并 CLI 参数与配置文件（纯函数）：优先级 CLI > 文件（spec §2.1）。
///
/// - `--root` 整体替换：CLI 出现任一根即整体忽略文件 `root` 数组，不合并。
/// - 布尔开关（allow_lan/hidden/compute）CLI 为 SetTrue 语义、无显式 false 通道，
///   与文件值按 OR 合并（文件 true + CLI 未给 = true）。
/// - `token_gen` 不参与合并（动作型参数），原样透传。
///
/// 返回 `Result` 为任务接口契约（Task 5 挂载接线后合并期可产出错误）；
/// 本任务纯合并不产 `Err`。
pub fn resolve_config(cli: ServeArgs, file: Option<FileConfig>) -> Result<ResolvedConfig, String> {
    let file = file.unwrap_or_default();
    // --root 整体替换：CLI 出现任一根即整体忽略文件 root 数组，不合并（spec §2.1）
    let root = if cli.root.is_empty() {
        file.root.into_iter().map(PathBuf::from).collect()
    } else {
        cli.root
    };
    Ok(ResolvedConfig {
        root,
        web_dist: cli.web_dist.or(file.web_dist.map(PathBuf::from)),
        port: cli.port.or(file.port).unwrap_or(DEFAULT_PORT),
        token: cli.token.or(file.token),
        token_gen: cli.token_gen,
        allow_lan: cli.allow_lan || file.allow_lan.unwrap_or(false),
        hidden: cli.hidden || file.hidden.unwrap_or(false),
        cors_origin: cli.cors_origin.or(file.cors_origin),
        compute: cli.compute || file.compute.unwrap_or(false),
        log_file: cli.log_file.or(file.log_file.map(PathBuf::from)),
        // kroki 上游 host（spec 2026-10-23 §8.2）：优先级 CLI > 文件 > core 缺省
        kroki_host: cli
            .kroki_host
            .or(file.kroki.and_then(|k| k.host))
            .unwrap_or_else(|| vviewer_core::kroki::DEFAULT_KROKI_HOST.to_string()),
        mounts: file.mounts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::serve;
    use std::path::Path;
    use crate::state::MountKind;

    /// 经临时文件走 load_file_config 真实路径（tempfile 先例）。
    fn load_from_str(text: &str) -> Result<FileConfig, String> {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("config.toml");
        std::fs::write(&path, text).expect("write config");
        load_file_config(&path)
    }

    /// resolve 直测的文件侧输入：字面构造，不经文件 IO。
    fn file_cfg(f: impl FnOnce(&mut FileConfig)) -> FileConfig {
        let mut c = FileConfig::default();
        f(&mut c);
        c
    }

    fn cli(root: &[&str]) -> ServeArgs {
        ServeArgs {
            root: root.iter().map(PathBuf::from).collect(),
            web_dist: None,
            port: None,
            token: None,
            token_gen: false,
            allow_lan: false,
            hidden: false,
            cors_origin: None,
            compute: false,
            log_file: None,
            kroki_host: None,
        }
    }

    // ---------- 解析（全参数 / 未知键 / 类型 / 空 / 缺失） ----------

    #[test]
    fn full_params_parse() {
        let cfg = load_from_str(
            r#"
root = ["/data/docs", "/data/books"]
web_dist = "./dist"
port = 9000
token = "sekret"
allow_lan = true
hidden = true
cors_origin = "https://a.example.com"
compute = true
log_file = "./vviewer.log"

[kroki]
host = "https://kroki.internal.example.com"

[[mount]]
kind = "s3"
label = "docs"
endpoint = "http://127.0.0.1:9000"
bucket = "b1"
prefix = "sub"
access_key_id = "ak"
secret_access_key = "sk"
path_style = true

[[mount]]
kind = "webdav"
endpoint = "https://dav.example.com"
username = "u"
password = "p"
"#,
        )
        .unwrap();
        assert_eq!(cfg.root, vec!["/data/docs", "/data/books"]);
        assert_eq!(cfg.web_dist.as_deref(), Some("./dist"));
        assert_eq!(cfg.port, Some(9000));
        assert_eq!(cfg.token.as_deref(), Some("sekret"));
        assert_eq!(cfg.allow_lan, Some(true));
        assert_eq!(cfg.hidden, Some(true));
        assert_eq!(cfg.cors_origin.as_deref(), Some("https://a.example.com"));
        assert_eq!(cfg.compute, Some(true));
        assert_eq!(cfg.log_file.as_deref(), Some("./vviewer.log"));
        assert_eq!(
            cfg.kroki.as_ref().and_then(|k| k.host.as_deref()),
            Some("https://kroki.internal.example.com")
        );
        assert_eq!(cfg.mounts.len(), 2);
        assert_eq!(cfg.mounts[0].kind, MountKind::S3);
        assert_eq!(cfg.mounts[0].label.as_deref(), Some("docs"));
        assert_eq!(cfg.mounts[0].bucket.as_deref(), Some("b1"));
        assert_eq!(cfg.mounts[0].prefix.as_deref(), Some("sub"));
        assert_eq!(cfg.mounts[0].access_key_id.as_deref(), Some("ak"));
        assert_eq!(cfg.mounts[0].secret_access_key.as_deref(), Some("sk"));
        assert_eq!(cfg.mounts[0].path_style, Some(true));
        assert_eq!(cfg.mounts[1].kind, MountKind::WebDav);
        assert_eq!(cfg.mounts[1].username.as_deref(), Some("u"));
        assert_eq!(cfg.mounts[1].password.as_deref(), Some("p"));
    }

    #[test]
    fn unknown_top_level_key_is_rejected_with_key_name() {
        // spec §2.1：未知键报错——拼错静默忽略是安全反模式（token 误拼致无鉴权裸奔）
        let err = load_from_str("tokn = \"x\"").unwrap_err();
        assert!(err.contains("unknown field"), "got: {err}");
        assert!(err.contains("tokn"), "error must name the key: {err}");
    }

    #[test]
    fn unknown_mount_key_is_rejected_with_key_name() {
        let err = load_from_str("[[mount]]\nkind = \"s3\"\nacces_key_id = \"x\"").unwrap_err();
        assert!(err.contains("unknown field"), "got: {err}");
        assert!(err.contains("acces_key_id"), "error must name the key: {err}");
    }

    #[test]
    fn type_error_surfaces_field_name() {
        let err = load_from_str("port = \"ninety\"").unwrap_err();
        assert!(err.contains("port"), "type error must surface the field: {err}");
    }

    #[test]
    fn mount_kind_is_typed_enum() {
        let err = load_from_str("[[mount]]\nkind = \"gs\"").unwrap_err();
        assert!(err.contains("gs"), "got: {err}");
        assert!(err.contains("s3"), "expected variants must be listed: {err}");
    }

    #[test]
    fn mount_kind_is_required() {
        let err = load_from_str("[[mount]]\nlabel = \"x\"").unwrap_err();
        assert!(err.contains("kind"), "got: {err}");
    }

    #[test]
    fn empty_file_is_all_defaults() {
        let cfg = load_from_str("").unwrap();
        assert_eq!(cfg, FileConfig::default());
    }

    #[test]
    fn missing_file_error_names_path() {
        let err = load_file_config(Path::new("/nonexistent/vviewer/nope.toml")).unwrap_err();
        assert!(err.contains("/nonexistent/vviewer/nope.toml"), "got: {err}");
    }

    #[test]
    fn malformed_toml_error_names_path() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("broken.toml");
        std::fs::write(&path, "port =").unwrap();
        let err = load_file_config(&path).unwrap_err();
        assert!(err.contains("broken.toml"), "got: {err}");
    }

    // ---------- 合并（CLI > 文件 优先级矩阵） ----------

    #[test]
    fn cli_root_replaces_file_root_entirely() {
        // spec §2.1：CLI 出现任一 --root 即忽略文件 root 数组，不合并
        let file = file_cfg(|c| c.root = vec!["/f1".into(), "/f2".into()]);
        let resolved = resolve_config(cli(&["/c1"]), Some(file)).unwrap();
        assert_eq!(resolved.root, vec![PathBuf::from("/c1")]);
    }

    #[test]
    fn file_root_used_when_cli_has_none() {
        let file = file_cfg(|c| c.root = vec!["/f1".into(), "/f2".into()]);
        let resolved = resolve_config(cli(&[]), Some(file)).unwrap();
        assert_eq!(
            resolved.root,
            vec![PathBuf::from("/f1"), PathBuf::from("/f2")]
        );
    }

    #[test]
    fn cli_token_overrides_file_token() {
        let file = file_cfg(|c| c.token = Some("file-tok".into()));
        let mut a = cli(&["/c1"]);
        a.token = Some("cli-tok".into());
        assert_eq!(
            resolve_config(a, Some(file)).unwrap().token.as_deref(),
            Some("cli-tok")
        );
    }

    #[test]
    fn file_token_used_when_cli_has_none() {
        let file = file_cfg(|c| c.token = Some("file-tok".into()));
        assert_eq!(
            resolve_config(cli(&["/c1"]), Some(file)).unwrap().token.as_deref(),
            Some("file-tok")
        );
    }

    #[test]
    fn cli_port_overrides_file_port() {
        let file = file_cfg(|c| c.port = Some(9000));
        let mut a = cli(&["/c1"]);
        a.port = Some(9999);
        assert_eq!(resolve_config(a, Some(file)).unwrap().port, 9999);
    }

    #[test]
    fn file_port_used_when_cli_has_none() {
        let file = file_cfg(|c| c.port = Some(9000));
        assert_eq!(resolve_config(cli(&["/c1"]), Some(file)).unwrap().port, 9000);
    }

    #[test]
    fn port_defaults_when_neither_side_provides() {
        assert_eq!(
            resolve_config(cli(&["/c1"]), None).unwrap().port,
            DEFAULT_PORT
        );
    }

    #[test]
    fn file_bool_flags_fill_cli_absence() {
        // SetTrue 语义无显式 false 通道：文件 true + CLI 未给 = true（OR 合并）
        let file = file_cfg(|c| {
            c.allow_lan = Some(true);
            c.hidden = Some(true);
            c.compute = Some(true);
        });
        let r = resolve_config(cli(&["/c1"]), Some(file)).unwrap();
        assert!(r.allow_lan && r.hidden && r.compute);
    }

    #[test]
    fn cli_bool_true_survives_file_false() {
        let file = file_cfg(|c| c.allow_lan = Some(false));
        let mut a = cli(&["/c1"]);
        a.allow_lan = true;
        assert!(resolve_config(a, Some(file)).unwrap().allow_lan);
    }

    #[test]
    fn path_options_prefer_cli_then_file() {
        let file = file_cfg(|c| {
            c.web_dist = Some("./f-dist".into());
            c.cors_origin = Some("https://f.example.com".into());
            c.log_file = Some("f.log".into());
        });
        let mut a = cli(&["/c1"]);
        a.web_dist = Some("/c-dist".into());
        let r = resolve_config(a, Some(file)).unwrap();
        assert_eq!(r.web_dist.as_deref(), Some(Path::new("/c-dist")));
        assert_eq!(r.cors_origin.as_deref(), Some("https://f.example.com"));
        assert_eq!(r.log_file, Some(PathBuf::from("f.log")));
    }

    // ---------- kroki host（spec 2026-10-23 §8.2）：优先级 CLI > 文件 > core 缺省 ----------

    #[test]
    fn cli_kroki_host_overrides_file_kroki_host() {
        let file = file_cfg(|c| {
            c.kroki = Some(KrokiSection { host: Some("https://file.example.com".into()) });
        });
        let mut a = cli(&["/c1"]);
        a.kroki_host = Some("https://cli.example.com".into());
        assert_eq!(
            resolve_config(a, Some(file)).unwrap().kroki_host,
            "https://cli.example.com"
        );
    }

    #[test]
    fn file_kroki_host_used_when_cli_has_none() {
        let file = file_cfg(|c| {
            c.kroki = Some(KrokiSection { host: Some("https://file.example.com".into()) });
        });
        assert_eq!(
            resolve_config(cli(&["/c1"]), Some(file)).unwrap().kroki_host,
            "https://file.example.com"
        );
    }

    #[test]
    fn kroki_host_defaults_when_neither_side_provides() {
        assert_eq!(
            resolve_config(cli(&["/c1"]), None).unwrap().kroki_host,
            vviewer_core::kroki::DEFAULT_KROKI_HOST
        );
    }

    #[test]
    fn unknown_kroki_section_key_is_rejected_with_key_name() {
        // [kroki] 节内未知键同顶层纪律（deny_unknown_fields 双层生效——拼错
        // 静默忽略会让部署侧 SSRF 防线 host 落回缺省而不自知）
        let err = load_from_str("[kroki]\nupstream = \"https://x\"").unwrap_err();
        assert!(err.contains("unknown field"), "got: {err}");
        assert!(err.contains("upstream"), "error must name the key: {err}");
    }

    #[test]
    fn no_file_resolves_to_cli_untouched() {
        // 行为契约：无 --config 时零变化
        let r = resolve_config(cli(&["/only"]), None).unwrap();
        assert_eq!(r.root, vec![PathBuf::from("/only")]);
        assert_eq!(r.port, DEFAULT_PORT);
        assert_eq!(r.token, None);
        assert!(!r.allow_lan && !r.hidden && !r.compute && !r.token_gen);
        assert_eq!(r.kroki_host, vviewer_core::kroki::DEFAULT_KROKI_HOST);
        assert!(r.mounts.is_empty());
    }

    #[test]
    fn token_gen_coexists_with_file_token() {
        // spec §2.1：--token-gen 不进配置（动作型参数）；文件 token 进合并产物，
        // serve 阶段 token_gen 动作按覆盖语义生成新 token（既有行为，未改）
        let file = file_cfg(|c| c.token = Some("file-tok".into()));
        let mut a = cli(&["/c1"]);
        a.token_gen = true;
        let r = resolve_config(a, Some(file)).unwrap();
        assert_eq!(r.token.as_deref(), Some("file-tok"));
        assert!(r.token_gen);
    }

    #[test]
    fn file_mounts_pass_through_resolution() {
        let file = file_cfg(|c| {
            c.mounts = vec![MountConfig {
                kind: MountKind::S3,
                label: Some("l".into()),
                endpoint: None,
                bucket: None,
                prefix: None,
                access_key_id: None,
                secret_access_key: None,
                username: None,
                password: None,
                path_style: None,
                region: None,
            }];
        });
        let r = resolve_config(cli(&["/c1"]), Some(file)).unwrap();
        assert_eq!(r.mounts.len(), 1);
        assert_eq!(r.mounts[0].kind, MountKind::S3);
    }

    /// 台账①（Task 3 评审 Major-1 先例同款）：MountConfig Debug 脱敏——凭据
    /// 不得经 FileConfig/ResolvedConfig 的嵌套 Debug 外泄，非敏感字段原样，
    /// 存在性（Some/None）保留供排障。
    #[test]
    fn mount_config_debug_redacts_credentials() {
        let m = MountConfig {
            kind: MountKind::S3,
            label: Some("l".into()),
            endpoint: Some("https://s3.example.com".into()),
            bucket: Some("b".into()),
            prefix: Some("sub".into()),
            access_key_id: Some("AKIAEXAMPLE".into()),
            secret_access_key: Some("TOPSECRET-VALUE".into()),
            username: None,
            password: Some("PLAINPASS".into()),
            path_style: Some(true),
            region: None,
        };
        let dbg = format!("{m:?}");
        assert!(!dbg.contains("AKIAEXAMPLE"), "{dbg}");
        assert!(!dbg.contains("TOPSECRET-VALUE"), "{dbg}");
        assert!(!dbg.contains("PLAINPASS"), "{dbg}");
        assert_eq!(dbg.matches("[redacted]").count(), 3, "{dbg}");
        assert!(dbg.contains("https://s3.example.com"), "非敏感字段原样: {dbg}");
        assert!(dbg.contains("Some(\"sub\")"), "存在性保留: {dbg}");

        // FileConfig / ResolvedConfig 嵌套 Debug 走同一手工实现
        let f = FileConfig { mounts: vec![m], ..Default::default() };
        assert!(!format!("{f:?}").contains("TOPSECRET-VALUE"));
        let r = resolve_config(cli(&["/c1"]), Some(f)).unwrap();
        assert!(!format!("{r:?}").contains("TOPSECRET-VALUE"));
    }

    /// 1-1：token 字段不得经任何配置结构 Debug 外泄（MountConfig 已脱敏的姊妹锚——
    /// 台账 deferred 1-1 的真实残留面）。
    #[test]
    fn token_is_redacted_in_all_config_debug_faces() {
        // 字面量构造（clippy field_reassign_with_default 零新增）；断言主体
        // 与简报逐字一致。
        let f = FileConfig { token: Some("TOPSECRET-TOKEN".into()), ..Default::default() };
        let dbg = format!("{f:?}");
        assert!(!dbg.contains("TOPSECRET-TOKEN"), "{dbg}");
        assert!(dbg.contains("[redacted]"), "存在性保留: {dbg}");

        let r = resolve_config(cli(&["/c1"]), Some(f)).unwrap();
        // resolve_config 不搬 token 以外的密值；此处直接构造断言
        let mut r2 = r.clone();
        r2.token = Some("TOPSECRET-TOKEN".into());
        assert!(!format!("{r2:?}").contains("TOPSECRET-TOKEN"));

        let args: ServeArgs = r2.into();
        // ServeArgs::from 透传 token；Debug 面同样脱敏
        let mut a = args;
        a.token = Some("TOPSECRET-TOKEN".into());
        assert!(!format!("{a:?}").contains("TOPSECRET-TOKEN"));
    }

    // ---------- C3：手工 Debug 字段清单同步锚（三道防线，见各常量注释） ----------

    const FILE_CONFIG_DEBUG_FIELDS: &[&str] = &[
        "root", "web_dist", "port", "token", "allow_lan",
        "hidden", "cors_origin", "compute", "log_file", "kroki", "mounts",
    ];

    #[test]
    fn file_config_debug_field_inventory_locked() {
        // ① 编译期字段全集锚（缺/多字段此字面量即编译失败）
        let probe = FileConfig {
            root: vec!["/tmp".into()],
            web_dist: Some("dist".into()),
            port: Some(1),
            token: Some("t".into()),
            allow_lan: Some(true),
            hidden: Some(true),
            cors_origin: Some("http://x".into()),
            compute: Some(true),
            log_file: Some("v.log".into()),
            kroki: None,
            mounts: Vec::new(),
        };
        assert_eq!(FILE_CONFIG_DEBUG_FIELDS.len(), 11);
        // ③ Debug 逐字段名（值选无字段名子串的形态，防误配）
        let dbg = format!("{probe:?}");
        for name in FILE_CONFIG_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    const RESOLVED_CONFIG_DEBUG_FIELDS: &[&str] = &[
        "root", "web_dist", "port", "token", "token_gen", "allow_lan",
        "hidden", "cors_origin", "compute", "log_file", "kroki_host", "mounts",
    ];

    #[test]
    fn resolved_config_debug_field_inventory_locked() {
        let probe = ResolvedConfig {
            root: vec!["/tmp".into()],
            web_dist: Some("dist".into()),
            port: 1,
            token: Some("t".into()),
            token_gen: true,
            allow_lan: true,
            hidden: true,
            cors_origin: Some("http://x".into()),
            compute: true,
            log_file: Some("v.log".into()),
            kroki_host: "https://kroki.io".into(),
            mounts: Vec::new(),
        };
        assert_eq!(RESOLVED_CONFIG_DEBUG_FIELDS.len(), 12);
        let dbg = format!("{probe:?}");
        for name in RESOLVED_CONFIG_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    const SERVE_ARGS_DEBUG_FIELDS: &[&str] = &[
        "root", "web_dist", "port", "token", "token_gen", "allow_lan",
        "hidden", "cors_origin", "compute", "log_file", "kroki_host",
    ];

    #[test]
    fn serve_args_debug_field_inventory_locked() {
        let probe = ServeArgs {
            root: vec!["/tmp".into()],
            web_dist: Some("dist".into()),
            port: Some(1),
            token: Some("t".into()),
            token_gen: true,
            allow_lan: true,
            hidden: true,
            cors_origin: Some("http://x".into()),
            compute: true,
            log_file: Some("v.log".into()),
            kroki_host: None,
        };
        assert_eq!(SERVE_ARGS_DEBUG_FIELDS.len(), 11);
        let dbg = format!("{probe:?}");
        for name in SERVE_ARGS_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    // ---------- 合并产物 → 既有启动校验链（校验链零改动，数据来源多一路） ----------

    #[test]
    fn file_allow_lan_without_token_rejected_via_chain() {
        let file = file_cfg(|c| c.allow_lan = Some(true));
        let a = cli(&["/tmp"]); // 根合法，隔离出 allow_lan 校验
        assert_eq!(serve(resolve_config(a, Some(file)).unwrap().into(), Vec::new()), Err(2));
    }

    #[test]
    fn file_cors_wildcard_rejected_via_chain() {
        let file = file_cfg(|c| c.cors_origin = Some("*".into()));
        let a = cli(&["/tmp"]);
        assert_eq!(serve(resolve_config(a, Some(file)).unwrap().into(), Vec::new()), Err(2));
    }

    #[test]
    fn empty_root_on_both_sides_rejected_via_chain() {
        let file = file_cfg(|c| c.root = vec![]);
        assert_eq!(
            serve(resolve_config(cli(&[]), Some(file)).unwrap().into(), Vec::new()),
            Err(2)
        );
    }

    #[test]
    fn file_kroki_host_invalid_rejected_via_chain() {
        // spec 2026-10-23 §8.2：TOML [kroki] host 与 CLI 共用启动校验链——
        // 非 http(s):// 前缀的 host 启动即拒（SSRF 防线 fail-closed）
        let file = file_cfg(|c| {
            c.kroki = Some(KrokiSection { host: Some("kroki.io".into()) });
        });
        let a = cli(&["/tmp"]);
        assert_eq!(
            serve(resolve_config(a, Some(file)).unwrap().into(), Vec::new()),
            Err(2)
        );
    }
}
