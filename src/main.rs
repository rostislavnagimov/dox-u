use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex},
};

use askama::Template;
use axum::{
    Router,
    extract::{ConnectInfo, DefaultBodyLimit, Json, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    collector_mode: bool,
    trusted_proxy_ips: HashSet<IpAddr>,
}

#[derive(Template)]
#[template(path = "index.html")]
struct Page {
    server_data_json: String,
    ip_response_json: String,
}

#[derive(Template)]
#[template(path = "visits.html")]
struct VisitsPage {
    visits: Vec<VisitView>,
    empty: bool,
    total: usize,
    current_page: usize,
    page_count: usize,
    has_previous: bool,
    previous_page: usize,
    has_next: bool,
    next_page: usize,
}

struct VisitView {
    id: String,
    created_at: String,
    completed_at: String,
    completed: bool,
    platform: String,
    device_type: String,
    device_model: String,
    browser: String,
    ip: String,
    peer_ip: String,
    location: String,
    ip_timezone: String,
    client_timezone: String,
    server_json: String,
    client_json: String,
    ip_json: String,
    events: Vec<EventView>,
    event_count: usize,
}

struct VisitRecord {
    id: String,
    created_at: String,
    completed_at: Option<String>,
    server_data_json: String,
    server_ip_response_json: String,
    client_data_json: Option<String>,
    webrtc_ip_responses_json: Option<String>,
    events: Vec<EventRecord>,
}

struct EventRecord {
    name: String,
    created_at: String,
    properties_json: String,
}

struct EventView {
    name: String,
    created_at: String,
    properties_json: String,
}

const VISITS_PER_PAGE: usize = 50;

fn open_database(path: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    if path != ":memory:"
        && let Some(parent) = Path::new(path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }

    let db = Connection::open(path)?;
    db.execute_batch(
        "PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS visits (
             id TEXT PRIMARY KEY,
             created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             completed_at TEXT,
             server_data_json TEXT NOT NULL,
             server_ip_response_json TEXT NOT NULL,
             client_data_json TEXT,
             webrtc_ip_responses_json TEXT
         );
         CREATE TABLE IF NOT EXISTS events (
             id TEXT PRIMARY KEY,
             visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
             created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             name TEXT NOT NULL,
             properties_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_visits_created_at
             ON visits(created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_events_visit_created_at
             ON events(visit_id, created_at);",
    )?;
    Ok(db)
}

fn trusted_proxy_ips_from_env() -> HashSet<IpAddr> {
    std::env::var("TRUSTED_PROXY_IPS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value.parse::<IpAddr>().unwrap_or_else(|error| {
                panic!("Invalid IP in TRUSTED_PROXY_IPS ({value}): {error}");
            })
        })
        .collect()
}

