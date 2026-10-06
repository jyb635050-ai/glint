"""HTTP 接口（契约见 tools/SPEC.md）。"""
import hashlib
import hmac
import os
import threading
import time
import urllib.parse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask

from . import config, extract, jobs, net
from .errors import Fail

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static')
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_fails, _flock = {}, threading.Lock()


def token():
    return hmac.new(config.ACCESS_CODE.encode(), b'glint-session-v1', hashlib.sha256).hexdigest()


def client_ip(req: Request):
    if config.TRUST_PROXY and req.headers.get('x-forwarded-for'):
        return req.headers['x-forwarded-for'].split(',')[0].strip()
    return req.client.host if req.client else '?'


def authed(req: Request):
    return not config.ACCESS_CODE or hmac.compare_digest(req.cookies.get('glint', ''), token())


@app.exception_handler(Fail)
async def _fail(_, e: Fail):
    return JSONResponse({'error': {'code': e.code, 'message': e.message}}, status_code=e.status)


@app.exception_handler(Exception)
async def _boom(_, e: Exception):
    return JSONResponse({'error': {'code': 'internal', 'message': '服务器出错了，请稍后再试'}}, status_code=500)


@app.middleware('http')
async def gate(request: Request, call_next):
    p = request.url.path
    if p.startswith('/api/') and p not in ('/api/health', '/api/login') and not authed(request):
        return JSONResponse({'error': {'code': 'auth_required', 'message': '请先输入访问口令'}}, status_code=401)
    try:
        resp = await call_next(request)
    except Fail as e:
        return JSONResponse({'error': {'code': e.code, 'message': e.message}}, status_code=e.status)
    if not p.startswith('/api/'):
        resp.headers.setdefault('Cache-Control', 'no-cache')
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('Referrer-Policy', 'no-referrer')
    return resp


async def body_json(req: Request):
    raw = await req.body()
    if len(raw) > 20000:
        raise Fail(413, 'too_large', '内容太长')
    try:
        import json
        data = json.loads(raw or b'{}')
        return data if isinstance(data, dict) else {}
    except ValueError:
        raise Fail(400, 'bad_request', '请求格式不对')


@app.get('/api/health')
def health():
    return {'ok': True}


@app.post('/api/login')
async def login(req: Request):
    ip, now = client_ip(req), time.time()
    with _flock:
        hist = [t for t in _fails.get(ip, []) if now - t < 60]
        _fails[ip] = hist
        if len(hist) >= 5:
            raise Fail(429, 'rate_limited', '口令错太多次了，请一分钟后再试')
    data = await body_json(req)
    code = str(data.get('code', ''))
    if config.ACCESS_CODE and hmac.compare_digest(code.encode(), config.ACCESS_CODE.encode()):
        r = JSONResponse({'ok': True})
        r.set_cookie('glint', token(), max_age=60 * 60 * 24 * 90, httponly=True, samesite='lax',
                     secure=req.url.scheme == 'https' or req.headers.get('x-forwarded-proto') == 'https')
        return r
    with _flock:
        _fails.setdefault(ip, []).append(now)
    raise Fail(401, 'bad_code', '口令不对')


@app.get('/api/me')
def me():
    return {'ok': True, 'locked': bool(config.ACCESS_CODE)}


@app.post('/api/probe')
async def probe(req: Request):
    data = await body_json(req)
    url = net.extract_url(str(data.get('url', '')))
    from starlette.concurrency import run_in_threadpool
    entry = await run_in_threadpool(extract.probe, url)
    return {'title': entry['title'], 'platform': entry['platform'], 'items': extract.items_of(entry)}


def _file_response(job):
    q = urllib.parse.quote(job.name)
    ascii_name = job.name.encode('ascii', 'ignore').decode().replace('"', '').strip() or 'glint'
    ext = job.name.rsplit('.', 1)[-1]
    headers = {'Content-Disposition': f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{q}', 'Cache-Control': 'no-store'}
    return FileResponse(job.file, media_type=jobs.MIME.get(ext, 'application/octet-stream'), headers=headers,
                        background=BackgroundTask(job.cleanup))


def _start(params):
    from starlette.concurrency import run_in_threadpool
    return run_in_threadpool(jobs.submit, params)


@app.get('/api/download')
async def download(req: Request):
    job = await _start(dict(req.query_params))
    from starlette.concurrency import run_in_threadpool
    await run_in_threadpool(job.done.wait, 20)
    if job.state == 'done':
        return _file_response(job)
    if job.state == 'error':
        job.cleanup()
        raise Fail(422 if job.error['code'] in ('no_media', 'bad_format', 'bad_quality') else 424, job.error['code'], job.error['message'])
    return JSONResponse({'job': job.id, 'poll': f'/api/jobs/{job.id}'}, status_code=202)


@app.post('/api/jobs')
async def new_job(req: Request):
    job = await _start(await body_json(req))
    return JSONResponse({'job': job.id, 'poll': f'/api/jobs/{job.id}'}, status_code=202)


@app.get('/api/jobs/{job_id}')
def job_state(job_id: str):
    jobs.sweep()
    job = jobs.get(job_id)
    if not job:
        raise Fail(404, 'not_found', '任务不存在或已过期')
    st = job.public()
    if job.state == 'error':
        job.cleanup()
    return st


@app.get('/api/jobs/{job_id}/file')
def job_file(job_id: str):
    job = jobs.get(job_id)
    if not job or job.state != 'done':
        raise Fail(404, 'not_found', '文件不存在或已经下载过了')
    return _file_response(job)


@app.get('/api/thumb')
def thumb(u: str = ''):
    if not u.startswith(('http://', 'https://')):
        raise Fail(400, 'bad_url', '缩略图地址不对')
    headers = {'Referer': 'https://www.tiktok.com/'} if 'tiktok' in u else None
    _, data, ctype = net.fetch(u, limit=15_000_000, headers=headers)
    if not ctype.startswith('image/'):
        ctype = 'image/jpeg'
    return Response(data, media_type=ctype, headers={'Cache-Control': 'private, max-age=3600'})


@app.get('/{path:path}')
def static(path: str):
    if path.startswith('api/'):
        raise Fail(404, 'not_found', '没有这个接口')
    f = os.path.normpath(os.path.join(STATIC, path or 'index.html'))
    if not f.startswith(STATIC) or not os.path.isfile(f):
        f = os.path.join(STATIC, 'index.html')
    return FileResponse(f)
