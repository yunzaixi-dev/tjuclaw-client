mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 应用内更新只在桌面端可用；Android/iOS 仍通过下载页或应用商店分发。
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .setup(|app| {
            use tauri::Manager;
            // A store that cannot open must never stop the app from launching;
            // commands then report store_unavailable and the client falls back.
            let dir = app.path().app_data_dir().ok();
            app.manage(store::Store::open_or_unavailable(dir.as_deref()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store::store_get,
            store::store_set,
            store::store_delete,
            store::store_list
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TJUClaw");
}
