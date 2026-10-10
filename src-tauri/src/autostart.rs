//! "Start with Windows": a value in the current user's `Run` key that points
//! at the installed exe. Off by default; turning it off deletes the value, and
//! the installer's uninstall hook (nsis/hooks.nsh) deletes it too.
//!
//! * Only HKCU is touched (no admin rights, nothing machine-wide).
//! * The value name is `Glitch` for the real app. A build with another
//!   identifier (QA copies, debug builds) gets its own name, so it can never
//!   overwrite or delete the installed Glitch's entry.
//! * Debug builds can point the whole thing at a scratch key with
//!   `GLITCH_AUTOSTART_KEY=Software\SomethingTemporary` for tests.
//! * If the setting is on but the entry is missing or points at an old path
//!   (after an update moved the exe), Glitch rewrites it when it starts.
//!
//! macOS / Linux: not supported yet (`SUPPORTED` is false, the card says so).

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::state::AppState;

pub const SUPPORTED: bool = cfg!(target_os = "windows");

/// The identifier of the released app (tauri.conf.json).
const RELEASE_IDENTIFIER: &str = "dev.glitch.companion";

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// `Glitch` for the real app, `Glitch (<identifier>)` for any other build.
pub fn value_name(identifier: &str) -> String {
    if identifier == RELEASE_IDENTIFIER {
        "Glitch".to_string()
    } else {
        format!("Glitch ({identifier})")
    }
}

/// The command the Run key holds: the exe path in quotes (spaces in
/// "Program Files" or a user name must not split it).
pub fn command_for(exe: &Path) -> String {
    format!("\"{}\"", exe.display())
}

/// Which registry key to use (a scratch one in debug builds, if asked).
fn run_key() -> String {
    if cfg!(debug_assertions) {
        if let Ok(k) = std::env::var("GLITCH_AUTOSTART_KEY") {
            if !k.trim().is_empty() {
                return k;
            }
        }
    }
    RUN_KEY.to_string()
}

fn identifier(app: &AppHandle) -> String {
    app.config().identifier.clone()
}

fn wanted_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("couldn't find Glitch's own file: {e}"))?;
    Ok(command_for(&exe))
}

/// (is Glitch registered to start now, why it couldn't be read).
pub fn status(app: &AppHandle) -> (bool, Option<String>) {
    if !SUPPORTED {
        return (false, None);
    }
    let want = wanted_command().ok();
    match imp::read(&run_key(), &value_name(&identifier(app))) {
        Ok(Some(v)) => (want.as_deref() == Some(v.as_str()), None),
        Ok(None) => (false, None),
        Err(e) => (false, Some(e)),
    }
}

/// Add or remove the entry.
pub fn set(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let (key, name) = (run_key(), value_name(&identifier(app)));
    if enabled {
        imp::write(&key, &name, &wanted_command()?)
    } else {
        imp::delete(&key, &name)
    }
}

/// At start: if the setting is on, make sure the entry is right.
pub fn sync_on_start(app: &AppHandle) {
    if !SUPPORTED || !app.state::<AppState>().settings().safety.start_with_windows {
        return;
    }
    if !status(app).0 {
        if let Err(e) = set(app, true) {
            eprintln!("glitch: couldn't register 'Start with Windows': {e}");
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn err(what: &str, code: u32) -> String {
        format!("{what} failed (Windows error {code})")
    }

    pub fn read(key: &str, name: &str) -> Result<Option<String>, String> {
        let (key, name) = (wide(key), wide(name));
        let mut size = 0u32;
        // SAFETY: valid NUL-terminated strings; the first call only asks for the size.
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if rc != ERROR_SUCCESS {
            return Err(err("reading the startup entry", rc));
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: `buf` is `size` bytes long.
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(err("reading the startup entry", rc));
        }
        let chars = (size as usize / 2).min(buf.len());
        Ok(Some(String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string()))
    }

    pub fn write(key: &str, name: &str, value: &str) -> Result<(), String> {
        let (key, name, data) = (wide(key), wide(name), wide(value));
        let mut hkey: HKEY = std::ptr::null_mut();
        // SAFETY: out-parameter for the opened key; closed below.
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(err("opening the startup list", rc));
        }
        // SAFETY: `data` is a NUL-terminated UTF-16 string of `len` bytes.
        let rc =
            unsafe { RegSetValueExW(hkey, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) };
        unsafe { RegCloseKey(hkey) };
        if rc != ERROR_SUCCESS {
            return Err(err("writing the startup entry", rc));
        }
        Ok(())
    }

    /// Removing something that isn't there is fine.
    pub fn delete(key: &str, name: &str) -> Result<(), String> {
        let (key, name) = (wide(key), wide(name));
        let mut hkey: HKEY = std::ptr::null_mut();
        // SAFETY: as in `write`.
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(err("opening the startup list", rc));
        }
        let rc = unsafe { RegDeleteValueW(hkey, name.as_ptr()) };
        unsafe { RegCloseKey(hkey) };
        if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
            return Err(err("removing the startup entry", rc));
        }
        Ok(())
    }

    /// Tests only: remove a scratch key.
    #[cfg(test)]
    pub fn delete_key(key: &str) {
        use windows_sys::Win32::System::Registry::RegDeleteKeyW;
        let key = wide(key);
        unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr()) };
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn read(_: &str, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn write(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err("not supported on this system".into())
    }
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_app_and_copies_have_different_entries() {
        assert_eq!(value_name("dev.glitch.companion"), "Glitch");
        assert_eq!(value_name("dev.glitch.pause.qa"), "Glitch (dev.glitch.pause.qa)");
        assert_ne!(value_name("dev.glitch.companion"), value_name("dev.glitch.companion.qa"));
    }

    #[test]
    fn the_identifier_matches_tauri_conf() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(&format!("\"identifier\": \"{RELEASE_IDENTIFIER}\"")));
    }

    #[test]
    fn the_command_is_the_quoted_path() {
        let cmd = command_for(Path::new(r"C:\Program Files\Glitch\glitch.exe"));
        assert_eq!(cmd, r#""C:\Program Files\Glitch\glitch.exe""#);
    }

    /// Writes, reads, replaces and deletes a value in a scratch key under
    /// HKCU, never in the real Run key.
    #[cfg(target_os = "windows")]
    #[test]
    fn the_registry_round_trip_in_a_scratch_key() {
        let key = format!(r"Software\GlitchAutostartTest\{}", std::process::id());
        let name = value_name("dev.glitch.test.autostart");
        assert_eq!(imp::read(&key, &name), Ok(None), "nothing there yet");
        imp::write(&key, &name, r#""C:\Program Files\Glitch\glitch.exe""#).unwrap();
        assert_eq!(imp::read(&key, &name).unwrap().as_deref(), Some(r#""C:\Program Files\Glitch\glitch.exe""#));
        // A longer unicode path, then replaced by a shorter one.
        let long = format!("\"C:\\Users\\Zo\u{eb} \u{4e2d}\\{}\\glitch.exe\"", "x".repeat(300));
        imp::write(&key, &name, &long).unwrap();
        assert_eq!(imp::read(&key, &name).unwrap().as_deref(), Some(long.as_str()));
        imp::write(&key, &name, "\"C:\\g.exe\"").unwrap();
        assert_eq!(imp::read(&key, &name).unwrap().as_deref(), Some("\"C:\\g.exe\""));
        imp::delete(&key, &name).unwrap();
        assert_eq!(imp::read(&key, &name), Ok(None));
        imp::delete(&key, &name).unwrap(); // already gone: fine
        imp::delete_key(&key);
        imp::delete_key(r"Software\GlitchAutostartTest");
    }
}
