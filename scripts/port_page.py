#!/usr/bin/env python3
"""Port one page of a live server-rendered site into an Astro project, verbatim.

Usage: edit the constants below, then:  python3 port_page.py <slug>
  <slug> examples: "."  (homepage)   "work"   "portfolio/crystal-vibes"

Per page it: snapshots the server HTML, collects every referenced same-site
asset into public/ at its original path (copying from LOCAL_SOURCES when the
file exists on disk, e.g. a purchased theme), recursively resolves CSS url()
references, strips the origin everywhere (raw + JSON-escaped forms, HTML and
collected css/js), and generates src/raw partials + a set:html .astro page.

Fidelity rules encoded here (do not "improve" them away):
- Source is the SERVER html via curl, never a rendered-DOM snapshot.
- Assets keep their original URL paths under public/.
- Markup is injected via ?raw + set:html so Astro never parses it.
- <body> attributes are copied verbatim into the .astro page.
"""
import os, re, shutil, subprocess, sys
from urllib.parse import urljoin, urlparse, unquote

# ---- edit these ----------------------------------------------------------
SITE = 'https://dlas.co.kr/'                # page URLs are SITE + slug + '/'
PROJECT = '/Users/tuesdaymorning/Devguru/memory_projects/dl_renovate'
# 라이브는 Salient 17.2.0, 구매본 reference/salient-new은 18.2.1이라 버전이 다르다.
# 로컬 복사를 쓰면 CSS/JS가 라이브와 달라져 동일성이 깨지므로 전량 다운로드한다.
LOCAL_SOURCES = {}
# --------------------------------------------------------------------------

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')
EXTS = ('.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif',
        '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mov', '.m4v',
        '.ogv', '.mp3', '.ogg', '.ico', '.json', '.pdf')

OUT = os.path.join(PROJECT, 'public')
SITE = SITE if SITE.endswith('/') else SITE + '/'
ORIGIN_PATH = urlparse(SITE).path                      # e.g. /demo/

# --- origin prefix variants -----------------------------------------------
# WordPress emits the origin in several shapes: https://, http://, and
# protocol-relative //host/ (WP Fastest Cache does this), each optionally in
# JSON-escaped form (https:\/\/host\/) and optionally with a www. host.
# All of them must be collected AND localized, otherwise assets silently stay
# pointed at the live origin.
_HOST = urlparse(SITE).netloc
_HOSTS = [_HOST] + ([_HOST[4:]] if _HOST.startswith('www.') else ['www.' + _HOST])
_PREFIXES = []                                          # longest first
for _h in _HOSTS:
    for _s in ('https://', 'http://', '//'):
        _p = _s + _h + ORIGIN_PATH                      # e.g. https://host/
        _PREFIXES += [_p, _p.replace('/', '\\/')]
_PREFIXES.sort(key=len, reverse=True)

def _unescape(u):
    return u.replace('\\/', '/')

def canonical(u):
    """Normalize any origin-prefix variant of a URL to the SITE form."""
    u = _unescape(u)
    for _s in ('https://', 'http://', '//'):
        for _h in _HOSTS:
            pre = _s + _h + ORIGIN_PATH
            if u.startswith(pre):
                return SITE + u[len(pre):]
    return u

def localize(s):
    """Strip every origin-prefix variant, leaving a root-relative path."""
    for p in _PREFIXES:
        s = s.replace(p, '\\/' if '\\/' in p else '/')
        rootless = p[:-1] if not p.endswith('\\/') else p[:-2]
        s = s.replace(rootless, '')
    return s
# --------------------------------------------------------------------------

# usage: port_page.py <slug> [--as <page-name>] [--allow-error]
#   --as 404        -> writes src/pages/404.astro instead of src/pages/<slug>/index.astro
#   --allow-error   -> keep the response even on a non-2xx status (needed to
#                      snapshot the live 404 template, which curl --fail rejects)
argv = sys.argv[1:]
PAGE_NAME = None
if '--as' in argv:
    i = argv.index('--as')
    PAGE_NAME = argv[i + 1]
    del argv[i:i + 2]
ALLOW_ERROR = '--allow-error' in argv
argv = [a for a in argv if not a.startswith('--')]

slug = argv[0].strip('/')
url = SITE if slug in ('', '.') else SITE + slug + '/'
name = PAGE_NAME or ('index' if slug in ('', '.') else slug.replace('/', '-'))

cmd = ['curl', '-sL', '-A', UA, url] if ALLOW_ERROR else ['curl', '-sL', '--fail', '-A', UA, url]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode != 0 or not r.stdout:
    sys.exit(f'FETCH FAILED {url}')
html = r.stdout

_ASSET_RE = re.compile(
    '(?:' + '|'.join(re.escape(p) for p in _PREFIXES) + r')[^"\'\s\)<>,}]+')

