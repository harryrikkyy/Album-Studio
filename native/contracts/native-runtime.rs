//! Canonical JSON boundary for the native shell. Generated copies travel with the pinned
//! engine so a packaged app never reads a mutable external schema at runtime.
mod generated;
pub(crate) use generated::Method;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::OnceLock;

const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}
impl Failure {
    pub(crate) fn operation(code: &'static str, message: impl Into<String>) -> Self {
        // Native libraries still expose text errors. Bound them before the JSON adapter.
        Self { code, message: message.into().chars().take(8000).collect() }
    }
    fn invalid(keyword: &str, path: &str) -> Self {
        Self { code: "CONTRACT_INVALID", message: format!("Unsupported contract data ({keyword}) at {}.", path.chars().take(4096).collect::<String>()) }
    }
    pub(crate) fn reply(&self, id: Value) -> Value {
        json!({"id": id, "ok": false, "error": self.message, "code": self.code, "retryable": false})
    }
}

struct Contracts {
    schema: Value,
    manifest: Value,
    patterns: HashMap<String, regex::Regex>,
}
static CONTRACTS: OnceLock<Result<Contracts, Failure>> = OnceLock::new();
fn contracts() -> Result<&'static Contracts, Failure> {
    CONTRACTS
        .get_or_init(|| {
            let schema: Value = serde_json::from_str(include_str!("schema.json")).map_err(|_| Failure::invalid("schema", ""))?;
            let manifest = serde_json::from_str(include_str!("manifest.json")).map_err(|_| Failure::invalid("manifest", ""))?;
            fn patterns(node: &Value, out: &mut HashMap<String, regex::Regex>) -> Result<(), Failure> {
                if let Some(pattern) = node.get("pattern").and_then(Value::as_str) {
                    out.insert(pattern.into(), regex::Regex::new(pattern).map_err(|_| Failure::invalid("pattern schema", ""))?);
                }
                match node {
                    Value::Object(map) => {
                        for item in map.values() {
                            patterns(item, out)?;
                        }
                    }
                    Value::Array(items) => {
                        for item in items {
                            patterns(item, out)?;
                        }
                    }
                    _ => {}
                }
                Ok(())
            }
            let mut compiled = HashMap::new();
            patterns(&schema, &mut compiled)?;
            Ok(Contracts { schema, manifest, patterns: compiled })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn at(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}
fn length(value: &str) -> usize {
    value.encode_utf16().count()
}
fn safe_json(value: &Value, depth: usize, nodes: &mut usize, characters: &mut usize, path: &str) -> Result<(), Failure> {
    *nodes += 1;
    if *nodes > 2_000_000 {
        return Err(Failure::invalid("maxNodes", path));
    }
    if depth > 64 {
        return Err(Failure::invalid("maxDepth", path));
    }
    match value {
        Value::String(text) => {
            *characters += length(text);
            if length(text) > 1_048_576 {
                return Err(Failure::invalid("maxLength", path));
            }
        }
        Value::Array(items) => {
            if items.len() > 250_000 {
                return Err(Failure::invalid("maxItems", path));
            }
            for (index, item) in items.iter().enumerate() {
                safe_json(item, depth + 1, nodes, characters, &at(path, &index.to_string()))?;
            }
        }
        Value::Object(items) => {
            if items.len() > 250_000 {
                return Err(Failure::invalid("maxProperties", path));
            }
            for (key, item) in items {
                *characters += length(key);
                if ["__proto__", "prototype", "constructor"].contains(&key.as_str()) {
                    return Err(Failure::invalid("propertyNames", &at(path, key)));
                }
                if *characters > 64 * 1024 * 1024 {
                    return Err(Failure::invalid("maxLength", path));
                }
                safe_json(item, depth + 1, nodes, characters, &at(path, key))?;
            }
        }
        _ => {}
    }
    if *characters > 64 * 1024 * 1024 {
        return Err(Failure::invalid("maxLength", path));
    }
    Ok(())
}

fn is_type(kind: &str, value: &Value) -> bool {
    match kind {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "integer" => value.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE_INTEGER),
        _ => false,
    }
}
fn equivalent(a: &Value, b: &Value) -> bool {
    if a.is_number() && b.is_number() { a.as_f64() == b.as_f64() } else { a == b }
}
fn primitive_key(value: &Value) -> String {
    match value.as_f64() {
        Some(number) => format!("number:{}", if number == 0.0 { 0 } else { number.to_bits() }),
        None => value.to_string(),
    }
}
fn matches(c: &Contracts, schema: &Value, value: &Value, path: &str, depth: usize, steps: &mut usize) -> Result<(), Failure> {
    *steps += 1;
    if *steps > 16_000_000 {
        return Err(Failure::invalid("maxSteps", path));
    }
    if depth > 512 {
        return Err(Failure::invalid("schemaDepth", path));
    }
    if schema == true {
        return Ok(());
    }
    if schema == false {
        return Err(Failure::invalid("false", path));
    }
    if !schema.is_object() {
        return Err(Failure::invalid("schema", path));
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let target = reference.strip_prefix('#').and_then(|pointer| c.schema.pointer(pointer)).ok_or_else(|| Failure::invalid("schema reference", path))?;
        return matches(c, target, value, path, depth + 1, steps);
    }
    if let Some(choices) = schema.get("anyOf").or_else(|| schema.get("oneOf")).and_then(Value::as_array) {
        let mut count = 0;
        for choice in choices {
            match matches(c, choice, value, path, depth + 1, steps) {
                Ok(()) => count += 1,
                Err(error) if *steps > 16_000_000 => return Err(error),
                Err(_) => {}
            }
            if count > 0 && schema.get("anyOf").is_some() {
                return Ok(());
            }
        }
        return if count == 1 { Ok(()) } else { Err(Failure::invalid("union", path)) };
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str)
        && !is_type(kind, value)
    {
        return Err(Failure::invalid("type", path));
    }
    if let Some(fixed) = schema.get("const")
        && !equivalent(value, fixed)
    {
        return Err(Failure::invalid("const", path));
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.iter().any(|option| equivalent(value, option))
    {
        return Err(Failure::invalid("enum", path));
    }
    if let Some(number) = value.as_f64() {
        if schema.get("minimum").and_then(Value::as_f64).is_some_and(|min| number < min) {
            return Err(Failure::invalid("minimum", path));
        }
        if schema.get("maximum").and_then(Value::as_f64).is_some_and(|max| number > max) {
            return Err(Failure::invalid("maximum", path));
        }
    }
    if let Some(text) = value.as_str() {
        let len = length(text) as u64;
        if schema.get("minLength").and_then(Value::as_u64).is_some_and(|min| len < min) {
            return Err(Failure::invalid("minLength", path));
        }
        if schema.get("maxLength").and_then(Value::as_u64).is_some_and(|max| len > max) {
            return Err(Failure::invalid("maxLength", path));
        }
        if let Some(pattern) = schema.get("pattern").and_then(Value::as_str)
            && !c.patterns.get(pattern).is_some_and(|regex| regex.is_match(text))
        {
            return Err(Failure::invalid("pattern", path));
        }
    }
    if let Some(items) = value.as_array() {
        if schema.get("minItems").and_then(Value::as_u64).is_some_and(|min| (items.len() as u64) < min) {
            return Err(Failure::invalid("minItems", path));
        }
        if schema.get("maxItems").and_then(Value::as_u64).is_some_and(|max| (items.len() as u64) > max) {
            return Err(Failure::invalid("maxItems", path));
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                matches(c, item_schema, item, &at(path, &index.to_string()), depth + 1, steps)?;
            }
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            let mut seen = std::collections::HashSet::new();
            for item in items {
                // Canonical uniqueness is restricted to primitives; object identity cannot
                // be portably compared across JS and Rust. Generation refuses that policy.
                if item.is_object() || item.is_array() || !seen.insert(primitive_key(item)) {
                    return Err(Failure::invalid("uniqueItems", path));
                }
            }
        }
    } else if let Some(items) = value.as_object() {
        if schema.get("maxProperties").and_then(Value::as_u64).is_some_and(|max| (items.len() as u64) > max) {
            return Err(Failure::invalid("maxProperties", path));
        }
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !items.contains_key(key) {
                    return Err(Failure::invalid("required", &at(path, key)));
                }
            }
        }
        for (key, item) in items {
            if let Some(names) = schema.get("propertyNames") {
                matches(c, names, &Value::String(key.clone()), &at(path, key), depth + 1, steps)?;
            }
            if let Some(property) = schema.get("properties").and_then(|properties| properties.get(key)) {
                matches(c, property, item, &at(path, key), depth + 1, steps)?;
            } else if let Some(extra) = schema.get("additionalProperties") {
                matches(c, extra, item, &at(path, key), depth + 1, steps)?;
            }
        }
    }
    Ok(())
}
fn validate(schema: &Value, value: &Value) -> Result<(), Failure> {
    safe_json(value, 0, &mut 0, &mut 0, "")?;
    matches(contracts()?, schema, value, "", 0, &mut 0)
}
fn definition(name: &str, value: &Value) -> Result<(), Failure> {
    validate(&contracts()?.schema["$defs"][name], value)
}

