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

use crate::ServeArgs;

/// CLI 与文件均未提供端口时的默认监听端口（与既有 clap 默认一致）。
pub const DEFAULT_PORT: u16 = 8321;

/// `[[mount]]` 节类型：阶段二下沉 lib（`vviewer::state`）——运行时注册
/// （POST /api/mounts）与静态 TOML 装配必须消费同一形态与同一后端构造
/// （`build_mount`），此处 re-export 供 FileConfig 与 main.rs 消费
/// （`MountKind` 随 build_mount 下沉，bin 侧不再直接使用）。
pub use vviewer::state::MountConfig;

/// 配置文件全参面：字段名即 TOML 键名（spec §2.1 示例块一一对应）。
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
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
    /// TOML 键为 `[[mount]]`（单数）；结构体字段按任务接口契约命名 `mounts`。
    #[serde(default, rename = "mount")]
    pub mounts: Vec<MountConfig>,
}

/// 合并产物：各字段为「CLI 显式值优先、文件补默认」后的最终值，直接喂给既有启动
/// 校验链与 serve 流程；`mounts` 原样透传（Task 5 挂载接线前仅承载不消费）。
#[derive(Debug, Clone, PartialEq)]
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
    /// 挂载配置原样透传（main.rs 装配链经后端构造消费——per-kind 必填校验在
    /// `build_mount`，Debug 面脱敏见 [`MountConfig`]）。
    pub mounts: Vec<MountConfig>,
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
        mounts: file.mounts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serve;
    use std::path::Path;
    use vviewer::state::MountKind;

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

    #[test]
    fn no_file_resolves_to_cli_untouched() {
        // 行为契约：无 --config 时零变化
        let r = resolve_config(cli(&["/only"]), None).unwrap();
        assert_eq!(r.root, vec![PathBuf::from("/only")]);
        assert_eq!(r.port, DEFAULT_PORT);
        assert_eq!(r.token, None);
        assert!(!r.allow_lan && !r.hidden && !r.compute && !r.token_gen);
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
        };
        let dbg = format!("{m:?}");
        assert!(!dbg.contains("AKIAEXAMPLE"), "{dbg}");
        assert!(!dbg.contains("TOPSECRET-VALUE"), "{dbg}");
        assert!(!dbg.contains("PLAINPASS"), "{dbg}");
        assert_eq!(dbg.matches("[redacted]").count(), 3, "{dbg}");
        assert!(dbg.contains("https://s3.example.com"), "非敏感字段原样: {dbg}");
        assert!(dbg.contains("Some(\"sub\")"), "存在性保留: {dbg}");

        // FileConfig / ResolvedConfig 嵌套 Debug 走同一手工实现
        let mut f = FileConfig::default();
        f.mounts = vec![m];
        assert!(!format!("{f:?}").contains("TOPSECRET-VALUE"));
        let r = resolve_config(cli(&["/c1"]), Some(f)).unwrap();
        assert!(!format!("{r:?}").contains("TOPSECRET-VALUE"));
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
}
