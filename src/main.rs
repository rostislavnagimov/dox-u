

use std::{collections::HashMap, println};

use axum::{Router, extract::Request, response::Html};
use askama::Template;
use tower_http::services::ServeFile;
use serde_json;
use reqwest;

#[derive(Template)]
#[template(path="index.html")]
struct Page {
    platform: String,
    mobile: String,
    ip: String,
    country: String,
    region: String,
    city: String,
    timezone: String,
    timeshift: i32,
    browser: String,
    lang: String,
}

async fn handler(req: Request) -> Html<String> {
    let headers: HashMap<&str, &str> = req
        .headers()
        .iter()
        .filter_map(|(k,v)| Some((k.as_str(), v.to_str().ok()?)))
        .collect();

    let ua = headers.get("user-agent").copied().unwrap_or("");

    let platform = headers.get("sec-ch-ua-platform")
        .map(|p| p.trim_matches('"'))
        .or_else(|| {
            if      ua.contains("Android")   { Some("Android") }
            else if ua.contains("iPhone") || ua.contains("iPad") { Some("iOS") }
            else if ua.contains("Windows")   { Some("Windows") }
            else if ua.contains("Macintosh") { Some("macOS") }
            else if ua.contains("CrOS")      { Some("ChromeOS") }
            else if ua.contains("Linux")     { Some("Linux") }
            else { None }
        })
        .unwrap_or("Unknown");

    let browser = headers.get("sec-ch-ua")
        .and_then(|s| s.split(", ")
            .filter_map(|b| b.split_once(";v="))
            .map(|(n, v)| (n.trim_matches('"'), v.trim_matches('"')))
            .find(|(n, _)| !n.starts_with("Not") && *n != "Chromium"))
        .map(|(n, v)| format!("{n} {v}"))
        .or_else(|| [("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                    ("FxiOS/", "Firefox"), ("CriOS/", "Chrome"), ("Chrome/", "Chrome"),
                    ("Version/", "Safari")]
            .iter().find(|(m, _)| ua.contains(m)).map(|(_, n)| n.to_string()))
        .unwrap_or("Unknown".into());

    // Мобильное: ?1 / ?0 (кавычек нет), иначе слово Mobi в UA
    let is_mobile = headers.get("sec-ch-ua-mobile")
        .map(|v| *v == "?1")
        .unwrap_or_else(|| ua.contains("Mobi"));

    let mobile = if is_mobile { "Mobile".to_string() } else { "Desktop".to_string() };


    // Основной язык: первый тег из accept-language, до ";q="
    let lang = headers.get("accept-language")
        .and_then(|l| l.split(|c| c == ',' || c == ';').next())
        .unwrap_or("");

    // IP: первый из x-forwarded-for, сразу парсим (заодно защита от мусора в URL геозапроса)
    let ip = headers.get("x-forwarded-for")
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
    if let Some(v) = headers.get("x-forwarded-for") {
        let ip = String::from_utf8_lossy(v.as_bytes());
        // Берем первый IP, если заголовок содержит список через запятую
        let client_ip = ip.split(',').next().unwrap_or(&ip).trim();
        
        // let url = format!(
        //     "http://ip-api.com/json/{}?fields=country,countryCode,regionName,city,timezone,offset,org",
        //     client_ip
        // );

        let url = format!(
            "https://ipwho.is/{}?fields=country,region,city,timezone",
            client_ip
        );

        if let Ok(res) = reqwest::get(&url).await {
            if let Ok(v) = res.json::<serde_json::Value>().await {
                country = v["country"].as_str().unwrap_or_default().to_string();
                region = v["region"].as_str().unwrap_or_default().to_string();
                city = v["city"].as_str().unwrap_or_default().to_string();
                
                // timezone у них приходит в виде объекта со смещением и ID
                timezone = v["timezone"]["id"].as_str().unwrap_or_default().to_string();
                timeshift = v["timezone"]["offset"].as_i64().unwrap_or(0) as i32; // Тут будет честные 18000 (+5)
            }
        }
    }


    let page = Page {
            platform: platform.to_string(),
            ip: ip.map(|i| i.to_string()).unwrap_or("Unknown".into()),
            mobile,
            country,
            region,
            city,
            timezone,
            timeshift,
            browser,
            lang: lang.to_string(),
    };

    // Отображаем страницу или пустую строку в случае ошибки рендеринга
    Html(page.render().unwrap_or_default())
}

#[tokio::main]
async fn main() {
    let app = Router::new()
    .route_service("/script.js", ServeFile::new("static/script.js"))
    .fallback(handler);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(
        listener,
        app
    ).await.unwrap();

}
