// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod platform;
mod shell;
mod transport;

use app::{Transport, TunnelControl};

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn send(&self, request: &temperance_core::HttpRequest) -> Result<(u16, String), String> {
        (**self).send(request)
    }
    fn probe(
        &self,
        request: &temperance_core::HttpRequest,
    ) -> Result<(u16, Option<String>, String), String> {
        (**self).probe(request)
    }
}

impl<W: TunnelControl + ?Sized> TunnelControl for Box<W> {
    fn up(&self, config: &std::path::Path) -> Result<(), String> {
        (**self).up(config)
    }
    fn down(&self, config: &std::path::Path) -> Result<(), String> {
        (**self).down(config)
    }
    fn is_up(&self) -> bool {
        (**self).is_up()
    }
    fn handshake_age(&self) -> Option<u64> {
        (**self).handshake_age()
    }
}

fn main() {
    let dir = platform::data_dir(std::env::args().skip(1), |name| std::env::var_os(name));
    std::fs::create_dir_all(&dir).expect("create data directory");
    let app = app::App::new(
        dir,
        Box::new(transport::Https::system()) as Box<dyn Transport + Send>,
        platform::tunnel(),
    )
    .expect("load identity");
    shell::builder(tauri::Builder::default(), app)
        .run(tauri::generate_context!())
        .expect("run Temperance");
}

#[cfg(test)]
mod tests;
