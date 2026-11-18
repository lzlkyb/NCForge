//! 字段观察点（watchpoint）的协议形状：下发规格与请求参数。
//!
//! 从 `debug.rs` 拆出：断点（文件 + 行）与观察点（类 + 字段）是两套 DAP 请求，
//! 挤在一个文件里两边都看不清，且观察点这边有自己的适配器判据（见下）。
//!
//! 🔴 全部判据来自 java-debug 0.32.0 反编译（2026-11-18，jar 在
//! `resources/jdtls/java-debug/`）：
//! - dataId 形状「类名#字段名」：`SetDataBreakpointsRequestHandler` 按 `split("#")`
//!   解析，必须两段非空；`DataBreakpointInfoRequestHandler` 用
//!   `String.format("%s#%s", referenceType.name(), fieldName)` 生成——
//!   **类名是对象的运行时类型**，子类实例的字段也可能声明在父类，所以 dataId
//!   只能问适配器要，前端不本地拼；
//! - `dataBreakpointInfo` 只认能解析到 ObjectReference 的引用：局部变量
//!   （StackFrameReference）与 <= 0 直接报错；
//! - accessType 线格式 read / write / readWrite（`@SerializedName` 标注），
//!   `Watchpoint.createWatchpointRequests` 按 "read" / "readWrite" 字面量分派
//!   JDI 请求（其余一律只装 Modification）；
//! - hitCondition 与行断点同病：`Integer.parseInt` 失败静默按 0；
//! - `setDataBreakpoints` 的回报 `breakpoints` 与请求**逐项同序**
//!   （`Types$Breakpoint` 上没有 dataId 字段）——所以参数构造一条都不能丢。

use serde_json::{json, Value};

/// 字段观察点的访问类型（DAP 线格式）。
pub const DATA_BP_ACCESS_TYPES: [&str; 3] = ["read", "write", "readWrite"];

/// 一个字段观察点（watchpoint）。`data_id` 只能来自 `dataBreakpointInfo` 的回报。
///
/// `condition` / `hitCondition` 与行断点同一套触发语义：条件在**命中时**才编译
/// （语法错误没有保存期反馈，前端按 `breakpointCondition.ts` 静态校验）；
/// hitCondition 只认正整数，`>=5` / `%5` 会被适配器静默按 0 处理。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBreakpointSpec {
    pub data_id: String,
    #[serde(default)]
    pub access_type: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub hit_condition: Option<String>,
}

/// `dataBreakpointInfo`：暂停时问适配器「这个字段能不能设观察点」。
///
/// `variables_reference` 必须解析到 ObjectReference（0.32.0 实测）：
/// 局部变量（StackFrameReference）与 <= 0 的引用直接报错，所以入口只开在
/// 「已展开对象的字段行」上。字段不存在同样报错。frameId 不给：
/// 适配器按当前暂停帧解析引用。
pub fn data_breakpoint_info_args(variables_reference: i64, name: &str) -> Value {
    json!({ "variablesReference": variables_reference, "name": name })
}

/// `setDataBreakpoints`：整批下发字段观察点（空数组 = 全部清掉）。
///
/// 🔴 响应回映射：适配器回报的 `breakpoints` 数组与请求**逐项同序**，
/// 前端按位置把 verified 映射回条目。所以这里一条都不能丢、不能重排——
/// 与行断点不同，Rust 侧不做任何过滤。非法 accessType 就地归一为
/// readWrite（DAP 默认值），保持数组长度与顺序。
pub fn data_breakpoints_args(breakpoints: &[DataBreakpointSpec]) -> Value {
    let items: Vec<Value> = breakpoints
        .iter()
        .map(|b| {
            let access = b
                .access_type
                .as_deref()
                .map(str::trim)
                .filter(|a| DATA_BP_ACCESS_TYPES.contains(a))
                .unwrap_or("readWrite");
            let mut item = json!({ "dataId": b.data_id, "accessType": access });
            // 空白条件不能下发：会变成恒假表达式（与行断点同一判据）
            if let Some(c) = b
                .condition
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
            {
                item["condition"] = json!(c);
            }
            if let Some(h) = b
                .hit_condition
                .as_deref()
                .map(str::trim)
                .filter(|h| !h.is_empty())
            {
                item["hitCondition"] = json!(h);
            }
            item
        })
        .collect();
    json!({ "breakpoints": items })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 字段观察点参数与回映射契约() {
        // dataBreakpointInfo：只发引用与字段名
        let info = data_breakpoint_info_args(42, "total");
        assert_eq!(info, json!({ "variablesReference": 42, "name": "total" }));

        // setDataBreakpoints：一条不能丢、顺序不能变（响应按位回映射 verified）
        let bps = data_breakpoints_args(&[
            DataBreakpointSpec {
                data_id: "nc.ui.pubapp.Caps#total".into(),
                access_type: Some("readWrite".into()),
                condition: Some("  total > 0  ".into()),
                hit_condition: Some("5".into()),
            },
            DataBreakpointSpec {
                data_id: "nc.vo.PubVO#pk".into(),
                access_type: Some("write".into()),
                ..Default::default()
            },
        ]);
        let list = bps["breakpoints"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["dataId"], "nc.ui.pubapp.Caps#total");
        assert_eq!(list[0]["accessType"], "readWrite");
        assert_eq!(list[0]["condition"], "total > 0");
        assert_eq!(list[0]["hitCondition"], "5");
        assert_eq!(list[1]["dataId"], "nc.vo.PubVO#pk");
        assert_eq!(list[1]["accessType"], "write");
        assert!(list[1].get("condition").is_none());
        assert!(list[1].get("hitCondition").is_none());
        // 空白条件不下发（恒假表达式）；非法 accessType 归一为 readWrite 但不减少条目
        let messy = data_breakpoints_args(&[
            DataBreakpointSpec {
                data_id: "A#b".into(),
                access_type: Some("READWRITE".into()),
                condition: Some("   ".into()),
                ..Default::default()
            },
            DataBreakpointSpec {
                data_id: "A#c".into(),
                access_type: None,
                ..Default::default()
            },
        ]);
        let messy = messy["breakpoints"].as_array().unwrap();
        assert_eq!(messy.len(), 2);
        assert!(messy[0].get("condition").is_none());
        assert_eq!(messy[0]["accessType"], "readWrite");
        assert_eq!(messy[1]["accessType"], "readWrite");
        // 空数组 = 清空全部观察点
        assert_eq!(data_breakpoints_args(&[])["breakpoints"], json!([]));
    }
}
