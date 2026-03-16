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

# ── Instagram via instaloader (primary — no credentials needed for public profiles) ──

def _get_instaloader():
    """Return a configured instaloader.Instaloader instance, optionally authenticated."""
    import instaloader
    il = instaloader.Instaloader(
        download_pictures=True,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )

    session_id = os.getenv("IG_SESSION", "").strip().lstrip("=")
    username   = os.getenv("IG_USERNAME", "").strip()
    password   = os.getenv("IG_PASSWORD", "").strip()

    # Try session cookie first (fastest, no password needed)
    if session_id and username:
        try:
            il.load_session_from_file(username, str(IL_SESSION))
            log.info("Loaded cached instaloader session for @%s", username)
            return il
        except Exception:
            pass
        try:
            il.context._session.cookies.set("sessionid", session_id, domain=".instagram.com")
            il.context.username = username
            il.save_session_to_file(str(IL_SESSION))
            log.info("Authenticated via IG_SESSION cookie for @%s", username)
            return il
        except Exception as e:
            log.warning("Session cookie auth failed (%s) — continuing anonymously", e)

    # Try username/password login
    if username and password:
        try:
            il.login(username, password)
            il.save_session_to_file(str(IL_SESSION))
            log.info("Logged in as @%s", username)
            return il
        except Exception as e:
            log.warning("Username/password login failed (%s) — continuing anonymously", e)

    log.info("No Instagram credentials set — scraping public profile anonymously")
    # Never wait and retry on rate-limit — fail fast so the pipeline can fall through
    il.context.max_connection_attempts = 1
    return il

# ── Instagram HTTP fallback (no instaloader — parses public page JSON) ────────

def _scrape_instagram_http(handle: str, web_dir: Path, tmp_dir: Path, max_images: int) -> list[dict]:
    """
    Scrape a public Instagram profile by fetching the page HTML and parsing
    the JSON data Instagram embeds in <script type="application/json"> tags.
    No credentials required.  Falls back gracefully on any parse failure.
    """
    import re as _re, json as _json

    log.info("Instagram HTTP fallback: fetching public page for @%s", handle)
    url = f"https://www.instagram.com/{handle}/"
    headers = {
        **HEADERS,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
    }
    try:
        r = requests.get(url, headers=headers, timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.warning("HTTP fallback: page fetch failed: %s", e)
        return []

    html = r.text
    image_urls: list[str] = []

    # Strategy 1: pull display_url values from embedded JSON blobs
    for m in _re.finditer(r'"display_url"\s*:\s*"(https://[^"]+)"', html):
        u = m.group(1).replace("\\u0026", "&").replace("\\/", "/")
        if u not in image_urls:
            image_urls.append(u)

    # Strategy 2: look for og:image meta tags
    for m in _re.finditer(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html):
        u = m.group(1)
        if u not in image_urls:
            image_urls.append(u)

    if not image_urls:
        log.warning("HTTP fallback: no image URLs found in page source for @%s", handle)
        return []

    log.info("HTTP fallback: found %d candidate image URL(s)", len(image_urls))
    http = requests.Session()
    http.headers.update(HEADERS)
    seen: set = set()
    records: list = []
    count = 0

    for img_url in image_urls[:max_images * 3]:
        if len(records) >= max_images:
            break
        tmp_file = tmp_dir / f"_igh_{count}.jpg"
        count += 1
        if not download_url(img_url, tmp_file, http):
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
            log.info("  [%d/%d] HTTP fallback saved: %s", len(records), max_images, Path(rec["path"]).name)
        time.sleep(0.5)

    log.info("HTTP fallback done — %d images.", len(records))
    return records

def scrape_instagram(handle: str, web_dir: Path, tmp_dir: Path, max_images: int) -> list[dict]:
    log.info("Instagram: scraping @%s (max %d images) via instaloader", handle, max_images)

    try:
        import instaloader
    except ImportError:
        log.warning("instaloader not installed — using HTTP fallback")
        return _scrape_instagram_http(handle, web_dir, tmp_dir, max_images)

    try:
        il = _get_instaloader()
    except Exception as e:
        log.warning("Failed to initialise instaloader (%s) — using HTTP fallback", e)
        return _scrape_instagram_http(handle, web_dir, tmp_dir, max_images)

    try:
        profile = instaloader.Profile.from_username(il.context, handle)
    except instaloader.exceptions.ProfileNotExistsException:
        log.error("Instagram profile @%s does not exist", handle)
        return []
    except instaloader.exceptions.ConnectionException as e:
        log.warning("instaloader rate-limited or blocked (%s) — using HTTP fallback", e)
        return _scrape_instagram_http(handle, web_dir, tmp_dir, max_images)
    except Exception as e:
        log.warning("Could not load Instagram profile @%s via instaloader (%s) — using HTTP fallback", handle, e)
        return _scrape_instagram_http(handle, web_dir, tmp_dir, max_images)

    seen: set = set()
    records: list = []
    http = requests.Session()
    http.headers.update(HEADERS)
    count = 0

    try:
        for post in profile.get_posts():
            if len(records) >= max_images:
                break
            if post.typename not in ("GraphImage", "GraphSidecar"):
                continue  # skip videos/reels

            # Collect candidate image URLs from this post
            candidate_urls: list[str] = []
            try:
                if post.typename == "GraphSidecar":
                    for node in post.get_sidecar_nodes():
                        if not node.is_video:
                            candidate_urls.append(node.display_url)
                else:
                    candidate_urls.append(post.url)
            except Exception as e:
                log.warning("Skipping post %s: %s", post.shortcode, e)
                continue

            for img_url in candidate_urls:
                if len(records) >= max_images:
                    break
                tmp_file = tmp_dir / f"_ig_{count}.jpg"
                count += 1
                if not download_url(img_url, tmp_file, http):
                    continue
                meta = {
                    "platform": "instagram",
                    "handle": handle,
                    "source_url": f"https://www.instagram.com/p/{post.shortcode}/",
                    "caption": (post.caption or "")[:300],
                    "likes": post.likes,
                }
                rec = accept_and_dedup(tmp_file, web_dir, seen, meta)
                if rec:
                    records.append(rec)
                    log.info("  [%d/%d] saved: %s", len(records), max_images, Path(rec["path"]).name)
                time.sleep(DL_DELAY)

    except instaloader.exceptions.ConnectionException as e:
        log.warning("Instagram rate-limited mid-scrape (%s) — keeping %d images collected so far", e, len(records))
        if not records:
            log.info("No images collected before rate-limit — trying HTTP fallback")
            return _scrape_instagram_http(handle, web_dir, tmp_dir, max_images)
    except Exception as e:
        log.error("Instagram scrape error: %s", e)

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
    parser.add_argument("--max",    "-m", type=int, default=15)
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
