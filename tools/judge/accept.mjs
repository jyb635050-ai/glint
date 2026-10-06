#!/usr/bin/env node
// 拾光 Glint 判卷 —— 冻结文件，执行者不得修改。契约见 tools/SPEC.md，用法见其第 4 节。
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k) => argv.includes(k);
const ROOT = path.resolve(opt('--project') || path.join(HERE, '..', '..'));
const REMOTE = opt('--url')?.replace(/\/+$/, '');
const CODE = opt('--code');
const PROVE = flag('--prove');
const ONLY = opt('--only')?.split(',').map((s) => s.trim());
const LIVE = flag('--live') || !!ONLY?.includes('live');
const want = (g) => (g === 'live' ? LIVE : !ONLY || ONLY.includes(g));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CJK = /[\u4e00-\u9fff]/;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-judge-'));
const tmp = (name) => path.join(WORK, 'out', name);
fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });

// ---------- 记分 ----------
const results = [];
class Limit extends Error {}
class NA extends Error {}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
async function attempt(fn, ms) {
  let timer;
  try {
    const note = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超时 ${ms / 1000}s`)), ms); })]);
    return { status: 'pass', note: typeof note === 'string' ? note : '' };
  } catch (e) {
    const status = e instanceof Limit ? 'limit' : e instanceof NA ? 'na' : 'fail';
    return { status, note: String(e?.message || e).split('\n')[0].slice(0, 300) };
  } finally { clearTimeout(timer); }
}
async function check(id, name, fn, ms = 240000) {
  const r = await attempt(fn, ms);
  results.push({ id, name, ...r });
  const icon = { pass: '✅', fail: '❌', limit: '🟡', na: '⚪' }[r.status];
  console.log(`${icon} ${id} ${name}${r.note ? ' — ' + r.note : ''}`);
  return r.status === 'pass';
}

// ---------- 进程与清理 ----------
const procs = [];
const servers = [];
let browser = null;
async function cleanup() {
  for (const c of procs) kill(c);
  for (const s of servers) try { s.close(); } catch {}
  try { await browser?.close(); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}
function kill(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}
setTimeout(() => { console.log('❌ 判卷总时长超过 45 分钟，强制结束'); cleanup().finally(() => process.exit(1)); }, 45 * 60 * 1000).unref();

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: o.enc === 'buffer' ? 'buffer' : 'utf8', maxBuffer: 1 << 28, timeout: o.timeout ?? 120000, cwd: o.cwd, env: o.env });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
function pyCmd() {
  if (process.env.GLINT_PY) return process.env.GLINT_PY;
  for (const p of ['.venv/Scripts/python.exe', '.venv/bin/python']) if (fs.existsSync(path.join(ROOT, p))) return path.join(ROOT, p);
  return process.platform === 'win32' ? 'python' : 'python3';
}
function appEnv(extra) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  for (const k of ['ACCESS_CODE', 'GLINT_TMP', 'GLINT_ALLOW_PRIVATE']) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}
async function startApp({ port, env = {}, lan = false, wait = true }) {
  must(fs.existsSync(path.join(ROOT, 'run.py')), `仓库根目录没有 run.py（${ROOT}）`);
  const child = spawn(pyCmd(), ['run.py', '--port', String(port), ...(lan ? ['--lan'] : [])], { cwd: ROOT, env: appEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.log = () => log;
  child.on('error', (e) => { log += String(e); });
  procs.push(child);
  if (!wait) return child;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (child.exitCode !== null) throw new Error(`run.py 退出了（码 ${child.exitCode}）：${log.slice(-300)}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.status === 200) return child; } catch {}
    await sleep(400);
  }
  throw new Error('60 秒内 /api/health 没有返回 200：' + log.slice(-300));
}

