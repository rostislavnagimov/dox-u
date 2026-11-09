use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    time::Duration,
};

use askama::Template;
use axum::{
    Router,
    extract::{Json, Request},
    http::HeaderValue,
    response::{Html, IntoResponse, Response},
    routing::post,
};
use reqwest;
use serde_json;
use tower_http::services::ServeFile;

#[derive(Template)]
#[template(path = "index.html")]
struct Page {
    server_data_json: String,
    ip_response_json: String,
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            let shared_carrier = octets[0] == 100 && (64..=127).contains(&octets[1]);
            let documentation = (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113);

            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !shared_carrier
                && !documentation
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
            let unique_local = segments[0] & 0xfe00 == 0xfc00;
            let link_local = segments[0] & 0xffc0 == 0xfe80;

            !ip.is_loopback()
                && !unique_local
                && !link_local
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !documentation
        }
    }
}

async fn webrtc_geolocation(Json(payload): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let server_ip = payload
        .get("serverIp")
        .and_then(serde_json::Value::as_str)
        .and_then(|ip| ip.parse::<IpAddr>().ok());
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .ok();

    if let Some(ips) = payload.get("ips").and_then(serde_json::Value::as_array) {
        for raw_ip in ips.iter().take(8) {
            let Some(ip) = raw_ip
                .as_str()
                .and_then(|value| value.parse::<IpAddr>().ok())
            else {
                continue;
            };
            if !seen.insert(ip) {
                continue;
            }

            let response = if is_public_ip(ip) {
                if let Some(client) = &client {
                    let url = format!(
                        "https://ipwho.is/{ip}?fields=success,country,region,city,timezone"
                    );
                    match client.get(url).send().await {
                        Ok(response) => response
                            .json::<serde_json::Value>()
                            .await
                            .unwrap_or(serde_json::Value::Null),
                        Err(_) => serde_json::Value::Null,
                    }
                } else {
                    serde_json::Value::Null
                }
            } else {
                serde_json::Value::Null
            };

            results.push(serde_json::json!({
                "ip": ip.to_string(),
                "matchesServer": server_ip == Some(ip),
                "public": is_public_ip(ip),
                "response": response,
            }));
        }
    }

    Json(serde_json::json!({ "results": results }))
}

async fn handler(req: Request) -> Response {
    let headers: HashMap<&str, &str> = req
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str(), v.to_str().ok()?)))
        .collect();

    let ua = headers.get("user-agent").copied().unwrap_or("");

    let platform = headers
        .get("sec-ch-ua-platform")
        .map(|p| p.trim_matches('"'))
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

    let browser = headers
        .get("sec-ch-ua-full-version-list")
        .or_else(|| headers.get("sec-ch-ua"))
        .and_then(|s| {
            s.split(", ")
                .filter_map(|b| b.split_once(";v="))
                .map(|(n, v)| (n.trim_matches('"'), v.trim_matches('"')))
                .find(|(n, _)| !n.starts_with("Not") && *n != "Chromium")
        })
        .map(|(n, v)| format!("{n} {v}"))
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
            .copied()
            .find(|(m, _)| ua.contains(*m))
            .map(|(m, n)| {
                let version = ua
                    .split(m)
                    .nth(1)
                    .unwrap_or("")
                    .split(|c: char| !(c.is_ascii_digit() || c == '.'))
                    .next()
                    .unwrap_or("");
                if version.is_empty() {
                    n.to_string()
                } else {
                    format!("{n} {version}")
                }
            })
        })
        .unwrap_or("Unknown".into());

    // Мобильное: ?1 / ?0 (кавычек нет), иначе слово Mobi в UA
    let is_mobile = headers
        .get("sec-ch-ua-mobile")
        .map(|v| *v == "?1")
        .unwrap_or_else(|| ua.contains("Mobi"));

    let mobile = if is_mobile {
        "Mobile".to_string()
    } else {
        "Desktop".to_string()
    };

    // Основной язык: первый тег из accept-language, до ";q="
    let lang = headers
        .get("accept-language")
        .map(|l| {
            l.split(',')
                .filter_map(|item| item.split(';').next())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or("Unknown".to_string());

    // IP: первый из x-forwarded-for, сразу парсим (заодно защита от мусора в URL геозапроса)
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok());

    // // Как пришёл: none = ввёл адрес или закладка, остальное = по ссылке
    // let typed: String = headers.get("sec-fetch-site").map(|v| *v == "none").unwrap_or("".to_string());

    let mut country = String::new();
    let mut region = String::new();
    let mut city = String::new();
    let mut timezone = String::new();
    let mut timeshift = 0;

    // Безопасно получаем IP и делаем запрос геопозиции
    let mut ip_response = serde_json::Value::Null;
    if let Some(client_ip) = ip.filter(|client_ip| is_public_ip(*client_ip)) {
        // let url = format!(
        //     "http://ip-api.com/json/{}?fields=country,countryCode,regionName,city,timezone,offset,org",
        //     client_ip
        // );

        let url =
            format!("https://ipwho.is/{client_ip}?fields=success,country,region,city,timezone",);

        if let Ok(res) = reqwest::get(&url).await {
            if let Ok(v) = res.json::<serde_json::Value>().await {
                ip_response = v.clone();
                country = v["country"].as_str().unwrap_or_default().to_string();
                region = v["region"].as_str().unwrap_or_default().to_string();
                city = v["city"].as_str().unwrap_or_default().to_string();

                // timezone у них приходит в виде объекта со смещением и ID
                timezone = v["timezone"]["id"].as_str().unwrap_or_default().to_string();
                timeshift = v["timezone"]["offset"].as_i64().unwrap_or(0) as i32; // Тут будет честные 18000 (+5)
            }
        }
    }

    let server_data_json = serde_json::json!({
        "platform": platform,
        "platformVersion": headers.get("sec-ch-ua-platform-version")
            .map(|v| v.trim_matches('"'))
            .filter(|v| !v.is_empty())
            .unwrap_or("Unknown"),
        "deviceModel": headers.get("sec-ch-ua-model")
            .map(|v| v.trim_matches('"'))
            .filter(|v| !v.is_empty())
            .unwrap_or("Unknown"),
        "architecture": headers.get("sec-ch-ua-arch")
            .map(|v| v.trim_matches('"'))
            .filter(|v| !v.is_empty())
            .unwrap_or("Unknown"),
        "bitness": headers.get("sec-ch-ua-bitness")
            .map(|v| v.trim_matches('"'))
            .filter(|v| !v.is_empty())
            .unwrap_or("Unknown"),
        "deviceType": mobile,
        "browser": browser,
        "languages": lang,
        "ip": ip.map(|value| value.to_string()).unwrap_or_else(|| "Unknown".to_string()),
        "country": country,
        "region": region,
        "city": city,
        "timezone": timezone,
        "timezoneOffsetSeconds": timeshift,
    })
    .to_string();

    let page = Page {
        server_data_json,
        ip_response_json: ip_response.to_string(),
    };

    // Отображаем страницу или пустую строку в случае ошибки рендеринга
    let mut response = Html(page.render().unwrap_or_default()).into_response();
    response.headers_mut().insert(
        "accept-ch",
        HeaderValue::from_static(
            "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-Arch, Sec-CH-UA-Bitness",
        ),
    );
    response
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/api/webrtc-geolocation", post(webrtc_geolocation))
        .route_service("/script.js", ServeFile::new("static/script.js"))
        .fallback(handler);
    let port = std::env::var("PORT").unwrap_or("3000".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .unwrap();
    axum::serve(listener, app).await.unwrap();
}