pub(crate) struct Request {
    pub(crate) id: Value,
    pub(crate) method: Method,
    pub(crate) params: Value,
}
pub(crate) fn request(value: &Value, debug: bool) -> Result<Request, Failure> {
    definition("RequestEnvelope", value)?;
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .and_then(Method::parse)
        .ok_or(Failure { code: "METHOD_UNKNOWN", message: "This method has no supported native contract.".into() })?;
    if method.is_debug() && !debug {
        return Err(Failure { code: "METHOD_UNAVAILABLE", message: "This method is only available in a debug build.".into() });
    }
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
    validate(&contracts()?.manifest["methods"][method.name()]["params"], &params)?;
    Ok(Request { id: value["id"].clone(), method, params })
}
/// JSON has one number type: an integer spelled `1.0` must correlate like `1`.
pub(crate) fn wire_id(value: &Value) -> Option<u64> {
    value.as_f64().filter(|id| id.is_finite() && *id > 0.0 && *id <= SAFE_INTEGER && id.fract() == 0.0).map(|id| id as u64)
}
pub(crate) fn reply_envelope(value: &Value) -> Result<(), Failure> {
    definition("ReplyEnvelope", value)
}
pub(crate) fn reply(method: Method, value: &Value) -> Result<(), Failure> {
    definition("ReplyEnvelope", value)?;
    if value["ok"] == true {
        validate(&contracts()?.manifest["methods"][method.name()]["result"], &value["result"])?;
    }
    Ok(())
}
pub(crate) fn event(value: &Value) -> Result<(), Failure> {
    definition("EventEnvelope", value)?;
    let name = value["event"].as_str().ok_or_else(|| Failure::invalid("event", ""))?;
    let Some(spec) = contracts()?.manifest["events"].get(name) else {
        return Err(Failure { code: "EVENT_UNKNOWN", message: "This event has no supported native contract.".into() });
    };
    validate(&spec["data"], value.get("data").unwrap_or(&json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authored_cross_runtime_examples_cover_every_method_and_event() {
        let examples: Value = serde_json::from_str(include_str!("examples.json")).unwrap();
        assert_eq!(examples["methods"].as_object().unwrap().len(), 53);
        for (name, example) in examples["methods"].as_object().unwrap() {
            let input = request(&json!({"id":1,"method":name,"params":example[0]}), true).unwrap();
            assert_eq!(input.method.name(), name);
            reply(input.method, &json!({"id":1,"ok":true,"result":example[1]})).unwrap();
            if input.method.is_debug() {
                assert!(request(&json!({"id":1,"method":name,"params":example[0]}), false).is_err());
            }
        }
        assert_eq!(examples["events"].as_object().unwrap().len(), 17);
        for (name, data) in examples["events"].as_object().unwrap() {
            event(&json!({"event":name,"data":data})).unwrap();
        }
    }
    #[test]
    fn malformed_envelopes_business_shapes_and_error_extensions_fail_closed() {
        for input in [
            Value::Null,
            json!([]),
            json!({"id":0,"method":"system.ping"}),
            json!({"id":1,"method":"unknown"}),
            json!({"id":1,"method":"system.ping","params":null}),
            json!({"id":1,"method":"album.open","params":{"path":"relative"}}),
            json!({"id":1,"method":"render.start","params":{"album":"/a","spreads":[1,1]}}),
            json!({"id":1,"method":"system.ping","params":{"n":{"__proto__":1}}}),
        ] {
            assert!(request(&input, true).is_err(), "{input}");
        }
        assert!(reply(Method::SystemPing, &json!({"id":1,"ok":true,"result":{"n":1}})).is_err());
        assert!(reply(Method::SystemPing, &json!({"id":1,"ok":false,"error":"bad","secret":true})).is_err());
        assert!(event(&json!({"event":"unknown","data":{}})).is_err());
        assert!(event(&json!({"event":"render.finished","data":{}})).is_err());
    }
    #[test]
    fn integer_spellings_utf16_lengths_and_unique_numbers_follow_js() {
        let input: Value = serde_json::from_str(r#"{"id":1.0,"method":"shell.ping","params":{}}"#).unwrap();
        assert!(request(&input, true).is_ok());
        let duplicate: Value = serde_json::from_str(r#"{"id":1,"method":"render.start","params":{"album":"/a","spreads":[1,1.0]}}"#).unwrap();
        assert!(request(&duplicate, true).is_err());
        assert_eq!(length("😀"), 2);
        assert!(request(&json!({"id":1,"method":"album.open","params":{"path": format!("/{}", "😀".repeat(2048))}}), true).is_err());
    }
    #[test]
    fn structured_recovery_fields_survive_without_rewriting() {
        let data = json!({"id":1,"ok":false,"code":"RELEASE_FAILED","error":"Saved; lock release failed","renderCommitted":true,"recoveryRequired":true,"retainedPath":"/retained","closeErrors":["close"],"retryable":false});
        reply(Method::RenderStart, &data).unwrap();
        assert_eq!(data["renderCommitted"], true);
        assert_eq!(data["retainedPath"], "/retained");
    }
}