// ---------- 媒体检验 ----------
function ffprobe(f) {
  const r = sh('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f]);
  if (r.status !== 0) throw new Error('ffprobe 读不了这个文件：' + String(r.stderr || r.error || '').trim().slice(0, 160));
  return JSON.parse(r.stdout);
}
function avgColor(f, isImage) {
  const r = sh('ffmpeg', ['-v', 'error', ...(isImage ? [] : ['-ss', '2']), '-i', f, '-frames:v', '1', '-vf', 'crop=iw/4:ih/4:iw*3/4:ih*3/4,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { enc: 'buffer' });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) throw new Error('取不到画面颜色');
  return [...r.stdout.subarray(0, 3)];
}
function meanVolume(f) {
  const r = sh('ffmpeg', ['-v', 'info', '-i', f, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || '');
  return m ? (m[1] === '-inf' ? -999 : parseFloat(m[1])) : -999;
}
function packetEnd(f, sel) {
  const r = sh('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', f], { timeout: 180000 });
  let m = 0;
  for (const line of String(r.stdout || '').split(/\r?\n/)) { const [a, b] = line.split(','); const pt = parseFloat(a); if (!isNaN(pt)) m = Math.max(m, pt + (parseFloat(b) || 0)); }
  return m;
}
const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const near = (c, e, tol = 45) => c.every((v, i) => Math.abs(v - e[i]) <= tol);
function docType(f) { const b = Buffer.alloc(80); const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, 80, 0); fs.closeSync(fd); return b.toString('latin1'); }
const isPic = (s) => s.disposition?.attached_pic === 1;
function verifyVideo(f, { format, height, color, dur, live }) {
  const p = ffprobe(f);
  const v = p.streams.find((s) => s.codec_type === 'video' && !isPic(s));
  const a = p.streams.find((s) => s.codec_type === 'audio');
  must(v, '没有视频画面');
  must(a, '没有音轨');
  const fn = p.format.format_name || '';
  if (format === 'mp4') {
    must(/mp4/.test(fn), `容器不是 MP4（${fn}）`);
    must(!/^qt/.test(p.format.tags?.major_brand || ''), 'MOV 冒充 MP4');
    must(v.codec_name === 'h264', `MP4 视频应为 H.264，实际 ${v.codec_name}`);
    must(a.codec_name === 'aac', `MP4 音频应为 AAC，实际 ${a.codec_name}`);
  } else if (format === 'webm') {
    must(docType(f).includes('webm'), 'WebM 文件头不对（可能是 MKV 改了个名）');
    must(['vp9', 'av1', 'vp8'].includes(v.codec_name), `WebM 视频应为 VP9/AV1，实际 ${v.codec_name}`);
    must(['opus', 'vorbis'].includes(a.codec_name), `WebM 音频应为 Opus/Vorbis，实际 ${a.codec_name}`);
  } else if (format === 'mkv') {
    must(docType(f).includes('matroska'), `容器不是 MKV（${fn}）`);
  }
  if (height) must(live ? Math.abs(v.height - height) <= 8 : v.height === height, `画面高度应为 ${height}，实际 ${v.height}`);
  const cd = parseFloat(p.format.duration || v.duration || '0');
  const d = Math.min(packetEnd(f, 'v:0'), packetEnd(f, 'a:0'));
  if (dur) must(Math.abs(d - dur) <= 0.6, `实际能播的时长应约 ${dur} 秒，实际 ${d.toFixed(2)} 秒（文件可能不完整）`);
  else must(d > 1 && d >= cd - 1.5, `文件不完整：标称 ${cd} 秒，实际只能播 ${d.toFixed(1)} 秒`);
  if (color) { const c = avgColor(f); must(near(c, color), `画面颜色 ${c} 对不上——不是所选清晰度的原始画面`); }
  const mv = meanVolume(f);
  must(mv > (live ? -70 : -45), `音轨是静音（${mv} dB）`);
  return `${v.codec_name}/${a.codec_name} ${v.width}×${v.height} ${d.toFixed(1)}s`;
}
const AUDIO = {
  mp3: (p, a) => a.codec_name === 'mp3',
  m4a: (p, a) => a.codec_name === 'aac' && /mp4/.test(p.format.format_name),
  opus: (p, a) => a.codec_name === 'opus',
  flac: (p, a) => a.codec_name === 'flac',
  wav: (p, a) => /^pcm_/.test(a.codec_name) && /wav/.test(p.format.format_name),
};
function verifyAudio(f, { format, dur, live }) {
  const p = ffprobe(f);
  const a = p.streams.find((s) => s.codec_type === 'audio');
  must(a, '没有音轨');
  must(!p.streams.some((s) => s.codec_type === 'video' && !isPic(s)), '音频文件里混着视频画面');
  must(AUDIO[format](p, a), `${format} 不对：容器 ${p.format.format_name}、编码 ${a.codec_name}`);
  const cd = parseFloat(p.format.duration || a.duration || '0');
  const d = packetEnd(f, 'a:0');
  if (dur) must(Math.abs(d - dur) <= 0.6, `${format} 实际能播的时长应约 ${dur} 秒，实际 ${d.toFixed(2)} 秒（文件可能不完整）`);
  else must(d > 1 && d >= cd - 1.5, `${format} 文件不完整：标称 ${cd} 秒，实际只能播 ${d.toFixed(1)} 秒`);
  const mv = meanVolume(f);
  must(mv > (live ? -70 : -45), `${format} 是静音（${mv} dB）`);
  return `${format}:${a.codec_name}`;
}
const IMG = { jpg: 'mjpeg', png: 'png', webp: 'webp' };
function verifyImage(f, { format, w, h, color, minW }) {
  const p = ffprobe(f);
  const v = p.streams.find((s) => s.codec_type === 'video');
  must(v, '不是图片');
  must(v.codec_name === IMG[format], `应为 ${format}，实际 ${v.codec_name}`);
  if (w) must(v.width === w && v.height === h, `尺寸应为 ${w}×${h}，实际 ${v.width}×${v.height}`);
  if (minW) must(v.width >= minW, `图片太小：${v.width}×${v.height}`);
  if (color) { const c = avgColor(f, true); must(near(c, color), `图片内容不对（颜色 ${c}）`); }
  return `${v.width}×${v.height}`;
}
function checkName(name, ext, needTitle = true) {
  must(name, '没给文件名');
  if (needTitle) must(name.includes('测试'), `文件名没带标题（或中文乱码）：${name}`);
  must(!/[\\/:*?"<>|]/.test(name), `文件名含非法字符：${name}`);
  must(name.toLowerCase().endsWith('.' + ext), `扩展名应为 .${ext}：${name}`);
}

// ---------- 接口调用 ----------
function cdName(cd) {
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) { try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch {} }
  m = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  return m ? m[1].trim() : '';
}
const mkctx = (base, cookie = '') => ({ base, cookie, h() { return this.cookie ? { cookie: this.cookie } : {}; } });
const absu = (ctx, u) => (/^https?:/.test(u) ? u : ctx.base + u);
async function apiProbe(ctx, text) {
  const res = await fetch(`${ctx.base}/api/probe`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...ctx.h() }, body: JSON.stringify({ url: text }), signal: AbortSignal.timeout(150000) });
  const body = await res.text();
  let json = null; try { json = JSON.parse(body); } catch {}
  return { status: res.status, body, json };
}
async function apiDownload(ctx, params, out) {
  let res = await fetch(`${ctx.base}/api/download?${new URLSearchParams(params)}`, { headers: ctx.h() });
  if (res.status === 202) {
    const j = await res.json();
    must(typeof j.poll === 'string' && j.poll.startsWith('/'), '202 没给同源 poll 路径');
    const t0 = Date.now();
    for (;;) {
      await sleep(500);
      const s = await (await fetch(absu(ctx, j.poll), { headers: ctx.h() })).json();
      if (s.state === 'done') { must(String(s.file).startsWith('/'), 'done 的 file 不是同源路径'); res = await fetch(absu(ctx, s.file), { headers: ctx.h() }); break; }
      if (s.state === 'error') throw new Error(`任务失败：${JSON.stringify(s.error).slice(0, 200)}`);
      must(Date.now() - t0 < 240000, '任务 4 分钟没完成');
    }
  }
  if (res.status !== 200) throw new Error(`下载 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const cd = res.headers.get('content-disposition') || '';
  must(/attachment/i.test(cd), '下载响应没有 Content-Disposition: attachment');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out));
  return { name: cdName(cd), file: out };
}
async function login(base, code) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const sc = r.headers.getSetCookie?.() || [];
  return { status: r.status, cookie: sc.map((c) => c.split(';')[0]).join('; ') };
}
const errOf = (pr) => pr.json?.error || {};
function mustUserError(pr, what) {
  must(pr.status >= 400 && pr.status < 500, `${what} 应返回 4xx，实际 ${pr.status}`);
  must(!/Traceback/.test(pr.body), `${what} 的响应里有 Python 报错堆栈`);
  must(typeof errOf(pr).code === 'string' && errOf(pr).code, `${what} 没有 error.code`);
  must(CJK.test(errOf(pr).message || ''), `${what} 的 error.message 不是中文人话`);
}

// ---------- 假视频站（判卷现场生成） ----------
const C = { r360: hex(0xc03030), g720: hex(0x30a040), b1080: hex(0x3050c0), cover: hex(0xe0a020), a: hex(0xe040a0), b: hex(0x20b0b0), c: hex(0x7040c0), gv: hex(0x80c020) };
const GALLERY = { '1600×2000': C.a, '1080×1080': C.b, '800×600': C.c };
function makeFixtures(dir) {
  const ff = (args, cwd = dir) => { const r = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, timeout: 300000 }); if (r.status !== 0) throw new Error('ffmpeg 造题失败（ffmpeg 需带 libx264/libvpx/libwebp）：' + String(r.stderr || r.error).slice(0, 300)); };
  for (const d of ['media/clip1', 'media/g', 'media/x', 'watch', 'post', 'blank']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const solid = (c, w, h) => `color=c=0x${c}:s=${w}x${h},drawbox=x=0:y=0:w=iw/8:h=ih/8:color=white:t=fill`;
  const moving = (c, w, h, d) => `color=c=0x${c}:s=${w}x${h}:r=30:d=${d}[b];testsrc2=s=${w / 4}x${h / 4}:r=30:d=${d}[t];[b][t]overlay=${w / 40}:${w / 40}`;
  ff(['-f', 'lavfi', '-i', moving('C03030', 640, 360, 6), '-f', 'lavfi', '-i', moving('30A040', 1280, 720, 6), '-f', 'lavfi', '-i', moving('3050C0', 1920, 1080, 6), '-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=48000',
    '-map', '0:v', '-map', '1:v', '-map', '2:v', '-map', '3:a', '-c:v:0', 'libx264', '-b:v:0', '400k', '-c:v:1', 'libx264', '-b:v:1', '1200k', '-c:v:2', 'libvpx-vp9', '-b:v:2', '1500k', '-deadline', 'realtime', '-cpu-used', '8',
    '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-c:a', 'aac', '-b:a', '128k', '-adaptation_sets', 'id=0,streams=0,1 id=1,streams=2 id=2,streams=3', '-dash_segment_type', 'auto', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0', '-f', 'dash', 'manifest.mpd'], path.join(dir, 'media/clip1'));
  ff(['-f', 'lavfi', '-i', solid('E0A020', 1280, 720), '-frames:v', '1', 'media/clip1/thumb.jpg']);
  ff(['-f', 'lavfi', '-i', solid('E040A0', 1600, 2000), '-frames:v', '1', 'media/g/a-1600.jpg']);
  ff(['-f', 'lavfi', '-i', solid('E040A0', 400, 500), '-frames:v', '1', 'media/g/a-400.jpg']);
  ff(['-f', 'lavfi', '-i', solid('20B0B0', 1080, 1080), '-frames:v', '1', 'media/g/b.png']);
  ff(['-f', 'lavfi', '-i', solid('7040C0', 800, 600), '-frames:v', '1', '-c:v', 'libwebp', 'media/g/c.webp']);
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=1x1', '-frames:v', '1', 'media/g/pixel.gif']);
  ff(['-f', 'lavfi', '-i', 'color=c=0x334455:s=32x32', '-frames:v', '1', 'media/g/icon.png']);
  ff(['-f', 'lavfi', '-i', moving('80C020', 1280, 720, 4), '-f', 'lavfi', '-i', 'sine=f=660:d=4:sample_rate=44100', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', 'media/g/v720.mp4']);
  // 反向验证用的坏文件
  ff(['-f', 'lavfi', '-i', moving('C03030', 1280, 720, 6), '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'media/x/red720.mp4']);
  ff(['-f', 'lavfi', '-i', moving('30A040', 1280, 720, 6), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'media/x/mute720.mp4']);
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '6', '-c:a', 'libmp3lame', 'media/x/silent.mp3']);
  ff(['-f', 'lavfi', '-i', moving('3050C0', 320, 180, 6), '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', '-f', 'matroska', 'media/x/fake.webm']);
  const page = (title, og, body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title><meta property="og:title" content="${title}">${og ? `<meta property="og:image" content="${og}">` : ''}<link rel="icon" href="/media/g/icon.png"></head><body>${body}</body></html>`;
  fs.writeFileSync(path.join(dir, 'watch/clip1.html'), page('测试视频 #1 / Test: clip?', '/media/clip1/thumb.jpg', '<h1>测试视频</h1><video controls poster="/media/clip1/thumb.jpg"><source src="/media/clip1/manifest.mpd" type="application/dash+xml"></video>'));
  fs.writeFileSync(path.join(dir, 'post/gallery1.html'), page('测试图集 · 三图一视频', '/media/g/a-1600.jpg', '<img src="/media/g/icon.png" width="32" height="32" alt="logo"><article><img src="/media/g/a-400.jpg" srcset="/media/g/a-400.jpg 400w, /media/g/a-1600.jpg 1600w" sizes="400px" alt="1"><img src="/media/g/b.png" alt="2"><picture><source srcset="/media/g/c.webp" type="image/webp"><img src="/media/g/c.webp" alt="3"></picture><video controls src="/media/g/v720.mp4"></video></article><img src="/media/g/pixel.gif" width="1" height="1" alt="">'));
  fs.writeFileSync(path.join(dir, 'blank/nomedia.html'), page('没有媒体的页面', null, '<p>这里只有文字，没有图片也没有视频。</p>'));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment', '.webm': 'video/webm', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg' };
function listen(srv) { return new Promise((ok) => srv.listen(0, '127.0.0.1', () => { servers.push(srv); ok(srv.address().port); })); }
function fixtureServer(dir) {
  return listen(http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<h1>404 页面不存在</h1>'); }
    const size = fs.statSync(p).size;
    const type = MIME[path.extname(p)] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const s = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-length': e - s + 1, 'content-range': `bytes ${s}-${e}/${size}`, 'accept-ranges': 'bytes' });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(p, { start: s, end: e }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(p).pipe(res);
  }));
}

