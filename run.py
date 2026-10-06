"""拾光 Glint 启动入口：python run.py --port 8787 [--lan]"""
import argparse
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


def main():
    ap = argparse.ArgumentParser(description='拾光 Glint 媒体下载站')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT') or 8787))
    ap.add_argument('--lan', action='store_true', help='对局域网开放（手机访问），必须有口令')
    ap.add_argument('--host', default=None, help='监听地址（云端用 0.0.0.0，同样必须有口令）')
    ap.add_argument('--open', action='store_true', help='启动后自动打开浏览器')
    ap.add_argument('--tips', action='store_true', help='打印使用提示（启动脚本用）')
    a = ap.parse_args()
    host = a.host or ('0.0.0.0' if a.lan else '127.0.0.1')
    if host not in ('127.0.0.1', 'localhost') and not os.environ.get('ACCESS_CODE'):
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
    if a.open:
        import threading
        import webbrowser
        threading.Timer(1.5, webbrowser.open, [f'http://127.0.0.1:{a.port}']).start()
    uvicorn.run(app, host=host, port=a.port, log_level='warning', proxy_headers=config.TRUST_PROXY,
                forwarded_allow_ips='*' if config.TRUST_PROXY else None, timeout_keep_alive=30)


if __name__ == '__main__':
    main()
