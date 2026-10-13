//! The Tauri window around `App`: two commands for the UI, a background tick
//! that pushes fresh views, and the parent's dashboard window.
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{Emitter, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::app::{open_browser, Action, App, Transport, TunnelControl, View};

pub type DesktopApp = App<Box<dyn Transport + Send>, Box<dyn TunnelControl + Send>>;
pub struct Shared(pub Mutex<DesktopApp>);

pub const DASHBOARD: &str = "dashboard";

impl Shared {
    /// A panic in one action must not lock the window out of every later one.
    fn lock(&self) -> MutexGuard<'_, DesktopApp> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[tauri::command]
fn view(state: tauri::State<'_, Shared>) -> View {
    state.lock().view()
}

/// Runs on a blocking thread: enrolling and pairing wait on the network, the
/// parent session starts its own async runtime, and the dashboard window can
/// only be created off the main thread on Windows.
#[tauri::command]
async fn act<R: Runtime>(handle: tauri::AppHandle<R>, action: Action) -> Result<View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Shared>();
        let mut app = state.lock();
        app.act(action);
        if let Some(url) = app.dashboard.take() {
            if let Err(e) = open_dashboard(&handle, &url) {
                app.status = format!("Can't open the dashboard window: {e}");
            }
        }
        app.view()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Background work every 5 seconds: end Wi-Fi sign-in windows, and refresh policy every 30 s.
pub fn tick<T: Transport, W: TunnelControl>(app: &mut App<T, W>, count: u64) {
    if let Err(e) = app.check_portal() {
        app.status = e;
    }
    if count % 6 == 0 && app.identity.is_some() && app.portal_until.is_none() {
        app.background_refresh();
    }
}

/// Only the session's own loopback address loads in the dashboard window.
pub fn same_origin(start: &Url, url: &Url) -> bool {
    url.scheme() == start.scheme()
        && url.host_str() == start.host_str()
        && url.port_or_known_default() == start.port_or_known_default()
}

/// Whether the dashboard window may follow a link; web links elsewhere go to `browse`.
pub fn navigation_allowed(home: &Url, url: &Url, browse: impl Fn(&str)) -> bool {
    if same_origin(home, url) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https") {
        browse(url.as_str());
    }
    false
}

/// Locks the app, lets `work` change it, and pushes the resulting view to the UI.
pub fn push_view<R: Runtime>(handle: &tauri::AppHandle<R>, work: impl FnOnce(&mut DesktopApp)) {
    let view = {
        let state = handle.state::<Shared>();
        let mut app = state.lock();
        work(&mut app);
        app.view()
    };
    let _ = handle.emit("view", view);
}

/// Shows the dashboard through the local proxy in its own window, with no
/// stored cookies; links elsewhere open in the browser.
fn open_dashboard<R: Runtime>(handle: &tauri::AppHandle<R>, url: &str) -> Result<(), String> {
    let start: Url = url
        .parse()
        .map_err(|e| format!("Bad dashboard address: {e}"))?;
    if let Some(window) = handle.get_webview_window(DASHBOARD) {
        window.navigate(start).map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let home = start.clone();
    let window = WebviewWindowBuilder::new(handle, DASHBOARD, WebviewUrl::External(start))
        .title("Family dashboard")
        .inner_size(1200.0, 820.0)
        .min_inner_size(380.0, 560.0)
        .incognito(true)
        .on_navigation(move |url| {
            navigation_allowed(&home, url, |link| {
                let _ = open_browser(link);
            })
        })
        .build()
        .map_err(|e| e.to_string())?;
    let handle = handle.clone();
    window.on_window_event(move |event| dashboard_event(&handle, event));
    Ok(())
}

pub fn dashboard_event<R: Runtime>(handle: &tauri::AppHandle<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        // Off the main thread: an action holding the lock may be waiting on it.
        let handle = handle.clone();
        std::thread::spawn(move || push_view(&handle, |app| app.dashboard_closed()));
    }
}

/// The commands and setup shared by the real app and the command tests.
pub fn builder<R: Runtime>(base: tauri::Builder<R>, app: DesktopApp) -> tauri::Builder<R> {
    base.manage(Shared(Mutex::new(app)))
        .invoke_handler(tauri::generate_handler![view, act])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut count = 0u64;
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    count = count.wrapping_add(1);
                    push_view(&handle, |app| tick(app, count));
                }
            });
            Ok(())
        })
}
