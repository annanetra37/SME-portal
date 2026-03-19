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

import os, re, sys, json, shutil, hashlib, logging, argparse, mimetypes, time, random
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
    handlers=[logging.StreamHandler(sys.stderr)],   # stderr so stdout stays clean for JSON
)
log = logging.getLogger("scraper")

# ── Constants ─────────────────────────────────────────────────────────────────
MIN_WIDTH    = 400
MIN_HEIGHT   = 400
MIN_SIZE     = 20_000   # bytes
SESSION_FILE = Path("/tmp/.instagram_session.json")

# ── Rate-limiting configuration ──────────────────────────────────────────────
DL_DELAY_MIN     = 2.0       # minimum seconds between downloads
DL_DELAY_MAX     = 5.0       # maximum seconds between downloads
BATCH_SIZE       = 5         # number of requests before a cooldown pause
BATCH_COOLDOWN   = (10, 20)  # cooldown range (seconds) after each batch
BACKOFF_BASE     = 5.0       # base seconds for exponential backoff
BACKOFF_MAX      = 120.0     # maximum backoff delay in seconds
MAX_RETRIES      = 4         # retries per request on rate-limit / transient errors

_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

HEADERS = {
    "User-Agent": random.choice(_USER_AGENTS),
}


# ── Rate-limit helpers ───────────────────────────────────────────────────────

def _random_delay():
    """Sleep for a randomised interval between downloads (human-like jitter)."""
    delay = random.uniform(DL_DELAY_MIN, DL_DELAY_MAX)
    log.debug("Rate-limit: sleeping %.1fs", delay)
    time.sleep(delay)


def _batch_cooldown(request_count: int):
    """After every BATCH_SIZE requests, take a longer cooldown pause."""
    if request_count > 0 and request_count % BATCH_SIZE == 0:
        cooldown = random.uniform(*BATCH_COOLDOWN)
        log.info("Rate-limit: batch cooldown — pausing %.0fs after %d requests", cooldown, request_count)
        time.sleep(cooldown)


_RETRYABLE_KEYWORDS = (
    "rate limit", "rate_limit", "ratelimit",
    "429", "too many", "please wait",
    "challenge_required", "challenge required", "challengerequired",
    "login_required", "login required", "loginrequired",
    "checkpoint", "checkpoint_required",
    "401", "unauthorized",
    "feedback_required", "feedbackrequired",
    "consent_required",
    "temporarily blocked",
)

# Instagram client reference — set during scrape, used by _with_backoff to re-auth
_ig_client = None

def _is_retryable(exc):
    """Check if an exception is a transient/auth error worth retrying."""
    err_str = str(exc).lower()
    class_name = type(exc).__name__.lower()
    combined = f"{class_name}: {err_str}"
    return any(kw in combined for kw in _RETRYABLE_KEYWORDS)


def _with_backoff(fn, *args, label: str = "request", **kwargs):
    """Call *fn* with exponential backoff on transient / rate-limit errors.

    On auth errors (401/LoginRequired), attempts to refresh the Instagram
    session before retrying.  Returns the result of *fn*, or re-raises after
    MAX_RETRIES failures.
    """
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_err = exc
            retryable = _is_retryable(exc)
            if not retryable and attempt == 1:
                raise  # not a transient error — fail fast

            # On auth errors, try to refresh the session
            err_lower = f"{type(exc).__name__}: {exc}".lower()
            is_auth = any(kw in err_lower for kw in ("login", "401", "unauthorized"))
            if is_auth and _ig_client:
                log.warning("Auth error detected — attempting session refresh…")
                try:
                    _ig_client.get_timeline_feed()  # poke session
                except Exception:
                    try:
                        session_id = os.getenv("IG_SESSION")
                        if session_id:
                            _ig_client.login_by_sessionid(session_id)
                            log.info("Session refreshed successfully.")
                    except Exception as re_err:
                        log.warning("Session refresh failed: %s", re_err)

            delay = min(BACKOFF_BASE * (2 ** (attempt - 1)) + random.uniform(0, 2), BACKOFF_MAX)
            log.warning(
                "Retryable error: %s failed (attempt %d/%d): %s — retrying in %.0fs",
                label, attempt, MAX_RETRIES, exc, delay,
            )
            time.sleep(delay)
    raise last_err  # type: ignore[misc]

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
    cl.delay_range = [3, 7]  # wider delay range to appear more human-like

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
    global _ig_client
    log.info("Instagram: scraping @%s (max %d images)", handle, max_images)

    try:
        cl = get_ig_client()
        _ig_client = cl  # expose for _with_backoff session refresh
    except RuntimeError as e:
        log.error("Instagram auth failed: %s", e)
        return []

    try:
        user_id = _with_backoff(cl.user_id_from_username, handle, label="user_id_lookup")
    except Exception as e:
        log.error("Could not resolve Instagram user ID: %s", e)
        return []

    try:
        medias = _with_backoff(cl.user_medias, user_id, max_images * 2, label="user_medias")
    except Exception as e:
        log.error("Failed to fetch Instagram media: %s", e)
        return []

    seen: set = set()
    records: list = []
    request_count = 0

    skipped = 0
    for media in medias:
        if len(records) >= max_images:
            break
        paths = []
        try:
            request_count += 1
            _batch_cooldown(request_count)
            if media.media_type == 1:       # photo
                p = _with_backoff(cl.photo_download, media.pk, str(tmp_dir), label=f"photo_{media.pk}")
                if p:
                    paths.append(Path(p))
            elif media.media_type == 8:     # carousel
                ps = _with_backoff(cl.album_download, media.pk, str(tmp_dir), label=f"album_{media.pk}")
                paths.extend([Path(p) for p in (ps or [])])
        except Exception as e:
            skipped += 1
            log.warning("Skipping post %s (%d skipped so far): %s: %s",
                        media.pk, skipped, type(e).__name__, e)
            # If too many consecutive auth failures, session is dead — stop early
            if skipped >= 5 and len(records) == 0:
                log.error("Too many failures with 0 successes — Instagram session may be invalid. "
                          "Try refreshing IG_SESSION with a new sessionid cookie.")
                break
            continue

        for p in paths:
            if len(records) >= max_images:
                break
            meta = {
                "platform": "instagram",
                "handle": handle,
                "source_url": f"https://www.instagram.com/p/{media.code}/",
                "caption": (media.caption_text or "")[:300],
                "likes": media.like_count,
            }
            rec = accept_and_dedup(p, web_dir, seen, meta)
            if rec:
                records.append(rec)
                log.info("  [%d/%d] saved: %s", len(records), max_images, Path(rec["path"]).name)
            _random_delay()

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
    http.headers.update({"User-Agent": random.choice(_USER_AGENTS)})
    seen: set = set()
    records: list = []
    count = 0
    request_count = 0

    try:
        for post in get_posts(handle, **kwargs):
            if len(records) >= max_images:
                break
            urls = post.get("images") or post.get("images_lowquality") or []
            for url in urls:
                if len(records) >= max_images:
                    break
                request_count += 1
                _batch_cooldown(request_count)
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
                _random_delay()
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
