"""
Social Media Image Scraper — SME Portal integration.

Usage:
    python3 scraper.py <instagram_or_facebook_url> --output <dir> --max <n>

Credentials (via environment variables):
    Instagram:  IG_SESSION   (recommended — sessionid cookie from browser)
                IG_USERNAME + IG_PASSWORD  (fallback)
    Facebook:   FB_COOKIES   (path to Netscape cookies.txt — optional)

Output:
    {output_dir}/web/*.jpg   — web-ready JPEG images (≤2000px, quality 88)
    {output_dir}/results.json — metadata list consumed by Node.js
"""

import os, re, sys, json, shutil, hashlib, logging, argparse, mimetypes, time
from pathlib import Path
from datetime import datetime

import requests
from PIL import Image

# OCR for text detection — optional, degrades gracefully
try:
    import pytesseract
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],   # stderr so stdout stays clean for JSON
)
log = logging.getLogger("scraper")

# ── Constants ─────────────────────────────────────────────────────────────────
MIN_WIDTH    = 400
MIN_HEIGHT   = 400
MIN_SIZE     = 20_000   # bytes
DL_DELAY     = 1.2      # seconds between downloads
SESSION_FILE = Path("/tmp/.instagram_session.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# ── instagrapi monkey-patch ───────────────────────────────────────────────────
# Older instagrapi versions crash with KeyError('pinned_channels_info') because
# some accounts don't have that field.  Patch it once at import time.
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
        pass  # instagrapi not installed — will be caught later

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

MAX_TEXT_CHARS = 40   # images with more OCR characters than this are skipped

def _has_text_overlay(path: Path) -> bool:
    """Return True if the image contains significant text (promo banners, flyers, etc.)."""
    if not HAS_OCR:
        return False
    try:
        with Image.open(path) as img:
            # Resize to speed up OCR (max 800px on longest side)
            img.thumbnail((800, 800), Image.LANCZOS)
            text = pytesseract.image_to_string(img, timeout=5)
            # Strip whitespace and count meaningful characters
            clean = re.sub(r'\s+', '', text)
            if len(clean) > MAX_TEXT_CHARS:
                log.info("  ⊘ Skipped (text overlay: %d chars): %s", len(clean), path.name)
                return True
        return False
    except Exception:
        return False  # OCR failed — allow the image

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
        # Skip images with text overlays (promo banners, price lists, flyers)
        if _has_text_overlay(path):
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
    # Convert to web-ready JPEG
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

# ── Instagram ─────────────────────────────────────────────────────────────────

def get_ig_client():
    """Return an authenticated instagrapi Client, or raise RuntimeError."""
    try:
        from instagrapi import Client
        from instagrapi.exceptions import TwoFactorRequired
    except ImportError:
        raise RuntimeError("instagrapi not installed — run: pip install instagrapi")

    cl = Client()
    cl.delay_range = [1, 3]

    session_id = os.getenv("IG_SESSION")
    username   = os.getenv("IG_USERNAME")
    password   = os.getenv("IG_PASSWORD")

    if session_id:
        log.info("Authenticating Instagram via session ID…")
        try:
            cl.login_by_sessionid(session_id)
        except Exception as e:
            raise RuntimeError(f"login_by_sessionid failed: {e}")
        cl.dump_settings(str(SESSION_FILE))
        return cl

    if SESSION_FILE.exists():
        log.info("Loading cached Instagram session…")
        try:
            cl.load_settings(str(SESSION_FILE))
            cl.get_timeline_feed()
            log.info("Cached session valid.")
            return cl
        except Exception as e:
            log.warning("Cached session expired (%s), re-authenticating.", e)
            SESSION_FILE.unlink(missing_ok=True)

    if not username or not password:
        raise RuntimeError(
            "Instagram auth required. Set one of:\n"
            "  IG_SESSION   — sessionid cookie from browser (recommended)\n"
            "  IG_USERNAME + IG_PASSWORD"
        )

    log.info("Logging in as @%s…", username)
    try:
        cl.login(username, password)
    except TwoFactorRequired:
        code = input("2FA code: ").strip()
        cl.login(username, password, verification_code=code)

    cl.dump_settings(str(SESSION_FILE))
    return cl

def scrape_instagram(handle: str, web_dir: Path, tmp_dir: Path, max_images: int) -> list[dict]:
    log.info("Instagram: scraping @%s (max %d images)", handle, max_images)

    try:
        cl = get_ig_client()
    except RuntimeError as e:
        log.error("Instagram auth failed: %s", e)
        return []

    try:
        user_id = cl.user_id_from_username(handle)
    except Exception as e:
        log.error("Could not resolve Instagram user ID: %s", e)
        return []

    try:
        medias = cl.user_medias(user_id, amount=max_images * 2)  # fetch extra, filter after
    except Exception as e:
        log.error("Failed to fetch Instagram media: %s", e)
        return []

    seen: set = set()
    records: list = []

    for media in medias:
        if len(records) >= max_images:
            break
        paths = []
        try:
            if media.media_type == 1:       # photo
                p = cl.photo_download(media.pk, folder=str(tmp_dir))
                if p:
                    paths.append(Path(p))
            elif media.media_type == 8:     # carousel
                ps = cl.album_download(media.pk, folder=str(tmp_dir))
                paths.extend([Path(p) for p in (ps or [])])
        except Exception as e:
            log.warning("Skipping post %s: %s", media.pk, e)
            continue

        for idx, p in enumerate(paths):
            if len(records) >= max_images:
                break
            # Each carousel slide gets a unique source_url suffix
            slide_suffix = f"?img_index={idx+1}" if len(paths) > 1 else ""
            meta = {
                "platform": "instagram",
                "handle": handle,
                "source_url": f"https://www.instagram.com/p/{media.code}/{slide_suffix}",
                "caption": (media.caption_text or "")[:300],
                "likes": media.like_count,
            }
            rec = accept_and_dedup(p, web_dir, seen, meta)
            if rec:
                records.append(rec)
                log.info("  [%d/%d] saved: %s", len(records), max_images, Path(rec["path"]).name)
            time.sleep(DL_DELAY)

    log.info("Instagram done — %d images.", len(records))
    return records

# ── Facebook ──────────────────────────────────────────────────────────────────

def scrape_facebook(handle: str, web_dir: Path, tmp_dir: Path, max_images: int) -> list[dict]:
    try:
        from facebook_scraper import get_posts
    except ImportError:
        log.warning("facebook-scraper not installed — skipping Facebook scrape (run: pip install facebook-scraper)")
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
    parser.add_argument("url",              help="Instagram or Facebook page URL")
    parser.add_argument("--output", "-o",  default="/tmp/sme_scraper_out")
    parser.add_argument("--max",    "-m",  type=int, default=15)
    args = parser.parse_args()

    try:
        platform = detect_platform(args.url)
        handle   = extract_handle(args.url)
    except ValueError as e:
        log.error(str(e))
        # Still write empty results so Node.js always gets valid JSON
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

    # Write results.json for Node.js to consume
    results_path = out_dir / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({"platform": platform, "handle": handle, "images": records}, f, indent=2)

    log.info("Done — %d images → %s", len(records), web_dir)
    log.info("Results → %s", results_path)

if __name__ == "__main__":
    main()
