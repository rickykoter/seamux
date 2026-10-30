//! The wall's poller against a fake cmux: its cadence, an event pulling a
//! read forward, and reply reaching a pane only by a live surface UUID.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use seamux_app::wall::{Frame, Source, Wall};
use serde_json::{json, Value};

const A: &str = "088AC8B3-C1B1-4EB9-9A88-1DA89CDBFF76";
const B: &str = "7C47DD0A-7A85-4389-A705-ACEF3DD0A71E";
const C: &str = "5D2E7A10-1B2C-4D3E-8F40-A1B2C3D4E5F6";
const WS: &str = "68A92708-B9BD-4D9D-9043-A55FD88A17AA";

#[derive(Default)]
struct Fake {
    text: Mutex<HashMap<String, String>>,
    reads: Mutex<Vec<(String, Instant)>>,
    sent: Mutex<Vec<(String, String)>>,
    focused: Mutex<Vec<(String, String)>>,
    /// Surfaces current.list reports; closing one drops it.
    live: Mutex<Vec<&'static str>>,
    /// cmux has no lifecycle hooks from these sessions: every agent is `unknown`.
    unknown: Mutex<bool>,
    /// cmux calls every agent `ended` (another copy of its session ended).
    ended: Mutex<bool>,
}

impl Fake {
    fn new() -> Arc<Fake> {
        let f = Fake::default();
        *f.live.lock().unwrap() = vec![A, B];
        f.text.lock().unwrap().insert(A.into(), "hello\n? Allow edit\n".into());
        f.text.lock().unwrap().insert(B.into(), "$ cargo test\n".into());
        Arc::new(f)
    }
    fn reads_of(&self, s: &str) -> Vec<Instant> {
        self.reads.lock().unwrap().iter().filter(|(x, _)| x == s).map(|(_, t)| *t).collect()
    }
}

impl Source for Fake {
    fn current(&self) -> Result<Value, cmux::Error> {
        let items: Vec<Value> = self
            .live
            .lock()
            .unwrap()
            .iter()
            .map(|s| {
                let agents = match *s {
                    _ if *self.unknown.lock().unwrap() => json!([{"kind": "claude", "state": "unknown"}]),
                    _ if *self.ended.lock().unwrap() => json!([{"kind": "claude", "state": "ended"}]),
                    A => json!([{"kind": "claude", "state": "needs_input"}]),
                    C => json!([]),
                    _ => json!([{"kind": "claude", "state": "working"}]),
                };
                json!({"kind": "terminal", "lifecycle": "running", "label": s, "cwd": "/w",
                       "agents": agents, "projections": [{"panel_id": s, "workspace_id": WS}]})
            })
            .collect();
        Ok(json!({"items": items}))
    }
    fn workspaces(&self) -> Result<Value, cmux::Error> {
        Ok(json!({"workspaces": [{"id": WS, "title": "port-store"}]}))
    }
    fn read(&self, surface: &str, _lines: u32) -> Result<String, cmux::Error> {
        self.reads.lock().unwrap().push((surface.to_string(), Instant::now()));
        Ok(self.text.lock().unwrap().get(surface).cloned().unwrap_or_default())
    }
    fn send_raw(&self, surface: &str, text: &str) -> Result<(), cmux::Error> {
        self.sent.lock().unwrap().push((surface.to_string(), text.to_string()));
        Ok(())
    }
    fn select_workspace(&self, _ws: &str) -> Result<(), cmux::Error> {
        Ok(())
    }
    fn focus(&self, surface: &str, ws: &str) -> Result<(), cmux::Error> {
        self.focused.lock().unwrap().push((surface.to_string(), ws.to_string()));
        Ok(())
    }
}

fn wall(fake: &Arc<Fake>, interval: Duration) -> Arc<Wall> {
    let pool: Vec<Arc<dyn Source>> = vec![fake.clone(), fake.clone()];
    Arc::new(Wall::new(pool, interval))
}

#[test]
fn first_tick_frames_every_terminal_then_only_changes() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_secs(1));
    let f = w.tick().expect("first tick frames");
    assert_eq!(f.tiles.len(), 2);
    assert_eq!(f.tiles[0].workspace_title, "port-store");
    assert_eq!(f.tiles[0].lines, vec!["hello", "? Allow edit"]);
    assert_eq!(f.tiles[0].state, "needs_input");
    assert!(w.tick().is_none(), "nothing changed, nothing sent");
    fake.text.lock().unwrap().insert(B.into(), "$ cargo test\nok\n".into());
    let f = w.tick().expect("a change frames again");
    assert_eq!(f.tiles[1].lines, vec!["$ cargo test", "ok"]);
}

