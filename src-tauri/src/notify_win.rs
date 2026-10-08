//! Windows' notification feed (UserNotificationListener) as a
//! [`NotificationSource`].
//!
//! Package identity: the research doc expected this API to need a sparse
//! package. The spike (2026-10-07, Windows 11 26200) showed that an
//! unpackaged exe gets `Allowed` from GetAccessStatus and can read toasts,
//! as long as "Notifications access" for desktop apps is on in Settings >
//! Privacy & security > Notifications. If Windows reports `Denied` (or the
//! call fails, e.g. on older builds), the feature says so in Settings and
//! stays quiet; a sparse package (see docs/update-me.md) is the fix there.
//!
//! Only toasts are read, by polling (every few seconds) and diffing ids;
//! no background task registration.

use glitch_core::update_me::notifications::{Access, NotificationSource, Toast};
use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};

pub struct WindowsSource;

fn status() -> Access {
    let Ok(l) = UserNotificationListener::Current() else { return Access::Unavailable };
    match l.GetAccessStatus() {
        Ok(UserNotificationListenerAccessStatus::Allowed) => Access::Allowed,
        Ok(UserNotificationListenerAccessStatus::Denied) => Access::Denied,
        Ok(_) => Access::Unspecified,
        Err(_) => Access::Unavailable,
    }
}

/// FILETIME ticks (100 ns since 1601) -> unix seconds.
fn unix(ticks: i64) -> i64 {
    (ticks - 116_444_736_000_000_000) / 10_000_000
}

fn read(n: &UserNotification) -> windows::core::Result<Toast> {
    let app = n.AppInfo()?.DisplayInfo()?.DisplayName()?.to_string();
    let binding = n.Notification()?.Visual()?.GetBinding(&KnownNotificationBindings::ToastGeneric()?)?;
    let texts: Vec<String> =
        binding.GetTextElements()?.into_iter().filter_map(|t| t.Text().ok().map(|s| s.to_string())).collect();
    let title = texts.first().cloned().unwrap_or_default();
    let body = texts.get(1..).map(|r| r.join(" ")).unwrap_or_default();
    Ok(Toast { id: n.Id()?, app, title, body, arrived: unix(n.CreationTime()?.UniversalTime) })
}

impl NotificationSource for WindowsSource {
    fn access(&self) -> Access {
        status()
    }

    /// Shows Windows' consent prompt if it hasn't been answered. The prompt
    /// is asynchronous: callers check [`access`](Self::access) again later.
    fn request_access(&self) -> Access {
        if status() == Access::Unspecified {
            if let Ok(l) = UserNotificationListener::Current() {
                let _ = l.RequestAccessAsync();
            }
        }
        status()
    }

    fn current(&self) -> Result<Vec<Toast>, String> {
        let l = UserNotificationListener::Current().map_err(|e| e.message().to_string())?;
        let list = l
            .GetNotificationsAsync(NotificationKinds::Toast)
            .and_then(|op| op.join())
            .map_err(|e| e.message().to_string())?;
        // A toast without the usual text layout is skipped, not an error.
        Ok(list.into_iter().filter_map(|n| read(&n).ok()).collect())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn filetime_to_unix() {
        assert_eq!(super::unix(116_444_736_000_000_000), 0);
        assert_eq!(super::unix(116_444_736_000_000_000 + 10_000_000 * 60), 60);
    }
}
