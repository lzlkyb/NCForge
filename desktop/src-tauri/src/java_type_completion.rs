//! 全库发现的候选先作为类名显示；选中后补依赖，再由 JDT 计算导入与类型编辑。
use crate::lang::LangSession;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub fn candidates(session: &LangSession, params: &Value) -> Value {
    let Some((index, catalog, _)) = &session.completion_catalog else {
        return json!([]);
    };
    let prefix = params["prefix"].as_str().unwrap_or("");
    let items: Vec<Value> = catalog
        .search(index, prefix, 30)
        .into_iter()
        .map(|candidate| {
            let (package, simple) = candidate
                .name
                .rsplit_once('.')
                .unwrap_or(("", &candidate.name));
            json!({
                "label": format!("{simple} - {package}"), "kind": candidate.kind,
                "filterText": simple, "insertText": candidate.name,
                "detail": format!("{} · NC 按需载入", candidate.name),
                "sortText": format!("zz-nc-{simple}-{}", candidate.name),
                "data": {"ncfType": candidate.name}
            })
        })
        .collect();
    Value::Array(items)
}

/// 旧 JDT LS 缺失的废弃标记只在选中候选时补，避免每次打字多一次 RPC。
pub fn resolve_item(
    session: &LangSession,
    item: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let start = Instant::now();
    let mut result = session
        .client
        .request("completionItem/resolve", item.clone(), timeout)?;
    if item["data"]["decl_signature"].is_string() {
        if let Some(remaining) = timeout.checked_sub(start.elapsed()) {
            let metadata = session.client.request(
                "workspace/executeCommand",
                json!({
                    "command":"ncforge.completionMetadata", "arguments":[item["data"]]
                }),
                remaining.min(Duration::from_millis(500)),
            );
            if metadata.is_ok_and(|v| v["deprecated"] == true) {
                result["deprecated"] = json!(true);
                result["tags"] = json!([1]);
            }
        }
    }
    Ok(session.from_server(&result))
}

pub fn resolve(session: &LangSession, params: &Value, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "NC 类型依赖加载超时".to_string())
    };
    let (index, catalog, project_root) = session
        .completion_catalog
        .as_ref()
        .ok_or("全 NC 类名目录未就绪")?;
    let name = params["name"].as_str().ok_or("缺少类型名")?;
    // 前端只给类型名；磁盘路径从受控 NC 索引取得，不能接受任意路径塞进项目。
    if !catalog.contains(index, name) {
        return Err("类型不属于当前 NC 环境".into());
    }
    let uri = params["textDocument"]["uri"].as_str().ok_or("缺少文档")?;
    let jars = crate::compile::type_dependency_jars(index, name);
    session.client.request(
        "workspace/executeCommand",
        json!({
            "command": "ncforge.includeType",
            "arguments": [{"uri":uri, "jars":jars, "order":index.jars, "projectRoot":project_root}]
        }),
        remaining()?,
    )?;
    let result = session.client.request(
        "textDocument/completion",
        json!({
            "textDocument":{"uri":uri}, "position":params["position"],
            "context":{"triggerKind":1}
        }),
        remaining()?,
    )?;
    let items = result.as_array().or_else(|| result["items"].as_array());
    let selected = items.and_then(|items| {
        items.iter().find(|item| {
            item["detail"] == name || item["data"]["decl_signature"] == format!("L{name};")
        })
    });
    if let Some(item) = selected {
        return resolve_item(session, item, remaining()?);
    }
    // 在当前语法位置 JDT 无法提供简名/导入时，全限定名仍是有效且无冲突的类型插入。
    Ok(json!({"insertText":name,"detail":name}))
}
