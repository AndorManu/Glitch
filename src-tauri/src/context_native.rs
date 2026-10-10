//! The OS side of "he reacts to what you're doing": a cheap look at what
//! the user is doing, once every few seconds (see `context.rs`). Only
//! classifications leave this file (an app *kind*, booleans, numbers): the
//! foreground window's title is read only to spot a video site in a
//! browser, the media session's track title only when the user asks
//! (`now_playing`); neither is stored or logged.
//!
//! Cost per poll (Windows): GetForegroundWindow + one process-name query,
//! GetSystemTimes, GetSystemPowerStatus, one notification-state query and,
//! if enabled, a walk over the media sessions (usually 0-2). No audio
//! capture, no screenshots, no window enumeration.
//!
//! macOS / Linux: no foreground app, media, battery or CPU readings yet;
//! the time-of-day reactions and focus mode still work.

/// What to read this poll (switched-off reactions cost nothing).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
pub struct Want {
    pub media: bool,
    pub battery: bool,
    pub cpu: bool,
}

pub use imp::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::Want;
    use glitch_core::context::{self, AppKind, Battery, Foreground, Media, Snapshot};
    use glitch_core::desktop::NowPlaying;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Media::MediaPlaybackType;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, GetSystemTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsZoomed,
    };

    /// Shell windows that are "in front" when the user clicks the desktop or taskbar.
    const SHELL: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// CPU use between two polls.
    #[derive(Default)]
    pub struct CpuMeter {
        last: Option<(u64, u64)>,
    }

    impl CpuMeter {
        pub fn sample(&mut self) -> Option<f32> {
            let ft = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut idle, mut kernel, mut user) = (ft(), ft(), ft());
            // SAFETY: three out-parameters.
            if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
                return None;
            }
            let v = |f: FILETIME| (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime);
            // Kernel time includes idle time.
            let (idle, total) = (v(idle), v(kernel) + v(user));
            let prev = self.last.replace((idle, total));
            let (pi, pt) = prev?;
            let dt = total.saturating_sub(pt);
            if dt == 0 {
                return None;
            }
            let busy = dt.saturating_sub(idle.saturating_sub(pi));
            Some((busy as f64 * 100.0 / dt as f64) as f32)
        }
    }

    /// Call once on the polling thread (WinRT needs COM).
    pub fn init_thread() {
        // SAFETY: plain init; "already initialised" is fine.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn exe_of(pid: u32) -> Option<String> {
        // SAFETY: the handle is closed below; the buffer size is passed in.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) };
        unsafe { CloseHandle(h) };
        (ok != 0).then(|| {
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().unwrap_or(&path).to_string()
        })
    }

    fn covers_monitor(hwnd: HWND) -> bool {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { GetWindowRect(hwnd, &mut r) } == 0 || unsafe { IsZoomed(hwnd) } != 0 {
            return false;
        }
        let mon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if unsafe { GetMonitorInfoW(mon, &mut mi) } == 0 {
            return false;
        }
        let m = mi.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }

    /// Looked at on the spot, never kept.
    fn title_is_video_site(hwnd: HWND) -> bool {
        let mut buf = [0u16; 256];
        let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        context::is_video_site_title(&String::from_utf16_lossy(&buf[..n.max(0) as usize]))
    }

    /// The app in front, and its exe name (for matching the media session).
    fn foreground(media_playing: bool) -> Option<(Foreground, String)> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() || SHELL.contains(&class_name(hwnd).as_str()) {
            return None;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == unsafe { GetCurrentProcessId() } {
            return None;
        }
        let exe = exe_of(pid).unwrap_or_default();
        let kind = context::classify_app(&exe);
        let fg = Foreground {
            id: hwnd as usize as u64,
            kind,
            fullscreen: covers_monitor(hwnd),
            video_site: media_playing && kind == AppKind::Browser && title_is_video_site(hwnd),
        };
        Some((fg, exe))
    }

    fn os_busy() -> bool {
        let mut state = 0;
        let hr = unsafe { SHQueryUserNotificationState(&mut state) };
        hr == 0 && matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    }

    fn battery() -> Option<Battery> {
        let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { GetSystemPowerStatus(&mut s) } == 0 || s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
            return None; // no battery (desktop PC) or unknown
        }
        Some(Battery { percent: s.BatteryLifePercent, charging: s.ACLineStatus == 1 })
    }

    thread_local! {
        static MANAGER: std::cell::RefCell<Option<Manager>> = const { std::cell::RefCell::new(None) };
    }

    fn manager() -> Option<Manager> {
        MANAGER.with(|m| {
            let mut m = m.borrow_mut();
            if m.is_none() {
                *m = Manager::RequestAsync().and_then(|op| op.join()).ok();
            }
            m.clone()
        })
    }

    fn sessions() -> Vec<Session> {
        let Some(m) = manager() else { return Vec::new() };
        m.GetSessions().map(|v| v.into_iter().collect()).unwrap_or_default()
    }

    fn is_playing(s: &Session) -> bool {
        s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).is_ok_and(|st| st == Status::Playing)
    }

    fn is_video(s: &Session) -> bool {
        s.GetPlaybackInfo()
            .and_then(|i| i.PlaybackType())
            .and_then(|t| t.Value())
            .is_ok_and(|t| t == MediaPlaybackType::Video)
    }

    fn app_id(s: &Session) -> String {
        s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()
    }

    fn media(playing: &[Session], fg_exe: &str) -> Media {
        if playing.is_empty() {
            return Media { playing: false, video: false, fg_app: false };
        }
        let front = playing.iter().find(|s| context::same_app(&app_id(s), fg_exe));
        let s = front.unwrap_or(&playing[0]);
        Media { playing: true, video: is_video(s), fg_app: front.is_some() }
    }

    /// One poll.
    pub fn snapshot(want: Want, cpu: &mut CpuMeter) -> Snapshot {
        let (minute, day) = context::local_clock();
        let playing: Vec<Session> =
            if want.media { sessions().into_iter().filter(is_playing).collect() } else { Vec::new() };
        let fg = foreground(!playing.is_empty());
        let media = want.media.then(|| media(&playing, fg.as_ref().map_or("", |(_, exe)| exe.as_str())));
        Snapshot {
            fg: fg.map(|(f, _)| f),
            media,
            battery: if want.battery { battery() } else { None },
            cpu: if want.cpu { cpu.sample() } else { None },
            os_busy: os_busy(),
            idle_ms: Some(crate::chaos_native::idle_ms()),
            minute,
            day,
        }
    }

    /// Title and artist, only when the user asks. Runs on its own thread
    /// with COM initialised (tool calls run on the async runtime).
    pub fn now_playing() -> Result<Option<NowPlaying>, String> {
        std::thread::spawn(|| {
            init_thread();
            let all = sessions();
            let s = all.iter().find(|s| is_playing(s)).or(all.first()).cloned();
            let Some(s) = s else { return Ok(None) };
            let p = s
                .TryGetMediaPropertiesAsync()
                .and_then(|op| op.join())
                .map_err(|e| format!("couldn't read what's playing: {}", e.message()))?;
            let text = |r: windows::core::Result<windows::core::HSTRING>| r.map(|h| h.to_string()).unwrap_or_default();
            Ok(Some(NowPlaying {
                title: text(p.Title()),
                artist: text(p.Artist()),
                app: app_id(&s),
                playing: is_playing(&s),
            }))
        })
        .join()
        .unwrap_or_else(|_| Err("couldn't read what's playing".into()))
    }

    /// The window in front (for debug triggers).
    pub fn foreground_id() -> u64 {
        unsafe { GetForegroundWindow() as usize as u64 }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::Want;
    use glitch_core::context::Snapshot;
    use glitch_core::desktop::NowPlaying;

    #[derive(Default)]
    pub struct CpuMeter;

    pub fn init_thread() {}

    pub fn snapshot(_want: Want, _cpu: &mut CpuMeter) -> Snapshot {
        let (minute, day) = glitch_core::context::local_clock();
        Snapshot { minute, day, ..Default::default() }
    }

    pub fn now_playing() -> Result<Option<NowPlaying>, String> {
        Err("Glitch can't see what's playing on this computer yet".into())
    }

    pub fn foreground_id() -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only look at this machine (no window is touched). Run with
    /// `cargo test -p glitch context_native -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_snapshot() {
        init_thread();
        #[allow(clippy::default_constructed_unit_structs)]
        let mut cpu = CpuMeter::default();
        let want = Want { media: true, battery: true, cpu: true };
        let _ = snapshot(want, &mut cpu);
        std::thread::sleep(std::time::Duration::from_millis(500));
        let t = std::time::Instant::now();
        let s = snapshot(want, &mut cpu);
        let took = t.elapsed();
        // Classifications only (no titles).
        println!(
            "fg kind {:?} fullscreen {:?}; media {:?}; battery {:?}; cpu {:?}; os_busy {}; idle {:?}; minute {}; took {took:?}",
            s.fg.as_ref().map(|f| f.kind),
            s.fg.as_ref().map(|f| f.fullscreen),
            s.media,
            s.battery,
            s.cpu,
            s.os_busy,
            s.idle_ms,
            s.minute
        );
        assert!(s.minute < 24 * 60);
        assert!(took < std::time::Duration::from_millis(250), "a poll must be cheap: {took:?}");
        println!("now playing available: {:?}", now_playing().map(|p| p.is_some()));
    }
}
