"""
fetch_feeds.py — POD Pulse Feed Fetcher
=========================================
Fetches content from Print on Demand sources:
- Printful blog (RSS) — embroidery & POD tips
- Printify blog (RSS) — POD business content
- eRank blog (RSS) — Etsy SEO & POD trends
- Etsy (HTML scrape) — POD shirt & stitched design listings

Usage:
    python tools/fetch_feeds.py
"""

import hashlib
import json
import re
import sys
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────────────

RSS_FEEDS = [
    {
        "url": "https://www.printful.com/blog/feed",
        "source": "printful",
        "sourceName": "Printful",
    },
    {
        "url": "https://printify.com/blog/category/print-on-demand/feed/",
        "source": "printify",
        "sourceName": "Printify",
    },
    {
        "url": "https://help.erank.com/feed/",
        "source": "erank",
        "sourceName": "eRank",
    },
]

ETSY_SEARCHES = [
    {"q": "print on demand shirt", "label": "POD Shirts"},
    {"q": "embroidered logo patch custom", "label": "Stitched Designs"},
]

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = PROJECT_ROOT / "dashboard" / "public" / "feeds.json"
# 30-day window: POD blogs publish weekly/bi-weekly so we need a wider window
HOURS_WINDOW = 720


# ─── Helpers ─────────────────────────────────────────────────────────────────

def strip_html(html_string: str) -> str:
    if not html_string:
        return ""
    text = re.sub(r"<[^>]+>", " ", html_string)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def generate_id(link: str, extra: str = "") -> str:
    raw = f"{link}{extra}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def parse_date(date_str: str) -> datetime | None:
    if not date_str:
        return None
    try:
        return parsedate_to_datetime(date_str)
    except Exception:
        pass
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass
    return None


def fetch_url(url: str, timeout: int = 15, extra_headers: dict = None) -> str | None:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if extra_headers:
        headers.update(extra_headers)
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  ⚠️  Failed to fetch {url}: {e}", file=sys.stderr)
        return None


# ─── RSS Feed Parser ─────────────────────────────────────────────────────────

def parse_rss_feed(xml_str: str, feed_config: dict, cutoff: datetime) -> list[dict]:
    articles = []
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError as e:
        print(f"  ⚠️  XML parse error for {feed_config['source']}: {e}", file=sys.stderr)
        return articles

    now_utc = datetime.now(timezone.utc).isoformat()
    items = root.findall(".//item")

    for item in items:
        title = item.findtext("title", "").strip()
        link = item.findtext("link", "").strip()
        pub_date_raw = item.findtext("pubDate", "").strip()
        description = item.findtext("description", "") or item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded", "")
        author = item.findtext("author") or item.findtext("{http://purl.org/dc/elements/1.1/}creator")
        categories = [cat.text for cat in item.findall("category") if cat.text]

        published_dt = parse_date(pub_date_raw)
        if published_dt is None:
            continue
        if published_dt < cutoff:
            continue

        articles.append({
            "id": generate_id(link, pub_date_raw),
            "title": title,
            "summary": strip_html(description)[:500],
            "url": link,
            "source": feed_config["source"],
            "sourceName": feed_config["sourceName"],
            "author": author.strip() if author else None,
            "publishedAt": published_dt.isoformat(),
            "fetchedAt": now_utc,
            "categories": categories,
            "isSaved": False,
        })

    return articles


# ─── Etsy HTML Scraper ───────────────────────────────────────────────────────

