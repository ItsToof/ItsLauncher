use futures_util::{stream, StreamExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::io::{Read, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::{fs, io::{AsyncBufReadExt, AsyncSeekExt, AsyncWriteExt}, process::Command};

const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const ASSETS_URL: &str = "https://resources.download.minecraft.net";
const MODRINTH_API: &str = "https://api.modrinth.com/v2";

const OS_NAME: &str = if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "macos") {
    "osx"
} else {
    "linux"
};
const CP_SEP: &str = if cfg!(windows) { ";" } else { ":" };

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}
fn net_err(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(c) = src {
        msg = format!("{msg}: {c}");
        src = c.source();
    }
    msg
}
fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}
fn log(app: &AppHandle, msg: impl Into<String>) {
    let _ = app.emit("stage", msg.into());
}
fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = reqwest::Client::builder()
        .user_agent("ItsLauncher/0.2 (personal project)")
        .connect_timeout(Duration::from_secs(15))
        .tcp_nodelay(true)
        .pool_max_idle_per_host(32)
        .build()
        .map_err(err)?;
    Ok(CLIENT.get_or_init(|| c).clone())
}
fn direct_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = reqwest::Client::builder()
        .user_agent("ItsLauncher/0.2 (personal project)")
        .connect_timeout(Duration::from_secs(15))
        .no_proxy()
        .build()
        .map_err(err)?;
    Ok(CLIENT.get_or_init(|| c).clone())
}
static CANCEL: AtomicBool = AtomicBool::new(false);
const CANCELLED: &str = "Отменено пользователем";
fn cancelled() -> bool {
    CANCEL.load(Ordering::Relaxed)
}
fn reset_cancel() {
    CANCEL.store(false, Ordering::Relaxed);
}
#[tauri::command]
fn cancel_task() {
    CANCEL.store(true, Ordering::Relaxed);
}

fn nerr(e: reqwest::Error) -> String {
    use std::error::Error;
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(c) = src {
        let t = c.to_string();
        if !out.contains(&t) {
            out.push_str(": ");
            out.push_str(&t);
        }
        src = c.source();
    }
    out
}
fn game_root() -> Result<PathBuf, String> {
    Ok(dirs::data_dir()
        .ok_or("Не найдена папка AppData")?
        .join(".itslauncher"))
}
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}
async fn parse_resp(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(err)?;
    if !status.is_success() {
        return Err(format!("{status}: {text}"));
    }
    serde_json::from_str(&text).map_err(err)
}
async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    parse_resp(client.get(url).send().await.map_err(err)?).await
}
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: Value,
) -> Result<(reqwest::StatusCode, String), String> {
    let send = |c: &reqwest::Client| {
        c.post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.to_string())
            .send()
    };
    let r = match send(client).await {
        Err(e) if e.is_connect() => send(&direct_client()?).await.map_err(|_| net_err(e))?,
        r => r.map_err(net_err)?,
    };
    let st = r.status();
    let t = r.text().await.map_err(net_err)?;
    Ok((st, t))
}
fn safe_rel_path(p: &str) -> Option<PathBuf> {
    let path = Path::new(p);
    if path.is_absolute() {
        return None;
    }
    for c in path.components() {
        if !matches!(c, Component::Normal(_)) {
            return None;
        }
    }
    Some(path.to_path_buf())
}
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Err("Некорректный идентификатор".into())
    } else {
        Ok(())
    }
}
fn open_target(t: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", t])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(t).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(t).spawn();
}

#[derive(Serialize, Deserialize, Clone)]
struct VersionEntry {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    url: String,
}
#[derive(Deserialize)]
struct Manifest {
    versions: Vec<VersionEntry>,
}
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Instance {
    id: String,
    name: String,
    mc_version: String,
    loader: String,
    loader_version: String,
    icon: Option<String>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    played: u64,
    #[serde(default)]
    last_played: u64,
    #[serde(default)]
    settings: Option<Value>,
    #[serde(default)]
    source_project: Option<String>,
    #[serde(default)]
    source_version: Option<String>,
    #[serde(default)]
    pack_detached: bool,
    #[serde(default)]
    created: u64,
    #[serde(default)]
    pack_files: Vec<String>,
}
#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}
struct Task {
    url: String,
    path: PathBuf,
    sha1: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Default)]
struct StoredAccount {
    id: String,
    name: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    client_token: String,
}
#[derive(Serialize, Deserialize, Default)]
struct AccountStore {
    accounts: Vec<StoredAccount>,
    active: Option<String>,
}
#[derive(Serialize)]
struct AccountView {
    id: String,
    name: String,
    kind: String,
}
#[derive(Serialize)]
struct AccountsInfo {
    accounts: Vec<AccountView>,
    active: Option<String>,
}

fn sha1_of(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(to_hex(hasher.finalize().as_slice()))
}

async fn file_sha1(path: &Path) -> Result<String, String> {
    let p = path.to_path_buf();
    tokio::task::spawn_blocking(move || sha1_of(&p)).await.map_err(err)?.ok_or_else(|| "Не удалось прочитать файл".to_string())
}
async fn stream_body(resp: reqwest::Response, tmp: &Path) -> Result<(), String> {
    let mut file = fs::File::create(tmp).await.map_err(err)?;
    let mut body = resp.bytes_stream();
    loop {
        if cancelled() {
            drop(file);
            let _ = fs::remove_file(tmp).await;
            return Err(CANCELLED.into());
        }
        match tokio::time::timeout(Duration::from_secs(30), body.next()).await {
            Err(_) => {
                drop(file);
                let _ = fs::remove_file(tmp).await;
                return Err("сервер перестал отвечать (таймаут 30 с)".into());
            }
            Ok(None) => break,
            Ok(Some(chunk)) => {
                let c = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        drop(file);
                        let _ = fs::remove_file(tmp).await;
                        return Err(nerr(e));
                    }
                };
                file.write_all(&c).await.map_err(err)?;
            }
        }
    }
    file.flush().await.map_err(err)?;
    Ok(())
}
async fn download(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    sha1: Option<&str>,
) -> Result<(), String> {
    if path.exists() {
        match sha1 {
            Some(h) => {

                let by_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().eq_ignore_ascii_case(h))
                    .unwrap_or(false);
                if by_name && std::fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false) {
                    return Ok(());
                }
                if let Ok(cur) = file_sha1(path).await {
                    if cur.eq_ignore_ascii_case(h) {
                        return Ok(());
                    }
                }
            }
            None => return Ok(()),
        }
    }
    if cancelled() {
        return Err(CANCELLED.into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(err)?;
    }
    let resp = client.get(url).send().await.map_err(nerr)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".part");
    let tmp = PathBuf::from(tmp_name);
    stream_body(resp, &tmp).await?;
    fs::rename(&tmp, path).await.map_err(err)?;
    Ok(())
}
async fn download_all(
    app: &AppHandle,
    client: &reqwest::Client,
    tasks: Vec<Task>,
) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    let tasks: Vec<Task> = tasks
        .into_iter()
        .filter(|t| seen.insert(t.path.clone()))
        .collect();
    let total = tasks.len();
    log(app, format!("Проверка и загрузка файлов: {total}"));
    let _ = app.emit("progress", Progress { done: 0, total });
    let c2 = client.clone();
    let mut results = stream::iter(tasks)
        .map(move |t| {
            let c = c2.clone();
            async move {
                let mut last: Result<(), String> = Ok(());
                for attempt in 0..3u64 {
                    last = download(&c, &t.url, &t.path, t.sha1.as_deref()).await;
                    match &last {
                        Ok(_) => break,
                        Err(e) if e == CANCELLED => break,
                        _ => tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await,
                    }
                }
                last.map_err(|e| if e == CANCELLED { e } else { format!("{}: {e}", t.url) })
            }
        })
        .buffer_unordered(32);
    let mut done = 0usize;
    while let Some(r) = results.next().await {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        r?;
        done += 1;
        if done % 10 == 0 || done == total {
            let _ = app.emit("progress", Progress { done, total });
        }
    }
    Ok(())
}

