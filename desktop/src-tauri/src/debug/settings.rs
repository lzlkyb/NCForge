//! java-debug settings protocol and safe merging, independent of transport and Tauri.
use serde_json::{json, Value};

/// java-debug 0.32 exposes settings through its LSP delegate command, not DAP.
/// With no attach-specific filters, its contexts read these shared settings dynamically.
pub fn read_debug_settings_args() -> Value {
    json!({ "command": "vscode.java.updateDebugSettings", "arguments": [] })
}

fn debug_settings_value(reply: Value) -> Result<Value, String> {
    let settings = match reply {
        Value::String(text) => serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("步进过滤设置回复无效：{e}"))?,
        value => value,
    };
    if !settings.is_object() {
        return Err("调试器未返回当前完整设置，未覆盖任何设置".into());
    }
    Ok(settings)
}

pub fn update_step_filters_args(current: Value, filters: &[String]) -> Result<Value, String> {
    let mut settings = debug_settings_value(current)?;
    // 0.32 replaces the complete settings object, then configures logLevel. A partial
    // object both resets unrelated options and fails with -32001 when logLevel is absent.
    if settings["logLevel"]
        .as_str()
        .is_none_or(|level| level.is_empty())
    {
        settings["logLevel"] = json!("WARNING");
    }
    if !settings["stepFilters"].is_object() {
        settings["stepFilters"] = json!({});
    }
    settings["stepFilters"]["skipClasses"] = json!(filters);
    settings["stepFilters"]["skipSynthetics"] = json!(true);
    settings["stepFilters"]["skipStaticInitializers"] = json!(true);
    settings["stepFilters"]["skipConstructors"] = json!(false);
    Ok(json!({ "command": "vscode.java.updateDebugSettings", "arguments": [settings.to_string()] }))
}

pub fn verify_step_filters_reply(reply: Value, filters: &[String]) -> Result<Value, String> {
    let settings = debug_settings_value(reply)?;
    let applied = &settings["stepFilters"];
    if applied["skipClasses"] != json!(filters)
        || applied["skipSynthetics"] != true
        || applied["skipStaticInitializers"] != true
        || applied["skipConstructors"] != false
    {
        return Err("调试器未确认应用步进过滤规则，请检查 java-debug 版本".into());
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_filters_require_actual_settings_confirmation() {
        let filters = vec!["Helper".into(), "java.*".into()];
        let args = update_step_filters_args(
            json!({ "maxStringLength": 2048, "showHex": true }),
            &filters,
        )
        .unwrap();
        let reply = args["arguments"][0].clone();
        let settings = verify_step_filters_reply(reply, &filters).unwrap();
        assert_eq!(settings["maxStringLength"], 2048);
        assert_eq!(settings["showHex"], true);
        assert_eq!(settings["logLevel"], "WARNING");
        let existing = update_step_filters_args(
            json!({ "logLevel": "INFO", "stepFilters": { "allowClasses": ["demo.*"] } }),
            &filters,
        )
        .unwrap();
        let preserved =
            verify_step_filters_reply(existing["arguments"][0].clone(), &filters).unwrap();
        assert_eq!(preserved["logLevel"], "INFO");
        assert_eq!(preserved["stepFilters"]["allowClasses"], json!(["demo.*"]));
        assert!(update_step_filters_args(Value::Null, &filters).is_err());
        assert!(verify_step_filters_reply(Value::Null, &filters).is_err());
        assert!(verify_step_filters_reply(json!("invalid json"), &filters).is_err());
        assert!(verify_step_filters_reply(
            json!({ "stepFilters": { "skipClasses": [] } }),
            &filters
        )
        .is_err());
    }
}
