//! The background helper: a Node.js process running Album Studio's project, photo and library
//! logic (`native/backend/server.js`), spoken to over stdin/stdout in JSON lines.
//!
//! Requests from the page that the shell doesn't handle itself are forwarded here with a helper
//! id; the reply is matched back to the page's id. Unsolicited `{event, data}` lines are passed
//! to the page as events. If the helper exits, every request still waiting is answered with an
//! error and the helper is started again on the next request.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

/// What the helper sent back, ready for the page.
pub enum Incoming {
    /// A reply to a page request, already carrying the page's own id.
    Reply(Value),
    /// An unsolicited event.
    Event(Value),
}

pub struct Backend {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    next_id: u64,
    /// helper id → the page's own request id.
    waiting: HashMap<u64, Value>,
    lines: Arc<Mutex<VecDeque<String>>>,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl Backend {
    /// `wake` is called (from the reader thread) whenever the helper writes a line.
    pub fn new(wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { child: None, stdin: None, next_id: 1, waiting: HashMap::new(), lines: Arc::default(), wake }
    }

    fn ensure_running(&mut self) -> Result<(), String> {
        if let Some(child) = &mut self.child {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(status)) => log::warn!("background helper exited ({status}); restarting"),
                Err(e) => log::warn!("background helper state unknown ({e}); restarting"),
            }
            self.child = None;
            self.stdin = None;
        }
        let script = crate::resources::backend_script();
        let mut cmd = Command::new(crate::resources::node());
        cmd.arg(&script);
        // The packaged engine, unless a test points elsewhere.
        if let Some(cli) = crate::resources::photocraft_cli()
            && std::env::var_os("ALBUM_STUDIO_PHOTOCRAFT_CLI").is_none()
        {
            cmd.env("ALBUM_STUDIO_PHOTOCRAFT_CLI", cli);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Album Studio's background helper couldn't start ({e}). Node.js is needed: {}", script.display()))?;
        let stdout = child.stdout.take().ok_or("helper has no stdout")?;
        let stderr = child.stderr.take().ok_or("helper has no stderr")?;
        let lines = self.lines.clone();
        let wake = self.wake.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                lines.lock().unwrap_or_else(|e| e.into_inner()).push_back(line);
                wake();
            }
            // EOF: the helper is gone. One more wake so waiting requests get their error.
            lines.lock().unwrap_or_else(|e| e.into_inner()).push_back(r#"{"event":"backend.exited"}"#.into());
            wake();
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[backend] {line}");
            }
        });
        self.stdin = child.stdin.take();
        self.child = Some(child);
        Ok(())
    }

    /// Forward a page request. An error here is answered to the page straight away.
    pub fn send(&mut self, page_id: Value, method: &str, params: Value) -> Result<(), String> {
        self.ensure_running()?;
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({"id": id, "method": method, "params": params}).to_string();
        let stdin = self.stdin.as_mut().ok_or("helper input is closed")?;
        writeln!(stdin, "{line}").and_then(|()| stdin.flush()).map_err(|e| format!("helper didn't accept the request: {e}"))?;
        self.waiting.insert(id, page_id);
        Ok(())
    }

    /// Everything the helper sent since the last call.
    pub fn drain(&mut self) -> Vec<Incoming> {
        let lines: Vec<String> = self.lines.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect();
        let mut out = Vec::new();
        for line in lines {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                log::warn!("[backend] not a protocol line: {}", line.chars().take(200).collect::<String>());
                continue;
            };
            if msg.get("event").and_then(Value::as_str) == Some("backend.exited") {
                // Answer everything still waiting; the next request restarts the helper.
                for (_, page_id) in self.waiting.drain() {
                    out.push(Incoming::Reply(json!({"id": page_id, "ok": false, "error": "The background helper stopped. Try again."})));
                }
                out.push(Incoming::Event(msg));
                continue;
            }
            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                if let Some(page_id) = self.waiting.remove(&id) {
                    let mut reply = msg;
                    reply["id"] = page_id;
                    out.push(Incoming::Reply(reply));
                }
            } else if msg.get("event").is_some() {
                out.push(Incoming::Event(msg));
            }
        }
        out
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        // Closing stdin lets the helper finish what it is doing and exit by itself.
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
mod architecture_recovery_tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn old_helper_eof_must_not_fail_a_new_helpers_request() {
        let mut backend = Backend::new(Arc::new(|| {}));
        backend.send(json!(101), "system.ping", json!({"exit":true})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let exited = backend.child.as_mut().unwrap().try_wait().unwrap().is_some();
            let eof = backend.lines.lock().unwrap().iter().any(|line| line.contains("backend.exited"));
            if exited && eof { break; }
            assert!(Instant::now() < deadline, "first real helper must reach exit and queue EOF");
            std::thread::sleep(Duration::from_millis(5));
        }
        backend.send(json!(202), "system.ping", json!({})).unwrap();
        let messages = backend.drain();
        assert!(!messages.iter().any(|message| matches!(message, Incoming::Reply(reply) if reply["id"] == 202 && reply["ok"] == false)), "an old generation's EOF failed the successfully submitted new generation request");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let messages = backend.drain();
            if messages.iter().any(|message| matches!(message, Incoming::Reply(reply) if reply["id"] == 202 && reply["ok"] == true)) { break; }
            assert!(Instant::now() < deadline, "new helper's actual reply must reach its original page id");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