// ---------- 浏览器工具 ----------
async function diffFrac(a, b) {
  const p = await browser.newPage();
  try {
    return await p.evaluate(async ([a, b]) => {
      const load = (s) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = 'data:image/png;base64,' + s; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const c = new OffscreenCanvas(ia.width, ia.height); const g = c.getContext('2d');
      g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, ia.width, ia.height).data;
      g.clearRect(0, 0, ia.width, ia.height); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, ia.width, ia.height).data;
      let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
      return n / (ia.width * ia.height);
    }, [a.toString('base64'), b.toString('base64')]);
  } finally { await p.close(); }
}
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
async function newCtx(base, o = {}) {
  const { cookie, ...rest } = o;
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 }, ...rest });
  ctx.thirdParty = []; ctx.errors = [];
  const origin = new URL(base).origin;
  ctx.on('request', (r) => { const u = r.url(); if (!/^(data|blob|about):/.test(u) && new URL(u).origin !== origin) ctx.thirdParty.push(u); });
  ctx.on('page', (pg) => {
    pg.on('pageerror', (e) => ctx.errors.push('页面异常：' + e.message));
    pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) ctx.errors.push('控制台报错：' + m.text()); });
  });
  if (cookie) {
    const [k, ...v] = cookie.split(';')[0].split('=');
    await ctx.addCookies([{ name: k.trim(), value: v.join('='), url: base }]);
  }
  return ctx;
}
async function vis(page, sel, ms = 15000) { await page.locator(sel).first().waitFor({ state: 'visible', timeout: ms }); return page.locator(sel).first(); }
async function submit(page, text, tap) {
  const u = await vis(page, '[data-t=url]');
  await u.fill(text);
  if (tap) await (await vis(page, '[data-t=go]')).tap(); else await u.press('Enter');
}
async function waitTitle(page, word) {
  await vis(page, '[data-t=result]', 60000);
  await page.waitForFunction((w) => (document.querySelector('[data-t=result] [data-t=title]')?.textContent || '').includes(w), word, { timeout: 60000 });
}
async function choose(item, sel, tap) { const l = item.locator(sel).first(); await l.waitFor({ state: 'visible', timeout: 10000 }); if (tap) await l.tap(); else await l.click(); }
async function uiDownload(page, item, { kind, quality, format, tap }, out) {
  if (await item.locator(`[data-kind="${kind}"]`).count()) await choose(item, `[data-kind="${kind}"]`, tap);
  if (quality) await choose(item, `[data-quality="${quality}"]`, tap);
  await choose(item, `[data-format="${format}"]`, tap);
  const btn = item.locator('[data-t=download]').first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), tap ? btn.tap() : btn.click()]);
  await dl.saveAs(out);
  const fail = await dl.failure();
  must(!fail, '浏览器下载失败：' + fail);
  return { name: dl.suggestedFilename(), file: out };
}
async function glassCheck(page) {
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-t=panel]'); if (!el) return { err: '找不到 [data-t=panel]' };
    const cs = getComputedStyle(el); const bf = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter || '';
    return { bf, bg: cs.backgroundColor };
  });
  must(!r.err, r.err);
  const m = /blur\(\s*([\d.]+)px/.exec(r.bf || '');
  must(m && parseFloat(m[1]) >= 12, `玻璃面板没有 ≥12px 的背景模糊（backdrop-filter: ${r.bf || 'none'}）`);
  const pa = (s) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));
  const slash = /\/\s*([\d.]+%?)\s*\)\s*$/.exec(r.bg), rgba = /^rgba\(([^)]+)\)/.exec(r.bg);
  const alpha = r.bg === 'transparent' ? 0 : slash ? pa(slash[1]) : rgba ? pa(rgba[1].split(',')[3]?.trim() || '1') : 1;
  must(alpha <= 0.75, `玻璃面板背景不透明度 ${alpha}，太实了`);
  return `${r.bf} / ${r.bg}`;
}
async function motionCheck(base, reduce, cookie) {
  const ctx = await newCtx(base, { reducedMotion: reduce ? 'reduce' : 'no-preference', cookie });
  try {
    const p = await ctx.newPage(); await p.goto(base); await sleep(2500);
    await p.evaluate(() => document.activeElement?.blur?.()); await p.mouse.move(0, 0); await sleep(300);
    const a = await p.screenshot(); await sleep(1500); const b = await p.screenshot();
    const d = await diffFrac(a, b);
    if (reduce) must(d <= 0.0005, `开了「减少动态效果」画面还在动（变化 ${(d * 100).toFixed(3)}%）`);
    else must(d >= 0.003, `背景没有在流动（1.5 秒画面变化 ${(d * 100).toFixed(3)}%）`);
    return `变化 ${(d * 100).toFixed(2)}%`;
  } finally { await ctx.close(); }
}
async function noOverflow(p, where) {
  const w = p.viewportSize().width;
  const sw = await p.evaluate(() => Math.max(document.scrollingElement.scrollWidth, document.documentElement.scrollWidth, document.body?.scrollWidth || 0));
  must(sw <= w + 1, `${where}出现横向滚动（内容宽 ${sw} > 屏宽 ${w}）`);
}

