"""解析：一个链接 → 标题 + 可下载的视频 / 图片清单。"""
import html.parser
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor

import yt_dlp
from yt_dlp.extractor import gen_extractor_classes

from . import config, net
from .errors import Fail, from_ytdlp

_cache, _lock = {}, threading.Lock()
TTL = 900

PLATFORMS = [('youtube', r'(^|\.)(youtube\.com|youtu\.be)$'), ('bilibili', r'(^|\.)(bilibili\.com|b23\.tv)$'),
             ('tiktok', r'(^|\.)tiktok\.com$'), ('instagram', r'(^|\.)instagram\.com$'), ('twitter', r'(^|\.)(x|twitter)\.com$')]


def platform_of(url):
    host = (urllib.parse.urlsplit(url).hostname or '').lower()
    for name, pat in PLATFORMS:
        if re.search(pat, host):
            return name
    return 'generic'


_SPECIFIC = None


def has_specific_extractor(url):
    global _SPECIFIC
    if _SPECIFIC is None:
        _SPECIFIC = [ie for ie in gen_extractor_classes() if ie.ie_key() != 'Generic']
    return any(ie.suitable(url) for ie in _SPECIFIC)


class _Logger:
    def debug(self, m): pass
    def info(self, m): pass
    def warning(self, m): pass
    def error(self, m): pass


def ydl_params(**extra):
    p = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'logger': _Logger(), 'socket_timeout': 30,
         'extractor_retries': 1, 'playlistend': 30, 'cachedir': False}
    rt = config.js_runtimes()
    if rt:
        p['js_runtimes'] = rt
    p.update(extra)
    return p


def _jobdir(prefix='p'):
    d = os.path.join(config.TMP, f'{prefix}-{uuid.uuid4().hex}')
    os.makedirs(d)
    return d


def ffprobe_json(target, timeout=40):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', target],
                       capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except ValueError:
        return None


