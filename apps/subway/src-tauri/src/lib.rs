mod bridge;

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

const DEFAULT_SUBWAY_URL: &str = "https://staticquasar931.github.io/SubwaySurfers/";
const WRAPPER_INIT_SCRIPT: &str = include_str!("wrapper.js");

fn wrapper_init_script() -> String {
    #[cfg(debug_assertions)]
    {
        format!("window.__SUBWAY_DEBUG__ = true;\n{WRAPPER_INIT_SCRIPT}")
    }
    #[cfg(not(debug_assertions))]
    {
        WRAPPER_INIT_SCRIPT.to_string()
    }
}

fn target_url() -> Url {
    let raw = std::env::var("SUBWAY_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SUBWAY_URL.to_string());

    raw.parse::<Url>()
        .unwrap_or_else(|_| DEFAULT_SUBWAY_URL.parse().expect("valid default URL"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let state = bridge::start(app.handle().clone())?;
            app.manage(state);

            let url = target_url();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Subway Surfers")
                .inner_size(430.0, 820.0)
                .min_inner_size(340.0, 560.0)
                .center()
                .initialization_script_for_all_frames(wrapper_init_script())
                .on_new_window(|_url, _features| NewWindowResponse::Deny)
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        if let Some(api_state) = window.try_state::<bridge::ApiState>() {
                            if let Some(latest) = api_state.latest() {
                                bridge::push_state_to_window(&window, &latest);
                            }
                        }
                    }
                })
                .build()?;

            let always_on_top_item = CheckMenuItemBuilder::with_id("always_on_top", "Always on Top")
                .checked(false)
                .accelerator("CmdOrCtrl+Shift+T")
                .build(app)?;
            let toggle_pause_item = MenuItemBuilder::with_id("toggle_pause", "Pause / Resume")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?;
            let reload_item = MenuItemBuilder::with_id("reload_game", "Reload Game")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let reset_url_item =
                MenuItemBuilder::with_id("reset_default", "Reset to Subway Surfers").build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Subway Surfers")
                .about(None)
                .separator()
                .quit()
                .build()?;
            let game_menu = SubmenuBuilder::new(app, "Game")
                .item(&toggle_pause_item)
                .item(&always_on_top_item)
                .separator()
                .item(&reload_item)
                .item(&reset_url_item)
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&game_menu)
                .item(&edit_menu)
                .build()?;
            app.set_menu(menu)?;

            let aot_handle = always_on_top_item.clone();
            let win_handle = window.clone();
            app.on_menu_event(move |_app, event| match event.id().as_ref() {
                "always_on_top" => {
                    let next = aot_handle.is_checked().unwrap_or(false);
                    let _ = win_handle.set_always_on_top(next);
                }
                "toggle_pause" => {
                    let _ = win_handle.eval("window.__SUBWAY_WRAPPER__?.toggleManualPause();");
                }
                "reload_game" => {
                    let _ = win_handle.eval("window.location.reload();");
                }
                "reset_default" => {
                    if let Ok(default_url) = DEFAULT_SUBWAY_URL.parse::<Url>() {
                        let _ = win_handle.navigate(default_url);
                    }
                }
                _ => {}
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Subway Surfers Wrapper")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                bridge::cleanup();
            }
        });
}