fn os_matches(os: &Value) -> bool {
    if let Some(name) = os["name"].as_str() {
        if name != OS_NAME {
            return false;
        }
    }
    match os["arch"].as_str() {
        Some("x86") => cfg!(target_arch = "x86"),
        Some("arm64") => cfg!(target_arch = "aarch64"),
        _ => true,
    }
}
fn rules_allow(rules: Option<&Vec<Value>>) -> bool {
    let Some(rules) = rules else { return true };
    let mut allowed = false;
    for r in rules {
        let is_allow = r["action"].as_str() == Some("allow");
        let os_ok = match r.get("os") {
            Some(os) => os_matches(os),
            None => true,
        };
        let no_features = r.get("features").is_none();
        if os_ok && no_features {
            allowed = is_allow;
        }
    }
    allowed
}
fn collect_args(list: &[Value]) -> Vec<String> {
    let mut out = vec![];
    for a in list {
        match a {
            Value::String(x) => out.push(x.clone()),
            Value::Object(o) => {
                if rules_allow(o.get("rules").and_then(|r| r.as_array())) {
                    match &o["value"] {
                        Value::String(x) => out.push(x.clone()),
                        Value::Array(arr) => {
                            for x in arr {
                                if let Some(x) = x.as_str() {
                                    out.push(x.to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}
fn maven_path(name: &str) -> Option<String> {
    let name = name.split('@').next()?;
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let (art, ver) = (parts[1], parts[2]);
    let file = if parts.len() > 3 {
        format!("{art}-{ver}-{}.jar", parts[3])
    } else {
        format!("{art}-{ver}.jar")
    };
    Some(format!("{group}/{art}/{ver}/{file}"))
}

fn offline_uuid(name: &str) -> String {
    let mut b = md5::compute(format!("OfflinePlayer:{name}")).0;
    b[6] = (b[6] & 0x0f) | 0x30;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = to_hex(&b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
fn extract_natives(jar: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(jar).map_err(err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(err)?;
    std::fs::create_dir_all(dest).map_err(err)?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(err)?;
        if f.is_dir() {
            continue;
        }
        let Some(entry_path) = f.enclosed_name() else { continue };
        if entry_path.starts_with("META-INF") {
            continue;
        }
        let Some(file_name) = entry_path.file_name() else { continue };
        let mut out = std::fs::File::create(dest.join(file_name)).map_err(err)?;
        std::io::copy(&mut f, &mut out).map_err(err)?;
    }
    Ok(())
}

fn instances_dir(root: &Path) -> PathBuf {
    root.join("instances")
}
fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() {
        "instance".into()
    } else {
        t
    }
}
fn unique_name(root: &Path, name: &str, except: Option<&str>) -> String {
    let taken: Vec<String> = std::fs::read_dir(instances_dir(root))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let i: Instance = serde_json::from_str(&std::fs::read_to_string(e.path().join("instance.json")).ok()?).ok()?;
                    if Some(i.id.as_str()) == except { None } else { Some(i.name.to_lowercase()) }
                })
                .collect()
        })
        .unwrap_or_default();
    let mut n = name.to_string();
    let mut k = 2;
    while taken.contains(&n.to_lowercase()) {
        n = format!("{name} ({k})");
        k += 1;
    }
    n
}
fn unique_id(root: &Path, name: &str) -> String {
    let base = slugify(name);
    let mut id = base.clone();
    let mut n = 2;
    while instances_dir(root).join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}
fn born(dir: &Path) -> u64 {
    std::fs::metadata(dir)
        .and_then(|m| m.created().or_else(|_| m.modified()))
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}
fn save_instance(root: &Path, inst: &Instance) -> Result<(), String> {
    let dir = instances_dir(root).join(&inst.id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut inst = inst.clone();
    if inst.created == 0 {
        inst.created = born(&dir);
    }
    let text = serde_json::to_string_pretty(&inst).map_err(err)?;
    std::fs::write(dir.join("instance.json"), text).map_err(err)
}
fn load_instance(root: &Path, id: &str) -> Result<Instance, String> {
    check_id(id)?;
    let t = std::fs::read_to_string(instances_dir(root).join(id).join("instance.json"))
        .map_err(|_| "Сборка не найдена".to_string())?;
    serde_json::from_str(&t).map_err(err)
}
async fn fetch_manifest(client: &reqwest::Client) -> Result<Manifest, String> {
    let v = get_json(client, MANIFEST_URL).await?;
    serde_json::from_value(v).map_err(err)
}
async fn latest_loader(client: &reqwest::Client, loader: &str, mc: &str) -> Result<String, String> {
    match loader {
        "fabric" | "quilt" => {
            let url = if loader == "fabric" {
                format!("https://meta.fabricmc.net/v2/versions/loader/{mc}")
            } else {
                format!("https://meta.quiltmc.org/v3/versions/loader/{mc}")
            };
            let v = get_json(client, &url).await?;
            v[0]["loader"]["version"]
                .as_str()
                .map(String::from)
                .ok_or_else(|| format!("Для Minecraft {mc} нет загрузчика {loader}"))
        }
        "forge" => {
            let v = get_json(client, "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json").await?;
            let p = &v["promos"];
            p[format!("{mc}-recommended")]
                .as_str()
                .or_else(|| p[format!("{mc}-latest")].as_str())
                .map(String::from)
                .ok_or_else(|| format!("Для Minecraft {mc} нет Forge"))
        }
        "neoforge" => {
            let v = get_json(client, "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge").await?;
            let mut it = mc.split('.').skip(1);
            let minor = it.next().unwrap_or("0");
            let patch = it.next().unwrap_or("0");
            let prefix = format!("{minor}.{patch}.");
            let list: Vec<&str> = v["versions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str())
                .filter(|x| x.starts_with(&prefix))
                .collect();
            list.iter()
                .rev()
                .find(|x| !x.contains("beta") && !x.contains("alpha"))
                .or(list.last())
                .map(|x| x.to_string())
                .ok_or_else(|| format!("Для Minecraft {mc} нет NeoForge"))
        }
        other => Err(format!("Загрузчик {other} не поддерживается")),
    }
}
async fn vanilla_json(client: &reqwest::Client, root: &Path, mc: &str) -> Result<Value, String> {
    let vpath = root.join("versions").join(mc).join(format!("{mc}.json"));
    if !vpath.exists() {
        let m = fetch_manifest(client).await?;
        let entry = m
            .versions
            .iter()
            .find(|v| v.id == mc)
            .ok_or_else(|| format!("Версия {mc} не найдена"))?;
        download(client, &entry.url, &vpath, None).await?;
    }
    serde_json::from_str(&fs::read_to_string(&vpath).await.map_err(err)?).map_err(err)
}
fn merge_profile(v: &mut Value, l: &Value) {
    let key = |x: &Value| {
        let mut p = x["name"].as_str().unwrap_or("").split(':');
        format!("{}:{}:{}", p.next().unwrap_or(""), p.next().unwrap_or(""), p.nth(1).unwrap_or(""))
    };
    let mut libs: Vec<Value> = l["libraries"].as_array().cloned().unwrap_or_default();
    let keys: std::collections::HashSet<String> = libs.iter().map(&key).collect();
    libs.extend(
        v["libraries"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|x| !keys.contains(&key(x))),
    );
    v["libraries"] = Value::Array(libs);
    if let Some(m) = l["mainClass"].as_str() {
        v["mainClass"] = m.into();
    }
    if let Some(a) = l["minecraftArguments"].as_str() {
        v["minecraftArguments"] = a.into();
    }
    for k in ["jvm", "game"] {
        if l["arguments"][k].is_array() {
            let mut a = v["arguments"][k].as_array().cloned().unwrap_or_default();
            a.extend(l["arguments"][k].as_array().cloned().unwrap_or_default());
            v["arguments"][k] = Value::Array(a);
        }
    }
}
async fn resolve_version(
    client: &reqwest::Client,
    root: &Path,
    inst: &Instance,
    vanilla: Value,
    profile: Option<&str>,
) -> Result<Value, String> {
    let mut v = vanilla;
    let (mc, lv) = (&inst.mc_version, &inst.loader_version);
    match inst.loader.as_str() {
        "fabric" | "quilt" => {
            let url = if inst.loader == "fabric" {
                format!("https://meta.fabricmc.net/v2/versions/loader/{mc}/{lv}/profile/json")
            } else {
                format!("https://meta.quiltmc.org/v3/versions/loader/{mc}/{lv}/profile/json")
            };
            let lpath = root.join("versions").join(format!("{}-{lv}-{mc}", inst.loader)).join("profile.json");
            download(client, &url, &lpath, None).await?;
            let l: Value = serde_json::from_str(&fs::read_to_string(&lpath).await.map_err(err)?).map_err(err)?;
            merge_profile(&mut v, &l);
        }
        "forge" | "neoforge" => {
            let p = profile.ok_or("Профиль загрузчика не установлен")?;
            let lpath = root.join("versions").join(p).join(format!("{p}.json"));
            let l: Value = serde_json::from_str(&fs::read_to_string(&lpath).await.map_err(err)?).map_err(err)?;
            merge_profile(&mut v, &l);
        }
        _ => {}
    }
    Ok(v)
}
fn store_path(root: &Path) -> PathBuf {
    root.join("accounts.json")
}
fn load_store(root: &Path) -> AccountStore {
    std::fs::read_to_string(store_path(root))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}
fn save_store(root: &Path, st: &AccountStore) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(err)?;
    let t = serde_json::to_string_pretty(st).map_err(err)?;
    let tmp = store_path(root).with_extension("json.tmp");
    std::fs::write(&tmp, t).map_err(err)?;
    std::fs::rename(&tmp, store_path(root)).map_err(err)
}
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn update_store<T>(root: &Path, f: impl FnOnce(&mut AccountStore) -> T) -> Result<T, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut st = load_store(root);
    let out = f(&mut st);
    save_store(root, &st)?;
    Ok(out)
}
fn offline_account(name: &str) -> StoredAccount {
    StoredAccount { id: offline_uuid(name), name: name.into(), kind: "offline".into(), ..Default::default() }
}
#[tauri::command]
async fn list_accounts() -> Result<AccountsInfo, String> {

    let st = update_store(&game_root()?, |st| {
        if st.accounts.is_empty() {
            st.accounts.push(offline_account("Player"));
        }
        let valid = st.active.as_ref().is_some_and(|id| st.accounts.iter().any(|a| &a.id == id));
        if !valid {
            st.active = st.accounts.first().map(|a| a.id.clone());
        }
        AccountStore { accounts: st.accounts.clone(), active: st.active.clone() }
    })?;
    Ok(AccountsInfo {
        accounts: st
            .accounts
            .iter()
            .map(|a| AccountView {
                id: a.id.clone(),
                name: a.name.clone(),
                kind: if a.kind.is_empty() { "ms".into() } else { a.kind.clone() },
            })
            .collect(),
        active: st.active,
    })
}
#[tauri::command]
fn set_active_account(id: Option<String>) -> Result<(), String> {
    update_store(&game_root()?, |st| {
        if id.as_ref().map_or(true, |i| st.accounts.iter().any(|a| &a.id == i)) {
            st.active = id;
        }
    })
}
#[tauri::command]
fn remove_account(id: String) -> Result<(), String> {
    update_store(&game_root()?, |st| {
        st.accounts.retain(|a| a.id != id);
        if st.active.as_deref() == Some(id.as_str()) {
            st.active = st.accounts.first().map(|a| a.id.clone());
        }
    })
}

#[tauri::command]
async fn get_versions() -> Result<Vec<VersionEntry>, String> {
    let m = fetch_manifest(&http_client()?).await?;
    Ok(m.versions)
}
#[tauri::command]
async fn list_instances() -> Result<Vec<Instance>, String> {
    let dir = instances_dir(&game_root()?);
    let mut out: Vec<Instance> = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(t) = std::fs::read_to_string(e.path().join("instance.json")) {
                if let Ok(mut i) = serde_json::from_str::<Instance>(&t) {
                    if i.created == 0 {
                        i.created = born(&e.path());
                    }
                    out.push(i);
                }
            }
        }
    }
    out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}
#[tauri::command]
async fn create_instance(name: String, mc_version: String, loader: String) -> Result<Instance, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Введите название сборки".into());
    }
    let client = http_client()?;
    let root = game_root()?;
    let loader_version = if loader == "vanilla" {
        String::new()
    } else {
        latest_loader(&client, &loader, &mc_version).await?
    };
    let inst = Instance {
        id: unique_id(&root, &name),
        name: unique_name(&root, &name, None),
        mc_version,
        loader,
        loader_version,
        ..Default::default()
    };
    save_instance(&root, &inst)?;
    Ok(inst)
}
#[tauri::command]
async fn delete_instance(id: String) -> Result<(), String> {
    check_id(&id)?;
    let dir = instances_dir(&game_root()?).join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn fetch_instance_icon(id: String) -> Result<Option<String>, String> {
    let root = game_root()?;
    let mut inst = load_instance(&root, &id)?;
    if inst.icon.is_some() {
        return Ok(inst.icon);
    }
    let client = http_client()?;
    let url = format!(
        "{MODRINTH_API}/search?query={}&facets={}&limit=10&index=relevance",
        urlenc(inst.name.trim()),
        urlenc("[[\"project_type:modpack\"]]")
    );
    let r = get_json(&client, &url).await?;
    let want = inst.name.trim().to_lowercase();
    let icon: Option<String> = r["hits"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|h| h["title"].as_str().map(|t| t.trim().to_lowercase()) == Some(want.clone()))
        .and_then(|h| h["icon_url"].as_str())
        .map(String::from);
    if let Some(i) = &icon {
        inst.icon = Some(i.clone());
        save_instance(&root, &inst)?;
    }
    Ok(icon)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

fn inst_path(id: &str, rel: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    let base = instances_dir(&game_root()?).join(id);
    let rel = rel.trim().trim_matches(|c: char| c == '/' || c == '\\');
    if rel.is_empty() {
        return Ok(base);
    }
    let r = safe_rel_path(rel).ok_or("Недопустимый путь")?;
    Ok(base.join(r))
}

#[tauri::command]
fn instance_list_dir(id: String, rel: String) -> Result<Vec<FsEntry>, String> {
    let dir = inst_path(&id, &rel)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<FsEntry> = vec![];
    for e in std::fs::read_dir(&dir).map_err(err)?.flatten() {
        let Ok(md) = e.metadata() else { continue };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(FsEntry {
            name: e.file_name().to_string_lossy().to_string(),
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            modified,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
fn instance_delete(id: String, rel: String) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err("Нельзя удалить корень сборки".into());
    }
    let p = inst_path(&id, &rel)?;
    let r = if p.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };
    r.map_err(err)
}

#[tauri::command]
fn instance_toggle_mod(id: String, rel: String) -> Result<String, String> {
    let p = inst_path(&id, &rel)?;
    let name = p
        .file_name()
        .ok_or("Нет имени файла")?
        .to_string_lossy()
        .to_string();
    let new_name = match name.strip_suffix(".disabled") {
        Some(n) => n.to_string(),
        None => format!("{name}.disabled"),
    };
    let np = p.with_file_name(&new_name);
    std::fs::rename(&p, &np).map_err(err)?;
    Ok(new_name)
}

#[tauri::command]
fn instance_import(id: String, rel: String, paths: Vec<String>) -> Result<usize, String> {
    let dest = inst_path(&id, &rel)?;
    std::fs::create_dir_all(&dest).map_err(err)?;
    let mut n = 0usize;
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name() else { continue };
        std::fs::copy(&src, dest.join(name)).map_err(err)?;
        n += 1;
    }
    Ok(n)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Разрешены только https-ссылки".into());
    }
    open_target(&url);
    Ok(())
}

#[tauri::command]
async fn modrinth_versions(project_id: String) -> Result<Value, String> {
    check_id(&project_id)?;
    let client = http_client()?;
    let v = get_json(&client, &format!("{MODRINTH_API}/project/{project_id}/version")).await?;
    let out: Vec<Value> = v
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|x| {
            json!({
                "id": x["id"],
                "name": x["name"],
                "version_number": x["version_number"],
                "game_versions": x["game_versions"],
                "loaders": x["loaders"],
                "date_published": x["date_published"],
                "version_type": x["version_type"]
            })
        })
        .collect();
    Ok(Value::Array(out))
}
fn read_mrpack(pack: &Path, dest: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(pack).map_err(err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(err)?;
    let index: Value = {
        let mut f = zip.by_name("modrinth.index.json").map_err(err)?;
        let mut text = String::new();
        f.read_to_string(&mut text).map_err(err)?;
        serde_json::from_str(&text).map_err(err)?
    };
    for prefix in ["overrides", "client-overrides"] {
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(err)?;
            if f.is_dir() {
                continue;
            }
            let Some(ep) = f.enclosed_name() else { continue };
            let Ok(rel) = ep.strip_prefix(prefix) else { continue };
            let target = dest.join(rel);
            if target.exists() && matches!(rel.to_string_lossy().as_ref(), "options.txt" | "servers.dat") {
                continue;
            }
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p).map_err(err)?;
            }
            let mut out = std::fs::File::create(&target).map_err(err)?;
            std::io::copy(&mut f, &mut out).map_err(err)?;
        }
    }
    Ok(index)
}
async fn install_pack(
    app: &AppHandle,
    client: &reqwest::Client,
    pack_path: &Path,
    dir: &Path,
    id: String,
    title: String,
    icon: Option<String>,
) -> Result<(Instance, Vec<String>), String> {
    let (p2, d2) = (pack_path.to_path_buf(), dir.to_path_buf());
    let index = tokio::task::spawn_blocking(move || read_mrpack(&p2, &d2))
        .await
        .map_err(err)??;
    let deps = &index["dependencies"];
    let mc = deps["minecraft"]
        .as_str()
        .ok_or("В сборке не указана версия Minecraft")?
        .to_string();
    let (loader, lv) = if let Some(v) = deps["fabric-loader"].as_str() {
        ("fabric", v)
    } else if let Some(v) = deps["quilt-loader"].as_str() {
        ("quilt", v)
    } else if let Some(v) = deps["neoforge"].as_str() {
        ("neoforge", v)
    } else if let Some(v) = deps["forge"].as_str() {
        ("forge", v)
    } else {
        ("vanilla", "")
    };
    let mut tasks: Vec<Task> = vec![];
    let mut files: Vec<String> = vec![];
    for f in index["files"].as_array().into_iter().flatten() {
        if f["env"]["client"].as_str() == Some("unsupported") {
            continue;
        }
        let Some(rel) = f["path"].as_str().and_then(safe_rel_path) else { continue };
        let Some(url) = f["downloads"][0].as_str() else { continue };
        files.push(rel.to_string_lossy().replace('\\', "/"));
        tasks.push(Task {
            url: url.to_string(),
            path: dir.join(rel),
            sha1: f["hashes"]["sha1"].as_str().map(String::from),
        });
    }
    log(app, format!("Загрузка модов сборки «{title}»..."));
    download_all(app, client, tasks).await?;
    let inst = Instance {
        id,
        name: title,
        mc_version: mc,
        loader: loader.to_string(),
        loader_version: lv.to_string(),
        icon,
        ..Default::default()
    };
    Ok((inst, files))
}
async fn fetch_pack(client: &reqwest::Client, root: &Path, version_id: &str) -> Result<(Value, PathBuf), String> {
    check_id(version_id)?;
    let ver = get_json(client, &format!("{MODRINTH_API}/version/{version_id}")).await?;
    let files = ver["files"].as_array().ok_or("У версии нет файлов")?;
    let file = files
        .iter()
        .find(|f| f["primary"].as_bool() == Some(true))
        .or_else(|| files.first())
        .ok_or("У версии нет файлов")?;
    let url = file["url"].as_str().ok_or("Нет ссылки на сборку")?;
    let pack_path = root.join("tmp").join(format!("{version_id}.mrpack"));
    download(client, url, &pack_path, file["hashes"]["sha1"].as_str()).await?;
    Ok((ver.clone(), pack_path))
}
#[tauri::command]
async fn modrinth_install(
    app: AppHandle,
    version_id: String,
    title: String,
    icon: Option<String>,
) -> Result<Instance, String> {
    reset_cancel();
    let client = http_client()?;
    let root = game_root()?;
    log(&app, "Получение информации о сборке...");
    let (ver, pack_path) = fetch_pack(&client, &root, &version_id).await?;
    let title = unique_name(&root, &title, None);
    let id = unique_id(&root, &title);
    let dir = instances_dir(&root).join(&id);
    fs::create_dir_all(&dir).await.map_err(err)?;
    let res = install_pack(&app, &client, &pack_path, &dir, id, title, icon).await;
    match res {
        Ok((mut inst, files)) => {
            inst.pack_files = files;
            inst.source_project = ver["project_id"].as_str().map(String::from);
            inst.source_version = Some(version_id.clone());
            save_instance(&root, &inst)?;
            let _ = fs::remove_file(&pack_path).await;
            Ok(inst)
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&dir).await;
            Err(e)
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = ((c[0] as u32) << 16) | ((*c.get(1).unwrap_or(&0) as u32) << 8) | (*c.get(2).unwrap_or(&0) as u32);
        o.push(T[(n >> 18) as usize & 63] as char);
        o.push(T[(n >> 12) as usize & 63] as char);
        o.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        o.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    o
}
fn split_args(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (vec![], String::new(), false);
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(zip_path).map_err(err)?).map_err(err)?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(err)?;
        let Some(rel) = f.enclosed_name() else { continue };
        let target = dest.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&target).map_err(err)?;
            continue;
        }
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(err)?;
        }
        let mut out = std::fs::File::create(&target).map_err(err)?;
        std::io::copy(&mut f, &mut out).map_err(err)?;
    }
    Ok(())
}
const JAVA_MAJORS: [u32; 4] = [8, 17, 21, 25];
fn java_dir(root: &Path) -> PathBuf {
    root.join("java")
}
fn java_exe_in(dir: &Path, depth: u8) -> Option<PathBuf> {
    let exe = dir.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
    if exe.is_file() {
        return Some(exe);
    }
    if depth == 0 {
        return None;
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        if e.path().is_dir() {
            if let Some(p) = java_exe_in(&e.path(), depth - 1) {
                return Some(p);
            }
        }
    }
    None
}
fn java_major_for(req: u32) -> u32 {
    match req {
        0..=8 => 8,
        9..=17 => 17,
        18..=21 => 21,
        _ => 25,
    }
}
async fn download_single(app: &AppHandle, client: &reqwest::Client, url: &str, path: &Path) -> Result<(), String> {
    let resp = client.get(url).send().await.map_err(nerr)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0) as usize;
    let mut file = fs::File::create(path).await.map_err(err)?;
    let mut body = resp.bytes_stream();
    let (mut done, mut last) = (0usize, 0usize);
    loop {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        match tokio::time::timeout(Duration::from_secs(30), body.next()).await {
            Err(_) => return Err("сервер перестал отвечать (таймаут 30 с)".into()),
            Ok(None) => break,
            Ok(Some(chunk)) => {
                let c = chunk.map_err(nerr)?;
                file.write_all(&c).await.map_err(err)?;
                done += c.len();
                if done - last > 1_048_576 {
                    last = done;
                    let _ = app.emit("progress", Progress { done: done / 1_048_576, total: total / 1_048_576 + 1 });
                }
            }
        }
    }
    file.flush().await.map_err(err)?;
    Ok(())
}
async fn fetch_block(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    start: u64,
    end: u64,
    got: &AtomicU64,
    app: &AppHandle,
    total: u64,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .header("Range", format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(nerr)?;
    if resp.status().as_u16() != 206 {
        return Err(format!("сервер не поддерживает докачку (HTTP {})", resp.status()));
    }
    let mut f = fs::OpenOptions::new().write(true).open(path).await.map_err(err)?;
    f.seek(SeekFrom::Start(start)).await.map_err(err)?;
    let mut body = resp.bytes_stream();
    let mut written = 0u64;
    let res: Result<(), String> = async {
        loop {
            if cancelled() {
                return Err(CANCELLED.to_string());
            }
            match tokio::time::timeout(Duration::from_secs(20), body.next()).await {
                Err(_) => return Err("сервер перестал отвечать (таймаут 20 с)".to_string()),
                Ok(None) => break,
                Ok(Some(chunk)) => {
                    let c = chunk.map_err(nerr)?;
                    f.write_all(&c).await.map_err(err)?;
                    let n = c.len() as u64;
                    written += n;
                    let prev = got.fetch_add(n, Ordering::Relaxed);
                    if (prev + n) / 1_048_576 != prev / 1_048_576 {
                        let _ = app.emit("progress", Progress { done: ((prev + n) / 1_048_576) as usize, total: (total / 1_048_576 + 1) as usize });
                    }
                }
            }
        }
        f.flush().await.map_err(err)?;
        if written != end - start + 1 {
            return Err("блок скачан не полностью".to_string());
        }
        Ok(())
    }
    .await;
    if res.is_err() {
        got.fetch_sub(written, Ordering::Relaxed);
    }
    res
}

async fn download_fast(app: &AppHandle, client: &reqwest::Client, url: &str, path: &Path) -> Result<(), String> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).await.map_err(err)?;
    }
    let probe = client.get(url).header("Range", "bytes=0-0").send().await.map_err(nerr)?;
    let status = probe.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let final_url = probe.url().to_string();
    let total: Option<u64> = if status.as_u16() == 206 {
        probe
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse().ok())
    } else {
        None
    };
    drop(probe);
    let Some(total) = total.filter(|t| *t > 0) else {
        return download_single(app, client, &final_url, path).await;
    };
    {
        let f = std::fs::File::create(path).map_err(err)?;
        f.set_len(total).map_err(err)?;
    }
    const BLOCK: u64 = 2 * 1024 * 1024;
    let blocks: Vec<(u64, u64)> = (0..total)
        .step_by(BLOCK as usize)
        .map(|a| (a, (a + BLOCK - 1).min(total - 1)))
        .collect();
    let got = Arc::new(AtomicU64::new(0));
    let (c2, u2, p2, g2, a2) = (client.clone(), final_url.clone(), path.to_path_buf(), got.clone(), app.clone());
    let mut results = stream::iter(blocks)
        .map(move |(a, b)| {
            let (c, u, p, g, ap) = (c2.clone(), u2.clone(), p2.clone(), g2.clone(), a2.clone());
            async move {
                let mut last: Result<(), String> = Ok(());
                for _ in 0..4 {
                    last = fetch_block(&c, &u, &p, a, b, &g, &ap, total).await;
                    match &last {
                        Ok(_) => break,
                        Err(e) if e == CANCELLED => break,
                        _ => tokio::time::sleep(Duration::from_millis(500)).await,
                    }
                }
                last
            }
        })
        .buffer_unordered(8);
    let mut first_err: Option<String> = None;
    while let Some(r) = results.next().await {
        if let Err(e) = r {
            first_err = Some(e);
            break;
        }
    }
    drop(results);
    if let Some(e) = first_err {
        let _ = fs::remove_file(path).await;
        return Err(e);
    }
    let _ = app.emit("progress", Progress { done: (total / 1_048_576 + 1) as usize, total: (total / 1_048_576 + 1) as usize });
    Ok(())
}
const JAVA_SOURCES: [&str; 2] = ["Azul Zulu", "Eclipse Adoptium"];
async fn java_download_url(client: &reqwest::Client, major: u32, source: usize) -> Result<String, String> {
    if source == 0 {
        let arch = if cfg!(target_arch = "aarch64") { "arch=arm&hw_bitness=64" } else { "arch=x64" };
        let url = format!(
            "https://api.azul.com/metadata/v1/zulu/packages/?java_version={major}&os=windows&{arch}&java_package_type=jre&archive_type=zip&latest=true&release_status=ga&availability_types=CA&javafx_bundled=false&page_size=1"
        );
        let v = get_json(client, &url).await?;
        let item: &Value = if v.is_array() { &v[0] } else { &v };
        item["download_url"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "сервер не вернул ссылку на Java".to_string())
    } else {
        let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
        Ok(format!("https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/{arch}/jre/hotspot/normal/eclipse"))
    }
}
async fn ensure_java(
    app: &AppHandle,
    client: &reqwest::Client,
    root: &Path,
    major: u32,
) -> Result<PathBuf, String> {
    let dir = java_dir(root).join(major.to_string());
    if let Some(p) = java_exe_in(&dir, 3) {
        return Ok(p);
    }
    if !cfg!(windows) {
        return Err(format!(
            "Автоскачивание Java работает только в Windows. Установи Java {major} и укажи путь в настройках"
        ));
    }
    let zip_path = java_dir(root).join(format!("{major}.zip"));
    let mut errors: Vec<String> = vec![];
    let mut ok = false;
    for i in 0..JAVA_SOURCES.len() {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        log(app, format!("Скачивание Java {major}..."));
        let res: Result<(), String> = async {
            let url = java_download_url(client, major, i).await?;
            download_fast(app, client, &url, &zip_path).await
        }
        .await;
        match res {
            Ok(()) => {
                ok = true;
                break;
            }
            Err(e) if e == CANCELLED => {
                let _ = fs::remove_file(&zip_path).await;
                return Err(e);
            }
            Err(e) => {
                let _ = fs::remove_file(&zip_path).await;
                errors.push(format!("источник {}: {e}", i + 1));
            }
        }
    }
    if !ok {
        return Err(format!("Не удалось скачать Java {major}.\n{}", errors.join("\n")));
    }
    log(app, format!("Распаковка Java {major}..."));
    let (z, d) = (zip_path.clone(), dir.clone());
    let ex = tokio::task::spawn_blocking(move || extract_zip(&z, &d)).await.map_err(err)?;
    let _ = fs::remove_file(&zip_path).await;
    if let Err(e) = ex {
        let _ = fs::remove_dir_all(&dir).await;
        return Err(format!("Не удалось распаковать Java {major}: {e}"));
    }
    java_exe_in(&dir, 3).ok_or_else(|| "Java распакована, но java.exe не найден".to_string())
}
#[derive(Serialize)]
struct JavaItem {
    major: u32,
    installed: bool,
}
#[tauri::command]
fn java_list() -> Result<Vec<JavaItem>, String> {
    let root = game_root()?;
    Ok(JAVA_MAJORS
        .iter()
        .map(|&m| JavaItem {
            major: m,
            installed: java_exe_in(&java_dir(&root).join(m.to_string()), 3).is_some(),
        })
        .collect())
}
#[tauri::command]
async fn java_install(app: AppHandle, major: u32) -> Result<(), String> {
    if !JAVA_MAJORS.contains(&major) {
        return Err("Неподдерживаемая версия Java".into());
    }
    reset_cancel();
    ensure_java(&app, &http_client()?, &game_root()?, major).await.map(|_| ())
}
#[tauri::command]
async fn java_remove(major: u32) -> Result<(), String> {
    if !JAVA_MAJORS.contains(&major) {
        return Err("Неподдерживаемая версия Java".into());
    }
    let dir = java_dir(&game_root()?).join(major.to_string());
    if dir.exists() {
        fs::remove_dir_all(&dir).await.map_err(err)?;
    }
    Ok(())
}
fn find_profile(root: &Path, loader: &str, ver: &str) -> Option<String> {
    for e in std::fs::read_dir(root.join("versions")).ok()?.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        let l = n.to_lowercase();
        let ok = if loader == "neoforge" { l.contains("neoforge") } else { l.contains("forge") && !l.contains("neoforge") };
        if ok && n.contains(ver) && e.path().join(format!("{n}.json")).exists() {
            return Some(n);
        }
    }
    None
}
async fn ensure_loader_profile(
    app: &AppHandle,
    client: &reqwest::Client,
    root: &Path,
    java: &Path,
    inst: &Instance,
) -> Result<String, String> {
    if let Some(p) = &inst.profile {
        if root.join("versions").join(p).join(format!("{p}.json")).exists() {
            return Ok(p.clone());
        }
    }
    if let Some(p) = find_profile(root, &inst.loader, &inst.loader_version) {
        return Ok(p);
    }
    let (mc, ver) = (&inst.mc_version, &inst.loader_version);
    let url = if inst.loader == "neoforge" {
        format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{ver}/neoforge-{ver}-installer.jar")
    } else {
        format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{mc}-{ver}/forge-{mc}-{ver}-installer.jar")
    };
    log(app, format!("Загрузка установщика {}...", inst.loader));
    let jar = root.join("tmp").join(format!("{}-{ver}-installer.jar", inst.loader));
    download(client, &url, &jar, None).await?;
    let v = vanilla_json(client, root, mc).await?;
    let cd = &v["downloads"]["client"];
    if let Some(u) = cd["url"].as_str() {
        download(client, u, &root.join("versions").join(mc).join(format!("{mc}.jar")), cd["sha1"].as_str()).await?;
    }
    let profiles = root.join("launcher_profiles.json");
    if !profiles.exists() {
        fs::write(&profiles, "{\"profiles\":{}}").await.map_err(err)?;
    }
    log(app, format!("Установка {} {ver} (это может занять несколько минут)...", inst.loader));
    let mut cmd = Command::new(java);
    cmd.arg("-jar").arg(&jar).arg("--installClient").arg(root).current_dir(root);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| format!("Не удалось запустить установщик: {e}"))?;
    if !out.status.success() {
        let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let tail: String = text.chars().rev().take(1200).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("Установщик {} завершился с ошибкой:\n{tail}", inst.loader));
    }
    let _ = fs::remove_file(&jar).await;
    find_profile(root, &inst.loader, ver).ok_or_else(|| "Установщик завершился, но профиль не найден".to_string())
}
const ELY_AUTH: &str = "https://authserver.ely.by/auth";
const ELY_INJECT: &str = "https://authserver.ely.by/api/authlib-injector";
fn add_account(root: &Path, acc: StoredAccount) -> Result<AccountView, String> {
    let view = AccountView { id: acc.id.clone(), name: acc.name.clone(), kind: acc.kind.clone() };
    update_store(root, |st| {
        st.accounts.retain(|a| a.id != acc.id);
        st.active = Some(acc.id.clone());
        st.accounts.push(acc);
    })?;
    Ok(view)
}
#[tauri::command]
fn add_offline_account(name: String) -> Result<AccountView, String> {
    let name = name.trim().to_string();
    if name.len() < 3 || name.len() > 16 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Ник: 3-16 символов, только латиница, цифры и _".into());
    }
    add_account(
        &game_root()?,
        offline_account(&name),
    )
}
#[tauri::command]
async fn ely_login(username: String, password: String) -> Result<AccountView, String> {
    let client = http_client()?;
    let client_token = to_hex(&md5::compute(format!("itslauncher-{}", username.trim())).0);
    let (st, t) = post_json(
        &client,
        &format!("{ELY_AUTH}/authenticate"),
        json!({ "username": username.trim(), "password": password, "clientToken": client_token, "requestUser": true }),
    )
    .await?;
    let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
    if st == reqwest::StatusCode::NOT_FOUND || st.is_server_error() {
        return Err("Сервис Ely.by сейчас недоступен. Попробуй позже.".into());
    }
    if !st.is_success() {
        let raw: String = t.chars().take(200).collect();
        let m = v["errorMessage"].as_str().or(v["error"].as_str()).map(String::from).unwrap_or_else(|| format!("HTTP {}: {}", st.as_u16(), raw.trim()));
        let m = m.as_str();
        let hint = if m.to_lowercase().contains("two factor") { " Введи пароль в формате пароль:код_2FA." } else { "" };
        return Err(format!("Ely.by: {m}.{hint}"));
    }
    let p = &v["selectedProfile"];
    let id = p["id"].as_str().ok_or("Ely.by не вернул профиль игрока")?.to_string();
    let name = p["name"].as_str().ok_or("Ely.by не вернул имя игрока")?.to_string();
    add_account(
        &game_root()?,
        StoredAccount {
            id,
            name,
            kind: "ely".into(),
            access_token: v["accessToken"].as_str().unwrap_or("").into(),
            client_token,
            ..Default::default()
        },
    )
}
async fn ely_session(
    client: &reqwest::Client,
    root: &Path,
    aid: &str,
) -> Result<(String, String, String), String> {
    let acc = load_store(root).accounts.iter().find(|a| a.id == aid).cloned().ok_or("Аккаунт не найден")?;
    let (code, _) = post_json(client, &format!("{ELY_AUTH}/validate"), json!({ "accessToken": acc.access_token })).await?;
    let mut token = acc.access_token.clone();
    if !code.is_success() {
        let (s2, t2) = post_json(
            client,
            &format!("{ELY_AUTH}/refresh"),
            json!({ "accessToken": acc.access_token, "clientToken": acc.client_token }),
        )
        .await?;
        if !s2.is_success() {
            return Err("Сессия Ely.by истекла, войди в аккаунт заново".into());
        }
        let v: Value = serde_json::from_str(&t2).map_err(err)?;
        token = v["accessToken"].as_str().ok_or("Нет accessToken")?.to_string();
        update_store(root, |st| {
            if let Some(a) = st.accounts.iter_mut().find(|a| a.id == aid) {
                a.access_token = token.clone();
            }
        })?;
    }
    Ok((token, acc.id, acc.name))
}
async fn ensure_injector(client: &reqwest::Client, root: &Path) -> Result<PathBuf, String> {
    let p = root.join("authlib-injector.jar");
    if p.exists() {
        return Ok(p);
    }
    let latest = match get_json(client, "https://authlib-injector.yushi.moe/artifact/latest.json").await {
        Ok(v) => v["download_url"].as_str().map(String::from),
        Err(_) => None,
    };
    let url = latest.unwrap_or_else(|| {
        "https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.5/authlib-injector-1.2.5.jar".to_string()
    });
    download(client, &url, &p, None).await?;
    Ok(p)
}
fn safe_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}
#[tauri::command]
async fn modrinth_search(
    kind: String,
    query: String,
    offset: u32,
    mc_version: Option<String>,
    loader: Option<String>,
    sort: String,
    categories: Option<Vec<String>>,
    exclude: Option<Vec<String>>,
    environment: Option<String>,
) -> Result<Value, String> {
    let ptype = match kind.as_str() {
        "mod" => "mod",
        "resourcepack" => "resourcepack",
        "shader" => "shader",
        _ => "modpack",
    };
    let mut facets = vec![format!("[\"project_type:{ptype}\"]")];
    if let Some(v) = mc_version.filter(|v| safe_token(v)) {
        facets.push(format!("[\"versions:{v}\"]"));
    }
    if let Some(l) = loader {
        let ls: Vec<String> = l.split(',').filter(|x| safe_token(x)).map(|x| format!("\"categories:{x}\"")).collect();
        if !ls.is_empty() {
            facets.push(format!("[{}]", ls.join(",")));
        }
    }
    for c in categories.unwrap_or_default().iter().filter(|c| safe_token(c)) {
        facets.push(format!("[\"categories:{c}\"]"));
    }
    for c in exclude.unwrap_or_default().iter().filter(|c| safe_token(c)) {
        facets.push(format!("[\"categories!={c}\"]"));
    }
    match environment.as_deref() {
        Some("client") => facets.push("[\"client_side:required\",\"client_side:optional\"]".into()),
        Some("server") => facets.push("[\"server_side:required\",\"server_side:optional\"]".into()),
        _ => {}
    }
    let default = if query.trim().is_empty() { "downloads" } else { "relevance" };
    let index = match sort.as_str() {
        "relevance" | "downloads" | "follows" | "newest" | "updated" => sort.as_str(),
        _ => default,
    };
    let url = format!(
        "{MODRINTH_API}/search?query={}&facets={}&limit=20&offset={offset}&index={index}",
        urlenc(query.trim()),
        urlenc(&format!("[{}]", facets.join(",")))
    );
    get_json(&http_client()?, &url).await
}
#[tauri::command]
async fn modrinth_install_project(
    instance_id: String,
    project_id: String,
    kind: String,
    mc_version: Option<String>,
    loader: Option<String>,
) -> Result<String, String> {
    check_id(&project_id)?;
    let (root, client) = (game_root()?, http_client()?);
    let inst = load_instance(&root, &instance_id)?;
    let sub = match kind.as_str() {
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        _ => return Err("Неверный тип".into()),
    };
    let dir = instances_dir(&root).join(&inst.id).join(sub);
    let mut queue = vec![project_id];
    let mut seen = std::collections::HashSet::new();
    let mut first = String::new();
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid.clone()) || seen.len() > 12 {
            continue;
        }
        let mut url = format!("{MODRINTH_API}/project/{pid}/version");
        let mut q: Vec<String> = vec![];
        if let Some(v) = mc_version.as_deref().filter(|v| safe_token(v)) {
            q.push(format!("game_versions={}", urlenc(&format!("[\"{v}\"]"))));
        }
        if let Some(l) = loader.as_deref() {
            let ls: Vec<String> = l.split(',').filter(|x| safe_token(x)).map(|x| format!("\"{x}\"")).collect();
            if !ls.is_empty() {
                q.push(format!("loaders={}", urlenc(&format!("[{}]", ls.join(",")))));
            }
        }
        if !q.is_empty() {
            url = format!("{url}?{}", q.join("&"));
        }
        let vers = get_json(&client, &url).await?;
        let Some(ver) = vers.as_array().and_then(|a| a.first()) else {
            if first.is_empty() {
                return Err("Нет подходящей версии для этой сборки".into());
            }
            continue;
        };
        let file = ver["files"]
            .as_array()
            .and_then(|f| f.iter().find(|x| x["primary"].as_bool() == Some(true)).or(f.first()))
            .ok_or("У версии нет файла")?;
        let name = file["filename"].as_str().ok_or("Нет имени файла")?;
        let Some(rel) = safe_rel_path(name) else { continue };
        download(&client, file["url"].as_str().ok_or("Нет ссылки")?, &dir.join(rel), file["hashes"]["sha1"].as_str()).await?;
        if first.is_empty() {
            first = name.to_string();
        }
        if kind == "mod" {
            for d in ver["dependencies"].as_array().into_iter().flatten() {
                if d["dependency_type"].as_str() == Some("required") {
                    if let Some(p) = d["project_id"].as_str() {
                        queue.push(p.to_string());
                    }
                }
            }
        }
    }
    Ok(first)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ident {
    file: String,
    title: String,
    icon: Option<String>,
    project_id: String,
    version_id: String,
    version_name: String,
}
#[tauri::command]
async fn instance_identify(id: String, rel: String, names: Option<Vec<String>>) -> Result<Vec<Ident>, String> {
    let dir = inst_path(&id, &rel)?;
    let files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).take(300).collect())
        .unwrap_or_default();
    let files: Vec<PathBuf> = match &names {
        Some(n) => files
            .into_iter()
            .filter(|p| p.file_name().map(|f| n.iter().any(|x| x.as_str() == f.to_string_lossy())).unwrap_or(false))
            .collect(),
        None => files,
    };
    let hashed: Vec<(String, String)> = tokio::task::spawn_blocking(move || {
        files
            .iter()
            .filter_map(|p| {
                Some((p.file_name()?.to_string_lossy().to_string(), sha1_of(p)?))
            })
            .collect()
    })
    .await
    .map_err(err)?;
    if hashed.is_empty() {
        return Ok(vec![]);
    }
    let client = http_client()?;
    let hashes: Vec<String> = hashed.iter().map(|h| h.1.clone()).collect();
    let (st, t) = post_json(&client, &format!("{MODRINTH_API}/version_files"), json!({ "hashes": hashes, "algorithm": "sha1" })).await?;
    if !st.is_success() {
        return Ok(vec![]);
    }
    let map: Value = serde_json::from_str(&t).map_err(err)?;
    let mut pids: Vec<String> = hashed
        .iter()
        .filter_map(|(_, h)| map[h.as_str()]["project_id"].as_str().map(String::from))
        .collect();
    pids.sort();
    pids.dedup();
    if pids.is_empty() {
        return Ok(vec![]);
    }
    let ids = serde_json::to_string(&pids).map_err(err)?;
    let projects = get_json(&client, &format!("{MODRINTH_API}/projects?ids={}", urlenc(&ids))).await?;
    let mut out = vec![];
    for (file, h) in &hashed {
        let Some(pid) = map[h.as_str()]["project_id"].as_str() else { continue };
        let Some(p) = projects.as_array().and_then(|a| a.iter().find(|x| x["id"].as_str() == Some(pid))) else { continue };
        out.push(Ident {
            file: file.clone(),
            title: p["title"].as_str().unwrap_or("").to_string(),
            icon: p["icon_url"].as_str().map(String::from),
            project_id: pid.to_string(),
            version_id: map[h.as_str()]["id"].as_str().unwrap_or("").to_string(),
            version_name: map[h.as_str()]["version_number"].as_str().unwrap_or("").to_string(),
        });
    }
    Ok(out)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct World {
    folder: String,
    icon: Option<String>,
    modified: u64,
}
#[tauri::command]
fn instance_worlds(id: String) -> Result<Vec<World>, String> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(inst_path(&id, "saves")?) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let icon = std::fs::read(p.join("icon.png")).ok().map(|d| format!("data:image/png;base64,{}", b64(&d)));
            let modified = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(World { folder: e.file_name().to_string_lossy().to_string(), icon, modified });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}
