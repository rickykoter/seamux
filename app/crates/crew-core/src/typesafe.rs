//! The one TypeSafe client (crew/hooks/typesafe.py): config, transport and
//! retry; no judgments.
//!
//!   seamux typesafe available   exit 0 when TypeSafe is configured, 1 when not
//!   seamux typesafe ask         {"state", "questions"} on stdin -> answers JSON
//!                               on stdout; exit 2 on any failure
//!
//! TypeSafe is on when a key exists ($TYPESAFE_API_KEY, or the first line of
//! ${XDG_CONFIG_HOME:-~/.config}/typesafe/api-key) and integrations.json does
//! not say {"typesafe": {"enabled": false}}. Any failure is an error out of
//! ask(); callers turn it into "no judgment", never a guess.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::home::crew_home;
use crate::py::{env_or, home};
use crate::pyjson;

const TIMEOUT: Duration = Duration::from_secs(10);

fn integrations() -> PathBuf {
    env_or("TYPESAFE_INTEGRATIONS").map(PathBuf::from).unwrap_or_else(|| crew_home().join("integrations.json"))
}

fn base_url() -> String {
    std::env::var("TYPESAFE_BASE_URL")
        .unwrap_or_else(|_| "https://api.typesafe.ai".into())
        .trim_end_matches('/')
        .to_string()
}

fn model() -> String {
    std::env::var("TYPESAFE_DEFAULT_MODEL").unwrap_or_else(|_| "jev-latest".into())
}

fn config() -> Value {
    std::fs::read_to_string(integrations())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("typesafe").cloned())
        .filter(|v| !is_falsy(v))
        .unwrap_or_else(|| json!({}))
}

/// The key, or "" when TypeSafe is off.
pub fn api_key() -> String {
    if config().get("enabled") == Some(&Value::Bool(false)) {
        return String::new();
    }
    let key = std::env::var("TYPESAFE_API_KEY").unwrap_or_default();
    if !key.trim().is_empty() {
        return key.trim().to_string();
    }
    let base = env_or("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"));
    std::fs::read_to_string(base.join("typesafe/api-key"))
        .ok()
        .and_then(|t| t.lines().next().map(|l| l.trim().to_string()))
        .unwrap_or_default()
}

/// A named threshold from integrations.json's typesafe block, clamped to [0, 1].
pub fn threshold(name: &str, default: f64) -> f64 {
    match config().get(name) {
        None => default,
        Some(v) => match v {
            Value::Number(n) => n.as_f64().map(|f| f.clamp(0.0, 1.0)).unwrap_or(default),
            Value::Bool(b) => (*b as u8) as f64,
            Value::String(s) => s.trim().parse::<f64>().map(|f| f.clamp(0.0, 1.0)).unwrap_or(default),
            _ => default,
        },
    }
}

/// One /v1/systemone POST; the raw answers back. 429 and 529 retry twice,
/// 1.5 s then 3 s apart; anything else fails at once.
pub fn ask(key: &str, state: &Value, questions: &Value) -> Result<Value, String> {
    let body = pyjson::dumps(&json!({"model": model(), "state": state, "questions": questions}));
    let url = format!("{}/v1/systemone", base_url());
    // The proxy env vars apply (ureq's proxy-from-env), except where NO_PROXY
    // says not to, which ureq 2 does not read and urllib does.
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .try_proxy_from_env(!no_proxy_for(&url))
        .build();
    for attempt in 0..3 {
        let res = agent
            .post(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Content-Type", "application/json")
            .send_string(&body);
        match res {
            Ok(r) => {
                let v: Value = serde_json::from_reader(r.into_reader()).map_err(|e| e.to_string())?;
                return v.get("answers").cloned().ok_or_else(|| "no answers in the response".to_string());
            }
            Err(ureq::Error::Status(code, _)) if (code == 429 || code == 529) && attempt < 2 => {
                std::thread::sleep(Duration::from_millis(1500 * (attempt + 1)));
            }
            Err(ureq::Error::Status(code, _)) => return Err(format!("HTTP Error {code}")),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("unreachable".into())
}

/// True when NO_PROXY (or no_proxy) exempts the URL's host, as urllib's
/// proxy_bypass_environment reads it: `*`, or a comma list of host suffixes,
/// an optional port and a leading dot allowed.
pub fn no_proxy_for(url: &str) -> bool {
    let list = std::env::var("no_proxy").or_else(|_| std::env::var("NO_PROXY")).unwrap_or_default();
    let after = url.split_once("://").map(|x| x.1).unwrap_or(url);
    let hostport = after.split('/').next().unwrap_or("").to_lowercase();
    let host = hostport.rsplit_once(':').map(|x| x.0).unwrap_or(&hostport).to_string();
    list.split(',').map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).any(|e| {
        if e == "*" {
            return true;
        }
        let e = e.trim_start_matches('.');
        let (eh, ep) = e.rsplit_once(':').map(|(h, p)| (h, Some(p))).unwrap_or((e, None));
        if let Some(p) = ep {
            if hostport != format!("{eh}:{p}") {
                return false;
            }
        }
        host == eh || host.ends_with(&format!(".{eh}"))
    })
}

const DOC: &str = "crew — the one TypeSafe client. Config, transport, retry; no judgments.

    typesafe.py available      exit 0 when TypeSafe is configured, 1 when not
    typesafe.py ask            {\"state\":..., \"questions\":...} on stdin ->
                               answers JSON on stdout; exit 2 on any failure
";

pub fn main(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("available") => {
            if api_key().is_empty() {
                1
            } else {
                0
            }
        }
        Some("ask") => {
            let key = api_key();
            if key.is_empty() {
                return 2;
            }
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            // `sys.stdin.read() or "{}"`: only empty input means {}; whitespace
            // and anything but an object fail, before any request is made.
            let req: Value = match serde_json::from_str(if input.is_empty() { "{}" } else { &input }) {
                Ok(v @ Value::Object(_)) => v,
                Ok(_) => {
                    eprintln!("typesafe: the request must be a JSON object");
                    return 2;
                }
                Err(e) => {
                    eprintln!("typesafe: {e}");
                    return 2;
                }
            };
            let questions = match req.get("questions") {
                Some(q) if !is_falsy(q) => q.clone(),
                _ => json!({}),
            };
            match ask(&key, req.get("state").unwrap_or(&Value::Null), &questions) {
                Ok(answers) => {
                    println!("{}", pyjson::dumps(&answers));
                    0
                }
                Err(e) => {
                    eprintln!("typesafe: {e}");
                    2
                }
            }
        }
        _ => {
            eprint!("{DOC}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_proxy_matches_like_urllib() {
        std::env::set_var("no_proxy", "localhost, .internal.example ,127.0.0.1:8080");
        assert!(super::no_proxy_for("http://localhost:4000/v1"));
        assert!(super::no_proxy_for("https://api.internal.example/v1"));
        assert!(super::no_proxy_for("http://127.0.0.1:8080/x"));
        assert!(!super::no_proxy_for("http://127.0.0.1:9090/x"));
        assert!(!super::no_proxy_for("https://api.typesafe.ai/v1"));
        std::env::remove_var("no_proxy");
    }
}

/// Python truthiness of a JSON value.
pub fn is_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}
