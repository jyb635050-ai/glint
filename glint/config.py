import os
import shutil
import tempfile

ALLOW_PRIVATE = os.environ.get('GLINT_ALLOW_PRIVATE') == '1'
TMP = os.path.abspath(os.environ.get('GLINT_TMP') or os.path.join(tempfile.gettempdir(), 'glint'))
ACCESS_CODE = os.environ.get('ACCESS_CODE') or ''
TRUST_PROXY = os.environ.get('GLINT_TRUST_PROXY') == '1'   # 云端在反向代理后面时取 X-Forwarded-For
MAX_JOBS = int(os.environ.get('GLINT_MAX_JOBS') or 2)
MAX_FILESIZE = int(os.environ.get('GLINT_MAX_BYTES') or 4_000_000_000)


def js_runtimes():
    """YouTube 需要 JS 运行时；有哪个用哪个。"""
    rt = {}
    for name in ('deno', 'node', 'bun'):
        path = shutil.which(name)
        if path:
            rt[name] = {'path': path}
    return rt or None