fn header_value<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn json_string(value: &Value, pointer: &str) -> Option<String> {
    match value.pointer(pointer)? {
        Value::String(value) if !value.is_empty() && value != "Unknown" => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn first_json_string(values: &[Option<String>]) -> String {
    values
        .iter()
        .find_map(|value| value.as_ref().filter(|value| !value.is_empty()).cloned())
        .unwrap_or_else(|| "—".into())
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn ip_geo_response<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value
        .pointer(&format!("/{key}/response"))
        .or_else(|| (key == "server" && value.get("success").is_some()).then_some(value))
}

fn ip_location(value: &Value, key: &str) -> String {
    let Some(response) = ip_geo_response(value, key) else {
        return "—".into();
    };
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return "—".into();
    }
    ["city", "region", "country"]
        .iter()
        .filter_map(|key| response.get(key).and_then(Value::as_str))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn visit_view(record: VisitRecord) -> VisitView {
    let server: Value = serde_json::from_str(&record.server_data_json).unwrap_or(Value::Null);
    let client: Value = record
        .client_data_json
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or(Value::Null);
    let server_ip_responses: Value =
        serde_json::from_str(&record.server_ip_response_json).unwrap_or(Value::Null);
    let webrtc_ip_responses: Value = record
        .webrtc_ip_responses_json
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_else(|| json!([]));
    let ip = json!({
        "server": server_ip_responses.get("server"),
        "peer": server_ip_responses.get("peer"),
        "webrtc": webrtc_ip_responses,
    });

    let events = record
        .events
        .into_iter()
        .map(|event| {
            let properties = serde_json::from_str(&event.properties_json).unwrap_or(Value::Null);
            EventView {
                name: event.name,
                created_at: event.created_at,
                properties_json: pretty_json(&properties),
            }
        })
        .collect::<Vec<_>>();

    VisitView {
        id: record.id,
        created_at: record.created_at,
        completed: record.completed_at.is_some(),
        completed_at: record.completed_at.unwrap_or_else(|| "—".into()),
        platform: first_json_string(&[
            json_string(&server, "/platform"),
            json_string(&client, "/uaData/platform"),
            json_string(&client, "/platform"),
        ]),
        device_type: first_json_string(&[
            json_string(&server, "/deviceType"),
            client
                .pointer("/uaData/mobile")
                .and_then(Value::as_bool)
                .map(|mobile| if mobile { "Mobile" } else { "Desktop" }.to_string()),
        ]),
        device_model: first_json_string(&[
            json_string(&server, "/deviceModel"),
            json_string(&client, "/uaData/model"),
        ]),
        browser: first_json_string(&[json_string(&server, "/browser")]),
        ip: first_json_string(&[json_string(&server, "/ip")]),
        peer_ip: first_json_string(&[json_string(&server, "/peerIp")]),
        location: ip_location(&server_ip_responses, "server"),
        ip_timezone: first_json_string(&[ip_geo_response(&server_ip_responses, "server")
            .and_then(|response| json_string(response, "/timezone/id"))]),
        client_timezone: first_json_string(&[json_string(&client, "/tz")]),
        server_json: pretty_json(&server),
        client_json: if client.is_null() {
            "Not collected".into()
        } else {
            pretty_json(&client)
        },
        ip_json: pretty_json(&ip),
        event_count: events.len(),
        events,
    }
}

fn request_ip(
    headers: &HeaderMap,
    peer: SocketAddr,
    trusted_proxy_ips: &HashSet<IpAddr>,
) -> (IpAddr, &'static str) {
    if !trusted_proxy_ips.contains(&peer.ip()) {
        return (peer.ip(), "connection");
    }

    if let Some(value) = header_value(headers, "x-forwarded-for") {
        for ip in value
            .split(',')
            .rev()
            .filter_map(|value| value.trim().parse::<IpAddr>().ok())
        {
            if !trusted_proxy_ips.contains(&ip) {
                return (ip, "x-forwarded-for");
            }
        }
    }

    if let Some(ip) = header_value(headers, "x-real-ip")
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .filter(|ip| !trusted_proxy_ips.contains(ip))
    {
        return (ip, "x-real-ip");
    }

    (peer.ip(), "connection")
}

fn header_hint<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    header_value(headers, name).map(|value| value.trim_matches('"'))
}

fn parse_server_data(
    headers: &HeaderMap,
    peer: SocketAddr,
    trusted_proxy_ips: &HashSet<IpAddr>,
) -> Value {
    let ua = header_value(headers, "user-agent").unwrap_or("");
    let (ip, ip_source) = request_ip(headers, peer, trusted_proxy_ips);

    let platform = header_hint(headers, "sec-ch-ua-platform")
        .or_else(|| {
            if ua.contains("Android") {
                Some("Android")
            } else if ua.contains("iPhone") || ua.contains("iPad") {
                Some("iOS")
            } else if ua.contains("Windows") {
                Some("Windows")
            } else if ua.contains("Macintosh") {
                Some("macOS")
            } else if ua.contains("CrOS") {
                Some("ChromeOS")
            } else if ua.contains("Linux") {
                Some("Linux")
            } else {
                None
            }
        })
        .unwrap_or("Unknown");

    let browser = header_value(headers, "sec-ch-ua-full-version-list")
        .or_else(|| header_value(headers, "sec-ch-ua"))
        .and_then(|brands| {
            brands
                .split(", ")
                .filter_map(|brand| brand.split_once(";v="))
                .map(|(name, version)| (name.trim_matches('"'), version.trim_matches('"')))
                .find(|(name, _)| !name.starts_with("Not") && *name != "Chromium")
        })
        .map(|(name, version)| format!("{name} {version}"))
        .or_else(|| {
            [
                ("Edg/", "Edge"),
                ("OPR/", "Opera"),
                ("Firefox/", "Firefox"),
                ("FxiOS/", "Firefox"),
                ("CriOS/", "Chrome"),
                ("Chrome/", "Chrome"),
                ("Version/", "Safari"),
            ]
            .iter()
            .find_map(|(marker, name)| {
                ua.split_once(marker).map(|(_, suffix)| {
                    let version = suffix
                        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
                        .next()
                        .unwrap_or("");
                    if version.is_empty() {
                        name.to_string()
                    } else {
                        format!("{name} {version}")
                    }
                })
            })
        })
        .unwrap_or_else(|| "Unknown".into());

    let device_type =
        if header_value(headers, "sec-ch-ua-mobile") == Some("?1") || ua.contains("Mobi") {
            "Mobile"
        } else {
            "Desktop"
        };
    let languages = header_value(headers, "accept-language")
        .map(|value| {
            value
                .split(',')
                .filter_map(|item| item.split(';').next())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "Unknown".into());

    json!({
        "platform": platform,
        "platformVersion": header_hint(headers, "sec-ch-ua-platform-version").filter(|value| !value.is_empty()).unwrap_or("Unknown"),
        "deviceModel": header_hint(headers, "sec-ch-ua-model").filter(|value| !value.is_empty()).unwrap_or("Unknown"),
        "architecture": header_hint(headers, "sec-ch-ua-arch").filter(|value| !value.is_empty()).unwrap_or("Unknown"),
        "bitness": header_hint(headers, "sec-ch-ua-bitness").filter(|value| !value.is_empty()).unwrap_or("Unknown"),
        "deviceType": device_type,
        "browser": browser,
        "languages": languages,
        "ip": ip.to_string(),
        "peerIp": peer.ip().to_string(),
        "ipMatchesPeer": ip == peer.ip(),
        "ipSource": ip_source,
        "origin": header_value(headers, "origin"),
        "referer": header_value(headers, "referer"),
        "fetchSite": header_value(headers, "sec-fetch-site"),
    })
}

fn server_headers_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        "accept-ch",
        HeaderValue::from_static(
            "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-Arch, Sec-CH-UA-Bitness",
        ),
    );
    response
}

