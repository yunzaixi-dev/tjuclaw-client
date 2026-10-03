#[cfg(desktop)]
mod local_sandbox;
#[cfg(all(test, desktop))]
#[path = "../sidecar_build.rs"]
#[allow(dead_code)]
mod sidecar_build_tests;
mod store;
#[cfg(desktop)]
mod workspace_cli;
#[cfg(desktop)]
mod workspace_connector;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 应用内更新只在桌面端可用；Android/iOS 仍通过下载页或应用商店分发。
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());
    let app = builder
        .setup(|app| {
            use tauri::Manager;
            // A store that cannot open must never stop the app from launching;
            // commands then report store_unavailable and the client falls back.
            let dir = app.path().app_data_dir().ok();
            app.manage(store::Store::open_or_unavailable(dir.as_deref()));
            // The desktop app is the TJUClaw web app with native extras: it
            // opens the product origin (sign-in, API and updates work as on
            // the web), preserving Docker extras and adapting the packaged CLI.
            #[cfg(desktop)]
            {
                app.manage(local_sandbox::LocalSandbox::default());
                app.manage(workspace_cli::WorkspaceCli::new(
                    app.path().app_config_dir().ok(),
                ));
                if !cfg!(debug_assertions) {
                    if let (Some(window), Ok(url)) = (
                        app.get_webview_window("main"),
                        "https://app.tjuclaw.cloud/workspace".parse(),
                    ) {
                        let _ = window.navigate(url);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(handlers())
        .build(tauri::generate_context!())
        .expect("failed to run TJUClaw");
    app.run(|app, event| {
        #[cfg(desktop)]
        if matches!(event, tauri::RunEvent::Exit) {
            use tauri::Manager;
            app.state::<workspace_cli::WorkspaceCli>().shutdown();
        }
        #[cfg(mobile)]
        let _ = (app, event);
    });
}

#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        store::store_get,
        store::store_set,
        store::store_delete,
        store::store_list,
        local_sandbox::local_sandbox_status,
        local_sandbox::local_sandbox_prepare,
        local_sandbox::local_sandbox_start,
        local_sandbox::local_sandbox_stop,
        local_sandbox::local_sandbox_turn,
        workspace_cli::workspace_cli_availability,
        workspace_cli::workspace_cli_status,
        workspace_cli::workspace_cli_init,
        workspace_cli::workspace_cli_connector_status,
        workspace_cli::workspace_cli_connector_start,
        workspace_cli::workspace_cli_connector_stop,
        workspace_cli::workspace_cli_configure,
        workspace_cli::workspace_cli_import,
        workspace_cli::workspace_cli_link,
        workspace_cli::workspace_cli_unlink,
        workspace_cli::workspace_cli_allow,
        workspace_cli::workspace_cli_approvals,
        workspace_cli::workspace_cli_review_approval
    ]
}

#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        store::store_get,
        store::store_set,
        store::store_delete,
        store::store_list
    ]
}