#[test]
fn an_unknown_state_comes_from_the_hint_when_it_has_one() {
    let fake = Fake::new();
    *fake.unknown.lock().unwrap() = true;
    let w = wall(&fake, Duration::from_secs(1));
    let f = w.tick().unwrap();
    assert_eq!((f.tiles[0].state.as_str(), f.tiles[1].state.as_str()), ("unknown", "unknown"));
    w.set_state_hint(Box::new(|| {
        HashMap::from([(A.to_uppercase(), "working".to_string()), (B.to_uppercase(), "shell".to_string())])
    }));
    let f = w.tick().expect("the hint changes the frame");
    assert_eq!((f.tiles[0].state.as_str(), f.tiles[1].state.as_str()), ("working", "shell"));
    assert!(f.tiles[0].agent.is_some() && f.tiles[1].agent.is_none(), "a gone agent leaves a terminal");
}

#[test]
fn a_terminal_holding_a_native_claude_is_an_agent() {
    let fake = Fake::new();
    fake.live.lock().unwrap().push(C);
    let w = wall(&fake, Duration::from_secs(1));
    let f = w.tick().unwrap();
    let c = f.tiles.iter().find(|t| t.surface == C).unwrap();
    assert!(c.agent.is_none(), "cmux sees a terminal there");
    w.set_native_probe(Box::new(|| std::collections::HashSet::from([C.to_uppercase()])));
    let f = w.tick().expect("the probe changes the frame");
    let c = f.tiles.iter().find(|t| t.surface == C).unwrap();
    assert_eq!((c.agent.as_deref(), c.state.as_str()), (Some("claude"), "idle"));
}

/// The truth probe stands in for crew_core::status::live_states: the panes
/// whose pane file names a session with a live pid. A dead pid is not in it.
#[test]
fn a_live_pane_file_beats_cmux_ended() {
    let fake = Fake::new();
    *fake.ended.lock().unwrap() = true;
    let w = wall(&fake, Duration::from_secs(1));
    let f = w.tick().unwrap();
    assert_eq!(f.tiles[1].state, "ended", "cmux keys lifecycle by session: a resumed copy ended");
    // B's pane file says working and its pid is alive; A's pid is dead, so A is not listed.
    w.set_truth_probe(Box::new(|| HashMap::from([(B.to_uppercase(), "working".to_string())])));
    let f = w.tick().expect("the pane file changes the frame");
    assert_eq!((f.tiles[0].state.as_str(), f.tiles[1].state.as_str()), ("ended", "working"));
    assert_eq!(f.tiles[1].agent.as_deref(), Some("claude"));
    assert_eq!(w.state_of(B).unwrap().0, "working", "a fresh look judges it the same way");
}

#[test]
fn a_native_pane_cmux_sees_no_agent_in_is_claude_when_its_file_is_live() {
    let fake = Fake::new();
    fake.live.lock().unwrap().push(C);
    let w = wall(&fake, Duration::from_secs(1));
    w.set_truth_probe(Box::new(|| HashMap::from([(C.to_uppercase(), "needs_input".to_string())])));
    let f = w.tick().unwrap();
    let c = f.tiles.iter().find(|t| t.surface == C).unwrap();
    assert_eq!((c.agent.as_deref(), c.state.as_str()), (Some("claude"), "needs_input"));
}

#[test]
fn polls_every_terminal_at_the_interval() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_millis(50));
    let (tx, rx) = mpsc::channel::<String>();
    let runner = {
        let w = w.clone();
        std::thread::spawn(move || w.run(rx, |_| true))
    };
    std::thread::sleep(Duration::from_millis(520));
    drop(tx);
    runner.join().unwrap();
    // What the poll promises: every terminal is read on every tick, ticks keep
    // coming, and none comes sooner than the interval. Not a tick count by
    // the wall clock: macOS stretches short timers (Low Power Mode makes a
    // 50ms sleep take ~125ms), so 520ms may hold 4 ticks or 11.
    let (a, b) = (fake.reads_of(A), fake.reads_of(B));
    assert!(a.len() >= 3, "{A} read only {} times in 520ms", a.len());
    assert!(a.len().abs_diff(b.len()) <= 1, "{A} read {} times, {B} {}", a.len(), b.len());
    for s in [A, B] {
        let ts = fake.reads_of(s);
        for w in ts.windows(2) {
            let gap = w[1] - w[0];
            assert!(gap >= Duration::from_millis(45), "{s} read again after {gap:?}, sooner than the 50ms interval");
        }
    }
}