async fn index(State(state): State<AppState>) -> Result<Response, StatusCode> {
    if state.collector_mode {
        return Ok(server_headers_response(
            Html("<!doctype html><html><head><meta charset=\"utf-8\"><title>Collector</title></head><body><script src=\"/script.js\" defer></script></body></html>")
                .into_response(),
        ));
    }
    let page = Page {
        server_data_json: "{}".into(),
        ip_response_json: "null".into(),
    };
    let html = page.render().map_err(|error| {
        eprintln!("Could not render overview: {error}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(server_headers_response(Html(html).into_response()))
}

async fn visits(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Html<String>, StatusCode> {
    let requested_page = query
        .get("page")
        .and_then(|page| page.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    let db = state.db.clone();
    let (total, current_page, page_count, mut records, mut events_by_visit) =
        tokio::task::spawn_blocking(move || -> rusqlite::Result<_> {
            let db = db.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
            let total: usize = db.query_row("SELECT COUNT(*) FROM visits", [], |row| {
                let count: i64 = row.get(0)?;
                usize::try_from(count).map_err(|_| rusqlite::Error::InvalidQuery)
            })?;
            let page_count = total.div_ceil(VISITS_PER_PAGE);
            let current_page = if page_count == 0 {
                1
            } else {
                requested_page.min(page_count)
            };
            let offset = (current_page - 1) * VISITS_PER_PAGE;
            let mut statement = db.prepare(
                "SELECT id, created_at, completed_at, server_data_json, server_ip_response_json, client_data_json, webrtc_ip_responses_json FROM visits ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
            )?;
            let rows = statement.query_map(
                params![VISITS_PER_PAGE as i64, offset as i64],
                |row| {
                    Ok(VisitRecord {
                        id: row.get(0)?,
                        created_at: row.get(1)?,
                        completed_at: row.get(2)?,
                        server_data_json: row.get(3)?,
                        server_ip_response_json: row.get(4)?,
                        client_data_json: row.get(5)?,
                        webrtc_ip_responses_json: row.get(6)?,
                        events: Vec::new(),
                    })
                },
            )?;
            let records = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);

            let visit_ids = records
                .iter()
                .map(|record| record.id.clone())
                .collect::<Vec<_>>();
            let mut events_by_visit: HashMap<String, Vec<EventRecord>> = HashMap::new();
            if !visit_ids.is_empty() {
                let placeholders = (0..visit_ids.len())
                    .map(|_| "?")
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT visit_id, name, created_at, properties_json FROM events WHERE visit_id IN ({placeholders}) ORDER BY created_at ASC, id ASC"
                );
                let mut statement = db.prepare(&sql)?;
                let rows = statement.query_map(params_from_iter(visit_ids.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        EventRecord {
                            name: row.get(1)?,
                            created_at: row.get(2)?,
                            properties_json: row.get(3)?,
                        },
                    ))
                })?;
                for row in rows {
                    let (visit_id, event) = row?;
                    events_by_visit.entry(visit_id).or_default().push(event);
                }
            }
            Ok((
                total,
                current_page,
                page_count,
                records,
                events_by_visit,
            ))
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    for record in &mut records {
        record.events = events_by_visit.remove(&record.id).unwrap_or_default();
    }

    let views = records.into_iter().map(visit_view).collect::<Vec<_>>();
    let page = VisitsPage {
        empty: views.is_empty(),
        total,
        current_page,
        page_count,
        has_previous: current_page > 1,
        previous_page: current_page.saturating_sub(1),
        has_next: current_page < page_count,
        next_page: current_page + 1,
        visits: views,
    };
    page.render()
        .map(Html)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn script(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let server = parse_server_data(&headers, peer, &state.trusted_proxy_ips);
    let ip_response = json!({ "server": null, "peer": null, "webrtc": [] });

    let visit_id = Uuid::new_v4().to_string();
    let db = state.db.clone();
    let id_for_db = visit_id.clone();
    let server_json = server.to_string();
    let ip_json = ip_response.to_string();
    let saved = tokio::task::spawn_blocking(move || -> rusqlite::Result<()> {
        db.lock().map_err(|_| rusqlite::Error::InvalidQuery)?
            .execute(
                "INSERT INTO visits (id, server_data_json, server_ip_response_json) VALUES (?1, ?2, ?3)",
                params![id_for_db, server_json, ip_json],
            )?;
        Ok(())
    }).await;
    let saved = saved
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| error.to_string()));
    if let Err(error) = saved {
        eprintln!("Could not save server visit: {error}");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let boot = json!({
        "sessionId": visit_id,
        "server": server,
        "ipResponse": ip_response,
        "icons": {
            "android.svg": include_str!("../static/android.svg"),
            "apple.svg": include_str!("../static/apple.svg"),
            "windows.svg": include_str!("../static/widows.svg"),
            "device.svg": include_str!("../static/icons/device.svg"),
            "browser.svg": include_str!("../static/icons/browser.svg"),
            "location.svg": include_str!("../static/icons/location.svg"),
            "timezone.svg": include_str!("../static/icons/timezone.svg"),
            "network.svg": include_str!("../static/icons/network.svg"),
            "language.svg": include_str!("../static/icons/language.svg"),
            "hardware.svg": include_str!("../static/icons/hardware.svg"),
        },
    });
    let script = format!(
        "(()=>{{const __doxPreviousBoot=window.__DOX_BOOT__;window.__DOX_BOOT__={};try{{\n{}\n}}finally{{if(__doxPreviousBoot===undefined)delete window.__DOX_BOOT__;else window.__DOX_BOOT__=__doxPreviousBoot;}}}})();",
        boot,
        include_str!("../static/script.js")
    );
    let mut response = (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        script,
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    server_headers_response(response)
}

async fn collect(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let session_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(|value| value.to_string())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let client_data = payload
        .get("clientData")
        .filter(|value| !value.is_null())
        .cloned();
    let ip_results = payload
        .get("ipResponses")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let server_ip_response = ip_results.get("server").cloned().unwrap_or(Value::Null);
    let peer_ip_response = ip_results.get("peer").cloned().unwrap_or(Value::Null);
    let webrtc_ip_responses = ip_results
        .get("webrtc")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let server_peer_json = json!({
        "server": server_ip_response,
        "peer": peer_ip_response,
    })
    .to_string();

    let db = state.db.clone();
    let client_json = client_data.as_ref().map(Value::to_string);
    let webrtc_json = webrtc_ip_responses.to_string();
    let (server_json, client_json) = tokio::task::spawn_blocking(move || {
        let db = db.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
        db.query_row(
            "UPDATE visits SET completed_at = CASE WHEN COALESCE(?2, client_data_json) IS NOT NULL THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE completed_at END, client_data_json = COALESCE(?2, client_data_json), server_ip_response_json = ?3, webrtc_ip_responses_json = ?4 WHERE id = ?1 RETURNING server_data_json, client_data_json",
            params![session_id, client_json, server_peer_json, webrtc_json],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
    let client_data = client_json
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or(Value::Null);
    let server_data = serde_json::from_str(&server_json).unwrap_or(Value::Null);

    Ok(Json(json!({
        "server": server_data,
        "client": client_data,
        "ip": {
            "server": server_ip_response,
            "peer": peer_ip_response,
            "webrtc": webrtc_ip_responses,
        },
    })))
}

async fn track_event(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    if payload.to_string().len() > 64 * 1024 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let visit_id = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(|value| value.to_string())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 128)
        .ok_or(StatusCode::BAD_REQUEST)?
        .to_owned();
    let properties = payload
        .get("properties")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !properties.is_object() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let properties_json = properties.to_string();

    let event_id = Uuid::new_v4().to_string();
    let db = state.db.clone();
    let stored = tokio::task::spawn_blocking(move || -> rusqlite::Result<Option<Value>> {
        let mut db = db.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
        let transaction = db.transaction()?;
        let server_data: Option<String> = transaction
            .query_row(
                "SELECT server_data_json FROM visits WHERE id = ?1",
                params![visit_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(server_data) = server_data else {
            return Ok(None);
        };
        let created_at: String = transaction.query_row(
            "INSERT INTO events (id, visit_id, name, properties_json) VALUES (?1, ?2, ?3, ?4) RETURNING created_at",
            params![event_id, visit_id, name, properties_json],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(Some(json!({
            "id": event_id,
            "visitId": visit_id,
            "name": name,
            "createdAt": created_at,
            "properties": properties,
            "server": serde_json::from_str::<Value>(&server_data).unwrap_or(Value::Null),
        })))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(stored))
}

#[tokio::main]
async fn main() {
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "data/dox-u.sqlite3".into());
    let db = open_database(&db_path).unwrap_or_else(|error| {
        panic!("Could not open SQLite database at {db_path}: {error}");
    });
    let state = AppState {
        db: Arc::new(Mutex::new(db)),
        collector_mode: std::env::var("DOX_MODE").is_ok_and(|value| value == "collector"),
        trusted_proxy_ips: trusted_proxy_ips_from_env(),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/visits", get(visits))
        .route("/script.js", get(script))
        .route("/api/collect", post(collect))
        .route(
            "/api/events",
            post(track_event).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .unwrap_or_else(|error| panic!("Could not bind on port {port}: {error}"));
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("HTTP server failed");
}
