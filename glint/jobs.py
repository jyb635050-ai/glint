"""下载任务：取源 → ffmpeg 转成目标格式 → 交给浏览器 → 删临时文件。"""
import copy
import glob
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import yt_dlp

from . import config, extract, net
from .errors import Fail, from_ytdlp

VIDEO_FORMATS = ('mp4', 'webm', 'mkv')
AUDIO_FORMATS = ('mp3', 'm4a', 'opus', 'flac', 'wav')
IMAGE_FORMATS = ('jpg', 'png', 'webp')
MIME = {'mp4': 'video/mp4', 'webm': 'video/webm', 'mkv': 'video/x-matroska', 'mp3': 'audio/mpeg', 'm4a': 'audio/mp4',
        'opus': 'audio/ogg', 'flac': 'audio/flac', 'wav': 'audio/wav', 'jpg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp'}

_pool = ThreadPoolExecutor(config.MAX_JOBS)
_jobs, _lock = {}, threading.Lock()


def safe_name(title):
    t = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', title or '')
    t = re.sub(r'\s+', ' ', t).strip().strip('.')
    return t[:80].strip() or 'glint'


class Job:
    def __init__(self, req):
        self.id = uuid.uuid4().hex
        self.req = req
        self.dir = os.path.join(config.TMP, 'j-' + self.id)
        self.state, self.progress, self.error, self.file, self.name = 'running', 0.0, None, None, None
        self.created = time.time()
        self.done = threading.Event()

    def public(self):
        if self.state == 'done':
            return {'state': 'done', 'progress': 1, 'file': f'/api/jobs/{self.id}/file', 'name': self.name}
        if self.state == 'error':
            return {'state': 'error', 'error': self.error}
        return {'state': 'running', 'progress': round(self.progress, 3)}

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        with _lock:
            _jobs.pop(self.id, None)


def validate(req, entry):
    kind, fmt, item = req.get('kind'), req.get('format'), req.get('item') or ''
    allowed = {'video': VIDEO_FORMATS, 'audio': AUDIO_FORMATS, 'image': IMAGE_FORMATS}.get(kind)
    if not allowed:
        raise Fail(400, 'bad_request', 'kind 只能是 video / audio / image')
    if fmt not in allowed:
        raise Fail(400, 'bad_format', f'{kind} 只支持 ' + ' / '.join(allowed))
    m = re.fullmatch(r'([vi])(\d+)', item)
    if not m:
        raise Fail(400, 'bad_request', '没有这个条目')
    pool = entry['videos'] if m.group(1) == 'v' else entry['images']
    idx = int(m.group(2))
    if idx >= len(pool):
        raise Fail(400, 'bad_request', '没有这个条目')
    if m.group(1) == 'i' and kind != 'image':
        raise Fail(400, 'bad_request', '图片只能按图片下载')
    if kind == 'video':
        q = req.get('quality')
        if not str(q or '').isdigit() or int(q) not in extract.video_qualities(pool[idx]):
            raise Fail(400, 'bad_quality', '没有这个清晰度')
    return m.group(1), pool[idx]


def submit(req):
    url = net.extract_url(req.get('url', ''))
    entry = extract.probe(url)
    validate(req, entry)
    job = Job(dict(req, url=url))
    os.makedirs(job.dir)
    with _lock:
        _jobs[job.id] = job
    _pool.submit(_run, job, entry)
    return job


def get(job_id):
    with _lock:
        return _jobs.get(job_id)


def sweep():
    """没人来取的任务 20 分钟后清掉。"""
    now = time.time()
    with _lock:
        old = [j for j in _jobs.values() if now - j.created > 1200]
    for j in old:
        j.cleanup()


def _run(job, entry):
    try:
        kind_src, src = validate(job.req, entry)
        out, name = _make(job, entry, kind_src, src)
        job.file, job.name, job.state, job.progress = out, name, 'done', 1.0
    except Fail as e:
        job.state, job.error = 'error', {'code': e.code, 'message': e.message}
        shutil.rmtree(job.dir, ignore_errors=True)
    except Exception:
        job.state, job.error = 'error', {'code': 'internal', 'message': '处理时出错了，换个清晰度或格式再试'}
        shutil.rmtree(job.dir, ignore_errors=True)
    finally:
        job.done.set()


