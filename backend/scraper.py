"""
Social Media Image Scraper — VM-friendly, no browser required.
Instagram : instagrapi (Instagram private/mobile API)
Facebook  : facebook-scraper library

Credentials (pick one method per platform):
  Instagram: IG_SESSION   — sessionid cookie from browser (recommended)
             IG_USERNAME + IG_PASSWORD  — username/password fallback
  Facebook:  FB_COOKIES   — path to Netscape cookies.txt (optional)

  All vars can be in a .env file or passed as CLI flags (--ig-session, etc.)

Output (consumed by Node.js server):
  {output_dir}/web/*.jpg    — web-ready JPEG images (≤2000px, quality 88)
  {output_dir}/results.json — metadata list; each record has an absolute 'path'
"""

import os, re, sys, json, shutil, hashlib, logging, argparse, time
from pathlib import Path
from datetime import datetime

import requests
from PIL import Image

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Logging — stderr keeps stdout clean for any future structured output ─────
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
MAX_DIM      = 2000
DL_DELAY     = 1.2      # seconds between downloads
SESSION_FILE = Path("/tmp/.instagram_session.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# ── Shared helpers ────────────────────────────────────────────────────────────

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
    """Quality-check, deduplicate, convert to web-ready JPEG, return record with absolute path."""
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
            if max(img.size) > MAX_DIM:
                img.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)
            img.save(out_path, "JPEG", quality=88, optimize=True)
        src.unlink(missing_ok=True)
        return {"path": str(out_path), "scraped_at": datetime.utcnow().isoformat(), **meta}
    except Exception as e:
        log.warning("Conversion failed %s: %s", src, e)
        src.unlink(missing_ok=True)
        return None

# ── Instagram via instagrapi ──────────────────────────────────────────────────

def _get_ig_client(session_id: str | None, username: str | None, password: str | None):
    """
    Return an authenticated instagrapi Client.
    Priority:
      1. session_id   — browser sessionid cookie, no login challenge risk.
      2. cached file  — previously saved full session (avoids re-login).
      3. username + password — fresh login (may trigger challenge on new IPs).
    """
    try:
        from instagrapi import Client
        from instagrapi.exceptions import TwoFactorRequired
    except ImportError:
        log.error("instagrapi not installed — run: pip install instagrapi")
        sys.exit(1)

    cl = Client()
    cl.delay_range = [1, 3]

    # Strategy 1: session ID from browser cookie
    if session_id:
        log.info("  Authenticating via session ID (browser cookie)…")
        cl.login_by_sessionid(session_id)
        cl.dump_settings(str(SESSION_FILE))
        log.info("  Authenticated. Full session cached → %s", SESSION_FILE)
        return cl

    # Strategy 2: cached session from a previous run
    if SESSION_FILE.exists():
        log.info("  Loading cached session from %s…", SESSION_FILE)
        try:
            cl.load_settings(str(SESSION_FILE))
            cl.get_timeline_feed()
            log.info("  Cached session is valid.")
            return cl
        except Exception as e:
            log.warning("  Cached session expired (%s) — will re-authenticate.", e)
            SESSION_FILE.unlink(missing_ok=True)

    # Strategy 3: username + password
    if not username or not password:
        log.error(
            "Instagram auth required. Set one of:\n"
            "  IG_SESSION   — sessionid cookie from browser (recommended)\n"
            "  IG_USERNAME + IG_PASSWORD\n\n"
            "How to get your session ID:\n"
            "  1. Open Instagram in Chrome and log in.\n"
            "  2. Press F12 → Application → Cookies → https://www.instagram.com\n"
            "  3. Find the cookie named 'sessionid' and copy its Value.\n"
            "  4. Set IG_SESSION=<that value> in your .env file."
        )
        sys.exit(1)

    log.info("  Logging in as @%s (username/password)…", username)
    try:
        cl.login(username, password)
    except TwoFactorRequired:
        code = input("  Enter 2FA code from your authenticator app: ").strip()
        cl.login(username, password, verification_code=code)

    cl.dump_settings(str(SESSION_FILE))
    log.info("  Session cached → %s (reused on next run)", SESSION_FILE)
    return cl

