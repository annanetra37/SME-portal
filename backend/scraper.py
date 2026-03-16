"""
Social Media Image Scraper — SME Portal integration.

Usage:
    python3 scraper.py <instagram_or_facebook_url> --output <dir> --max <n>

Credentials (via environment variables — all optional for public profiles):
    Instagram:  IG_SESSION   (sessionid cookie — speeds up, avoids rate limits)
                IG_USERNAME + IG_PASSWORD  (fallback login)
    Facebook:   FB_COOKIES   (path to Netscape cookies.txt — optional)

Output:
    {output_dir}/web/*.jpg   — web-ready JPEG images (≤2000px, quality 88)
    {output_dir}/results.json — metadata list consumed by Node.js
"""

import os, sys, json, shutil, hashlib, logging, argparse, time, tempfile
from pathlib import Path
from datetime import datetime

import requests
from PIL import Image

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
log = logging.getLogger("scraper")

# ── Constants ─────────────────────────────────────────────────────────────────
MIN_WIDTH    = 400
MIN_HEIGHT   = 400
MIN_SIZE     = 20_000   # bytes
DL_DELAY     = 1.5      # seconds between downloads
IL_SESSION   = Path("/tmp/.instaloader_session")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# ── instagrapi monkey-patch ───────────────────────────────────────────────────
# Some instagrapi versions crash with KeyError('pinned_channels_info').
def _patch_instagrapi():
    try:
        import instagrapi.extractors as _ext

        def _safe_extract_broadcast_channel(data: dict) -> list:
            try:
                info = data.get("pinned_channels_info") or {}
                return info.get("pinned_channels_list") or []
            except Exception:
                return []

        _ext.extract_broadcast_channel = _safe_extract_broadcast_channel
    except Exception:
        pass

_patch_instagrapi()

# ── Helpers ───────────────────────────────────────────────────────────────────

def detect_platform(url: str) -> str:
    from urllib.parse import urlparse
    host = urlparse(url).netloc.lower()
    if "instagram.com" in host:
        return "instagram"
    if "facebook.com" in host or "fb.com" in host:
        return "facebook"
    raise ValueError(f"Unsupported platform URL: {url}")

def extract_handle(url: str) -> str:
    from urllib.parse import urlparse
    parts = [p for p in urlparse(url).path.strip("/").split("/") if p]
    if not parts:
        raise ValueError(f"Cannot extract handle from: {url}")
    return parts[0]

def sha256_prefix(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:14]

def is_quality_image(path: Path) -> bool:
    try:
        if path.stat().st_size < MIN_SIZE:
            return False
        with Image.open(path) as img:
            w, h = img.size
            if w < MIN_WIDTH or h < MIN_HEIGHT:
                return False
            if img.mode in ("L", "1"):
                return False
        return True
    except Exception:
        return False

def download_url(url: str, dest: Path, session: requests.Session) -> bool:
    try:
        r = session.get(url, timeout=25, stream=True)
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(65536):
                f.write(chunk)
        return True
    except Exception as e:
        log.debug("Download failed %s: %s", url, e)
        return False

def accept_and_dedup(src: Path, web_dir: Path, seen: set, meta: dict) -> dict | None:
    if not is_quality_image(src):
        src.unlink(missing_ok=True)
        return None
    digest = sha256_prefix(src)
    if digest in seen:
        src.unlink(missing_ok=True)
        return None
    seen.add(digest)
    try:
        web_dir.mkdir(parents=True, exist_ok=True)
        out_path = web_dir / f"{digest}.jpg"
        with Image.open(src) as img:
            img = img.convert("RGB")
            if max(img.size) > 2000:
                img.thumbnail((2000, 2000), Image.LANCZOS)
            img.save(out_path, "JPEG", quality=88, optimize=True)
        src.unlink(missing_ok=True)
        return {"path": str(out_path), "scraped_at": datetime.utcnow().isoformat(), **meta}
    except Exception as e:
        log.warning("Conversion failed %s: %s", src, e)
        src.unlink(missing_ok=True)
        return None

# ── Instagram (via public viewer proxies — no login required) ─────────────────
#
# Instagram blocks unauthenticated server IPs (redirects to /accounts/login/).
# We use public Instagram viewer sites that cache and re-serve the same CDN
# images without needing a session.  Multiple sources are tried in order.