def _probe_streams(path):
    j = extract.ffprobe_json(path, 60) or {}
    v = next((s for s in j.get('streams', []) if s.get('codec_type') == 'video' and not (s.get('disposition') or {}).get('attached_pic')), None)
    a = next((s for s in j.get('streams', []) if s.get('codec_type') == 'audio'), None)
    dur = float((j.get('format') or {}).get('duration') or 0)
    return v, a, dur


def _ffmpeg(job, args, dur, base, span):
    cmd = ['ffmpeg', '-hide_banner', '-v', 'error', '-y', '-nostdin', '-progress', 'pipe:1', *args]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    for line in p.stdout:
        if line.startswith('out_time_us=') and dur > 0:
            try:
                job.progress = base + span * min(1.0, int(line.split('=')[1]) / 1e6 / dur)
            except ValueError:
                pass
    err = p.stderr.read()
    if p.wait() != 0:
        raise Fail(500, 'internal', '格式转换失败：' + (err.strip().splitlines() or ['未知原因'])[-1][:120])


def _pick_video(info, height, fmt):
    vids = [f for f in extract._video_formats(info) if f['height'] == height]
    pref = {'mp4': ('avc', 'h264'), 'webm': ('vp9', 'vp09', 'av01', 'vp8'), 'mkv': ()}[fmt]
    vids.sort(key=lambda f: (str(f.get('vcodec', '')).lower().startswith(pref) if pref else 0,
                             f.get('acodec') not in (None, 'none'), f.get('tbr') or 0, f.get('fps') or 0), reverse=True)
    return vids[0]


def _pick_audio(info, fmt):
    auds = [f for f in info.get('formats') or [] if f.get('acodec') not in (None, 'none', '') and f.get('vcodec') in ('none',)]
    pref = {'mp4': ('mp4a', 'aac'), 'm4a': ('mp4a', 'aac'), 'webm': ('opus', 'vorbis'), 'opus': ('opus',), 'mp3': ('mp3',)}.get(fmt, ())
    auds.sort(key=lambda f: (str(f.get('acodec', '')).lower().startswith(pref) if pref else 0, f.get('abr') or f.get('tbr') or 0), reverse=True)
    return auds[0] if auds else None


