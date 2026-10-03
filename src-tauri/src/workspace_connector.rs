//! One explicitly started CLI daemon. No model/Agent implementation lives here.
use serde::{ser::SerializeStruct, Serialize, Serializer};
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const STREAM_LIMIT: usize = 64 * 1024;
const LINE_LIMIT: usize = 4096;
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct ConnectorStatus {
    pub running: bool,
    /// CLI startup heartbeat + recovery flush succeeded. The server's online
    /// flag remains authoritative; this is not proof of model execution.
    pub connected: bool,
    pub phase: &'static str,
    pub error: Option<&'static str>,
}

impl Serialize for ConnectorStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let state = match self.phase {
            "connected" if self.connected && self.running => "running",
            "starting" => "starting",
            "stopping" => "stopping",
            "failed" => "failed",
            _ => "stopped",
        };
        let mut output = serializer.serialize_struct("ConnectorStatus", 2)?;
        output.serialize_field("state", state)?;
        output.serialize_field("error", &self.error)?;
        output.end()
    }
}

impl Default for ConnectorStatus {
    fn default() -> Self {
        Self {
            running: false,
            connected: false,
            phase: "stopped",
            error: None,
        }
    }
}

struct Running {
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Connector {
    active: Mutex<Option<Running>>,
    status: Arc<Mutex<ConnectorStatus>>,
}

impl Connector {
    pub fn status(&self) -> Result<ConnectorStatus, &'static str> {
        Ok(self
            .status
            .lock()
            .map_err(|_| "workspace_cli_state_unavailable")?
            .clone())
    }

    pub fn require_stopped(&self) -> Result<(), &'static str> {
        if self.status()?.running {
            Err("workspace_cli_connector_running")
        } else {
            Ok(())
        }
    }

    pub fn start(&self, mut command: Command) -> Result<ConnectorStatus, &'static str> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "workspace_cli_state_unavailable")?;
        if active
            .as_ref()
            .is_some_and(|run| !run.done.load(Ordering::Acquire))
        {
            return Err("workspace_cli_connector_running");
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| "workspace_cli_spawn_failed")?;
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let mut process = ManagedProcess {
            child,
            tree,
            terminated: false,
        };
        let stdout = process
            .child
            .stdout
            .take()
            .ok_or("workspace_cli_output_failed")?;
        let stderr = process
            .child
            .stderr
            .take()
            .ok_or("workspace_cli_output_failed")?;
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let fault = Arc::new(Mutex::new(None));
        let ready = Arc::new(AtomicBool::new(false));
        let readers = Arc::new(AtomicBool::new(false));
        let reader_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let spawn_reader = |is_stdout: bool, reader: Box<dyn Read + Send>| {
            let fault = fault.clone();
            let ready = ready.clone();
            let readers = readers.clone();
            let count = reader_count.clone();
            std::thread::Builder::new().spawn(move || {
                let result = if is_stdout {
                    read_events(reader, &ready, &fault)
                } else {
                    discard_bounded(reader)
                };
                if let Err(error) = result {
                    if let Ok(mut slot) = fault.lock() {
                        *slot = Some(error);
                    }
                }
                if count.fetch_add(1, Ordering::AcqRel) == 1 {
                    readers.store(true, Ordering::Release);
                }
            })
        };
        if spawn_reader(true, Box::new(stdout)).is_err()
            || spawn_reader(false, Box::new(stderr)).is_err()
        {
            return Err("workspace_cli_output_failed");
        }
        let starting = ConnectorStatus {
            running: true,
            connected: false,
            phase: "starting",
            error: None,
        };
        *self
            .status
            .lock()
            .map_err(|_| "workspace_cli_state_unavailable")? = starting.clone();
        let state = self.status.clone();
        let run_stop = stop.clone();
        let run_done = done.clone();
        std::thread::Builder::new()
            .spawn(move || {
                let mut error = None;
                let startup_deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    if run_stop.load(Ordering::Acquire) {
                        break;
                    }
                    if let Ok(value) = fault.lock() {
                        if value.is_some() {
                            error = *value;
                            break;
                        }
                    }
                    match process.child.try_wait() {
                        Ok(Some(_)) => {
                            error = Some("workspace_cli_connector_exited");
                            break;
                        }
                        Err(_) => {
                            error = Some("workspace_cli_wait_failed");
                            break;
                        }
                        Ok(None) => {}
                    }
                    if ready.load(Ordering::Acquire) {
                        if let Ok(mut status) = state.lock() {
                            if status.phase != "stopping" {
                                status.connected = true;
                                status.phase = "connected";
                            }
                        }
                    } else if Instant::now() >= startup_deadline {
                        error = Some("workspace_cli_connection_timeout");
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                process.terminate();
                // Readers should close on exit. If an unexpected descendant retains
                // a pipe, prevent another daemon from leaking more reader threads.
                let deadline = Instant::now() + Duration::from_secs(1);
                while !readers.load(Ordering::Acquire) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if !readers.load(Ordering::Acquire) {
                    error = Some("workspace_cli_output_failed");
                }
                if let Ok(mut status) = state.lock() {
                    *status = ConnectorStatus {
                        running: false,
                        connected: false,
                        phase: if error.is_some() { "failed" } else { "stopped" },
                        error,
                    };
                }
                // Keep the start gate closed if leaked descendants retain streams.
                run_done.store(readers.load(Ordering::Acquire), Ordering::Release);
            })
            .map_err(|_| {
                if let Ok(mut status) = self.status.lock() {
                    *status = ConnectorStatus {
                        error: Some("workspace_cli_spawn_failed"),
                        phase: "failed",
                        ..Default::default()
                    };
                }
                "workspace_cli_spawn_failed"
            })?;
        *active = Some(Running { stop, done });
        Ok(starting)
    }

    /// Also used at native app exit; no background daemon survives by design.
    pub fn stop(&self) -> Result<ConnectorStatus, &'static str> {
        let active = self
            .active
            .lock()
            .map_err(|_| "workspace_cli_state_unavailable")?;
        if let Some(run) = active.as_ref() {
            if !run.done.load(Ordering::Acquire) {
                let mut status = self
                    .status
                    .lock()
                    .map_err(|_| "workspace_cli_state_unavailable")?;
                // The monitor may have published its final state just before
                // done becomes visible. Never overwrite that with stopping.
                if status.running {
                    status.connected = false;
                    status.phase = "stopping";
                }
            }
            run.stop.store(true, Ordering::Release);
            let deadline = Instant::now() + STOP_TIMEOUT + Duration::from_secs(2);
            while !run.done.load(Ordering::Acquire) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if !run.done.load(Ordering::Acquire) {
                return Err("workspace_cli_stop_failed");
            }
        }
        self.status()
    }
}

