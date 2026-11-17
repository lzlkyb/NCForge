//! 跨 IPC 的结构化错误。
//!
//! ## 为什么不用 `String`
//!
//! 后端一直返 `Result<T, String>`，前端能拿到的只有一串英文原文。由此长出三个问题：
//!
//! 1. **语义只能靠猜**：`friendlyError.ts` 里那十几条正则（`os error 5` →
//!    「没有权限」）不是因为喜欢正则，是因为拿不到任何结构化信息。
//! 2. **拼法不稳定**：同一个意思，不同命令写成 `failed to …` / `… 失败` / `cannot …`，
//!    正则每加一条都只能覆盖一部分。
//! 3. **分不清轻重**：用户路径写错（改一下就能成）和我们自己的不变量被破坏，
//!    在字符串里长得一样，无法决定「给人话」还是「该上报」。
//!
//! ## 约定
//!
//! **新命令一律返 `Result<T, AppError>`**，由 `scripts/check-error-contract.mjs` 拦。
//!
//! 存量 400 多处 `Result<_, String>` 不批量迁移：改一处签名就得改它的每个调用点，
//! 和建立错误契约不是一件事，混在一起会让 diff 无法 review。基线只许减。
//!
//! ## `code` 的规矩
//!
//! `code` 是**契约**，前端按它查表出人话；`detail` 是**证据**，排障时看。
//! 所以：`code` 一旦发布就不要改字面值（改了等于改了契约），文案改动只动前端表。

use std::fmt;

/// 错误的性质。决定前端怎么呈现，以及要不要上报。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorClass {
    /// 用户输入/操作不对（路径非法、参数为空、缺配置）：改一下就能成功。
    Input,
    /// 本机环境（没权限、文件被占用、磁盘满、找不到文件）。
    Environment,
    /// 外部依赖没响应（服务没起、网络不通、超时）。
    Unavailable,
    /// 数据本身有问题（SQL 报错、格式损坏、校验不通过）。
    Data,
    /// 不该发生：不变量被破坏。看到这一类就是我们的 bug，不是用户的问题。
    Internal,
}

/// 一次调用失败的全部信息。
///
/// 序列化成 `{ code, class, detail, hint? }` 对象过 IPC。前端 `lib/ipcError.ts`
/// 会把它包成 `Error` 实例——**不能直接 throw 裸对象**，否则 `String(e)`
/// 变成 `[object Object]`，所有既有 `catch` 分支会一起失灵。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    /// 稳定标识，如 `io.notFound`、`diagnostics.empty`。不要写自然语言。
    pub code: &'static str,
    pub class: ErrorClass,
    /// 原始详情：系统原文、具体路径、失败的那一步。排障看这个。
    pub detail: String,
    /// 可选的一句话建议。前端没有对应文案时才用它。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str, class: ErrorClass, detail: impl Into<String>) -> Self {
        Self {
            code,
            class,
            detail: detail.into(),
            hint: None,
        }
    }

    pub fn input(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Input, detail)
    }

    pub fn env(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Environment, detail)
    }

    pub fn unavailable(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Unavailable, detail)
    }

    pub fn data(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Data, detail)
    }

    pub fn internal(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Internal, detail)
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// 给 io 错误补一句「在做什么」，`code` / `class` 仍是 `From<io::Error>` 分流的
    /// 结果。
    ///
    /// 不用 `map_err(|e| format!("建日志目录失败: {e}"))`：那会把 `io.permissionDenied`
    /// 这类结构信息压成一句中文，前端又只能靠猜。前缀归 detail，分类归 code。
    pub fn io(what: &str, e: std::io::Error) -> Self {
        let mut err = Self::from(e);
        err.detail = format!("{what}: {}", err.detail);
        err
    }
}

/// `Display` 只输出 `detail`。
///
/// 这一条不是随手写的：`?` 在 `Result<_, AppError>` 链里不会调用 `Display`，
/// 但 `log::warn!("{e}")`、`format!` 会。若把 code 也拼进去，日志里每条错误
/// 都多一段 `[io.notFound]`，读起来更费劲——code 是给机器查表用的，不是给人读的。
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for AppError {}

/// `?` 直接吃 `io::Error`。类目按 `ErrorKind` 分，前端因此能对「没权限 / 文件被占 /
/// 磁盘满」给出不同建议，而不是笼统一句「操作失败」。
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let (code, class) = match e.kind() {
            ErrorKind::NotFound => ("io.notFound", ErrorClass::Environment),
            ErrorKind::PermissionDenied => ("io.permissionDenied", ErrorClass::Environment),
            ErrorKind::AlreadyExists => ("io.alreadyExists", ErrorClass::Input),
            ErrorKind::TimedOut => ("io.timeout", ErrorClass::Unavailable),
            ErrorKind::InvalidInput => ("io.invalidInput", ErrorClass::Input),
            // 其余（磁盘满、被占用、网络盘掉线）都归环境：用户能处理，但不是他填错了
            _ => ("io", ErrorClass::Environment),
        };
        Self::new(code, class, e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 过 IPC 的形态是**对象**。写成字符串就退化成老样子，前端白改。
    #[test]
    fn 序列化成对象且字段名是驼峰() {
        let e = AppError::input("diagnostics.empty", "没有勾选任何内容").with_hint("至少勾一项");
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "diagnostics.empty");
        assert_eq!(json["class"], "input");
        assert_eq!(json["detail"], "没有勾选任何内容");
        assert_eq!(json["hint"], "至少勾一项");
    }

    /// 没有建议时不要留 `"hint": null`：前端判 `if (hint)` 与判 `!= null` 是两种写法，
    /// 少一个键就少一次歧义。
    #[test]
    fn 没有建议时字段整个消失() {
        let json = serde_json::to_value(AppError::env("io.notFound", "x")).unwrap();
        assert!(json.get("hint").is_none(), "实测 {json}");
    }

    /// `Display` 只给 detail：日志里不该出现给人看的 code 前缀。
    #[test]
    fn 展示只输出详情() {
        let e = AppError::data("db.syntax", "ORA-00933: SQL 命令未正确结束");
        assert_eq!(e.to_string(), "ORA-00933: SQL 命令未正确结束");
        assert!(!e.to_string().contains("db.syntax"));
    }

    /// `?` 能把 io 错误按 kind 分流——这是「结构化」相对于字符串的唯一实际收益，
    /// 不验等于没做。
    #[test]
    fn io错误按类型分流() {
        let nf: AppError = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file").into();
        assert_eq!(nf.code, "io.notFound");
        assert_eq!(nf.class, ErrorClass::Environment);

        let denied: AppError =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied").into();
        assert_eq!(denied.code, "io.permissionDenied");

        // 已存在是**用户输入问题**（换个名字就行），不是环境问题
        let exists: AppError =
            std::io::Error::new(std::io::ErrorKind::AlreadyExists, "exists").into();
        assert_eq!(exists.class, ErrorClass::Input);
    }

    /// 兜底分支也要有 code：返回空串会让前端查表落空又不报错。
    #[test]
    fn 未归类的io错误仍有稳定code() {
        let other: AppError =
            std::io::Error::new(std::io::ErrorKind::WouldBlock, "would block").into();
        assert_eq!(other.code, "io");
        assert_eq!(other.class, ErrorClass::Environment);
        assert!(!other.detail.is_empty(), "详情不能丢，排障全靠它");
    }
}
