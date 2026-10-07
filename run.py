"""拾光 Glint 启动入口：python run.py --port 8787 [--lan]"""
import argparse
import atexit
import re
import shutil
import subprocess
import threading
import urllib.parse
import os
import secrets
import socket
import sys


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


PAGES = 'https://jyb635050-ai.github.io/glint/'


def find_cloudflared():
    p = shutil.which('cloudflared')
    if p:
        return p
    for c in (r'C:\Program Files (x86)\cloudflared\cloudflared.exe', r'C:\Program Files\cloudflared\cloudflared.exe',
              os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe')):
        if os.path.exists(c):
            return c
    return None


def start_tunnel(port, code):
    """开一条 Cloudflare 免费隧道，拿到外网网址后打印「一点就进」的链接和二维码。"""
    exe = find_cloudflared()
    if not exe:
        print('—— 没找到 cloudflared，外网访问没开。安装：winget install Cloudflare.cloudflared（Mac：brew install cloudflared）', flush=True)
        return
    proc = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', '--url', f'http://127.0.0.1:{port}'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    atexit.register(proc.terminate)

    def watch():
        for line in proc.stderr:
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if m:
                link = PAGES + '#' + urllib.parse.urlencode({'api': m.group(0), 'code': code})
                print()
                print('外网已打通（手机在外面也能用）。打开或扫码这个链接，会自动连上并登录：', flush=True)
                print(link, flush=True)
                try:
                    import qrcode
                    q = qrcode.QRCode(border=1)
                    q.add_data(link)
                    q.print_ascii(invert=True)
                except Exception:
                    pass
                print('（每次启动外网地址都会变，换了就重新打开新链接）', flush=True)
                print()
                break
        for _ in proc.stderr:   # 继续读完，免得管道堵住
            pass

    threading.Thread(target=watch, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description='拾光 Glint 媒体下载站')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT') or 8787))
    ap.add_argument('--lan', action='store_true', help='对局域网开放（手机访问），必须有口令')
    ap.add_argument('--host', default=None, help='监听地址（云端用 0.0.0.0，同样必须有口令）')
    ap.add_argument('--open', action='store_true', help='启动后自动打开浏览器')
    ap.add_argument('--tunnel', action='store_true', help='开 Cloudflare 免费隧道，让 GitHub Pages 上的网页和外网手机能用（必须有口令）')
    ap.add_argument('--tips', action='store_true', help='打印使用提示（启动脚本用）')
    a = ap.parse_args()
    host = a.host or ('0.0.0.0' if a.lan else '127.0.0.1')
    if a.tunnel:
        os.environ['GLINT_TRUST_PROXY'] = '1'   # 经隧道来的请求，真实 IP 在 CF-Connecting-IP 里
    if (a.tunnel or host not in ('127.0.0.1', 'localhost')) and not os.environ.get('ACCESS_CODE'):
        if a.host:
            print('对外开放必须先设置环境变量 ACCESS_CODE（访问口令）', file=sys.stderr)
            sys.exit(2)
        # --lan 没给口令：用上次生成的（存在 secrets/，不进仓库），没有就现场生成一个
        f = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'secrets', 'access-code.txt')
        code = open(f, encoding='utf-8').read().strip() if os.path.exists(f) else ''
        if not code:
            code = f'{secrets.randbelow(10**6):06d}'
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, 'w', encoding='utf-8') as fh:
                fh.write(code)
        os.environ['ACCESS_CODE'] = code

    from glint import config
    os.makedirs(config.TMP, exist_ok=True)
    import uvicorn
    from glint.app import app

    print(f'拾光 Glint 已启动  电脑打开：http://127.0.0.1:{a.port}', flush=True)
    if host == '0.0.0.0':
        ip = lan_ip()
        if ip:
            print(f'手机连同一个 Wi-Fi 打开：http://{ip}:{a.port}', flush=True)
        print(f'访问口令：{config.ACCESS_CODE}', flush=True)
    if a.tips:
        print('—— 手机连同一个 Wi-Fi，打开上面的「手机网址」，输入口令即可。', flush=True)
        print('—— 第一次运行 Windows 可能弹出防火墙提示，请点「允许」。关掉这个窗口就停止。', flush=True)
    if a.tunnel:
        start_tunnel(a.port, config.ACCESS_CODE)
    if a.open:
        import threading
        import webbrowser
        threading.Timer(1.5, webbrowser.open, [f'http://127.0.0.1:{a.port}']).start()
    uvicorn.run(app, host=host, port=a.port, log_level='warning', proxy_headers=config.TRUST_PROXY,
                forwarded_allow_ips='*' if config.TRUST_PROXY else None, timeout_keep_alive=30)


if __name__ == '__main__':
    main()