def site_asset_urls(text):
    out = set()
    for m in _ASSET_RE.findall(text):
        u = canonical(m).split('?')[0].split('#')[0].rstrip('\\').rstrip('&;.,')
        if u.lower().endswith(EXTS):
            out.add(u)
    return out

copied = downloaded = 0
failed, done = [], set()

def fetch(u):
    global copied, downloaded
    if u in done:
        return
    done.add(u)
    # percent-decode: the static server decodes the request path before hitting
    # disk, so Korean/percent-encoded upload filenames must be stored decoded.
    rel = unquote(urlparse(u).path[len(ORIGIN_PATH):])
    dest = os.path.join(OUT, rel)
    if os.path.isfile(dest):
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for prefix, local in LOCAL_SOURCES.items():
        if rel.startswith(prefix):
            cand = os.path.join(local, rel[len(prefix):])
            if os.path.isfile(cand):
                shutil.copy2(cand, dest)
                copied += 1
                return
    rr = subprocess.run(['curl', '-sL', '--fail', '-A', UA, '-o', dest, u], capture_output=True)
    if rr.returncode != 0 or not os.path.isfile(dest) or os.path.getsize(dest) == 0:
        failed.append(u)
        if os.path.isfile(dest):
            os.remove(dest)
    else:
        downloaded += 1

for u in sorted(site_asset_urls(html)):
    fetch(u)

# Contact Form 7 6.x fetches a per-form SWV validation schema over the REST API
# on load. It is a static JSON document, so snapshot it to keep client-side
# validation byte-identical to the live site. (Submission itself still needs a
# backend — see plan Task 8.)
for _fid in sorted(set(re.findall(r'data-wpcf7-id="(\d+)"', html))):
    fetch(f'{SITE}wp-json/contact-form-7/v1/contact-forms/{_fid}/feedback/schema')

# recursively resolve url() references inside collected CSS (fonts, images)
for _ in range(4):
    new = set()
    for root, _d, files in os.walk(OUT):
        for f in files:
            if not f.endswith('.css'):
                continue
            p = os.path.join(root, f)
            css = open(p, encoding='utf-8', errors='ignore').read()
            base = SITE + os.path.dirname(os.path.relpath(p, OUT)) + '/'
            for m in re.findall(r'url\(\s*[\'"]?([^\'")]+)[\'"]?\s*\)', css):
                if m.startswith(('data:', '#')):
                    continue
                absu = canonical(urljoin(base, m.split('?')[0].split('#')[0]))
                if absu.startswith(SITE) and absu.lower().endswith(EXTS) and absu not in done:
                    new.add(absu)
    if not new:
        break
    for u in sorted(new):
        fetch(u)

# strip the origin inside every collected css/js (downloaded files still point home)
for root, _d, files in os.walk(OUT):
    for f in files:
        if not f.endswith(('.css', '.js')):
            continue
        p = os.path.join(root, f)
        s = open(p, encoding='utf-8', errors='ignore').read()
        n = localize(s)
        if n != s:
            open(p, 'w', encoding='utf-8').write(n)

head_inner = localize(html[html.find('<head>') + 6: html.find('</head>')])
bm = re.search(r'<body([^>]*)>', html)
body_attrs = bm.group(1).strip()
body_inner = localize(html[bm.end(): html.rfind('</body>')])
hm = re.search(r'<html([^>]*)>', html)
html_attrs = (hm.group(1).strip() if hm else 'lang="en"')

os.makedirs(f'{PROJECT}/src/raw', exist_ok=True)
open(f'{PROJECT}/src/raw/{name}-head.html', 'w').write(head_inner)
open(f'{PROJECT}/src/raw/{name}-body.html', 'w').write(body_inner)

depth = 0 if (PAGE_NAME or slug in ('', '.')) else slug.count('/') + 1
rawpath = '../' * (depth + 1) + 'raw/'
attrs = '\n    '.join(re.findall(r'[a-zA-Z-]+="[^"]*"|[a-zA-Z-]+', body_attrs))
page = f"""---
// /{slug if slug not in ('', '.') else ''} page ported verbatim from {url}
import head from '{rawpath}{name}-head.html?raw';
import body from '{rawpath}{name}-body.html?raw';
---

<html {html_attrs}>
  <head><Fragment set:html={{head}} /></head>
  <body
    {attrs}
  ><Fragment set:html={{body}} /></body>
</html>
"""
if PAGE_NAME:
    os.makedirs(f'{PROJECT}/src/pages', exist_ok=True)
    open(f'{PROJECT}/src/pages/{PAGE_NAME}.astro', 'w').write(page)
else:
    pdir = f'{PROJECT}/src/pages' if slug in ('', '.') else f'{PROJECT}/src/pages/{slug}'
    os.makedirs(pdir, exist_ok=True)
    open(pdir + '/index.astro', 'w').write(page)
print(f'{name}: copied {copied}, downloaded {downloaded}, failed {len(failed)}')
for u in failed:
    print('  FAIL', u)