def _fetch_source(job, v, spec):
    """把源文件下到任务目录，返回路径。占进度 0–60%。"""
    if 'direct' in v:
        path = os.path.join(job.dir, 'src.bin')
        net.fetch_to(v['direct']['url'], path, progress=lambda r: setattr(job, 'progress', 0.6 * r), limit=config.MAX_FILESIZE)
        return path

    def hook(d):
        if d.get('status') == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            if total:
                job.progress = min(0.6, 0.6 * d.get('downloaded_bytes', 0) / total)

    params = extract.ydl_params(format=spec, outtmpl=os.path.join(job.dir, 'src.%(ext)s'), merge_output_format='mkv',
                                progress_hooks=[hook], max_filesize=config.MAX_FILESIZE, fixup='never', concurrent_fragment_downloads=4,
                                paths={'temp': job.dir})
    info = copy.deepcopy(v['info'])
    # 解析时 yt-dlp 已按默认规则挑过格式，那份选择结果要清掉，否则它会照旧下载合并
    for k in ('requested_formats', 'requested_downloads', 'requested_subtitles', 'format_id', 'format', 'format_note',
              'url', 'ext', 'protocol', 'vcodec', 'acodec', 'width', 'height', 'fps', 'tbr', 'abr', 'vbr', 'resolution',
              'filesize', 'filesize_approx', 'http_headers', 'manifest_url', 'fragments', '__files_to_merge', '__postprocessors', 'filepath', '_filename'):
        if info.get('formats'):   # 没有 formats 列表时信息本身就是唯一格式，不能删
            info.pop(k, None)
    try:
        with yt_dlp.YoutubeDL(params) as ydl:
            ydl.process_ie_result(info, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise from_ytdlp(str(e))
    srcs = [p for p in glob.glob(os.path.join(job.dir, 'src.*')) if not p.endswith(('.part', '.ytdl'))]
    if not srcs:
        raise Fail(424, 'unavailable', '平台没给文件，稍后再试')
    return max(srcs, key=os.path.getsize)


AUDIO_ENC = {'mp3': (('mp3',), ['-c:a', 'libmp3lame', '-q:a', '2']), 'm4a': (('aac',), ['-c:a', 'aac', '-b:a', '192k']),
             'opus': (('opus',), ['-c:a', 'libopus', '-b:a', '160k']), 'flac': (('flac',), ['-c:a', 'flac']),
             'wav': ((), ['-c:a', 'pcm_s16le'])}
AUDIO_MUX = {'mp3': 'mp3', 'm4a': 'ipod', 'opus': 'ogg', 'flac': 'flac', 'wav': 'wav'}


def _make(job, entry, kind_src, src):
    req, fmt, kind = job.req, job.req['format'], job.req['kind']
    base = safe_name(entry['title'])
    out = os.path.join(job.dir, 'out.' + fmt)
    if kind == 'image':
        if kind_src == 'i':
            url, headers = src['src'], src.get('headers')
            idx = int(req['item'][1:])
            name = f'{base} {idx + 1}.{fmt}' if len(entry['images']) > 1 else f'{base}.{fmt}'
        else:
            url = src['direct'].get('thumbnail') if 'direct' in src else extract.best_thumbnail(src['info'])
            headers = None
            if not url:
                raise Fail(404, 'no_media', '这个视频没有封面')
            name = f'{base} 封面.{fmt}'
        _, data, _ = net.fetch(url, limit=40_000_000, headers=headers)
        raw = os.path.join(job.dir, 'src.img')
        with open(raw, 'wb') as f:
            f.write(data)
        job.progress = 0.5
        v, _, _ = _probe_streams(raw)
        if not v:
            raise Fail(422, 'no_media', '拿到的不是图片')
        same = {'jpg': 'mjpeg', 'png': 'png', 'webp': 'webp'}[fmt] == v.get('codec_name')
        if same:
            os.replace(raw, out)
        else:
            enc = {'jpg': ['-q:v', '2'], 'png': [], 'webp': ['-c:v', 'libwebp', '-quality', '92']}[fmt]
            _ffmpeg(job, ['-i', raw, '-frames:v', '1', *enc, out], 0, 0.5, 0.5)
        return out, name

    if kind == 'audio':
        info = src.get('info') or {}
        a = _pick_audio(info, fmt) if info else None
        spec = a['format_id'] if a else 'bestaudio/best'
        path = _fetch_source(job, src, spec)
        _, astream, dur = _probe_streams(path)
        if not astream:
            raise Fail(422, 'no_media', '这个视频没有声音')
        keep, enc = AUDIO_ENC[fmt]
        codec = ['-c:a', 'copy'] if astream.get('codec_name') in keep else enc
        _ffmpeg(job, ['-i', path, '-map', '0:a:0', '-vn', *codec, '-f', AUDIO_MUX[fmt], out], dur, 0.6, 0.4)
        return out, f'{base}.{fmt}'

    # 视频
    q = int(req['quality'])
    if 'direct' in src:
        spec = None
    else:
        vf = _pick_video(src['info'], q, fmt)
        af = None if vf.get('acodec') not in (None, 'none') else _pick_audio(src['info'], fmt)
        spec = vf['format_id'] + (f"+{af['format_id']}" if af else '')
    path = _fetch_source(job, src, spec)
    v, a, dur = _probe_streams(path)
    if not v:
        raise Fail(422, 'no_media', '拿到的文件里没有画面')
    vc = v.get('codec_name')
    if fmt == 'mp4':
        cv = ['-c:v', 'copy'] if vc == 'h264' else ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
        ca = (['-c:a', 'copy'] if a and a.get('codec_name') == 'aac' else ['-c:a', 'aac', '-b:a', '192k']) if a else []
        tail = ['-movflags', '+faststart', '-f', 'mp4']
    elif fmt == 'webm':
        cv = ['-c:v', 'copy'] if vc in ('vp9', 'av1', 'vp8') else ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
                                                                    '-row-mt', '1', '-b:v', '0', '-crf', '32', '-pix_fmt', 'yuv420p']
        ca = (['-c:a', 'copy'] if a and a.get('codec_name') in ('opus', 'vorbis') else ['-c:a', 'libopus', '-b:a', '160k']) if a else []
        tail = ['-f', 'webm']
    else:
        cv, ca, tail = ['-c:v', 'copy'], (['-c:a', 'copy'] if a else []), ['-f', 'matroska']
    maps = ['-map', '0:v:0'] + (['-map', '0:a:0'] if a else [])
    _ffmpeg(job, ['-i', path, *maps, *cv, *ca, *tail, out], dur, 0.6, 0.4)
    return out, f'{base} [{q}p].{fmt}'
