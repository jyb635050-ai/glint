# 拾光 Glint · 接口与界面契约（判卷依据，冻结）

判卷 `tools/judge/accept.mjs` 只按本文件考。本文件与判卷目录都是冻结文件，改了就不合格。

## 1. 启动

- 在仓库根目录：`python run.py --port <端口> [--lan]`（判卷优先用 `GLINT_PY` 环境变量，其次 `.venv` 里的 python，最后 PATH 上的 `python`）。
- 不带 `--lan`：只监听 127.0.0.1，局域网连不上。带 `--lan`：监听 0.0.0.0，且必须有口令——没设 `ACCESS_CODE` 就拒绝启动或自动生成口令，绝不能无口令对外开放。
- 环境变量：
  - `ACCESS_CODE`：设了就要口令。
  - `GLINT_TMP`：所有中间文件只许放这里。
  - `GLINT_ALLOW_PRIVATE=1`：允许解析本机/内网地址（只给判卷用，默认拒绝）。
- 60 秒内 `GET /api/health` 返回 200 算启动成功。

## 2. 接口

- `GET /api/health` → 200 `{"ok": true}`，永远不要口令。
- `POST /api/login` `{"code": "..."}` → 对：200 并 `Set-Cookie`（HttpOnly）；错：401；同一 IP 一分钟内错 5 次以上 → 429。
- 有口令时，除 health、login 外所有 `/api/*` 没带有效 cookie → 401，`error.code = "auth_required"`。
- `POST /api/probe` `{"url": "<用户粘贴的整段文字>"}`：文字里可能夹着中文和其他字，服务器自己从中取出第一个 http(s) 链接。成功 → 200：

```json
{ "title": "标题", "platform": "youtube|bilibili|tiktok|instagram|generic|…",
  "items": [
    { "id": "字符串", "kind": "video", "qualities": [1080, 720, 360], "thumbnail": "/同源路径 或 null" },
    { "id": "字符串", "kind": "image", "width": 1600, "height": 2000, "thumbnail": "/同源路径 或 null" }
  ] }
```

  - `kind` 取 `video` / `image` / `audio`。视频的 `qualities` 是能下的画面高度，去重、从大到小。图片的宽高是能拿到的最大版本（`srcset` 取最大）。
  - 图集/混合帖每张图、每段视频各算一个 item；同一张图不重复列；小于 100 像素的图标、1×1 跟踪像素不列。
  - `thumbnail` 必须是本站同源路径（缩略图走后端中转），或者 null。
- `GET /api/download?url=&item=&kind=&quality=&format=`
  - `kind=video`：`quality` 取 qualities 里的一个；`format` 取 `mp4`（H.264 + AAC）、`webm`（VP9/AV1 + Opus/Vorbis）、`mkv`（Matroska，编码不限）。画面必须是那一档的原始画面，不许拿别的档拉伸。
  - `kind=audio`：`format` 取 `mp3`、`m4a`（AAC）、`opus`、`flac`、`wav`。
  - `kind=image`：`format` 取 `jpg`、`png`、`webp`；对视频 item 用 `kind=image` 就是下载它的封面。
  - 返回方式二选一：直接 200 回文件；或 202 `{"job": "...", "poll": "/api/..."}`，轮询 poll 得到 `{"state": "running", "progress": 0~1}` / `{"state": "done", "file": "/api/..."}` / `{"state": "error", "error": {...}}`，再 GET file 拿文件。
  - 文件响应必须带 `Content-Disposition: attachment`，文件名含标题、保留中文（用 `filename*=UTF-8''…`）、扩展名与格式一致、不含 `\ / : * ? " < > |`。