impl Drop for Connector {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn discard_bounded(mut reader: impl Read) -> Result<(), &'static str> {
    let mut count = 0;
    let mut buffer = [0; 2048];
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|_| "workspace_cli_output_failed")?;
        if n == 0 {
            return Ok(());
        }
        count += n;
        if count > STREAM_LIMIT {
            return Err("workspace_cli_output_limit");
        }
    }
}

fn read_events(
    reader: impl Read,
    ready: &AtomicBool,
    fault: &Mutex<Option<&'static str>>,
) -> Result<(), &'static str> {
    let mut reader = BufReader::new(reader);
    let mut count = 0;
    loop {
        // A malicious line cannot force an unbounded read_until allocation.
        let mut line = Vec::new();
        let n = reader
            .by_ref()
            .take((LINE_LIMIT + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "workspace_cli_output_failed")?;
        if n == 0 {
            return Ok(());
        }
        count += n;
        if line.len() > LINE_LIMIT || count > STREAM_LIMIT {
            return Err("workspace_cli_output_limit");
        }
        let data: serde_json::Value =
            serde_json::from_slice(&line).map_err(|_| "workspace_cli_invalid_output")?;
        if data == serde_json::json!({"ok":true,"data":{"event":"connected"}}) {
            ready.store(true, Ordering::Release);
        } else if data == serde_json::json!({"ok":true,"data":{"stopped":true}}) {
            // Final response after graceful shutdown, not a readiness event.
        } else if data.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            // No arbitrary error text, stderr, URLs, or credentials cross IPC.
            let error = match data.pointer("/error/id").and_then(|v| v.as_str()) {
                Some("workspace_not_linked") => "workspace_cli_not_linked",
                Some("workspace_config_unavailable") => "workspace_cli_config_unavailable",
                _ => "workspace_cli_connection_failed",
            };
            *fault
                .lock()
                .map_err(|_| "workspace_cli_state_unavailable")? = Some(error);
        } else {
            return Err("workspace_cli_invalid_output");
        }
    }
}