#[test]
fn an_event_pulls_one_read_forward() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_secs(30));
    let frames: Arc<Mutex<Vec<(Instant, Frame)>>> = Arc::default();
    let (tx, rx) = mpsc::channel::<String>();
    let runner = {
        let (w, frames) = (w.clone(), frames.clone());
        std::thread::spawn(move || {
            w.run(rx, move |f| {
                frames.lock().unwrap().push((Instant::now(), f));
                true
            })
        })
    };
    // The first tick runs at once; wait for it.
    let t0 = Instant::now();
    while frames.lock().unwrap().is_empty() && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let before_b = fake.reads_of(B).len();
    fake.text.lock().unwrap().insert(A.into(), "hello\n? Allow edit\n> yes\n".into());
    let sent = Instant::now();
    tx.send(A.into()).unwrap();
    tx.send("8F1C2D3E-0000-4000-8000-000000000000".into()).unwrap(); // unknown: ignored
    let t1 = Instant::now();
    while frames.lock().unwrap().len() < 2 && t1.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(tx);
    runner.join().unwrap();
    let frames = frames.lock().unwrap();
    assert_eq!(frames.len(), 2, "the pull framed the change");
    assert!(frames[1].0.duration_since(sent) < Duration::from_millis(200), "pulled read came within 200ms, not at the 30s tick");
    assert_eq!(frames[1].1.tiles[0].lines.last().map(String::as_str), Some("> yes"));
    assert_eq!(fake.reads_of(B).len(), before_b, "only the named surface was re-read");
}

#[test]
fn reply_goes_only_to_a_live_surface_uuid() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_secs(1));
    w.tick();
    // A positional ref is refused before anything reaches cmux.
    let e = w.reply("surface:3", "yes").unwrap_err();
    assert!(e.contains("UUID"), "{e}");
    // A UUID that is no longer a live terminal is refused too.
    fake.live.lock().unwrap().retain(|s| *s != B);
    let e = w.reply(B, "yes").unwrap_err();
    assert!(e.contains("not a live terminal"), "{e}");
    assert!(w.reply(A, "  ").is_err(), "empty reply refused");
    assert!(fake.sent.lock().unwrap().is_empty());
    // A plain shell takes no reply: the text would run as a command.
    fake.live.lock().unwrap().push(C);
    let e = w.reply(C, "rm -rf ~").unwrap_err();
    assert!(e.contains("no running agent"), "{e}");
    assert!(fake.sent.lock().unwrap().is_empty());
    // The live agent gets the text as typed, control characters dropped,
    // line breaks flattened, then Enter.
    w.reply(A, "use \\n literally\nplease\x03").unwrap();
    assert_eq!(*fake.sent.lock().unwrap(), vec![(A.to_string(), "use \\n literally please\r".to_string())]);
}

#[test]
fn jump_focuses_the_pane_in_its_workspace() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_secs(1));
    w.jump(A).unwrap();
    assert_eq!(*fake.focused.lock().unwrap(), vec![(A.to_string(), WS.to_string())]);
    assert!(w.jump("workspace:1").is_err());
}

#[test]
fn a_stream_of_events_never_starves_the_poll() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_millis(100));
    let (tx, rx) = mpsc::channel::<String>();
    let runner = {
        let w = w.clone();
        std::thread::spawn(move || w.run(rx, |_| true))
    };
    // Events for A far faster than a read takes, for half a second.
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(500) {
        let _ = tx.send(A.into());
        std::thread::sleep(Duration::from_millis(2));
    }
    drop(tx);
    runner.join().unwrap();
    let b = fake.reads_of(B).len();
    assert!(b >= 3, "B is only read by ticks; it was read {b} times");
    let a = fake.reads_of(A).len();
    assert!(a <= 12, "pulls of A are throttled; it was read {a} times");
}

#[test]
fn a_failed_emit_is_sent_again() {
    let fake = Fake::new();
    let w = wall(&fake, Duration::from_millis(40));
    let (tx, rx) = mpsc::channel::<String>();
    let calls: Arc<Mutex<u32>> = Arc::default();
    let runner = {
        let (w, calls) = (w.clone(), calls.clone());
        std::thread::spawn(move || {
            w.run(rx, move |_| {
                let mut n = calls.lock().unwrap();
                *n += 1;
                *n > 1 // the first emit fails
            })
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    drop(tx);
    runner.join().unwrap();
    assert_eq!(*calls.lock().unwrap(), 2, "the unchanged frame went again once, then stopped");
}