- 出错：非 2xx，JSON `{"error": {"code": "...", "message": "中文人话"}}`。用户的错（不是链接、页面没媒体、页面 404、被拦的地址）一律 4xx，不许 5xx；任何响应体里不许出现 Python 报错堆栈（Traceback）。常用 code：`bad_url`、`blocked_host`、`no_media`、`not_found`、`login_required`、`unavailable`、`rate_limited`、`auth_required`、`internal`。
- 安全：本机、内网、链路本地地址（含 localhost、`[::1]`、169.254.x、十进制写法的 IP、0.0.0.0）和 `file:` 一律拒绝（`blocked_host` 或 `bad_url`），按解析后的真实 IP 判断；缩略图中转和跳转后的地址同样适用。
- 临时文件：下载全部结束 10 秒后，`GLINT_TMP` 里不许留任何非空文件（解析结果要缓存请放内存）。

## 3. 页面（`GET /`）

判卷靠这些 `data-t` 标记找元素，长什么样随意：

| 标记 | 含义 |
| --- | --- |
| `[data-t=url]` | 链接输入框；回车或点 `[data-t=go]` 开始解析 |
| `[data-t=panel]` | 主玻璃面板 |
| `[data-t=result]` | 解析成功后出现；里面有 `[data-t=title]` |
| `[data-t=item][data-item=video\|image\|audio]` | 每个可下载的东西一个 |
| item 里的 `[data-kind=video\|audio\|image]` | 可选的类型切换；有就会先点它 |
| item 里的 `[data-quality="720"]`、`[data-format="mp4"]` | 清晰度、格式选项（点击选中；平铺可见，不要藏进下拉菜单；清晰度按从高到低排） |
| item 里的 `[data-t=download]` | 点了浏览器就收到下载文件 |
| `[data-t=error]` | 出错时显示，中文说明 |
| `[data-t=code]` + `[data-t=login]` | 需要口令时的输入框和按钮；登录后刷新页面仍保持登录 |
| `[data-t=lang]` | 中文 / English 切换；`<html lang>` 跟着变（zh… / en…） |

- 默认中文。整个使用过程浏览器只请求本站（缩略图也走后端），不许有任何第三方请求。
- 观感：`[data-t=panel]` 有 `backdrop-filter` 模糊 ≥ 12px、背景半透明（不透明度 ≤ 0.75）；背景在流动（静置 1.5 秒前后画面有变化）；系统开了「减少动态效果」时画面静止。
- 电脑 1440×900、手机 390×844 都不许横向滚动；手机上 `[data-t=url]`、`[data-t=go]` 首屏可见，`[data-t=go]`、`[data-t=download]` 高度 ≥ 44px；手机点按能走完整个下载流程。
- 动画流畅：桌面静置 3 秒，帧间隔 95% 分位 ≤ 50ms。

## 4. 判卷用法

```
npm ci --prefix tools/judge
npx --prefix tools/judge playwright install chromium
node tools/judge/accept.mjs                      # 本地全量（造假视频站，离线可跑）
node tools/judge/accept.mjs --only api,ui        # 分组：boot,api,ui,mobile,sec
node tools/judge/accept.mjs --live               # 再加真实平台（tools/judge/live.json）
node tools/judge/accept.mjs --url https://xxx.hf.space --code 口令   # 考线上（界面+口令+真实平台）
node tools/judge/accept.mjs --prove              # 反向验证：故意弄坏，判卷必须全部抓到（全抓到时退出码 1）
```

- 需要 Node ≥ 20、PATH 上有 ffmpeg/ffprobe（要带 libx264、libvpx、libwebp）。
- 真实平台：先试 `live.json` 的候选链接。都失败时，判卷用 yt-dlp 命令行亲自试这些链接——命令行拿得到而网站拿不到，直接 ❌。命令行也拿不到（链接死了或平台不给），再试 `tools/live-extra.json` 的补充链接（格式同 `live.json`，可自行新建；域名必须属于该平台，每个平台最多取 5 条）。补充链接也全失败：命令行同样拿不到记 🟡「平台限制」，否则 ❌。
- 考线上时没法用命令行对照：干净的中文报错（login_required / unavailable / rate_limited / blocked_host / not_found）记 🟡，解析成功却下载失败、崩溃、5xx、超时记 ❌。