struct ManagedProcess {
    child: Child,
    tree: ProcessTree,
    terminated: bool,
}
impl ManagedProcess {
    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        self.terminated = true;
        self.tree.request_stop(&mut self.child);
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.tree.kill(&mut self.child);
        let _ = self.child.wait();
    }
}
impl Drop for ManagedProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(unix)]
struct ProcessTree {
    group: i32,
}
#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, &'static str> {
        Ok(Self {
            group: child.id() as i32,
        })
    }
    fn request_stop(&self, _child: &mut Child) {
        // SIGTERM reaches Go's signal context, which cancels active model/MCP
        // child groups before the hard-stop deadline.
        unsafe {
            libc::kill(-self.group, libc::SIGTERM);
        }
    }
    fn kill(&self, child: &mut Child) {
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
        let _ = child.kill();
    }
}

#[cfg(windows)]
struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, &'static str> {
        use std::{mem, os::windows::io::AsRawHandle};
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("workspace_cli_process_isolation_failed");
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                CloseHandle(job);
                return Err("workspace_cli_process_isolation_failed");
            }
            Ok(Self { job })
        }
    }
    fn request_stop(&self, child: &mut Child) {
        self.kill(child);
    }
    fn kill(&self, _child: &mut Child) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_state_reports_running_only_after_verified_readiness() {
        for (phase, running, connected, expected) in [
            ("stopped", false, false, "stopped"),
            ("starting", true, false, "starting"),
            ("connected", true, true, "running"),
            ("stopping", true, false, "stopping"),
            ("failed", false, false, "failed"),
        ] {
            let status = ConnectorStatus {
                phase,
                running,
                connected,
                error: None,
            };
            let output = serde_json::to_value(status).unwrap();
            assert_eq!(output, serde_json::json!({"state":expected,"error":null}));
        }
    }

    #[test]
    fn readiness_is_exact_json_not_stderr_or_arbitrary_output() {
        let ready = AtomicBool::new(false);
        let fault = Mutex::new(None);
        read_events(
            &b"{\"ok\":true,\"data\":{\"event\":\"connected\"}}\n"[..],
            &ready,
            &fault,
        )
        .unwrap();
        assert!(ready.load(Ordering::Acquire));
        assert!(read_events(
            &b"{\"ok\":true,\"data\":{\"event\":\"connected\",\"token\":\"secret\"}}\n"[..],
            &ready,
            &fault
        )
        .is_err());
        read_events(
            &b"{\"ok\":false,\"error\":{\"id\":\"token=secret\"}}\n"[..],
            &ready,
            &fault,
        )
        .unwrap();
        assert_eq!(
            *fault.lock().unwrap(),
            Some("workspace_cli_connection_failed")
        );
    }

    #[test]
    fn connector_streams_have_hard_limits() {
        assert_eq!(
            discard_bounded(&vec![0; STREAM_LIMIT + 1][..]),
            Err("workspace_cli_output_limit")
        );
        assert_eq!(
            read_events(
                &vec![b' '; LINE_LIMIT + 1][..],
                &AtomicBool::new(false),
                &Mutex::new(None)
            ),
            Err("workspace_cli_output_limit")
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_lifecycle_does_not_duplicate_daemons_and_reaps_on_stop() {
        use std::process::Stdio;
        let connector = Connector::default();
        assert!(!connector.status().unwrap().running);
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' '{\"ok\":true,\"data\":{\"event\":\"connected\"}}'; exec /bin/sleep 30"])
            .env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        connector.start(command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !connector.status().unwrap().connected && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(connector.status().unwrap().connected);
        assert!(connector.start(Command::new("/bin/sleep")).is_err());
        assert!(connector.require_stopped().is_err());
        let stopped = connector.stop().unwrap();
        assert!(!stopped.running && !stopped.connected);
        connector.require_stopped().unwrap();
    }
}
