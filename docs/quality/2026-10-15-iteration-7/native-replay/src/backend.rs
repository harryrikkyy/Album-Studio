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

struct Pending {
    page_id: Value,
    generation: u64,
}

enum ReaderMessage {
    Line { generation: u64, line: String },
    Exited { generation: u64 },
}

pub struct Backend {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    next_id: u64,
    /// helper id → the page's own request id.
    waiting: HashMap<u64, Pending>,
    generation: u64,
    lines: Arc<Mutex<VecDeque<ReaderMessage>>>,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl Backend {
    /// `wake` is called (from the reader thread) whenever the helper writes a line.
    pub fn new(wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { child: None, stdin: None, next_id: 1, waiting: HashMap::new(), generation: 0, lines: Arc::default(), wake }
    }

    fn ensure_running(&mut self) -> Result<(), String> {
        if let Some(child) = &mut self.child {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(status)) => log::warn!("background helper exited ({status}); restarting"),
                Err(e) => return Err(format!("The background helper state could not be verified ({e}). Preserve current work before retrying.")),
            }
            self.child = None;
            self.stdin = None;
        }
        let generation = self.generation.checked_add(1).ok_or("The helper generation counter is exhausted; restart Album Studio after current work finishes.")?;
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
                lines.lock().unwrap_or_else(|e| e.into_inner()).push_back(ReaderMessage::Line { generation, line });
                wake();
            }
            // EOF: the helper is gone. One more wake so waiting requests get their error.
            lines.lock().unwrap_or_else(|e| e.into_inner()).push_back(ReaderMessage::Exited { generation });
            wake();
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[backend] {line}");
            }
        });
        self.generation = generation;
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
        self.waiting.insert(id, Pending { page_id, generation: self.generation });
        Ok(())
    }

    /// Everything the helper sent since the last call.
    pub fn drain(&mut self) -> Vec<Incoming> {
        let lines: Vec<ReaderMessage> = self.lines.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect();
        let mut out = Vec::new();
        for message in lines {
            match message {
                ReaderMessage::Exited { generation } => {
                    let abandoned: Vec<u64> = self.waiting.iter().filter_map(|(id, pending)| (pending.generation == generation).then_some(*id)).collect();
                    for id in abandoned {
                        if let Some(pending) = self.waiting.remove(&id) {
                            out.push(Incoming::Reply(json!({"id": pending.page_id, "ok": false, "code": "BACKEND_STOPPED", "retryable": false, "error": "The background helper stopped. Reopen the album to verify completed work before retrying."})));
                        }
                    }
                    if generation == self.generation {
                        self.stdin = None;
                        out.push(Incoming::Event(json!({"event": "backend.exited", "data": {}})));
                    }
                }
                ReaderMessage::Line { generation, line } => {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        log::warn!("[backend] invalid protocol line");
                        continue;
                    };
                    if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                        if self.waiting.get(&id).is_some_and(|pending| pending.generation == generation)
                            && let Some(pending) = self.waiting.remove(&id)
                        {
                            let mut reply = msg;
                            reply["id"] = pending.page_id;
                            out.push(Incoming::Reply(reply));
                        }
                    } else if generation == self.generation && msg.get("event").is_some() {
                        out.push(Incoming::Event(msg));
                    }
                }
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
            let eof = backend.lines.lock().unwrap().iter().any(|message| matches!(message, ReaderMessage::Exited { .. }));
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