# ---------- 网页嗅探 ----------
class _Sniff(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.imgs, self.meta, self.title, self._t, self._pic = [], {}, '', False, 0

    def handle_starttag(self, tag, attrs):
        a = {k: (v or '') for k, v in attrs}
        if tag == 'meta':
            key = a.get('property') or a.get('name')
            if key and a.get('content'):
                self.meta.setdefault(key.lower(), a['content'])
        elif tag == 'title':
            self._t = True
        elif tag == 'picture':
            self._pic += 1
        elif tag == 'img' or (tag == 'source' and self._pic and a.get('srcset')):
            best = _best_src(a)
            if best:
                w = a.get('width', '')
                h = a.get('height', '')
                tiny = (w.isdigit() and int(w) < 100) or (h.isdigit() and int(h) < 100)
                self.imgs.append((best, tiny))

    def handle_endtag(self, tag):
        if tag == 'title':
            self._t = False
        elif tag == 'picture':
            self._pic = max(0, self._pic - 1)

    def handle_data(self, d):
        if self._t:
            self.title += d


def _best_src(a):
    best, score = a.get('src') or a.get('data-src') or '', 0
    for part in (a.get('srcset') or a.get('data-srcset') or '').split(','):
        bits = part.strip().split()
        if not bits:
            continue
        s = 1.0
        if len(bits) > 1:
            d = bits[1].lower()
            try:
                s = float(d[:-1]) * (1 if d.endswith('w') else 1000)
            except ValueError:
                s = 1.0
        if s > score:
            best, score = bits[0], s
    return best if best and not best.startswith('data:') else ''


def _image_size(url, headers=None):
    d = _jobdir()
    try:
        _, data, _ = net.fetch(url, limit=25_000_000, headers=headers)
        path = os.path.join(d, 'i')
        with open(path, 'wb') as f:
            f.write(data)
        j = ffprobe_json(path, 20)
        s = next((s for s in (j or {}).get('streams', []) if s.get('codec_type') == 'video'), None)
        return (s['width'], s['height']) if s else (0, 0)
    except Fail:
        return (0, 0)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def sniff_images(page_url, html_text):
    sn = _Sniff()
    sn.feed(html_text)
    urls, seen = [], set()
    for src, tiny in sn.imgs:
        full = urllib.parse.urljoin(page_url, src)
        if tiny or full in seen or not full.startswith('http'):
            continue
        seen.add(full)
        urls.append(full)
    urls = urls[:60]
    with ThreadPoolExecutor(6) as ex:
        sizes = list(ex.map(_image_size, urls))
    images = [{'src': u, 'width': w, 'height': h} for u, (w, h) in zip(urls, sizes) if w >= 100 and h >= 100]
    title = sn.meta.get('og:title') or sn.title.strip()
    return images, title, sn.meta


# ---------- 平台专用：图片帖 ----------
def tiktok_images(url):
    """TikTok 图集：页面里的 imagePost.images（参考 cobalt 的思路，自行实现）。"""
    m = re.search(r'/(?:video|photo)/(\d+)', url)
    if not m:
        final, _ = net.open_url(url)
        m = re.search(r'/(?:video|photo)/(\d+)', final)
        if not m:
            return [], None
    _, body, _ = net.fetch(f'https://www.tiktok.com/@i/video/{m.group(1)}', limit=6_000_000)
    s = re.search(rb'<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', body, re.S)
    if not s:
        return [], None
    try:
        data = json.loads(s.group(1))
        item = data['__DEFAULT_SCOPE__']['webapp.video-detail']['itemInfo']['itemStruct']
    except (KeyError, ValueError, TypeError):
        return [], None
    out = []
    for im in (item.get('imagePost') or {}).get('images') or []:
        lst = (im.get('imageURL') or {}).get('urlList') or []
        if lst:
            out.append({'src': lst[0], 'width': im.get('imageWidth') or 0, 'height': im.get('imageHeight') or 0,
                        'headers': {'Referer': 'https://www.tiktok.com/'}})
    return out, item.get('desc')


def instagram_media(url):
    """Instagram 帖子：嵌入页 /embed/captioned/ 里的媒体（不登录）。"""
    m = re.search(r'/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)', url)
    if not m:
        return [], [], None
    _, body, _ = net.fetch(f'https://www.instagram.com/p/{m.group(1)}/embed/captioned/', limit=4_000_000)
    text = body.decode('utf-8', 'replace')
    images, videos, title = [], [], None
    ctx = re.search(r'"contextJSON":"((?:\\.|[^"\\])*)"', text)
    media = None
    if ctx:
        try:
            media = json.loads(json.loads(f'"{ctx.group(1)}"')).get('gql_data', {}).get('shortcode_media')
        except (ValueError, AttributeError):
            media = None
    if media:
        nodes = [e['node'] for e in (media.get('edge_sidecar_to_children') or {}).get('edges', [])] or [media]
        for n in nodes:
            dim = n.get('dimensions') or {}
            if n.get('is_video') and n.get('video_url'):
                videos.append({'url': n['video_url'], 'width': dim.get('width'), 'height': dim.get('height'),
                               'thumbnail': n.get('display_url')})
            elif n.get('display_url'):
                images.append({'src': n['display_url'], 'width': dim.get('width') or 0, 'height': dim.get('height') or 0})
        cap = (media.get('edge_media_to_caption') or {}).get('edges') or []
        title = cap[0]['node']['text'][:80] if cap else None
    else:
        for src in re.findall(r'class="EmbeddedMediaImage"[^>]*src="([^"]+)"', text):
            images.append({'src': src.replace('&amp;', '&'), 'width': 0, 'height': 0})
    for im in images:
        if not im['width']:
            im['width'], im['height'] = _image_size(im['src'])
    return images, videos, title


# ---------- 主流程 ----------
def _fill_unknown_formats(info):
    """网页里 <video src=mp4> 之类，yt-dlp 不给分辨率，自己 ffprobe 补。"""
    for f in info.get('formats') or []:
        if f.get('height') or f.get('vcodec') not in (None, ''):
            continue
        u = f.get('url') or ''
        if not u.startswith('http') or f.get('protocol', 'http').startswith('m3u8') or 'dash' in f.get('protocol', ''):
            continue
        try:
            net.check_url(u)
        except Fail:
            continue
        j = ffprobe_json(u, 40)
        if not j:
            continue
        v = next((s for s in j['streams'] if s.get('codec_type') == 'video'), None)
        a = next((s for s in j['streams'] if s.get('codec_type') == 'audio'), None)
        if v:
            f.update(width=v.get('width'), height=v.get('height'), vcodec=v.get('codec_name'))
        else:
            f['vcodec'] = 'none'
        f['acodec'] = a.get('codec_name') if a else 'none'


def _safe_formats(info):
    """生成的格式里如果指向内网地址，一律丢掉（防止公开网页把我们引到内网）。"""
    if config.ALLOW_PRIVATE:
        return
    keep = []
    for f in info.get('formats') or []:
        u = f.get('manifest_url') or f.get('url') or ''
        try:
            if u.startswith('http'):
                net.check_url(u)
            keep.append(f)
        except Fail:
            pass
    info['formats'] = keep


def _video_formats(info):
    return [f for f in info.get('formats') or [] if f.get('vcodec') not in (None, 'none', '') and f.get('height')]


def _ytdlp(url):
    with yt_dlp.YoutubeDL(ydl_params()) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as e:
            return None, str(e)
        except Exception as e:  # yt-dlp 内部偶发异常
            return None, str(e)
    entries = []
    if info and info.get('_type') == 'playlist':
        entries = [e for e in (info.get('entries') or []) if e][:30]
    elif info:
        entries = [info]
    return {'title': info.get('title'), 'extractor': info.get('extractor_key'), 'entries': entries}, ''


def probe(url):
    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit['t'] < TTL:
            return hit
    net.check_url(url)
    plat = platform_of(url)
    page_html, page_meta, title = None, {}, None
    target = url
    if not has_specific_extractor(url):
        # 通用网页：自己先抓（逐跳检查跳转），再把最终网址交给 yt-dlp
        target, body, ctype = net.fetch(url, limit=6_000_000)
        if 'html' in ctype or body.lstrip()[:1] == b'<':
            page_html = body.decode('utf-8', 'replace')
    res, err = _ytdlp(target)
    videos, images = [], []
    if res:
        for e in res['entries']:
            _fill_unknown_formats(e)
            _safe_formats(e)
            if _video_formats(e) or any(f.get('acodec') not in (None, 'none') for f in e.get('formats') or []):
                videos.append({'info': e})
        title = res['title']
        if res['extractor'] in ('Generic', 'HTML5MediaEmbed'):
            title = None
    extra_err = None
    try:
        if plat == 'tiktok' and not _video_formats((videos[0]['info'] if videos else {})):
            imgs, desc = tiktok_images(url)
            images += imgs
            title = title or desc
        if plat == 'instagram':
            imgs, vids, cap = instagram_media(url)
            images += imgs
            if not videos:
                videos += [{'direct': v} for v in vids]
            title = title or cap
    except Fail as e:
        extra_err = e
    if page_html is not None:
        imgs, t, page_meta = sniff_images(target, page_html)
        known = {i['src'] for i in images}
        images += [i for i in imgs if i['src'] not in known]
        title = t or title
    videos = [v for v in videos if 'direct' in v or _video_formats(v['info']) or v['info'].get('formats')]
    if not videos and not images:
        if err and 'unsupported url' not in err.lower():
            raise from_ytdlp(err)
        if extra_err:
            raise extra_err
        raise Fail(422, 'no_media', '这个页面里没找到能下载的视频或图片')
    if not title and videos and 'info' in videos[0]:
        title = videos[0]['info'].get('title')
    title = (title or page_meta.get('og:title') or '未命名').strip()
    entry = {'t': time.time(), 'url': url, 'platform': plat, 'title': title, 'videos': videos, 'images': images}
    with _lock:
        if len(_cache) > 300:
            for k in sorted(_cache, key=lambda k: _cache[k]['t'])[:100]:
                _cache.pop(k, None)
        _cache[url] = entry
    return entry


def thumb_path(u):
    return '/api/thumb?u=' + urllib.parse.quote(u, safe='') if u else None


def best_thumbnail(info):
    ths = [t for t in info.get('thumbnails') or [] if t.get('url')]
    if ths:
        ths.sort(key=lambda t: ((t.get('width') or 0) * (t.get('height') or 0), t.get('preference') or 0))
        return ths[-1]['url']
    return info.get('thumbnail')


def video_qualities(v):
    if 'direct' in v:
        return [v['direct']['height']] if v['direct'].get('height') else []
    return sorted({f['height'] for f in _video_formats(v['info'])}, reverse=True)


def items_of(entry):
    out = []
    for i, v in enumerate(entry['videos']):
        qs = video_qualities(v)
        if 'direct' in v:
            th = v['direct'].get('thumbnail')
        else:
            th = best_thumbnail(v['info'])
        it = {'id': f'v{i}', 'kind': 'video' if qs else 'audio', 'thumbnail': thumb_path(th)}
        if qs:
            it['qualities'] = qs
        if 'info' in v:
            it['audio'] = any(f.get('acodec') not in (None, 'none', '') for f in v['info'].get('formats') or [])
        if 'info' in v and v['info'].get('duration'):
            it['duration'] = v['info']['duration']
        if len(entry['videos']) > 1 and 'info' in v:
            it['title'] = v['info'].get('title')
        out.append(it)
    for i, im in enumerate(entry['images']):
        out.append({'id': f'i{i}', 'kind': 'image', 'width': im['width'], 'height': im['height'], 'thumbnail': thumb_path(im['src'])})
    return out
