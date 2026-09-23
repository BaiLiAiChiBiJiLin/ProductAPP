//! Small loopback-only API for integrations that need to submit an SVG path.
//! The actual import remains in the existing WebView flow so batch state and
//! streamed progress behave exactly like a file picker upload.
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf}, thread};
use tauri::{AppHandle, Emitter};

pub const DEFAULT_PORT: u16 = 47821;
const PORT_ATTEMPTS: u16 = 20;
const MAX_BODY: usize = 16 * 1024;
const MAX_SVG_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone)]
struct ImportRequest { path: String }

fn response(stream: &mut TcpStream, status: &str, body: serde_json::Value) {
    let bytes = body.to_string().into_bytes();
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n", bytes.len());
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&bytes);
}

fn handle(mut stream: TcpStream, app: &AppHandle, port: u16) {
    let mut bytes = Vec::with_capacity(4096);
    let mut buffer = [0u8; 4096];
    loop {
        let Ok(count) = stream.read(&mut buffer) else { return };
        if count == 0 { return }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_BODY || bytes.windows(4).any(|window| window == b"\r\n\r\n") { break }
    }
    let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        response(&mut stream, "400 Bad Request", serde_json::json!({"error":"请求头不完整"})); return;
    };
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header.lines();
    let Some(request_line) = lines.next() else { return };
    if request_line == "GET /api/health HTTP/1.1" || request_line == "GET /api/port HTTP/1.1" {
        response(&mut stream, "200 OK", serde_json::json!({"ok":true,"service":"printflow","host":"127.0.0.1","port":port,"url":format!("http://127.0.0.1:{port}")})); return;
    }
    if !request_line.starts_with("POST /api/import-svg HTTP/") {
        response(&mut stream, "404 Not Found", serde_json::json!({"error":"接口不存在"})); return;
    }
    let content_length = lines.find_map(|line| line.strip_prefix("Content-Length:").and_then(|value| value.trim().parse::<usize>().ok())).unwrap_or(0);
    if content_length == 0 || content_length > MAX_BODY { response(&mut stream, "413 Payload Too Large", serde_json::json!({"error":"请求体过大或为空"})); return; }
    let mut body = bytes[header_end + 4..].to_vec();
    while body.len() < content_length {
        let Ok(count) = stream.read(&mut buffer) else { return };
        if count == 0 { break }
        body.extend_from_slice(&buffer[..count]);
    }
    let Ok(request) = serde_json::from_slice::<ImportRequest>(&body[..body.len().min(content_length)]) else {
        response(&mut stream, "400 Bad Request", serde_json::json!({"error":"请求必须是 {path: string}"})); return;
    };
    let path = PathBuf::from(request.path.trim());
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("svg")) {
        response(&mut stream, "400 Bad Request", serde_json::json!({"error":"path 必须是绝对 SVG 文件路径"})); return;
    }
    let Ok(metadata) = std::fs::metadata(&path) else { response(&mut stream, "404 Not Found", serde_json::json!({"error":"SVG 文件不存在"})); return };
    if !metadata.is_file() { response(&mut stream, "400 Bad Request", serde_json::json!({"error":"path 不是文件"})); return }
    if metadata.len() > MAX_SVG_BYTES { response(&mut stream, "413 Payload Too Large", serde_json::json!({"error":"SVG 超过 500MB 限制"})); return }
    app.emit("external-svg-import", ImportRequest { path: path.to_string_lossy().into_owned() }).ok();
    response(&mut stream, "202 Accepted", serde_json::json!({"accepted":true,"path":path}));
}

pub fn start(app: AppHandle, status_path: &Path) -> std::io::Result<u16> {
    let (listener, port) = (0..PORT_ATTEMPTS).find_map(|offset| {
        let port = DEFAULT_PORT.saturating_add(offset);
        TcpListener::bind(("127.0.0.1", port)).ok().map(|listener| (listener, port))
    }).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrInUse, "本地 API 备用端口全部被占用"))?;
    if let Some(parent) = status_path.parent() { fs::create_dir_all(parent)?; }
    let temp = status_path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&serde_json::json!({
        "host": "127.0.0.1", "port": port, "url": format!("http://127.0.0.1:{port}")
    })).map_err(std::io::Error::other)?)?;
    fs::rename(temp, status_path)?;
    thread::Builder::new().name("printflow-local-api".into()).spawn(move || {
        for stream in listener.incoming().flatten() { handle(stream, &app, port); }
    }).map(|_| port)
}
