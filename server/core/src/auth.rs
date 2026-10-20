//! Bearer 鉴权原语（constant-time 比较，框架无关）：解析与判定语义自
//! 适配层 auth.rs 原样迁入——axum 中间件只保留头部提取与响应构造。

/// `Authorization: Bearer <t>`（scheme 大小写不敏感，RFC 7235）。
pub fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, rest) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(rest.trim())
}

/// 逐字节 OR 的 constant-time 比较：长度差异与逐字节差异都累积后统一判定，
/// 不因首个不同字节提前返回。
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

/// 鉴权判定：提供的 token 与期望值 constant-time 相等（原语义 = `ct_eq`）。
pub fn check(token: &str, expected: &str) -> bool {
    ct_eq(token.as_bytes(), expected.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_token_accepts_case_insensitive_scheme() {
        assert_eq!(bearer_token("Bearer abc"), Some("abc"));
        assert_eq!(bearer_token("bearer abc"), Some("abc"));
        assert_eq!(bearer_token("BEARER  abc "), Some("abc")); // trim 尾随空白
    }

    #[test]
    fn bearer_token_rejects_other_schemes_and_malformed() {
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token("Bearerabc"), None);
        assert_eq!(bearer_token(""), None);
    }

    #[test]
    fn ct_eq_equal_inputs() {
        assert!(ct_eq(b"secret", b"secret"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn ct_eq_differing_bytes_and_lengths() {
        assert!(!ct_eq(b"secret", b"secreT"));
        assert!(!ct_eq(b"secret", b"secre")); // 前缀长度差
        assert!(!ct_eq(b"", b"x"));
    }

    #[test]
    fn check_compares_full_strings_constant_time() {
        assert!(check("tok-1", "tok-1"));
        assert!(!check("tok-1", "tok-2"));
        assert!(!check("tok", "token"));
    }
}