def scrape_instagram(
    handle: str,
    web_dir: Path,
    tmp_dir: Path,
    session_id: str | None,
    username: str | None,
    password: str | None,
    max_images: int,
) -> list[dict]:
    log.info("Instagram: scraping @%s via instagrapi (mobile API)", handle)
    cl = _get_ig_client(session_id, username, password)

    try:
        user_id = cl.user_id_from_username(handle)
        log.info("  User ID for @%s: %s", handle, user_id)
    except Exception as e:
        log.error("  Could not resolve user ID: %s", e)
        return []

    log.info("  Fetching up to %d posts…", max_images)
    try:
        medias = cl.user_medias(user_id, amount=max_images * 2)  # over-fetch, filter after
    except Exception as e:
        log.error("  Failed to fetch media list: %s", e)
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
            elif media.media_type == 8:     # carousel/album
                ps = cl.album_download(media.pk, folder=str(tmp_dir))
                paths.extend([Path(p) for p in (ps or [])])
            # skip video-only posts
        except Exception as e:
            log.warning("  Skipping post %s: %s", media.pk, e)
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
            time.sleep(DL_DELAY)

    log.info("Instagram done — %d images.", len(records))
    return records

# ── Facebook via facebook-scraper ─────────────────────────────────────────────

def scrape_facebook(
    handle: str,
    web_dir: Path,
    tmp_dir: Path,
    cookies: str | None,
    max_images: int,
) -> list[dict]:
    try:
        from facebook_scraper import get_posts
    except ImportError:
        log.error("facebook-scraper not installed — run: pip install facebook-scraper")
        sys.exit(1)

    log.info("Facebook: scraping page '%s' (max %d images)", handle, max_images)

    kwargs: dict = {
        "pages": max(1, max_images // 5),
        "extra_info": True,
        "youtube_dl": False,
        "options": {"images": True, "progress": False},
    }
    if cookies:
        kwargs["cookies"] = cookies
        log.info("  Using cookies: %s", cookies)
    else:
        log.warning(
            "  No cookies supplied — only truly public posts will be accessible.\n"
            "  For better results: export Facebook cookies to fb_cookies.txt and pass\n"
            "  --fb-cookies fb_cookies.txt  (or set FB_COOKIES env var)."
        )

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
        log.error("  facebook-scraper error: %s", e)
        if not records:
            log.info(
                "  Tip: Facebook often requires cookies for non-public pages.\n"
                "  Export your FB session cookies to fb_cookies.txt and use:\n"
                "  --fb-cookies fb_cookies.txt"
            )

    log.info("Facebook done — %d images.", len(records))
    return records

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="SME Portal social media image scraper",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("url",             help="Instagram or Facebook page URL")
    parser.add_argument("--output", "-o",  default="/tmp/sme_scraper_out",
                        help="Output directory")
    parser.add_argument("--max",    "-m",  type=int, default=15,
                        help="Max images to download")

    ig = parser.add_argument_group("Instagram credentials (pick one method)")
    ig.add_argument("--ig-session", default=os.getenv("IG_SESSION"),
                    help="Instagram 'sessionid' cookie  [env: IG_SESSION]  ← recommended")
    ig.add_argument("--ig-user",    default=os.getenv("IG_USERNAME"),
                    help="Instagram username  [env: IG_USERNAME]")
    ig.add_argument("--ig-pass",    default=os.getenv("IG_PASSWORD"),
                    help="Instagram password  [env: IG_PASSWORD]")

    fb = parser.add_argument_group("Facebook options")
    fb.add_argument("--fb-cookies", default=os.getenv("FB_COOKIES"),
                    help="Path to Netscape cookies.txt  [env: FB_COOKIES]")

    args = parser.parse_args()

    try:
        platform = detect_platform(args.url)
        handle   = extract_handle(args.url)
    except ValueError as e:
        log.error(str(e))
        sys.exit(1)

    out_dir = Path(args.output)
    web_dir = out_dir / "web"
    tmp_dir = out_dir / "_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    web_dir.mkdir(parents=True, exist_ok=True)

    log.info("Platform: %s | Handle: %s | Max: %d", platform, handle, args.max)

    if platform == "instagram":
        records = scrape_instagram(
            handle, web_dir, tmp_dir,
            session_id=args.ig_session,
            username=args.ig_user,
            password=args.ig_pass,
            max_images=args.max,
        )
    else:
        records = scrape_facebook(
            handle, web_dir, tmp_dir,
            cookies=args.fb_cookies,
            max_images=args.max,
        )

    shutil.rmtree(tmp_dir, ignore_errors=True)

    # Write results.json — consumed by Node.js (expects .images[].path as absolute path)
    results_path = out_dir / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({"platform": platform, "handle": handle, "images": records}, f, indent=2)

    log.info("Done — %d images → %s", len(records), web_dir)
    log.info("Results → %s", results_path)

    if not records:
        sys.exit(1)

if __name__ == "__main__":
    main()