#[tauri::command]
fn instance_read_image(id: String, rel: String) -> Result<String, String> {
    let p = inst_path(&id, &rel)?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return Err("Это не изображение".into()),
    };
    if std::fs::metadata(&p).map_err(err)?.len() > 12_000_000 {
        return Err("Файл слишком большой".into());
    }
    Ok(format!("data:{mime};base64,{}", b64(&std::fs::read(&p).map_err(err)?)))
}
#[tauri::command]
fn instance_read_log(id: String) -> Result<String, String> {
    let mut file = std::fs::File::open(inst_path(&id, "logs/latest.log")?).map_err(|_| "Файл logs/latest.log не найден".to_string())?;
    let len = file.metadata().map_err(err)?.len();
    std::io::Seek::seek(&mut file, SeekFrom::Start(len.saturating_sub(300_000))).map_err(err)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(err)?;
    Ok(String::from_utf8_lossy(&data).to_string())
}
#[tauri::command]
fn instance_set_settings(id: String, settings: Value) -> Result<(), String> {
    let root = game_root()?;
    let mut i = load_instance(&root, &id)?;
    i.settings = Some(settings);
    save_instance(&root, &i)
}
#[tauri::command]
async fn loader_versions(loader: String, mc: String) -> Result<Vec<String>, String> {
    if !safe_token(&mc) {
        return Ok(vec![]);
    }
    let client = http_client()?;
    match loader.as_str() {
        "fabric" | "quilt" => {
            let url = if loader == "fabric" {
                format!("https://meta.fabricmc.net/v2/versions/loader/{mc}")
            } else {
                format!("https://meta.quiltmc.org/v3/versions/loader/{mc}")
            };
            let v = get_json(&client, &url).await?;
            Ok(v.as_array().into_iter().flatten().filter_map(|x| x["loader"]["version"].as_str().map(String::from)).collect())
        }
        "forge" => {
            let v = get_json(&client, "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json").await?;
            let prefix = format!("{mc}-");
            let mut out: Vec<String> = v[mc.as_str()]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str())
                .map(|x| x.strip_prefix(&prefix).unwrap_or(x).to_string())
                .collect();
            out.reverse();
            Ok(out)
        }
        "neoforge" => {
            let v = get_json(&client, "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge").await?;
            let mut it = mc.split('.').skip(1);
            let minor = it.next().unwrap_or("0");
            let patch = it.next().unwrap_or("0");
            let prefix = format!("{minor}.{patch}.");
            let mut out: Vec<String> = v["versions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str())
                .filter(|x| x.starts_with(&prefix))
                .map(String::from)
                .collect();
            out.reverse();
            Ok(out)
        }
        _ => Ok(vec![]),
    }
}
#[tauri::command]
async fn instance_change(id: String, mc_version: String, loader: String, loader_version: Option<String>) -> Result<(), String> {
    let root = game_root()?;
    let mut inst = load_instance(&root, &id)?;
    let lv = match (loader.as_str(), loader_version.filter(|v| !v.is_empty())) {
        ("vanilla", _) => String::new(),
        (_, Some(v)) => v,
        _ => latest_loader(&http_client()?, &loader, &mc_version).await?,
    };
    inst.mc_version = mc_version;
    inst.loader = loader;
    inst.loader_version = lv;
    inst.profile = None;
    save_instance(&root, &inst)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackUpdate {
    version_id: String,
    version_name: String,
}
#[tauri::command]
async fn instance_pack_update(id: String) -> Result<Option<PackUpdate>, String> {
    let inst = load_instance(&game_root()?, &id)?;
    if inst.pack_detached {
        return Ok(None);
    }
    let (Some(pid), Some(cur)) = (inst.source_project.clone(), inst.source_version.clone()) else { return Ok(None) };
    if !safe_token(&pid) {
        return Ok(None);
    }
    let client = http_client()?;
    let list = get_json(&client, &format!("{MODRINTH_API}/project/{pid}/version")).await?;
    let list = list.as_array().cloned().unwrap_or_default();
    let latest = list.iter().find(|v| v["version_type"].as_str() == Some("release")).or(list.first());
    let current = get_json(&client, &format!("{MODRINTH_API}/version/{cur}")).await?;
    let cur_date = current["date_published"].as_str().unwrap_or("").to_string();
    Ok(latest.and_then(|v| {
        let vid = v["id"].as_str()?;
        if vid == cur || v["date_published"].as_str().unwrap_or("") <= cur_date.as_str() {
            return None;
        }
        Some(PackUpdate { version_id: vid.to_string(), version_name: v["version_number"].as_str().unwrap_or("").to_string() })
    }))
}
#[tauri::command]
async fn modrinth_update_pack(app: AppHandle, id: String, version_id: String) -> Result<(), String> {
    reset_cancel();
    let client = http_client()?;
    let root = game_root()?;
    let old = load_instance(&root, &id)?;
    log(&app, "Получение информации о сборке...");
    let (_, pack_path) = fetch_pack(&client, &root, &version_id).await?;
    let dir = instances_dir(&root).join(&id);
    let (fresh, files) = install_pack(&app, &client, &pack_path, &dir, id.clone(), old.name.clone(), old.icon.clone()).await?;
    let keep: std::collections::HashSet<&String> = files.iter().collect();
    for f in old.pack_files.iter().filter(|f| !keep.contains(f)) {
        if let Some(rel) = safe_rel_path(f) {
            let _ = std::fs::remove_file(dir.join(rel));
        }
    }
    let mut inst = old;
    inst.mc_version = fresh.mc_version;
    inst.loader = fresh.loader;
    inst.loader_version = fresh.loader_version;
    inst.profile = None;
    inst.pack_files = files;
    inst.source_version = Some(version_id);
    save_instance(&root, &inst)?;
    let _ = fs::remove_file(&pack_path).await;
    Ok(())
}
#[tauri::command]
fn instance_set_detached(id: String, detached: bool) -> Result<(), String> {
    let root = game_root()?;
    let mut inst = load_instance(&root, &id)?;
    inst.pack_detached = detached;
    save_instance(&root, &inst)
}
#[tauri::command]
fn instance_rename(id: String, name: String) -> Result<String, String> {
    let root = game_root()?;
    let mut inst = load_instance(&root, &id)?;
    let n = name.trim();
    if n.is_empty() {
        return Err("Введите название".into());
    }
    inst.name = unique_name(&root, n, Some(&id));
    save_instance(&root, &inst)?;
    Ok(inst.name)
}
#[tauri::command]
fn instance_packs(id: String) -> Result<Vec<String>, String> {
    let Ok(text) = std::fs::read_to_string(inst_path(&id, "options.txt")?) else { return Ok(vec![]) };
    let line = text.lines().find(|l| l.starts_with("resourcePacks:")).unwrap_or("");
    let list: Vec<String> = serde_json::from_str(line.trim_start_matches("resourcePacks:")).unwrap_or_default();
    Ok(list.into_iter().filter_map(|x| x.strip_prefix("file/").map(String::from)).collect())
}
#[tauri::command]
fn instance_set_pack(id: String, file: String, enabled: bool) -> Result<(), String> {
    let path = inst_path(&id, "options.txt")?;
    let text = std::fs::read_to_string(&path).map_err(|_| "Сначала запусти игру один раз, чтобы появился файл настроек".to_string())?;
    let key = "resourcePacks:";
    let entry = format!("file/{file}");
    let render = |mut list: Vec<String>| {
        list.retain(|x| x != &entry);
        if enabled {
            list.push(entry.clone());
        }
        format!("{key}{}", serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
    };
    let mut found = false;
    let mut out: Vec<String> = text
        .lines()
        .map(|l| match l.strip_prefix(key) {
            Some(rest) => {
                found = true;
                render(serde_json::from_str(rest).unwrap_or_default())
            }
            None => l.to_string(),
        })
        .collect();
    if !found {
        out.push(render(vec!["vanilla".to_string()]));
    }
    std::fs::write(&path, out.join("\n") + "\n").map_err(err)
}
const DEVICE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MS_SCOPE: &str = "XboxLive.signin offline_access";
const BUILTIN_CLIENT_ID: &str = "c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb";
fn resolve_client_id(user: &str) -> Result<String, String> {
    let u = user.trim();
    Ok(if u.is_empty() { BUILTIN_CLIENT_ID.to_string() } else { u.to_string() })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCode {
    user_code: String,
    verification_uri: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlenc(k), urlenc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

async fn post_form(
    client: &reqwest::Client,
    url: &str,
    body: String,
) -> Result<(reqwest::StatusCode, String), String> {
    let r = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(err)?;
    let st = r.status();
    let t = r.text().await.map_err(err)?;
    Ok((st, t))
}

async fn ms_chain(
    client: &reqwest::Client,
    ms_token: &str,
) -> Result<(String, String, String), String> {
    let (st, t) = post_json(
        client,
        "https://user.auth.xboxlive.com/user/authenticate",
        json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={ms_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }),
    )
    .await?;
    if !st.is_success() {
        return Err(format!("Xbox Live: {st} {t}"));
    }
    let xbl: Value = serde_json::from_str(&t).map_err(err)?;
    let xbl_token = xbl["Token"].as_str().ok_or("Нет токена Xbox Live")?.to_string();
    let (st, t) = post_json(
        client,
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }),
    )
    .await?;
    if !st.is_success() {
        let hint = if t.contains("2148916233") {
            "У этого аккаунта Microsoft нет профиля Xbox. Создайте его на xbox.com."
        } else if t.contains("2148916238") {
            "Это детский аккаунт: его нужно добавить в семью Microsoft."
        } else {
            ""
        };
        return Err(format!("XSTS: {st} {hint} {t}"));
    }
    let xsts: Value = serde_json::from_str(&t).map_err(err)?;
    let xtoken = xsts["Token"].as_str().ok_or("Нет токена XSTS")?.to_string();
    let uhs = xsts["DisplayClaims"]["xui"][0]["uhs"]
        .as_str()
        .ok_or("Нет uhs в ответе XSTS")?
        .to_string();
    let (st, t) = post_json(
        client,
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        json!({ "identityToken": format!("XBL3.0 x={uhs};{xtoken}") }),
    )
    .await?;
    if !st.is_success() {
        let hint = if t.contains("Invalid app registration") {
            "Ваше Azure-приложение ещё не одобрено Mojang (форма https://aka.ms/AppRegInfo)."
        } else {
            ""
        };
        return Err(format!("Minecraft login: {st} {hint} {t}"));
    }
    let mc: Value = serde_json::from_str(&t).map_err(err)?;
    let mc_token = mc["access_token"].as_str().ok_or("Нет токена Minecraft")?.to_string();
    let r = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .header("Authorization", format!("Bearer {mc_token}"))
        .send()
        .await
        .map_err(err)?;
    let st = r.status();
    let t = r.text().await.map_err(err)?;
    if st.as_u16() == 404 {
        return Err("На этом аккаунте нет Minecraft Java Edition".into());
    }
    if !st.is_success() {
        return Err(format!("Профиль Minecraft: {st} {t}"));
    }
    let p: Value = serde_json::from_str(&t).map_err(err)?;
    let id = p["id"].as_str().ok_or("Нет id профиля")?.to_string();
    let name = p["name"].as_str().ok_or("Нет имени профиля")?.to_string();
    Ok((mc_token, id, name))
}

async fn refresh_session(
    client: &reqwest::Client,
    client_id: &str,
    refresh: &str,
) -> Result<(String, String, String, String), String> {
    let body = form(&[
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("scope", MS_SCOPE),
    ]);
    let (st, t) = post_form(client, TOKEN_URL, body).await?;
    if !st.is_success() {
        return Err(format!("Не удалось обновить вход, войдите заново: {t}"));
    }
    let v: Value = serde_json::from_str(&t).map_err(err)?;
    let access = v["access_token"].as_str().ok_or("Нет access_token")?;
    let new_refresh = v["refresh_token"].as_str().unwrap_or(refresh).to_string();
    let (tok, uuid, name) = ms_chain(client, access).await?;
    Ok((tok, uuid, name, new_refresh))
}

#[tauri::command]
async fn ms_begin_login(client_id: String) -> Result<DeviceCode, String> {
    let actual_client_id = resolve_client_id(&client_id)?;
    let client = http_client()?;
    let body = form(&[("client_id", &actual_client_id), ("scope", MS_SCOPE)]);
    let (st, t) = post_form(&client, DEVICE_URL, body).await?;
    let v: Value = serde_json::from_str(&t).map_err(err)?;
    if !st.is_success() {
        return Err(format!("{}", v["error_description"].as_str().unwrap_or(&t)));
    }
    Ok(DeviceCode {
        user_code: v["user_code"].as_str().ok_or("Нет user_code")?.to_string(),
        verification_uri: v["verification_uri"]
            .as_str()
            .unwrap_or("https://microsoft.com/link")
            .to_string(),
        device_code: v["device_code"].as_str().ok_or("Нет device_code")?.to_string(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
    })
}

#[tauri::command]
async fn ms_poll_login(
    client_id: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<AccountView, String> {
    let actual_client_id = resolve_client_id(&client_id)?;
    let client = http_client()?;
    let root = game_root()?;
    let start = Instant::now();
    let mut wait = interval.max(2);
    let (access, refresh) = loop {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        if start.elapsed().as_secs() > expires_in {
            return Err("Время ожидания входа истекло".into());
        }
        let body = form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", &actual_client_id),
            ("device_code", device_code.as_str()),
        ]);
        let (_, t) = post_form(&client, TOKEN_URL, body).await?;
        let v: Value = serde_json::from_str(&t).map_err(err)?;
        if let Some(a) = v["access_token"].as_str() {
            break (
                a.to_string(),
                v["refresh_token"].as_str().unwrap_or("").to_string(),
            );
        }
        match v["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => wait += 5,
            Some(e) => {
                return Err(format!(
                    "Вход не удался: {e} {}",
                    v["error_description"].as_str().unwrap_or("")
                ))
            }
            None => return Err(format!("Неожиданный ответ: {t}")),
        }
    };
    let (_tok, uuid, name) = ms_chain(&client, &access).await?;
    update_store(&root, |store| {
        store.accounts.retain(|a| a.id != uuid);
        store.accounts.push(StoredAccount {
            id: uuid.clone(),
            name: name.clone(),
            refresh_token: refresh,
            kind: "ms".into(),
            ..Default::default()
        });
        store.active = Some(uuid.clone());
    })?;
    Ok(AccountView { id: uuid, name, kind: "ms".into() })
}

#[tauri::command]
fn ms_client_ready(client_id: String) -> bool {
    resolve_client_id(&client_id).is_ok()
}

async fn account_session(
    client: &reqwest::Client,
    root: &Path,
    aid: &str,
    client_id: &str,
) -> Result<(String, String, String), String> {
    let cid = resolve_client_id(client_id)?;
    let acc = load_store(root).accounts.iter().find(|a| a.id == aid).cloned().ok_or("Аккаунт не найден")?;
    let (tok, uuid, name, new_ref) = refresh_session(client, &cid, &acc.refresh_token).await?;
    update_store(root, |store| {
        if let Some(a) = store.accounts.iter_mut().find(|a| a.id == aid) {
            a.refresh_token = new_ref;
            a.name = name.clone();
        }
    })?;
    Ok((tok, uuid, name))
}

fn stoppers() -> &'static std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>> = std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
#[tauri::command]
fn stop_instance(id: String) -> Result<(), String> {
    let tx = stoppers().lock().map_err(err)?.remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(());
            Ok(())
        }
        None => Err("Экземпляр не запущен".into()),
    }
}
#[tauri::command]
async fn reset_launcher() -> Result<(), String> {
    if !stoppers().lock().map_err(err)?.is_empty() {
        return Err("Сначала закрой запущенные экземпляры".into());
    }
    let root = game_root()?;
    if root.exists() {
        fs::remove_dir_all(&root).await.map_err(err)?;
    }
    if let Some(d) = dirs::data_local_dir() {
        let _ = std::fs::remove_dir_all(d.join("com.itslauncher.app"));
    }
    Ok(())
}
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}
fn collect_files(base: &Path, dir: &Path, skip: &[&str], out: &mut Vec<(PathBuf, String)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(r) = p.strip_prefix(base) else { continue };
        let rel = r.to_string_lossy().replace('\\', "/");
        if skip.iter().any(|s| rel == *s || rel.starts_with(&format!("{s}/"))) {
            continue;
        }
        if p.is_dir() {
            collect_files(base, &p, skip, out);
        } else {
            out.push((p, rel));
        }
    }
}
fn write_zip(path: &Path, files: Vec<(PathBuf, String)>, extra: Vec<(String, Vec<u8>)>) -> Result<(), String> {
    let mut z = zip::ZipWriter::new(std::fs::File::create(path).map_err(err)?);
    let opt = zip::write::SimpleFileOptions::default();
    for (abs, name) in files {
        z.start_file(name, opt.clone()).map_err(err)?;
        let mut r = std::fs::File::open(&abs).map_err(err)?;
        std::io::copy(&mut r, &mut z).map_err(err)?;
    }
    for (name, data) in extra {
        z.start_file(name, opt.clone()).map_err(err)?;
        z.write_all(&data).map_err(err)?;
    }
    z.finish().map_err(err)?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TopEntry {
    name: String,
    is_dir: bool,
    size: u64,
}
fn dir_size(p: &Path) -> u64 {
    let Ok(md) = std::fs::metadata(p) else { return 0 };
    if md.is_file() {
        return md.len();
    }
    std::fs::read_dir(p)
        .map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum::<u64>())
        .unwrap_or(0)
}
#[tauri::command]
async fn instance_top(id: String) -> Result<Vec<TopEntry>, String> {
    let base = inst_path(&id, "")?;
    tokio::task::spawn_blocking(move || {
        let mut out: Vec<TopEntry> = std::fs::read_dir(&base)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_name() != "instance.json")
                    .map(|e| {
                        let p = e.path();
                        TopEntry { name: e.file_name().to_string_lossy().to_string(), is_dir: p.is_dir(), size: dir_size(&p) }
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        out
    })
    .await
    .map_err(err)
}
#[tauri::command]
async fn instance_export(
    id: String,
    format: String,
    name: String,
    version: String,
    summary: String,
    include: Vec<String>,
) -> Result<String, String> {
    let root = game_root()?;
    let inst = load_instance(&root, &id)?;
    let base = instances_dir(&root).join(&inst.id);
    let out_dir = dirs::download_dir().unwrap_or_else(|| root.join("exports"));
    std::fs::create_dir_all(&out_dir).map_err(err)?;
    let title = if name.trim().is_empty() { inst.name.clone() } else { name.trim().to_string() };
    let slug = slugify(&title);
    let mut files: Vec<(PathBuf, String)> = vec![];
    for top in &include {
        let Some(rel) = safe_rel_path(top) else { continue };
        let p = base.join(&rel);
        if p.is_dir() {
            collect_files(&base, &p, &[".mixin.out"], &mut files);
        } else if p.is_file() {
            files.push((p, top.clone()));
        }
    }
    files.retain(|(_, r)| r != "instance.json");
    if format == "zip" {
        let path = out_dir.join(format!("{slug}.zip"));
        let p2 = path.clone();
        tokio::task::spawn_blocking(move || write_zip(&p2, files, vec![])).await.map_err(err)??;
        return Ok(s(&path));
    }
    let fl = files.clone();
    let cand: Vec<(String, String)> = tokio::task::spawn_blocking(move || {
        fl.iter()
            .filter(|(_, r)| ["mods/", "resourcepacks/", "shaderpacks/"].iter().any(|p| r.starts_with(p)))
            .filter_map(|(p, r)| {
                Some((r.clone(), sha1_of(Path::new(p))?))
            })
            .collect()
    })
    .await
    .map_err(err)?;
    let mut found = json!({});
    if !cand.is_empty() {
        let hashes: Vec<String> = cand.iter().map(|c| c.1.clone()).collect();
        let (st, t) = post_json(&http_client()?, &format!("{MODRINTH_API}/version_files"), json!({ "hashes": hashes, "algorithm": "sha1" })).await?;
        if st.is_success() {
            found = serde_json::from_str(&t).map_err(err)?;
        }
    }
    let mut index_files: Vec<Value> = vec![];
    let mut entries: Vec<(PathBuf, String)> = vec![];
    for (abs, rel) in files {
        let hash = cand.iter().find(|c| c.0 == rel).map(|c| c.1.clone());
        let info = hash
            .as_ref()
            .and_then(|h| found[h.as_str()]["files"].as_array())
            .and_then(|fl| fl.iter().find(|f| f["hashes"]["sha1"].as_str() == hash.as_deref()));
        if let Some(f) = info {
            index_files.push(json!({
                "path": rel,
                "hashes": { "sha1": f["hashes"]["sha1"], "sha512": f["hashes"]["sha512"] },
                "env": { "client": "required", "server": "required" },
                "downloads": [f["url"]],
                "fileSize": f["size"]
            }));
        } else {
            entries.push((abs, format!("overrides/{rel}")));
        }
    }
    let mut deps = serde_json::Map::new();
    deps.insert("minecraft".into(), inst.mc_version.clone().into());
    let key = match inst.loader.as_str() {
        "fabric" => Some("fabric-loader"),
        "quilt" => Some("quilt-loader"),
        "forge" => Some("forge"),
        "neoforge" => Some("neoforge"),
        _ => None,
    };
    if let Some(k) = key {
        deps.insert(k.into(), inst.loader_version.clone().into());
    }
    let ver = if version.trim().is_empty() { "1.0.0".to_string() } else { version.trim().to_string() };
    let index = json!({
        "formatVersion": 1, "game": "minecraft", "versionId": ver, "name": title,
        "summary": summary.trim(), "files": index_files, "dependencies": deps
    });
    let data = serde_json::to_vec_pretty(&index).map_err(err)?;
    let path = out_dir.join(format!("{slug}.mrpack"));
    let p2 = path.clone();
    tokio::task::spawn_blocking(move || write_zip(&p2, entries, vec![("modrinth.index.json".to_string(), data)]))
        .await
        .map_err(err)??;
    Ok(s(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Upd {
    file: String,
    version_id: String,
    version_name: String,
}
fn hash_dir(dir: &Path) -> Vec<(String, String)> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .take(300)
                .filter_map(|p| {
                    Some((p.file_name()?.to_string_lossy().to_string(), sha1_of(&p)?))
                })
                .collect()
        })
        .unwrap_or_default()
}
#[tauri::command]
async fn instance_updates(id: String, rel: String, kind: String) -> Result<Vec<Upd>, String> {
    let root = game_root()?;
    let inst = load_instance(&root, &id)?;
    let dir = inst_path(&id, &rel)?;
    let hashed = tokio::task::spawn_blocking(move || hash_dir(&dir)).await.map_err(err)?;
    if hashed.is_empty() {
        return Ok(vec![]);
    }
    let hashes: Vec<String> = hashed.iter().map(|h| h.1.clone()).collect();
    let mut body = json!({ "hashes": hashes, "algorithm": "sha1", "game_versions": [inst.mc_version] });
    if kind == "mod" && inst.loader != "vanilla" {
        body["loaders"] = if inst.loader == "quilt" { json!(["quilt", "fabric"]) } else { json!([inst.loader]) };
    }
    let (st, t) = post_json(&http_client()?, &format!("{MODRINTH_API}/version_files/update"), body).await?;
    if !st.is_success() {
        return Ok(vec![]);
    }
    let map: Value = serde_json::from_str(&t).map_err(err)?;
    let mut out = vec![];
    for (file, h) in &hashed {
        let v = &map[h.as_str()];
        if v.is_null() {
            continue;
        }
        let current = v["files"]
            .as_array()
            .map(|fl| fl.iter().any(|f| f["hashes"]["sha1"].as_str() == Some(h.as_str())))
            .unwrap_or(false);
        if !current {
            out.push(Upd {
                file: file.clone(),
                version_id: v["id"].as_str().unwrap_or("").to_string(),
                version_name: v["version_number"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}
#[tauri::command]
async fn instance_update(id: String, rel: String, file: String, version_id: String) -> Result<String, String> {
    check_id(&version_id)?;
    let dir = inst_path(&id, &rel)?;
    let client = http_client()?;
    let ver = get_json(&client, &format!("{MODRINTH_API}/version/{version_id}")).await?;
    let files = ver["files"].as_array().ok_or("У версии нет файлов")?;
    let f = files
        .iter()
        .find(|x| x["primary"].as_bool() == Some(true))
        .or(files.first())
        .ok_or("У версии нет файлов")?;
    let name = f["filename"].as_str().ok_or("Нет имени файла")?;
    let rel_name = safe_rel_path(name).ok_or("Недопустимое имя файла")?;
    let target = if file.ends_with(".disabled") { dir.join(format!("{name}.disabled")) } else { dir.join(&rel_name) };
    download(&client, f["url"].as_str().ok_or("Нет ссылки")?, &target, f["hashes"]["sha1"].as_str()).await?;
    let old = dir.join(safe_rel_path(&file).ok_or("Недопустимое имя")?);
    if old != target {
        let _ = std::fs::remove_file(&old);
    }
    Ok(name.to_string())
}
#[tauri::command]
fn instance_open_dir(id: String) -> Result<(), String> {
    let dir = inst_path(&id, "")?;
    if !dir.is_dir() {
        return Err("Папка сборки не найдена".into());
    }
    open_target(&s(&dir));
    Ok(())
}
#[tauri::command]
fn open_exports_dir() -> Result<(), String> {
    let dir = dirs::download_dir().unwrap_or(game_root()?.join("exports"));
    open_target(&s(&dir));
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchOptions {
    instance_id: String,
    account_id: String,
    java_path: String,
    memory_mb: u32,
    min_memory_mb: u32,
    jvm_args: String,
    width: u32,
    height: u32,
    fullscreen: bool,
    record_time: bool,
}

fn sync_window_options(game_dir: &Path, fullscreen: bool, width: u32, height: u32) {
    let path = game_dir.join("options.txt");
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let windowed = !fullscreen && width > 0 && height > 0;
    let mut seen = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| match l.split_once(':').map(|x| x.0) {
            Some("fullscreen") => {
                seen = true;
                format!("fullscreen:{fullscreen}")
            }
            Some("overrideWidth") if windowed => format!("overrideWidth:{width}"),
            Some("overrideHeight") if windowed => format!("overrideHeight:{height}"),
            _ => l.to_string(),
        })
        .collect();
    if !seen {
        lines.push(format!("fullscreen:{fullscreen}"));
    }
    let _ = std::fs::write(&path, lines.join("
") + "
");
}
fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(app: AppHandle, id: String, r: R) {
    tokio::spawn(async move {
        let mut rd = tokio::io::BufReader::new(r);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match rd.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
            let _ = app.emit("game-log", json!({ "id": id, "line": line }));
        }
    });
}
#[tauri::command]
async fn launch(app: AppHandle, options: LaunchOptions) -> Result<(), String> {
    reset_cancel();
    let client = http_client()?;
    let root = game_root()?;
    let mut inst = load_instance(&root, &options.instance_id)?;
    let game_dir = instances_dir(&root).join(&inst.id);
    fs::create_dir_all(&game_dir).await.map_err(err)?;

    let acc = load_store(&root)
        .accounts
        .iter()
        .find(|a| a.id == options.account_id)
        .cloned()
        .ok_or("Выбери аккаунт в профиле")?;
    let mut extra_jvm: Vec<String> = vec![];
    let (player_name, uuid, token, user_type) = match acc.kind.as_str() {
        "offline" => (acc.name.clone(), acc.id.clone(), "0".to_string(), "legacy".to_string()),
        "ely" => {
            log(&app, "Проверка входа Ely.by...");
            let (tok, id, name) = ely_session(&client, &root, &acc.id).await?;
            let jar = ensure_injector(&client, &root).await?;
            extra_jvm.push(format!("-javaagent:{}={ELY_INJECT}", s(&jar)));
            (name, id, tok, "mojang".to_string())
        }
        _ => {
            log(&app, "Обновление входа Microsoft...");
            let (tok, id, name) = account_session(&client, &root, &acc.id, "").await?;
            (name, id, tok, "msa".to_string())
        }
    };

    log(&app, format!("Подготовка «{}»...", inst.name));
    let mc = inst.mc_version.clone();
    let vanilla = vanilla_json(&client, &root, &mc).await?;
    let req = vanilla["javaVersion"]["majorVersion"].as_u64().unwrap_or(8) as u32;
    let java: PathBuf = if options.java_path.trim().is_empty() {
        ensure_java(&app, &client, &root, java_major_for(req)).await?
    } else {
        PathBuf::from(options.java_path.trim())
    };
    let profile = if matches!(inst.loader.as_str(), "forge" | "neoforge") {
        let p = ensure_loader_profile(&app, &client, &root, &java, &inst).await?;
        if inst.profile.as_deref() != Some(p.as_str()) {
            inst.profile = Some(p.clone());
            save_instance(&root, &inst)?;
        }
        Some(p)
    } else {
        None
    };
    let v = resolve_version(&client, &root, &inst, vanilla, profile.as_deref()).await?;

    let version_dir = root.join("versions").join(&mc);
    let libs_dir = root.join("libraries");
    let assets_dir = root.join("assets");
    let natives_dir = version_dir.join("natives");
    let mut tasks: Vec<Task> = vec![];
    let mut classpath: Vec<PathBuf> = vec![];
    let mut native_jars: Vec<PathBuf> = vec![];

    for lib in v["libraries"].as_array().into_iter().flatten() {
        if !rules_allow(lib["rules"].as_array()) {
            continue;
        }
        let dl = &lib["downloads"];
        if let Some(art) = dl.get("artifact") {
            if let Some(path) = art["path"].as_str() {
                let p = libs_dir.join(path);
                if let Some(url) = art["url"].as_str().filter(|u| !u.is_empty()) {
                    tasks.push(Task { url: url.into(), path: p.clone(), sha1: art["sha1"].as_str().map(String::from) });
                }
                classpath.push(p);
            }
        } else if lib.get("downloads").is_none() && lib.get("natives").is_none() {

            let Some(n) = lib["name"].as_str() else { continue };
            if let Some(rel) = maven_path(n) {
                let base = lib["url"].as_str().unwrap_or("https://libraries.minecraft.net/");
                let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
                let p = libs_dir.join(&rel);
                tasks.push(Task { url: format!("{base}{rel}"), path: p.clone(), sha1: lib["sha1"].as_str().map(String::from) });
                classpath.push(p);
            }
        }
        if let Some(key) = lib["natives"][OS_NAME].as_str() {
            let key = key.replace("${arch}", if cfg!(target_pointer_width = "64") { "64" } else { "32" });
            if let Some(cl) = dl["classifiers"].get(&key) {
                if let (Some(path), Some(url)) = (cl["path"].as_str(), cl["url"].as_str()) {
                    let p = libs_dir.join(path);
                    tasks.push(Task { url: url.into(), path: p.clone(), sha1: cl["sha1"].as_str().map(String::from) });
                    native_jars.push(p);
                }
            } else if lib.get("downloads").is_none() {
                if let Some(rel) = lib["name"].as_str().and_then(|n| maven_path(&format!("{n}:{key}"))) {
                    let base = lib["url"].as_str().unwrap_or("https://libraries.minecraft.net/");
                    let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
                    let p = libs_dir.join(&rel);
                    tasks.push(Task { url: format!("{base}{rel}"), path: p.clone(), sha1: None });
                    native_jars.push(p);
                }
            }
        }
    }
    let client_dl = &v["downloads"]["client"];
    let client_jar = version_dir.join(format!("{mc}.jar"));
    tasks.push(Task {
        url: client_dl["url"].as_str().ok_or("Нет ссылки на client.jar")?.into(),
        path: client_jar.clone(),
        sha1: client_dl["sha1"].as_str().map(String::from),
    });
    classpath.push(client_jar);
    let mut seen = std::collections::HashSet::new();
    classpath.retain(|p| seen.insert(p.clone()));

    let asset_id = v["assetIndex"]["id"].as_str().ok_or("Нет assetIndex")?.to_string();
    let index_path = assets_dir.join("indexes").join(format!("{asset_id}.json"));
    download(
        &client,
        v["assetIndex"]["url"].as_str().ok_or("Нет ссылки на assetIndex")?,
        &index_path,
        v["assetIndex"]["sha1"].as_str(),
    )
    .await?;
    let index: Value = serde_json::from_str(&fs::read_to_string(&index_path).await.map_err(err)?).map_err(err)?;

    let virtual_root: Option<PathBuf> = if index["map_to_resources"].as_bool() == Some(true) {
        Some(game_dir.join("resources"))
    } else if index["virtual"].as_bool() == Some(true) {
        Some(assets_dir.join("virtual").join(&asset_id))
    } else {
        None
    };
    let mut legacy: Vec<(PathBuf, PathBuf)> = vec![];
    if let Some(objects) = index["objects"].as_object() {
        for (name, obj) in objects {
            if let Some(hash) = obj["hash"].as_str().filter(|h| h.len() > 2) {
                let prefix = &hash[..2];
                let obj_path = assets_dir.join("objects").join(prefix).join(hash);
                tasks.push(Task {
                    url: format!("{ASSETS_URL}/{prefix}/{hash}"),
                    path: obj_path.clone(),
                    sha1: Some(hash.to_string()),
                });
                if let (Some(vr), Some(rel)) = (&virtual_root, safe_rel_path(name)) {
                    legacy.push((obj_path, vr.join(rel)));
                }
            }
        }
    }
    download_all(&app, &client, tasks).await?;
    if !legacy.is_empty() {
        tokio::task::spawn_blocking(move || {
            for (src, dst) in legacy {
                if dst.exists() {
                    continue;
                }
                if let Some(p) = dst.parent() {
                    let _ = std::fs::create_dir_all(p);
                }
                let _ = std::fs::copy(&src, &dst);
            }
        })
        .await
        .map_err(err)?;
    }
    let game_assets = virtual_root.clone().unwrap_or_else(|| assets_dir.clone());

    fs::create_dir_all(&natives_dir).await.map_err(err)?;
    for jar in native_jars {
        let dest = natives_dir.clone();
        tokio::task::spawn_blocking(move || extract_natives(&jar, &dest)).await.map_err(err)??;
    }

    let classpath_str = classpath.iter().map(|p| s(p)).collect::<Vec<_>>().join(CP_SEP);
    let (jvm_raw, game_raw) = if let Some(a) = v.get("arguments") {
        (
            a["jvm"].as_array().map(|x| collect_args(x)).unwrap_or_default(),
            a["game"].as_array().map(|x| collect_args(x)).unwrap_or_default(),
        )
    } else {
        (
            vec!["-Djava.library.path=${natives_directory}".to_string(), "-cp".to_string(), "${classpath}".to_string()],
            v["minecraftArguments"].as_str().unwrap_or("").split_whitespace().map(String::from).collect(),
        )
    };
    let session = format!("token:{token}:{uuid}");
    let vars: Vec<(&str, String)> = vec![
        ("${auth_player_name}", player_name),
        ("${version_name}", profile.clone().unwrap_or_else(|| mc.clone())),
        ("${game_directory}", s(&game_dir)),
        ("${assets_root}", s(&assets_dir)),
        ("${game_assets}", s(&game_assets)),
        ("${assets_index_name}", asset_id),
        ("${auth_uuid}", uuid),
        ("${auth_access_token}", token.clone()),
        ("${auth_session}", session),
        ("${user_type}", user_type),
        ("${version_type}", v["type"].as_str().unwrap_or("release").into()),
        ("${natives_directory}", s(&natives_dir)),
        ("${launcher_name}", "ItsLauncher".into()),
        ("${launcher_version}", "0.3".into()),
        ("${classpath}", classpath_str),
        ("${library_directory}", s(&libs_dir)),
        ("${classpath_separator}", CP_SEP.into()),
        ("${user_properties}", "{}".into()),
        ("${clientid}", "0".into()),
        ("${auth_xuid}", "0".into()),
    ];
    let fill = |mut a: String| {
        for (k, val) in &vars {
            a = a.replace(k, val);
        }
        a
    };
    let main_class = v["mainClass"].as_str().ok_or("Нет mainClass")?.to_string();
    let mut args: Vec<String> = vec![];
    if options.min_memory_mb > 0 {
        args.push(format!("-Xms{}M", options.min_memory_mb));
    }
    args.push(format!("-Xmx{}M", options.memory_mb));
    args.extend(split_args(&options.jvm_args));
    args.extend(extra_jvm);
    args.extend(jvm_raw.into_iter().map(&fill));
    args.push(main_class);
    args.extend(game_raw.into_iter().map(&fill));
    if options.width > 0 && options.height > 0 {
        args.extend(["--width".to_string(), options.width.to_string(), "--height".to_string(), options.height.to_string()]);
    }
    if options.fullscreen {
        args.push("--fullscreen".into());
    }

    sync_window_options(&game_dir, options.fullscreen, options.width, options.height);
    log(&app, "Запуск игры...");
    let mut cmd = Command::new(&java);
    cmd.args(&args)
        .current_dir(&game_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Не удалось запустить Java («{}»): {e}", java.display()))?;
    let id = inst.id.clone();
    let _ = app.emit("game-start", id.clone());
    if let Some(o) = child.stdout.take() {
        pump(app.clone(), id.clone(), o);
    }
    if let Some(e) = child.stderr.take() {
        pump(app.clone(), id.clone(), e);
    }
    let started = Instant::now();
    let record = options.record_time;
    let app2 = app.clone();
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut m) = stoppers().lock() {
        m.insert(id.clone(), tx);
    }
    tokio::spawn(async move {
        let mut killed = false;
        let status = tokio::select! {
            r = child.wait() => r.ok(),
            _ = &mut rx => {
                killed = true;
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };
        let code = status.and_then(|s| s.code()).unwrap_or(-1);
        if let Ok(mut m) = stoppers().lock() {
            m.remove(&id);
        }
        let secs = started.elapsed().as_secs();
        if let Ok(mut i) = load_instance(&root, &id) {
            if record {
                i.played += secs;
            }
            i.last_played = now_secs();
            let _ = save_instance(&root, &i);
        }
        let _ = app2.emit("game-exit", json!({ "id": id, "code": code, "secs": secs, "killed": killed }));
    });
    Ok(())
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct PackInfo {
    kind: String,
    name: String,
    mc_version: String,
    loader: String,
    loader_version: String,
    #[serde(skip)]
    base: String,
    #[serde(skip)]
    overrides: String,
    #[serde(skip)]
    cf_files: Vec<(u64, u64)>,
}
fn read_zip_text(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut t = String::new();
    f.read_to_string(&mut t).ok()?;
    Some(t)
}
fn loader_key(x: &str) -> &'static str {
    match x.trim().to_lowercase().as_str() {
        "forge" => "forge",
        "neoforge" => "neoforge",
        "fabric" => "fabric",
        "quilt" => "quilt",
        _ => "vanilla",
    }
}

fn wrapper_of(names: &[String]) -> String {
    let known = [
        "mods", "config", "resourcepacks", "shaderpacks", "saves", "scripts", "kubejs", "defaultconfigs",
        "datapacks", "options.txt", "servers.dat", "libraries", "logs", "screenshots",
    ];
    let mut first: Option<String> = None;
    for n in names {
        let n = n.replace('\\', "/");
        let Some((a, _)) = n.split_once('/') else { return String::new() };
        match &first {
            None => first = Some(a.to_string()),
            Some(f) if f != a => return String::new(),
            _ => {}
        }
    }
    match first {
        Some(f) if !known.contains(&f.to_lowercase().as_str()) => f,
        _ => String::new(),
    }
}
fn inspect_zip(path: &Path) -> Result<PackInfo, String> {
    let file = std::fs::File::open(path).map_err(err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Не удалось открыть архив как zip: {e}"))?;
    let stem = path
        .file_stem()
        .map(|x| x.to_string_lossy().to_string())
        .filter(|x| !x.trim().is_empty())
        .unwrap_or_else(|| "Сборка".to_string());
    let mut names: Vec<String> = vec![];
    for i in 0..zip.len() {
        let Ok(f) = zip.by_index(i) else { continue };
        let Some(ep) = f.enclosed_name() else { continue };
        let mut n = ep.to_string_lossy().replace('\\', "/");
        if f.is_dir() && !n.ends_with('/') {
            n.push('/');
        }
        names.push(n);
    }
    if let Some(t) = read_zip_text(&mut zip, "modrinth.index.json") {
        let v: Value = serde_json::from_str(&t).map_err(|e| format!("Повреждён modrinth.index.json: {e}"))?;
        let d = &v["dependencies"];
        let (loader, lv) = if let Some(x) = d["fabric-loader"].as_str() {
            ("fabric", x)
        } else if let Some(x) = d["quilt-loader"].as_str() {
            ("quilt", x)
        } else if let Some(x) = d["neoforge"].as_str() {
            ("neoforge", x)
        } else if let Some(x) = d["forge"].as_str() {
            ("forge", x)
        } else {
            ("vanilla", "")
        };
        let mc = d["minecraft"].as_str().ok_or("В сборке не указана версия Minecraft")?;
        return Ok(PackInfo {
            kind: "mrpack".into(),
            name: v["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(&stem).to_string(),
            mc_version: mc.to_string(),
            loader: loader.into(),
            loader_version: lv.into(),
            ..Default::default()
        });
    }
    if let Some(t) = read_zip_text(&mut zip, "manifest.json") {
        if let Ok(m) = serde_json::from_str::<Value>(&t) {
            if let Some(mc) = m["minecraft"]["version"].as_str() {
                let ml = m["minecraft"]["modLoaders"].as_array();
                let pick = ml.and_then(|a| a.iter().find(|x| x["primary"].as_bool() == Some(true)).or_else(|| a.first()));
                let id = pick.and_then(|x| x["id"].as_str()).unwrap_or("");
                let (l, ver) = id.split_once('-').unwrap_or((id, ""));
                let loader = loader_key(l);
                let cf_files = m["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|f| f["required"].as_bool() != Some(false))
                    .filter_map(|f| Some((f["projectID"].as_u64()?, f["fileID"].as_u64()?)))
                    .collect();
                return Ok(PackInfo {
                    kind: "curseforge".into(),
                    name: m["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(&stem).to_string(),
                    mc_version: mc.to_string(),
                    loader: loader.into(),
                    loader_version: if loader == "vanilla" { String::new() } else { ver.to_string() },
                    overrides: m["overrides"].as_str().unwrap_or("overrides").to_string(),
                    cf_files,
                    ..Default::default()
                });
            }
        }
    }
    if let Some(n) = names.iter().find(|n| n.ends_with("mmc-pack.json")) {
        let base = n.trim_end_matches("mmc-pack.json").to_string();
        if let Some(t) = read_zip_text(&mut zip, n) {
            if let Ok(m) = serde_json::from_str::<Value>(&t) {
                let (mut mc, mut loader, mut lv) = (String::new(), "vanilla", String::new());
                for c in m["components"].as_array().into_iter().flatten() {
                    let ver = c["version"].as_str().unwrap_or("").to_string();
                    match c["uid"].as_str().unwrap_or("") {
                        "net.minecraft" => mc = ver,
                        "net.fabricmc.fabric-loader" => (loader, lv) = ("fabric", ver),
                        "org.quiltmc.quilt-loader" => (loader, lv) = ("quilt", ver),
                        "net.minecraftforge" => (loader, lv) = ("forge", ver),
                        "net.neoforged" => (loader, lv) = ("neoforge", ver),
                        _ => {}
                    }
                }
                if !mc.is_empty() {
                    let name = read_zip_text(&mut zip, &format!("{base}instance.cfg"))
                        .and_then(|c| c.lines().find_map(|l| l.strip_prefix("name=").map(|x| x.trim().to_string())))
                        .filter(|x| !x.is_empty())
                        .unwrap_or(stem);
                    return Ok(PackInfo {
                        kind: "prism".into(),
                        name,
                        mc_version: mc,
                        loader: loader.into(),
                        loader_version: lv,
                        base,
                        ..Default::default()
                    });
                }
            }
        }
    }
    if names.iter().all(|n| n.ends_with('/')) {
        return Err("Архив пуст".into());
    }
    Ok(PackInfo { kind: "plain".into(), name: stem, base: wrapper_of(&names), ..Default::default() })
}
fn extract_into(zip_path: &Path, dest: &Path, prefixes: &[String]) -> Result<usize, String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(zip_path).map_err(err)?).map_err(err)?;
    let mut count = 0usize;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(err)?;
        if f.is_dir() {
            continue;
        }
        let Some(ep) = f.enclosed_name() else { continue };
        let mut rel: Option<PathBuf> = None;
        for pre in prefixes {
            if pre.trim_matches('/').is_empty() {
                rel = Some(ep.clone());
                break;
            }
            if let Ok(r) = ep.strip_prefix(pre.trim_matches('/')) {
                rel = Some(r.to_path_buf());
                break;
            }
        }
        let Some(rel) = rel else { continue };
        if rel.as_os_str().is_empty() || rel == Path::new("instance.json") {
            continue;
        }
        let target = dest.join(&rel);
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(err)?;
        }
        let mut out = std::fs::File::create(&target).map_err(err)?;
        std::io::copy(&mut f, &mut out).map_err(err)?;
        count += 1;
    }
    Ok(count)
}
fn pct_decode(x: &str) -> String {
    let b = x.as_bytes();
    let mut o: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                o.push(v);
                i += 3;
                continue;
            }
        }
        o.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&o).to_string()
}
async fn cf_download(client: &reqwest::Client, pid: u64, fid: u64, dir: &Path) -> Result<(), String> {
    if cancelled() {
        return Err(CANCELLED.into());
    }
    let url = format!("https://www.curseforge.com/api/v1/mods/{pid}/files/{fid}/download");
    let resp = client.get(&url).send().await.map_err(nerr)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let raw = resp.url().path_segments().and_then(|mut sg| sg.next_back()).map(pct_decode).unwrap_or_default();
    let fname = Path::new(&raw)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty() && n.contains('.'))
        .unwrap_or_else(|| format!("{pid}-{fid}.jar"));
    let path = dir.join(&fname);
    if path.exists() {
        return Ok(());
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = PathBuf::from(tmp);
    stream_body(resp, &tmp).await?;
    fs::rename(&tmp, &path).await.map_err(err)
}
#[tauri::command]
async fn inspect_pack(path: String) -> Result<PackInfo, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err("Файл не найден".into());
    }
    tokio::task::spawn_blocking(move || inspect_zip(&p)).await.map_err(err)?
}
async fn import_inner(
    app: &AppHandle,
    client: &reqwest::Client,
    pack: &Path,
    dir: &Path,
    info: &PackInfo,
    id: String,
    title: String,
) -> Result<Instance, String> {
    if info.kind == "mrpack" {
        let (mut inst, files) = install_pack(app, client, pack, dir, id, title, None).await?;
        inst.pack_files = files;
        return Ok(inst);
    }
    log(app, "Распаковка сборки...");
    let prefixes: Vec<String> = match info.kind.as_str() {
        "curseforge" => vec![info.overrides.clone()],
        "prism" => vec![format!("{}.minecraft", info.base), format!("{}minecraft", info.base)],
        _ => vec![info.base.clone()],
    };
    let (p2, d2) = (pack.to_path_buf(), dir.to_path_buf());
    tokio::task::spawn_blocking(move || extract_into(&p2, &d2, &prefixes)).await.map_err(err)??;
    if info.kind == "curseforge" && !info.cf_files.is_empty() {
        let mods_dir = dir.join("mods");
        fs::create_dir_all(&mods_dir).await.map_err(err)?;
        let total = info.cf_files.len();
        log(app, format!("Загрузка модов сборки «{title}»..."));
        let _ = app.emit("progress", Progress { done: 0, total });
        let mut results = stream::iter(info.cf_files.clone())
            .map(|(pid, fid)| {
                let c = client.clone();
                let d = mods_dir.clone();
                async move {
                    let mut last: Result<(), String> = Ok(());
                    for _ in 0..3 {
                        last = cf_download(&c, pid, fid, &d).await;
                        match &last {
                            Ok(_) => break,
                            Err(e) if e == CANCELLED => break,
                            _ => tokio::time::sleep(Duration::from_millis(500)).await,
                        }
                    }
                    last.map_err(|e| if e == CANCELLED { e } else { format!("мод {pid}/{fid}: {e}") })
                }
            })
            .buffer_unordered(8);
        let (mut done, mut failed) = (0usize, Vec::<String>::new());
        while let Some(r) = results.next().await {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            if let Err(e) = r {
                failed.push(e);
            }
            done += 1;
            let _ = app.emit("progress", Progress { done, total });
        }
        if !failed.is_empty() {
            return Err(format!(
                "Не удалось скачать модов: {} из {total}.\n{}",
                failed.len(),
                failed.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
            ));
        }
    }
    Ok(Instance {
        id,
        name: title,
        mc_version: info.mc_version.clone(),
        loader: info.loader.clone(),
        loader_version: info.loader_version.clone(),
        ..Default::default()
    })
}
#[tauri::command]
async fn import_pack(app: AppHandle, path: String, name: String, mc_version: String, loader: String) -> Result<Instance, String> {
    reset_cancel();
    let pack = PathBuf::from(path.trim());
    if !pack.is_file() {
        return Err("Файл сборки не найден".into());
    }
    let p2 = pack.clone();
    let mut info = tokio::task::spawn_blocking(move || inspect_zip(&p2)).await.map_err(err)??;
    let client = http_client()?;
    let root = game_root()?;
    if info.kind == "plain" {
        if mc_version.trim().is_empty() {
            return Err("Выбери версию Minecraft для этой сборки".into());
        }
        info.mc_version = mc_version.trim().to_string();
        info.loader = loader_key(&loader).to_string();
        if info.loader != "vanilla" {
            log(&app, "Поиск версии загрузчика...");
            info.loader_version = latest_loader(&client, &info.loader, &info.mc_version).await?;
        }
    }
    let wanted = if name.trim().is_empty() { info.name.clone() } else { name.trim().to_string() };
    let title = unique_name(&root, &wanted, None);
    let id = unique_id(&root, &title);
    let dir = instances_dir(&root).join(&id);
    fs::create_dir_all(&dir).await.map_err(err)?;
    log(&app, format!("Импорт «{title}»..."));
    match import_inner(&app, &client, &pack, &dir, &info, id, title).await {
        Ok(inst) => {
            save_instance(&root, &inst)?;
            Ok(inst)
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&dir).await;
            Err(e)
        }
    }
}
#[cfg(windows)]
async fn pick_file_impl() -> Result<Option<String>, String> {
    let script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; \
$f = New-Object System.Windows.Forms.OpenFileDialog; $f.Title = 'Выберите сборку'; \
$f.Filter = 'Сборки (*.mrpack;*.zip)|*.mrpack;*.zip|Все файлы (*.*)|*.*'; \
if ($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
        .stdin(std::process::Stdio::null());
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| format!("Не удалось открыть окно выбора файла: {e}"))?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if p.is_empty() { None } else { Some(p) })
}
#[cfg(not(windows))]
async fn pick_file_impl() -> Result<Option<String>, String> {
    let out = Command::new("zenity")
        .args(["--file-selection", "--title=Выберите сборку"])
        .output()
        .await
        .map_err(|_| "Выбор файла недоступен: перетащи файл сборки в окно".to_string())?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if p.is_empty() { None } else { Some(p) })
}
#[tauri::command]
async fn pick_pack_file() -> Result<Option<String>, String> {
    pick_file_impl().await
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u8);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[tauri::command]
async fn account_skin(id: String) -> Result<Option<String>, String> {
    let id: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if id.len() != 32 {
        return Ok(None);
    }
    let client = http_client()?;
    let cache = game_root()?.join("skins").join(format!("{id}.png"));
    let read_cache = || std::fs::read(&cache).ok().map(|d| format!("data:image/png;base64,{}", b64(&d)));
    let fresh = std::fs::metadata(&cache)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs() < 3600)
        .unwrap_or(false);
    if fresh {
        return Ok(read_cache());
    }
    let fetched: Result<Vec<u8>, String> = async {
        let v = get_json(&client, &format!("https://sessionserver.mojang.com/session/minecraft/profile/{id}")).await?;
        let raw = v["properties"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["name"].as_str() == Some("textures"))
            .and_then(|p| p["value"].as_str())
            .ok_or("Нет текстур")?;
        let dec = b64_decode(raw).ok_or("Некорректные данные текстур")?;
        let tex: Value = serde_json::from_slice(&dec).map_err(err)?;
        let url = tex["textures"]["SKIN"]["url"].as_str().ok_or("У игрока нет скина")?.to_string();
        let url = url.replacen("http://", "https://", 1);
        if !url.starts_with("https://textures.minecraft.net/") {
            return Err(format!("Недопустимый адрес скина: {url}"));
        }
        let bytes = client.get(&url).send().await.map_err(err)?.error_for_status().map_err(err)?.bytes().await.map_err(err)?;
        Ok(bytes.to_vec())
    }
    .await;
    match fetched {
        Ok(bytes) => {
            if let Some(dir) = cache.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&cache, &bytes);
            Ok(Some(format!("data:image/png;base64,{}", b64(&bytes))))
        }
        Err(e) => match read_cache() {
            Some(d) => Ok(Some(d)),
            None => Err(e),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_versions, list_instances, create_instance, delete_instance, instance_list_dir,
            instance_delete, instance_toggle_mod, instance_import, instance_identify, instance_worlds, instance_top, instance_updates, instance_update, loader_versions, instance_change,
            instance_read_image, instance_read_log, instance_set_settings, instance_export, open_exports_dir, instance_open_dir,
            fetch_instance_icon, open_url, quit_app, launch, stop_instance, instance_pack_update, modrinth_update_pack, instance_rename, instance_set_detached, instance_packs, instance_set_pack, modrinth_search, modrinth_versions, modrinth_install,
            modrinth_install_project, ms_client_ready, ms_begin_login, ms_poll_login, reset_launcher, list_accounts,
            set_active_account, remove_account, add_offline_account, ely_login, java_list,
            java_install, java_remove, account_skin, cancel_task, inspect_pack, import_pack, pick_pack_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