def scrape_etsy_listings(query: str, label: str, max_items: int = 12) -> list[dict]:
    """Scrape Etsy search page for product listings."""
    encoded_q = urllib.parse.quote(query)
    url = f"https://www.etsy.com/search?q={encoded_q}&explicit=1"

    print(f"   🔍 Query: '{query}'")
    html = fetch_url(url)
    if not html:
        return []

    articles = []
    now_utc = datetime.now(timezone.utc).isoformat()
    # Etsy embeds listing data as JSON in script tags
    # Pattern: listing id, title, price, url, image
    # Try to extract listing cards via regex on the HTML
    
    # Extract listing titles and URLs from structured data
    # Etsy uses data-listing-id and aria-label patterns
    title_pattern = re.compile(
        r'<a[^>]+href="(https://www\.etsy\.com/listing/[^"?]+)[^"]*"[^>]*>\s*<div[^>]*>\s*<h3[^>]*>([^<]+)</h3>',
        re.IGNORECASE | re.DOTALL
    )
    
    # Fallback: extract JSON-LD structured data
    jsonld_pattern = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.DOTALL)
    jsonld_matches = jsonld_pattern.findall(html)
    
    seen_urls = set()
    
    for jsonld_str in jsonld_matches:
        try:
            data = json.loads(jsonld_str)
            items = []
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                items = [data]
            
            for item in items:
                if item.get("@type") not in ("Product", "ItemList"):
                    continue
                if item.get("@type") == "ItemList":
                    for el in item.get("itemListElement", []):
                        items.append(el.get("item", {}))
                    continue
                
                name = item.get("name", "").strip()
                url = item.get("url", "").strip()
                desc = item.get("description", "") or ""
                image = item.get("image", "")
                if isinstance(image, list):
                    image = image[0] if image else ""
                price_info = item.get("offers", {})
                price = ""
                if isinstance(price_info, dict):
                    price = price_info.get("price", "")
                    currency = price_info.get("priceCurrency", "USD")
                    if price:
                        price = f"{currency} {price}"

                if not name or not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                
                summary = strip_html(desc) or f"{label} listing on Etsy"
                if price:
                    summary = f"{price} — {summary}" if summary else price

                articles.append({
                    "id": generate_id(url),
                    "title": name,
                    "summary": summary[:500],
                    "url": url,
                    "source": "etsy",
                    "sourceName": "Etsy",
                    "author": None,
                    "publishedAt": now_utc,
                    "fetchedAt": now_utc,
                    "categories": [label, "Print on Demand"],
                    "isSaved": False,
                })
                
                if len(articles) >= max_items:
                    break
        except (json.JSONDecodeError, KeyError):
            continue
        
        if len(articles) >= max_items:
            break

    # Fallback: simple href+title extraction if JSON-LD failed
    if not articles:
        listing_pattern = re.compile(r'href="(https://www\.etsy\.com/listing/\d+/[^"?]+)[^"]*"[^>]*title="([^"]+)"')
        for match in listing_pattern.finditer(html):
            url, title = match.group(1), match.group(2).strip()
            if url in seen_urls or not title:
                continue
            seen_urls.add(url)
            articles.append({
                "id": generate_id(url),
                "title": unescape(title),
                "summary": f"{label} listing on Etsy",
                "url": url,
                "source": "etsy",
                "sourceName": "Etsy",
                "author": None,
                "publishedAt": now_utc,
                "fetchedAt": now_utc,
                "categories": [label, "Print on Demand"],
                "isSaved": False,
            })
            if len(articles) >= max_items:
                break

    return articles


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    print("🛍️  POD Pulse — Feed Fetcher")
    print("=" * 45)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS_WINDOW)
    print(f"📅 Cutoff: last {HOURS_WINDOW}h for blog posts | Etsy listings always fresh")

    all_articles = []
    seen_ids = set()

    # ── RSS Feeds ──
    for feed in RSS_FEEDS:
        print(f"\n📡 Fetching RSS: {feed['sourceName']}")
        xml_str = fetch_url(feed["url"], extra_headers={
            "Accept": "application/rss+xml, application/xml, text/xml"
        })
        if xml_str is None:
            continue

        articles = parse_rss_feed(xml_str, feed, cutoff)
        print(f"   ✅ {len(articles)} article(s) in window")
        for a in articles:
            if a["id"] not in seen_ids:
                seen_ids.add(a["id"])
                all_articles.append(a)

    # ── Etsy Scraper ──
    print(f"\n🛒 Scraping Etsy listings...")
    for search in ETSY_SEARCHES:
        listings = scrape_etsy_listings(search["q"], search["label"])
        print(f"   ✅ '{search['label']}': {len(listings)} listing(s)")
        for a in listings:
            if a["id"] not in seen_ids:
                seen_ids.add(a["id"])
                all_articles.append(a)

    # Sort by publishedAt descending (newest first)
    all_articles.sort(key=lambda a: a["publishedAt"], reverse=True)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_articles, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Done! Wrote {len(all_articles)} articles to {OUTPUT_PATH}")
    print(f"   Note: Etsy blocks automated scraping. Add Etsy listings manually or via Etsy API.")


if __name__ == "__main__":
    main()