// ---------- 各组题 ----------
const T = {};
T.A2 = async (ctx, fx, url) => {
  const pr = await apiProbe(ctx, url); const v = pr.json?.items?.find((i) => i.kind === 'video'); must(v, '解析不到视频');
  const d = await apiDownload(ctx, { url, item: v.id, kind: 'video', quality: 720, format: 'mp4' }, tmp('a2.mp4'));
  checkName(d.name, 'mp4');
  return verifyVideo(d.file, { format: 'mp4', height: 720, color: C.g720, dur: 6 });
};
T.A4 = async (ctx, fx, url) => {
  const pr = await apiProbe(ctx, url); const v = pr.json?.items?.find((i) => i.kind === 'video'); must(v, '解析不到视频');
  const d = await apiDownload(ctx, { url, item: v.id, kind: 'video', quality: 1080, format: 'webm' }, tmp('a4.webm'));
  checkName(d.name, 'webm');
  return verifyVideo(d.file, { format: 'webm', height: 1080, color: C.b1080, dur: 6 });
};
T.A6 = async (ctx, fx, url) => {
  const pr = await apiProbe(ctx, url); const v = pr.json?.items?.find((i) => i.kind === 'video'); must(v, '解析不到视频');
  const out = [];
  for (const f of ['mp3', 'm4a', 'opus', 'flac', 'wav']) {
    const d = await apiDownload(ctx, { url, item: v.id, kind: 'audio', format: f }, tmp('a6.' + f));
    checkName(d.name, f);
    out.push(verifyAudio(d.file, { format: f, dur: 6 }));
  }
  return out.join(' ');
};
T.A12 = async (ctx, fx) => {
  mustUserError(await apiProbe(ctx, '随便写点字，不是链接'), '不是链接');
  mustUserError(await apiProbe(ctx, `${fx}/blank/nomedia.html`), '没有媒体的页面');
  mustUserError(await apiProbe(ctx, `${fx}/watch/missing.html`), '404 页面');
};
T.A13 = async (tmpDir) => {
  const count = (d) => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) n += count(p); else if (fs.statSync(p).size > 0) n++; } return n; };
  const t0 = Date.now(); let n;
  while ((n = count(tmpDir)) > 0 && Date.now() - t0 < 10000) await sleep(500);
  must(n === 0, `下载完 10 秒后 GLINT_TMP 里还剩 ${n} 个文件`);
};
T.S1 = async (ctx, fx) => {
  const pr = await apiProbe(ctx, `${fx}/watch/clip1.html`);
  must(pr.status === 401 && errOf(pr).code === 'auth_required', `没口令也能解析（HTTP ${pr.status} ${errOf(pr).code || ''}）`);
  const d = await fetch(`${ctx.base}/api/download?url=x&item=x&kind=video&quality=360&format=mp4`, { headers: ctx.h() });
  must(d.status === 401, `没口令也能调下载接口（HTTP ${d.status}）`);
};
T.U7 = async (base, fx, cookie) => {
  const ctx = await newCtx(base, { cookie });
  try {
    const p = await ctx.newPage(); await p.goto(base);
    if (fx) { await submit(p, `${fx}/watch/clip1.html`); await waitTitle(p, '测试'); }
    await sleep(2500);
    must(ctx.thirdParty.length === 0, `出现第三方请求：${ctx.thirdParty[0]}`);
  } finally { await ctx.close(); }
};
T.U8 = async (base, cookie) => { const ctx = await newCtx(base, { cookie }); try { const p = await ctx.newPage(); await p.goto(base); await vis(p, '[data-t=panel]'); return await glassCheck(p); } finally { await ctx.close(); } };
T.U9 = (base, cookie) => motionCheck(base, false, cookie);
T.M1 = async (base, fx, cookie) => {
  const ctx = await newCtx(base, { ...MOBILE, cookie });
  try {
    const p = await ctx.newPage(); await p.goto(base); await vis(p, '[data-t=url]'); await sleep(800);
    await noOverflow(p, '手机首页');
    if (fx) { await submit(p, `${fx}/post/gallery1.html`, true); await waitTitle(p, '图集'); await sleep(800); await noOverflow(p, '手机图集结果页'); }
  } finally { await ctx.close(); }
};

