"""网络层：从文字里取链接、拦本机/内网地址、带跳转检查的抓取。"""
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

from .errors import Fail
from . import config

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36')

# 链接到空白或中文标点为止（分享文案里常见「链接 + 中文」）
_URL = re.compile(r'[a-z][a-z0-9+.\-]*://[^\s<>"\'，。！？、；：】）》「」『』]+', re.I)


def extract_url(text: str) -> str:
    m = _URL.search(text or '')
    if not m:
        raise Fail(400, 'bad_url', '没找到链接，请粘贴以 http 开头的网址或整段分享文案')
    url = m.group(0).rstrip('.,;!?)')
    if urllib.parse.urlsplit(url).scheme.lower() not in ('http', 'https'):
        raise Fail(400, 'bad_url', '只支持 http / https 网址')
    return url


def _bad_ip(ip) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified or not ip.is_global)


def check_url(url: str) -> None:
    """按解析后的真实 IP 判断，拦本机、内网、链路本地等地址。"""
    p = urllib.parse.urlsplit(url)
    if p.scheme.lower() not in ('http', 'https'):
        raise Fail(400, 'bad_url', '只支持 http / https 网址')
    if not p.hostname:
        raise Fail(400, 'bad_url', '网址不完整')
    if config.ALLOW_PRIVATE:
        return
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == 'https' else 80),
                                   proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, ValueError):
        raise Fail(400, 'not_found', '找不到这个网站，检查一下链接')
    for info in infos:
        if _bad_ip(ipaddress.ip_address(info[4][0].split('%')[0])):
            raise Fail(400, 'blocked_host', '出于安全考虑，不能访问本机或内网地址')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def open_url(url: str, headers=None, timeout=20):
    """逐跳检查的 GET；返回 (最终网址, 响应对象)。"""
    for _ in range(8):
        check_url(url)
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', **(headers or {})})
        try:
            resp = _opener.open(req, timeout=timeout)
            return url, resp
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get('Location'):
                url = urllib.parse.urljoin(url, e.headers['Location'])
                continue
            if e.code == 404 or e.code == 410:
                raise Fail(404, 'not_found', f'页面不存在（HTTP {e.code}）')
            if e.code in (401, 403):
                raise Fail(403, 'login_required', '这个页面要登录或不允许访问')
            if e.code == 429:
                raise Fail(429, 'rate_limited', '对方网站限流了，过一会儿再试')
            raise Fail(424, 'unavailable', f'对方网站出错了（HTTP {e.code}）')
        except Fail:
            raise
        except Exception:
            raise Fail(424, 'unavailable', '连不上这个网站，稍后再试')
    raise Fail(400, 'unavailable', '跳转次数太多')


def fetch(url: str, limit=8_000_000, headers=None):
    """抓取到内存；返回 (最终网址, 内容, content-type)。"""
    final, resp = open_url(url, headers)
    with resp:
        data = resp.read(limit + 1)
        if len(data) > limit:
            raise Fail(413, 'too_large', '文件太大了')
        return final, data, resp.headers.get('Content-Type', '')


def fetch_to(url: str, path: str, headers=None, progress=None, limit=4_000_000_000):
    """流式抓取到文件（直链媒体）。"""
    final, resp = open_url(url, headers, timeout=60)
    total = int(resp.headers.get('Content-Length') or 0)
    got = 0
    with resp, open(path, 'wb') as f:
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            got += len(chunk)
            if got > limit:
                raise Fail(413, 'too_large', '文件太大了')
            f.write(chunk)
            if progress and total:
                progress(got / total)
    return resp.headers.get('Content-Type', '')