import re as _re
import random as _random

# Rotate through realistic browser User-Agents so each request looks different
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]

def _rand_headers(referer: str = "") -> dict:
    ua = _random.choice(_USER_AGENTS)
    h = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }
    if referer:
        h["Referer"] = referer
    return h

def _fetch_image_urls_picuki(handle: str, session: requests.Session) -> list[str]:
    """picuki.com — public Instagram viewer, no login needed."""
    url = f"https://www.picuki.com/profile/{handle}"
    try:
        r = session.get(url, headers=_rand_headers("https://www.picuki.com/"), timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.debug("picuki fetch failed: %s", e)
        return []
    html = r.text
    urls: list[str] = []
    # picuki wraps posts in <div class="photo"> and uses <img> with src pointing to CDN
    for m in _re.finditer(r'<img[^>]+src="(https://[^"]*(?:cdninstagram|fbcdn)[^"]+)"', html):
        u = m.group(1)
        if u not in urls:
            urls.append(u)
    # fallback: any img under a post-image class
    for m in _re.finditer(r'class="[^"]*post-image[^"]*"[^>]*(?:src|data-src)="([^"]+)"', html):
        u = m.group(1)
        if u not in urls:
            urls.append(u)
    log.info("  picuki: %d URL(s) found for @%s", len(urls), handle)
    return urls

def _fetch_image_urls_imginn(handle: str, session: requests.Session) -> list[str]:
    """imginn.com — another public Instagram viewer."""
    url = f"https://imginn.com/{handle}/"
    try:
        r = session.get(url, headers=_rand_headers("https://imginn.com/"), timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.debug("imginn fetch failed: %s", e)
        return []
    html = r.text
    urls: list[str] = []
    for m in _re.finditer(r'data-src="(https://[^"]*(?:cdninstagram|fbcdn)[^"]+)"', html):
        u = m.group(1)
        if u not in urls:
            urls.append(u)
    for m in _re.finditer(r'<img[^>]+src="(https://[^"]*(?:cdninstagram|fbcdn)[^"]+)"', html):
        u = m.group(1)
        if u not in urls:
            urls.append(u)
    log.info("  imginn: %d URL(s) found for @%s", len(urls), handle)
    return urls

def _fetch_image_urls_insta_stories(handle: str, session: requests.Session) -> list[str]:
    """instastories.bar — another public viewer as last resort."""
    url = f"https://instastories.bar/tag/{handle}"
    try:
        r = session.get(url, headers=_rand_headers("https://instastories.bar/"), timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.debug("instastories fetch failed: %s", e)
        return []
    html = r.text
    urls: list[str] = []
    for m in _re.finditer(r'<img[^>]+src="(https://[^"]*(?:cdninstagram|fbcdn)[^"]+)"', html):
        u = m.group(1)
        if u not in urls:
            urls.append(u)
    log.info("  instastories: %d URL(s) found for @%s", len(urls), handle)
    return urls

def scrape_instagram(handle: str, web_dir: Path, tmp_dir: Path, max_images: int) -> list[dict]:
    log.info("Instagram: scraping @%s (max %d images) via public viewers", handle, max_images)

    # Brief human-like pause before starting
    time.sleep(_random.uniform(1.0, 2.5))

    session = requests.Session()

    # Try each public viewer in order until we have enough candidate URLs
    image_urls: list[str] = []
    for source_fn in (_fetch_image_urls_picuki, _fetch_image_urls_imginn, _fetch_image_urls_insta_stories):
        image_urls = source_fn(handle, session)
        if image_urls:
            break
        time.sleep(_random.uniform(1.5, 3.0))  # pause between source attempts

    if not image_urls:
        log.warning("Instagram: no image URLs found for @%s from any source", handle)
        return []

    log.info("Instagram: %d candidate URL(s) to process for @%s", len(image_urls), handle)

    seen: set = set()
    records: list = []
    count = 0

    for img_url in image_urls[:max_images * 3]:
        if len(records) >= max_images:
            break
        tmp_file = tmp_dir / f"_ig_{count}.jpg"
        count += 1
        dl_headers = _rand_headers(f"https://www.instagram.com/{handle}/")
        try:
            r = session.get(img_url, headers=dl_headers, timeout=25, stream=True)
            r.raise_for_status()
            with open(tmp_file, "wb") as f:
                for chunk in r.iter_content(65536):
                    f.write(chunk)
        except Exception as e:
            log.debug("Image download failed %s: %s", img_url, e)
            continue
        meta = {
            "platform": "instagram",
            "handle": handle,
            "source_url": f"https://www.instagram.com/{handle}/",
            "caption": "",
            "likes": None,
        }
        rec = accept_and_dedup(tmp_file, web_dir, seen, meta)
        if rec:
            records.append(rec)
            log.info("  [%d/%d] saved: %s", len(records), max_images, Path(rec["path"]).name)
        # Random delay between downloads — mimics human browsing pace
        time.sleep(_random.uniform(2.0, 4.0))

    log.info("Instagram done — %d images.", len(records))
    return records

# ── Facebook ──────────────────────────────────────────────────────────────────

def scrape_facebook(handle: str, web_dir: Path, tmp_dir: Path, max_images: int) -> list[dict]:
    try:
        from facebook_scraper import get_posts
    except ImportError:
        log.warning("facebook-scraper not installed — skipping (run: pip install facebook-scraper)")
        return []

    log.info("Facebook: scraping page '%s' (max %d images)", handle, max_images)

    cookies = os.getenv("FB_COOKIES")
    kwargs: dict = {
        "pages": max(1, max_images // 5),
        "extra_info": True,
        "youtube_dl": False,
        "options": {"images": True, "progress": False},
    }
    if cookies:
        kwargs["cookies"] = cookies

    http = requests.Session()
    http.headers.update(HEADERS)
    seen: set = set()
    records: list = []
    count = 0

    try:
        for post in get_posts(handle, **kwargs):
            if len(records) >= max_images:
                break
            urls = post.get("images") or post.get("images_lowquality") or []
            for url in urls:
                if len(records) >= max_images:
                    break
                tmp_file = tmp_dir / f"_fb_{count}.jpg"
                count += 1
                if not download_url(url, tmp_file, http):
                    continue
                meta = {
                    "platform": "facebook",
                    "handle": handle,
                    "source_url": post.get("post_url") or "",
                    "caption": (post.get("text") or "")[:300],
                    "likes": post.get("likes"),
                }
                rec = accept_and_dedup(tmp_file, web_dir, seen, meta)
                if rec:
                    records.append(rec)
                    log.info("  [%d/%d] saved: %s", len(records), max_images, Path(rec["path"]).name)
                time.sleep(DL_DELAY)
    except Exception as e:
        log.error("facebook-scraper error: %s", e)

    log.info("Facebook done — %d images.", len(records))
    return records

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="SME Portal social media image scraper")
    parser.add_argument("url",             help="Instagram or Facebook page URL")
    parser.add_argument("--output", "-o", default="/tmp/sme_scraper_out")
    parser.add_argument("--max",    "-m", type=int, default=6)
    args = parser.parse_args()

    try:
        platform = detect_platform(args.url)
        handle   = extract_handle(args.url)
    except ValueError as e:
        log.error(str(e))
        out_dir = Path(args.output)
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / "results.json", "w", encoding="utf-8") as f:
            json.dump({"platform": "unknown", "handle": "", "images": []}, f)
        sys.exit(0)

    out_dir = Path(args.output)
    web_dir = out_dir / "web"
    tmp_dir = out_dir / "_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    web_dir.mkdir(parents=True, exist_ok=True)

    log.info("Platform: %s | Handle: %s | Max: %d", platform, handle, args.max)

    try:
        if platform == "instagram":
            records = scrape_instagram(handle, web_dir, tmp_dir, args.max)
        else:
            records = scrape_facebook(handle, web_dir, tmp_dir, args.max)
    except Exception as e:
        log.error("Unhandled scraper error: %s", e)
        records = []

    shutil.rmtree(tmp_dir, ignore_errors=True)

    results_path = out_dir / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({"platform": platform, "handle": handle, "images": records}, f, indent=2)

    log.info("Done — %d images → %s", len(records), web_dir)
    log.info("Results → %s", results_path)

if __name__ == "__main__":
    main()