async function runLocal() {
  const fxDir = path.join(WORK, 'fx'); fs.mkdirSync(fxDir);
  console.log('… 正在生成假视频站');
  makeFixtures(fxDir);
  const fxPort = await fixtureServer(fxDir);
  const fx = `http://127.0.0.1:${fxPort}`;
  const clip = `${fx}/watch/clip1.html`, gal = `${fx}/post/gallery1.html`;
  const share = `【测试】看看这个 ${clip}?from=share 太好笑了`;
  const tmpA = path.join(WORK, 'tmpA'), tmpB = path.join(WORK, 'tmpB'); fs.mkdirSync(tmpA); fs.mkdirSync(tmpB);
  const portA = await freePort();
  const A = mkctx(`http://127.0.0.1:${portA}`);
  const envA = { GLINT_ALLOW_PRIVATE: '1', GLINT_TMP: tmpA };
  const okA = await check('B1', '启动 run.py，60 秒内 /api/health 返回 200', () => startApp({ port: portA, env: envA }), 90000);
  if (!okA) return;
  await check('B2', '不带 --lan 时局域网连不上', async () => {
    let ip = null; for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if (!ip && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) ip = a.address;
    if (!ip) throw new NA('本机没有局域网 IPv4，无法考');
    const can = await new Promise((ok) => { const s = net.connect({ host: ip, port: portA, timeout: 2000 }); s.on('connect', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); s.on('timeout', () => { s.destroy(); ok(false); }); });
    must(!can, `从 ${ip}:${portA} 能连上——没带 --lan 却对局域网开放了`);
  });
  await check('B3', '首页 / 返回 HTML', async () => { const r = await fetch(A.base + '/'); must(r.status === 200 && /html/.test(r.headers.get('content-type') || ''), `HTTP ${r.status}`); });

  let thumbPath = null;
  if (want('api')) {
    await check('A1', '解析分享文案里的视频：标题、三档清晰度 1080/720/360', async () => {
      const pr = await apiProbe(A, share);
      must(pr.status === 200, `HTTP ${pr.status} ${pr.body.slice(0, 200)}`);
      must((pr.json.title || '').includes('测试视频'), `标题不对：${pr.json.title}`);
      const vs = pr.json.items.filter((i) => i.kind === 'video');
      must(vs.length === 1, `视频 item 应 1 个，实际 ${vs.length}`);
      must(JSON.stringify(vs[0].qualities) === '[1080,720,360]', `清晰度应为 [1080,720,360]，实际 ${JSON.stringify(vs[0].qualities)}`);
    });
    await check('A2', '720p MP4：H.264+AAC、原始画面、时长、有声、文件名', () => T.A2(A, fx, share));
    await check('A3', '1080p MP4（源是 VP9，必须转成 H.264）', async () => {
      const pr = await apiProbe(A, clip); const v = pr.json.items.find((i) => i.kind === 'video');
      const d = await apiDownload(A, { url: clip, item: v.id, kind: 'video', quality: 1080, format: 'mp4' }, tmp('a3.mp4'));
      checkName(d.name, 'mp4'); return verifyVideo(d.file, { format: 'mp4', height: 1080, color: C.b1080, dur: 6 });
    });
    await check('A4', '1080p WebM：VP9/AV1 + Opus/Vorbis', () => T.A4(A, fx, clip));
    await check('A5', '360p MKV', async () => {
      const pr = await apiProbe(A, clip); const v = pr.json.items.find((i) => i.kind === 'video');
      const d = await apiDownload(A, { url: clip, item: v.id, kind: 'video', quality: 360, format: 'mkv' }, tmp('a5.mkv'));
      checkName(d.name, 'mkv'); return verifyVideo(d.file, { format: 'mkv', height: 360, color: C.r360, dur: 6 });
    });
    await check('A6', '音频五种格式 mp3/m4a/opus/flac/wav', () => T.A6(A, fx, clip));
    await check('A7', '视频封面下载成 PNG', async () => {
      const pr = await apiProbe(A, clip); const v = pr.json.items.find((i) => i.kind === 'video');
      const d = await apiDownload(A, { url: clip, item: v.id, kind: 'image', format: 'png' }, tmp('a7.png'));
      checkName(d.name, 'png'); return verifyImage(d.file, { format: 'png', w: 1280, h: 720, color: C.cover });
    });
    let gItems = null;
    await check('A8', '图集：恰好 3 张图 + 1 段视频，去掉图标/跟踪像素/重复，srcset 取最大', async () => {
      const pr = await apiProbe(A, gal);
      must(pr.status === 200, `HTTP ${pr.status} ${pr.body.slice(0, 200)}`);
      const imgs = pr.json.items.filter((i) => i.kind === 'image'), vids = pr.json.items.filter((i) => i.kind === 'video');
      const dims = imgs.map((i) => `${i.width}×${i.height}`).sort();
      must(imgs.length === 3, `图片 item 应 3 个，实际 ${imgs.length}：${dims.join(',')}`);
      must(JSON.stringify(dims) === JSON.stringify(Object.keys(GALLERY).sort()), `图片尺寸应为 ${Object.keys(GALLERY).join(',')}，实际 ${dims.join(',')}`);
      must(vids.length === 1 && vids[0].qualities?.includes(720), `视频 item 应 1 个且含 720，实际 ${JSON.stringify(vids)}`);
      gItems = pr.json.items;
    });
    await check('A9', '图集三张图分别下成 jpg/png/webp，尺寸和内容都对', async () => {
      must(gItems, 'A8 没过，拿不到图集');
      const imgs = gItems.filter((i) => i.kind === 'image'); const fmts = ['jpg', 'png', 'webp']; const out = [];
      for (let i = 0; i < imgs.length; i++) {
        const f = fmts[i % 3]; const key = `${imgs[i].width}×${imgs[i].height}`; const [w, h] = key.split('×').map(Number);
        const d = await apiDownload(A, { url: gal, item: imgs[i].id, kind: 'image', format: f }, tmp(`a9-${i}.${f}`));
        checkName(d.name, f); out.push(f + ' ' + verifyImage(d.file, { format: f, w, h, color: GALLERY[key] }));
      }
      return out.join('，');
    });
    await check('A10', '图集里的视频下成 720p MP4', async () => {
      must(gItems, 'A8 没过，拿不到图集');
      const v = gItems.find((i) => i.kind === 'video');
      const d = await apiDownload(A, { url: gal, item: v.id, kind: 'video', quality: 720, format: 'mp4' }, tmp('a10.mp4'));
      checkName(d.name, 'mp4'); return verifyVideo(d.file, { format: 'mp4', height: 720, color: C.gv, dur: 4 });
    });
    await check('A11', '两个下载同时进行都完好', async () => {
      const pr = await apiProbe(A, clip); const v = pr.json.items.find((i) => i.kind === 'video');
      const [x, y] = await Promise.all([
        apiDownload(A, { url: clip, item: v.id, kind: 'video', quality: 720, format: 'mp4' }, tmp('a11.mp4')),
        apiDownload(A, { url: clip, item: v.id, kind: 'audio', format: 'mp3' }, tmp('a11.mp3')),
      ]);
      verifyVideo(x.file, { format: 'mp4', height: 720, color: C.g720, dur: 6 }); verifyAudio(y.file, { format: 'mp3', dur: 6 });
    });
    await check('A12', '出错给 4xx + 中文说明，不露堆栈', () => T.A12(A, fx));
    await check('A13', '下载完 10 秒内临时文件删干净', () => T.A13(tmpA), 30000);
    await check('A14', '缩略图走本站中转（同源路径且能取到图）', async () => {
      const pr = await apiProbe(A, clip); const ths = pr.json.items.map((i) => i.thumbnail).filter(Boolean);
      for (const t of ths) {
        must(t.startsWith('/') && !t.startsWith('//'), `缩略图不是同源路径：${t}`);
        const r = await fetch(A.base + t); must(r.status === 200 && /^image\//.test(r.headers.get('content-type') || ''), `缩略图取不到：HTTP ${r.status}`);
        thumbPath = thumbPath || t;
      }
      return ths.length ? `${ths.length} 个缩略图` : '没给缩略图（允许）';
    });
  }

  if (want('ui')) {
    browser = browser || await chromium.launch();
    const ctx = await newCtx(A.base);
    const page = await ctx.newPage();
    await check('U1', '首页打开：默认中文、输入框和按钮可见', async () => {
      await page.goto(A.base); await vis(page, '[data-t=url]'); await vis(page, '[data-t=go]');
      const lang = await page.evaluate(() => document.documentElement.lang || '');
      must(/^zh/i.test(lang), `<html lang> 应为 zh…，实际「${lang}」`);
    });
    await check('U2', '粘贴分享文案回车 → 出结果、标题、缩略图加载', async () => {
      await page.goto(A.base); await submit(page, share); await waitTitle(page, '测试视频');
      await sleep(1500);
      const bad = await page.evaluate(() => [...document.querySelectorAll('[data-t=result] img')].filter((i) => !(i.complete && i.naturalWidth > 0)).length);
      must(bad === 0, `${bad} 张缩略图没加载出来`);
    });
    await check('U3', '界面选 720 + MP4 下载，文件完好', async () => {
      const item = page.locator('[data-t=item][data-item=video]').first();
      if (await item.locator('[data-kind="video"]').count()) await choose(item, '[data-kind="video"]');
      const qs = await item.locator('[data-quality]').evaluateAll((els) => els.filter((e) => e.offsetWidth > 0).map((e) => +e.dataset.quality));
      must(JSON.stringify(qs) === '[1080,720,360]', `清晰度选项应为 1080,720,360，实际 ${qs}`);
      const d = await uiDownload(page, item, { kind: 'video', quality: 720, format: 'mp4' }, tmp('u3.mp4'));
      checkName(d.name, 'mp4'); return verifyVideo(d.file, { format: 'mp4', height: 720, color: C.g720, dur: 6 });
    });
    await check('U4', '界面下 MP3', async () => {
      const item = page.locator('[data-t=item][data-item=video]').first();
      const d = await uiDownload(page, item, { kind: 'audio', format: 'mp3' }, tmp('u4.mp3'));
      checkName(d.name, 'mp3'); return verifyAudio(d.file, { format: 'mp3', dur: 6 });
    });
    await check('U5', '界面图集：3 张图 + 1 段视频，逐张下成 WebP', async () => {
      await page.goto(A.base); await submit(page, gal); await waitTitle(page, '图集'); await sleep(1000);
      const imgs = page.locator('[data-t=item][data-item=image]');
      must(await imgs.count() === 3, `图片 item 应 3 个，实际 ${await imgs.count()}`);
      must(await page.locator('[data-t=item][data-item=video]').count() === 1, '视频 item 应 1 个');
      const got = [];
      for (let i = 0; i < 3; i++) {
        const d = await uiDownload(page, imgs.nth(i), { kind: 'image', format: 'webp' }, tmp(`u5-${i}.webp`));
        checkName(d.name, 'webp'); const dim = verifyImage(d.file, { format: 'webp' });
        must(GALLERY[dim], `尺寸 ${dim} 不是原图`); verifyImage(d.file, { format: 'webp', color: GALLERY[dim] }); got.push(dim);
      }
      must(new Set(got).size === 3, `三张图有重复：${got}`);
      return got.join(',');
    });
    await check('U6', '乱输文字 → 中文报错，不露堆栈', async () => {
      await page.goto(A.base); await submit(page, '随便写点字，不是链接');
      const e = await vis(page, '[data-t=error]', 15000); const t = await e.innerText();
      must(CJK.test(t), `报错不是中文：${t}`); must(!/Traceback/.test(t), '报错里有堆栈');
    });
    await check('U7', '全程没有第三方请求（缩略图也走本站）', async () => {
      await sleep(1000);
      must(ctx.thirdParty.length === 0, `出现第三方请求：${ctx.thirdParty[0]}`);
    });
    await check('U8', '玻璃面板：背景模糊 ≥12px、半透明', () => T.U8(A.base));
    await check('U9', '背景在流动', () => T.U9(A.base));
    await check('U10', '开「减少动态效果」时画面静止', () => motionCheck(A.base, true));
    await check('U11', '静置 3 秒帧间隔 95 分位 ≤ 50ms', async () => {
      await page.goto(A.base); await sleep(1500);
      const iv = await page.evaluate(() => new Promise((ok) => { const ts = []; const f = (t) => { ts.push(t); if (t - ts[0] < 3000) requestAnimationFrame(f); else ok(ts.slice(1).map((v, i) => v - ts[i])); }; requestAnimationFrame(f); }));
      iv.sort((a, b) => a - b); const p95 = iv[Math.floor(iv.length * 0.95)];
      must(iv.length >= 60, `3 秒只画了 ${iv.length} 帧`); must(p95 <= 50, `帧间隔 95 分位 ${p95.toFixed(1)}ms`);
      return `${iv.length} 帧，p95 ${p95.toFixed(1)}ms`;
    });
    await check('U12', '中英切换', async () => {
      await page.goto(A.base); await (await vis(page, '[data-t=lang]')).click(); await sleep(600);
      const s = await page.evaluate(() => ({ lang: document.documentElement.lang, go: document.querySelector('[data-t=go]')?.innerText || '' }));
      must(/^en/i.test(s.lang), `切换后 <html lang> 应为 en…，实际 ${s.lang}`); must(!CJK.test(s.go), `切换后按钮还是中文：${s.go}`);
      await page.locator('[data-t=lang]').first().click(); await sleep(600);
      must(/^zh/i.test(await page.evaluate(() => document.documentElement.lang)), '切不回中文');
    });
    await check('U13', '整个界面过程没有页面异常/控制台报错', async () => { must(ctx.errors.length === 0, ctx.errors[0]); });
    await ctx.close();
  }

  if (want('mobile')) {
    browser = browser || await chromium.launch();
    await check('M1', '手机 390×844 不横向滚动（首页和图集结果）', () => T.M1(A.base, fx));
    await check('M2', '手机首屏看得到输入框和按钮，按钮 ≥ 44px 高', async () => {
      const ctx = await newCtx(A.base, MOBILE);
      try {
        const p = await ctx.newPage(); await p.goto(A.base);
        for (const s of ['[data-t=url]', '[data-t=go]']) { const b = await (await vis(p, s)).boundingBox(); must(b && b.y >= 0 && b.y + b.height <= 844, `${s} 不在首屏`); }
        const g = await p.locator('[data-t=go]').first().boundingBox(); must(g.height >= 44, `解析按钮高 ${g.height}px`);
        await submit(p, clip, true); await waitTitle(p, '测试视频');
        const item = p.locator('[data-t=item][data-item=video]').first();
        const btn = item.locator('[data-t=download]').first(); await btn.waitFor({ state: 'visible', timeout: 10000 });
        const db = await btn.boundingBox(); must(db.height >= 44, `下载按钮高 ${db.height}px`);
      } finally { await ctx.close(); }
    });
    await check('M3', '手机点按走完：360p MP4 下载完好', async () => {
      const ctx = await newCtx(A.base, MOBILE);
      try {
        const p = await ctx.newPage(); await p.goto(A.base); await submit(p, clip, true); await waitTitle(p, '测试视频');
        const d = await uiDownload(p, p.locator('[data-t=item][data-item=video]').first(), { kind: 'video', quality: 360, format: 'mp4', tap: true }, tmp('m3.mp4'));
        checkName(d.name, 'mp4'); return verifyVideo(d.file, { format: 'mp4', height: 360, color: C.r360, dur: 6 });
      } finally { await ctx.close(); }
    });
  }

  if (want('sec')) {
    const code = 'jg-' + crypto.randomBytes(6).toString('hex');
    const portB = await freePort();
    const B = mkctx(`http://127.0.0.1:${portB}`);
    const okB = await check('S0', '带口令启动（ACCESS_CODE，不放行内网）', () => startApp({ port: portB, env: { ACCESS_CODE: code, GLINT_TMP: tmpB } }), 90000);
    if (okB) {
      await check('S1', '没口令：解析和下载接口都 401', () => T.S1(B, fx));
      await check('S2', '口令正确 → 拿到 cookie；默认拒绝解析本机地址', async () => {
        const l = await login(B.base, code); must(l.status === 200 && l.cookie, `正确口令登录失败（HTTP ${l.status}）`); B.cookie = l.cookie;
        const pr = await apiProbe(B, clip); must(pr.status >= 400 && pr.status < 500 && pr.json?.error, `本机地址没被拦（HTTP ${pr.status}）`);
        must(!pr.json?.items, '本机地址被解析出了内容');
      });
      await check('S3', '各种内网/本机写法都拦（localhost、[::1]、169.254、十进制 IP、0.0.0.0、file:）', async () => {
        must(B.cookie, 'S2 没登录成功，无从考');
        const bad = [`http://localhost:${fxPort}/watch/clip1.html`, `http://[::1]:${fxPort}/watch/clip1.html`, 'http://169.254.169.254/latest/meta-data/', `http://2130706433:${fxPort}/watch/clip1.html`, `http://0.0.0.0:${fxPort}/watch/clip1.html`, 'file:///etc/passwd', 'file:///C:/Windows/win.ini'];
        for (const u of bad) {
          const t0 = Date.now(); const pr = await apiProbe(B, u);
          must(pr.status >= 400 && pr.status < 500 && !pr.json?.items, `${u} 没被拦（HTTP ${pr.status}）`);
          must(!/Traceback/.test(pr.body), `${u} 的响应有堆栈`); must(Date.now() - t0 < 15000, `${u} 拦得太慢`);
        }
      });
      await check('S4', '缩略图中转同样拦本机地址', async () => {
        must(B.cookie, 'S2 没登录成功，无从考');
        if (!thumbPath) throw new NA('A14 没给缩略图（或没跑 api 组），无从考');
        const r = await fetch(B.base + thumbPath, { headers: B.h() });
        must(!(r.status === 200 && /^image\//.test(r.headers.get('content-type') || '')), '不放行内网的实例照样把本机图片中转出来了');
      });
      if (want('ui') || want('mobile')) {
        browser = browser || await chromium.launch();
        await check('S5', '界面口令：错的报错、对的进入、刷新后仍登录', async () => {
          const ctx = await newCtx(B.base);
          try {
            const p = await ctx.newPage(); await p.goto(B.base);
            await (await vis(p, '[data-t=code]')).fill('wrong-code'); await (await vis(p, '[data-t=login]')).click();
            await vis(p, '[data-t=error]', 10000);
            await p.locator('[data-t=code]').first().fill(code); await p.locator('[data-t=login]').first().click();
            await p.locator('[data-t=code]').first().waitFor({ state: 'hidden', timeout: 10000 }); await vis(p, '[data-t=url]');
            await p.reload(); await vis(p, '[data-t=url]'); await sleep(1000);
            must(!(await p.locator('[data-t=code]').first().isVisible().catch(() => false)), '刷新后又要输口令');
          } finally { await ctx.close(); }
        });
      }
      await check('S6', '一分钟内错 6 次口令 → 429', async () => {
        let s = 0; for (let i = 0; i < 6; i++) s = (await login(B.base, 'wrong-' + i)).status;
        must(s === 429, `第 6 次错口令返回 ${s}，没限流`);
      });
    }
    await check('S7', '带 --lan 但没设口令：拒绝启动或强制要口令', async () => {
      const portC = await freePort();
      const c = await startApp({ port: portC, env: { GLINT_TMP: tmpB }, lan: true, wait: false });
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (c.exitCode !== null) return `拒绝启动（退出码 ${c.exitCode}）`;
        try { const r = await fetch(`http://127.0.0.1:${portC}/api/health`); if (r.status === 200) break; } catch {}
        await sleep(400);
      }
      if (c.exitCode !== null) return `拒绝启动（退出码 ${c.exitCode}）`;
      const pr = await apiProbe(mkctx(`http://127.0.0.1:${portC}`), 'https://example.com/');
      kill(c);
      must(pr.status === 401, `--lan 无口令也能直接解析（HTTP ${pr.status}）`);
      return '自动要求口令';
    }, 60000);
  }

  if (LIVE) await runLive(A, true);
}

// ---------- 真实平台 ----------
function ytdlpControl(url) {
  const py = pyCmd();
  const tries = [[py, ['-m', 'yt_dlp']], ['yt-dlp', []]];
  for (const [cmd, pre] of tries) {
    for (const extra of [['--js-runtimes', 'node'], []]) {
      const r = sh(cmd, [...pre, '--no-config', ...extra, '-J', '--skip-download', '--no-playlist', url], { timeout: 150000 });
      if (r.error) break;
      if (r.status === 0) { try { const j = JSON.parse(r.stdout); return (j.formats || []).some((f) => f.vcodec !== 'none'); } catch { return false; } }
      if (/no such option|unrecognized/i.test(r.stderr || '')) continue;
      return false;
    }
  }
  return false;
}
const CLEAN = ['login_required', 'unavailable', 'rate_limited', 'blocked_host', 'not_found'];
const HOSTS = { youtube: /(^|\.)youtube\.com$|^youtu\.be$/, bilibili: /(^|\.)bilibili\.com$|^b23\.tv$/, tiktok: /(^|\.)tiktok\.com$/, instagram: /(^|\.)instagram\.com$/ };
const hostOk = (plat, u) => { try { return !!HOSTS[plat]?.test(new URL(u).hostname.toLowerCase()); } catch { return false; } };
// 补充链接：执行者可在 tools/live-extra.json 里补（同格式），只在候选链接全失败时才用，域名必须属于该平台，每平台最多 5 条
function extraLive() {
  const f = path.join(ROOT, 'tools', 'live-extra.json');
  if (!fs.existsSync(f)) return { video: {}, images: [] };
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { video: j.video || {}, images: j.images || [] };
}
const isClean = (pr) => pr.status >= 400 && pr.status < 500 && CLEAN.includes(errOf(pr).code) && CJK.test(errOf(pr).message || '');
async function liveVideoOnce(ctx, plat, u) {
  const pr = await apiProbe(ctx, u);
  if (pr.status !== 200) { const e = new Error(`解析 HTTP ${pr.status} ${errOf(pr).code || ''} ${(errOf(pr).message || pr.body).slice(0, 100)}`); e.clean = isClean(pr); throw e; }
  const v = pr.json.items.find((i) => i.kind === 'video'); must(v && v.qualities?.length, '没有视频清晰度');
  const q = Math.min(...v.qualities);
  const d = await apiDownload(ctx, { url: u, item: v.id, kind: 'video', quality: q, format: 'mp4' }, tmp(`l-${plat}.mp4`));
  checkName(d.name, 'mp4', false); const vv = verifyVideo(d.file, { format: 'mp4', height: q, live: true });
  const a = await apiDownload(ctx, { url: u, item: v.id, kind: 'audio', format: 'mp3' }, tmp(`l-${plat}.mp3`));
  checkName(a.name, 'mp3', false); verifyAudio(a.file, { format: 'mp3', live: true });
  const c = await apiDownload(ctx, { url: u, item: v.id, kind: 'image', format: 'jpg' }, tmp(`l-${plat}.jpg`));
  checkName(c.name, 'jpg', false); verifyImage(c.file, { format: 'jpg', minW: 120 });
  return `${u} ${q}p ${vv}`;
}
async function liveImageOnce(ctx, plat, u) {
  const pr = await apiProbe(ctx, u);
  if (pr.status !== 200) { const e = new Error(`解析 HTTP ${pr.status} ${errOf(pr).code || ''} ${(errOf(pr).message || pr.body).slice(0, 100)}`); e.clean = isClean(pr); throw e; }
  const im = pr.json.items.filter((i) => i.kind === 'image'); must(im.length, '没解析出图片');
  const d = await apiDownload(ctx, { url: u, item: im[0].id, kind: 'image', format: 'jpg' }, tmp(`li-${plat}.jpg`));
  checkName(d.name, 'jpg', false);
  return `${u} ${im.length} 张，首张 ` + verifyImage(d.file, { format: 'jpg', minW: 320 });
}
async function liveGroup(ctx, local, plat, frozen, extra, once, control) {
  const errs = []; let clean = true;
  const tryAll = async (list, tag) => {
    for (const u of list) {
      try { return (await once(ctx, plat, u)) + tag; } catch (e) { errs.push(`${u}：${e.message}`); if (!e.clean) clean = false; }
    }
    return null;
  };
  let ok = await tryAll(frozen, '');
  if (ok) return ok;
  if (local && control && frozen.some(control)) throw new Error('yt-dlp 命令行拿得到、网站拿不到｜' + errs.join(' ｜ '));
  const ex = extra.filter((u) => hostOk(plat, u)).slice(0, 5);
  ok = await tryAll(ex, '（补充链接）');
  if (ok) return ok;
  if (local && control) { if (ex.some(control)) throw new Error('补充链接 yt-dlp 命令行拿得到、网站拿不到｜' + errs.join(' ｜ ')); throw new Limit('yt-dlp 命令行本身也拿不到（平台限制）｜' + errs[0]); }
  if (clean) throw new Limit('给了干净的中文报错（平台限制）｜' + errs[0]);
  throw new Error(errs.join(' ｜ '));
}
async function runLive(ctx, local) {
  const live = JSON.parse(fs.readFileSync(path.join(HERE, 'live.json'), 'utf8'));
  const ex = extraLive();
  for (const [plat, urls] of Object.entries(live.video)) {
    await check(`L-${plat}`, `${plat} 真实视频：解析 → 最低档 MP4 + MP3 + 封面 JPG`, () => liveGroup(ctx, local, plat, urls, ex.video[plat] || [], liveVideoOnce, ytdlpControl), 900000);
  }
  for (const { platform, url } of live.images || []) {
    const extra = ex.images.filter((i) => i.platform === platform).map((i) => i.url);
    await check(`L-${platform}-图`, `${platform} 真实图片帖：至少 1 张图下成 JPG`, () => liveGroup(ctx, local, platform, [url], extra, liveImageOnce, null), 600000);
  }
}

// ---------- 考线上 ----------
async function runRemote() {
  must(CODE, '考线上要带 --code 口令');
  const R = mkctx(REMOTE);
  await check('R0', '线上 /api/health 200', async () => { const r = await fetch(REMOTE + '/api/health'); must(r.status === 200, `HTTP ${r.status}`); });
  await check('R1', '线上没口令解析 → 401', async () => { const pr = await apiProbe(R, 'https://www.bilibili.com/video/BV1GJ411x7h7'); must(pr.status === 401, `HTTP ${pr.status}`); });
  const ok = await check('R2', '线上口令登录', async () => { const l = await login(REMOTE, CODE); must(l.status === 200 && l.cookie, `HTTP ${l.status}`); R.cookie = l.cookie; });
  if (!ok) return;
  browser = await chromium.launch();
  await check('R3', '线上界面输口令进入', async () => {
    const ctx = await newCtx(REMOTE);
    try { const p = await ctx.newPage(); await p.goto(REMOTE); await (await vis(p, '[data-t=code]', 30000)).fill(CODE); await (await vis(p, '[data-t=login]')).click(); await p.locator('[data-t=code]').first().waitFor({ state: 'hidden', timeout: 15000 }); await vis(p, '[data-t=url]'); } finally { await ctx.close(); }
  });
  await check('R4', '线上首页没有第三方请求', () => T.U7(REMOTE, null, R.cookie));
  await check('R5', '线上玻璃面板', () => T.U8(REMOTE, R.cookie));
  await check('R6', '线上背景在流动', () => T.U9(REMOTE, R.cookie));
  await check('R7', '线上手机不横向滚动', () => T.M1(REMOTE, null, R.cookie));
  await runLive(R, false);
}

// ---------- 反向验证 ----------
async function readBody(req) { const ch = []; for await (const c of req) ch.push(c); return Buffer.concat(ch); }
function startProxy(target, mode, x) {
  return listen(http.createServer(async (req, res) => {
    try {
      const headers = { ...req.headers }; delete headers['accept-encoding']; delete headers.host; delete headers['content-length'];
      if (mode === 'authbypass' && x.cookie) headers.cookie = x.cookie;
      const body = await readBody(req);
      const up = await fetch(target + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' });
      let buf = Buffer.from(await up.arrayBuffer());
      const h = {}; up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie'].includes(k)) h[k] = v; });
      const sc = up.headers.getSetCookie?.() || []; if (sc.length) h['set-cookie'] = sc;
      const cd = up.headers.get('content-disposition') || '', ct = up.headers.get('content-type') || '', name = cdName(cd).toLowerCase();
      if (/attachment/i.test(cd)) {
        if (mode === 'truncate') buf = buf.subarray(0, Math.floor(buf.length * 0.4));
        if (mode === 'upscale' && name.endsWith('.mp4')) buf = fs.readFileSync(x.fx + '/media/x/red720.mp4');
        if (mode === 'noaudio' && name.endsWith('.mp4')) buf = fs.readFileSync(x.fx + '/media/x/mute720.mp4');
        if (mode === 'silent' && name.endsWith('.mp3')) buf = fs.readFileSync(x.fx + '/media/x/silent.mp3');
        if (mode === 'fakewebm' && name.endsWith('.webm')) buf = fs.readFileSync(x.fx + '/media/x/fake.webm');
        if (mode === 'badname') h['content-disposition'] = 'attachment; filename="video.mp4"';
      }
      if (/text\/html/.test(ct)) {
        let s = buf.toString('utf8');
        const inject = { thirdparty: `<img src="${x.fxUrl}/media/clip1/thumb.jpg" style="position:absolute;width:1px;height:1px;opacity:0">`, overflow: '<div style="width:2400px;height:2px"></div>', opaque: '<style>[data-t=panel]{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:#fff!important}</style>', staticbg: '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style><script>window.requestAnimationFrame=function(){return 0};</script>' }[mode];
        if (inject) s = /<\/body>/i.test(s) && mode !== 'staticbg' && mode !== 'opaque' ? s.replace(/<\/body>/i, inject + '</body>') : s.replace(/<head[^>]*>/i, (m) => m + inject);
        buf = Buffer.from(s);
      }
      if (mode === 'traceback' && up.status >= 400 && /json/.test(ct)) buf = Buffer.from(JSON.stringify({ error: { code: 'internal', message: 'Traceback (most recent call last):\n  File "app.py", line 1' } }));
      res.writeHead(up.status, h); res.end(buf);
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  }));
}
async function runProve() {
  const fxDir = path.join(WORK, 'fx'); fs.mkdirSync(fxDir); console.log('… 正在生成假视频站'); makeFixtures(fxDir);
  const fxPort = await fixtureServer(fxDir); const fx = `http://127.0.0.1:${fxPort}`; const clip = `${fx}/watch/clip1.html`;
  const tmpA = path.join(WORK, 'tmpA'); fs.mkdirSync(tmpA);
  const portA = await freePort(); await startApp({ port: portA, env: { GLINT_ALLOW_PRIVATE: '1', GLINT_TMP: tmpA } });
  const code = 'jg-' + crypto.randomBytes(6).toString('hex'); const portB = await freePort();
  await startApp({ port: portB, env: { ACCESS_CODE: code, GLINT_TMP: path.join(WORK, 'tmpB') } });
  const cookieB = (await login(`http://127.0.0.1:${portB}`, code)).cookie;
  browser = await chromium.launch();
  const A = `http://127.0.0.1:${portA}`, Bu = `http://127.0.0.1:${portB}`;
  const cases = [
    ['truncate', '下载只给 40%', A, (b) => T.A2(mkctx(b), fx, clip)],
    ['upscale', '720 用别的画面冒充', A, (b) => T.A2(mkctx(b), fx, clip)],
    ['noaudio', 'MP4 没音轨', A, (b) => T.A2(mkctx(b), fx, clip)],
    ['badname', '文件名丢了标题', A, (b) => T.A2(mkctx(b), fx, clip)],
    ['fakewebm', 'MKV 改名冒充 WebM', A, (b) => T.A4(mkctx(b), fx, clip)],
    ['silent', 'MP3 是静音', A, (b) => T.A6(mkctx(b), fx, clip)],
    ['traceback', '报错露出堆栈', A, (b) => T.A12(mkctx(b), fx)],
    ['tmpleak', '临时文件没删', A, async () => { fs.writeFileSync(path.join(tmpA, 'leak.part'), 'x'.repeat(100)); try { await T.A13(tmpA); } finally { fs.rmSync(path.join(tmpA, 'leak.part'), { force: true }); } }],
    ['authbypass', '口令形同虚设', Bu, (b) => T.S1(mkctx(b), fx)],
    ['thirdparty', '页面偷偷请求第三方', A, (b) => T.U7(b, fx)],
    ['opaque', '面板不是玻璃', A, (b) => T.U8(b)],
    ['staticbg', '背景不动', A, (b) => T.U9(b)],
    ['overflow', '手机横向溢出', A, (b) => T.M1(b, null)],
  ];
  let caught = 0;
  for (const [mode, label, target, fn] of cases) {
    const port = mode === 'tmpleak' ? null : await startProxy(target, mode, { fx: fxDir, fxUrl: fx, cookie: cookieB });
    const r = await attempt(() => fn(port ? `http://127.0.0.1:${port}` : A), 300000);
    const hit = r.status === 'fail'; if (hit) caught++;
    console.log(`${hit ? '✅ 抓到' : '❌ 漏判'} ${mode}（${label}）${r.note ? ' — ' + r.note : ''}`);
  }
  console.log(`\n反向验证：${caught}/${cases.length} 抓到`);
  return caught === cases.length ? 1 : 3;
}

// ---------- 主流程 ----------
(async () => {
  const frozen = ['accept.mjs', 'live.json', 'package.json', 'package-lock.json'].map((f) => path.join(HERE, f)).concat(path.join(HERE, '..', 'SPEC.md'));
  const hash = crypto.createHash('sha256'); for (const f of frozen) hash.update(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0));
  console.log(`拾光 Glint 判卷｜判卷指纹 ${hash.digest('hex').slice(0, 16)}｜项目 ${ROOT}${REMOTE ? '｜线上 ' + REMOTE : ''}`);
  for (const t of ['ffmpeg', 'ffprobe']) if (sh(t, ['-version']).status !== 0) { console.log(`❌ PATH 上找不到 ${t}`); await cleanup(); process.exit(1); }
  let code = 0;
  try {
    if (PROVE) code = await runProve();
    else {
      if (REMOTE) await runRemote(); else await runLocal();
      const n = (s) => results.filter((r) => r.status === s).length;
      const scored = n('pass') + n('fail');
      console.log(`\n合计：通过 ${n('pass')} / 计分 ${scored}（🟡平台限制 ${n('limit')}，⚪不适用 ${n('na')}）`);
      code = n('fail') === 0 && n('pass') > 0 ? 0 : 1;
    }
  } catch (e) { console.log('❌ 判卷中断：' + (e?.stack || e)); code = 1; }
  await cleanup();
  process.exit(code);
})();
