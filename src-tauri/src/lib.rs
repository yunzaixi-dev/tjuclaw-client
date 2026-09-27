mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
