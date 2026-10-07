# 拾光 Glint

粘贴 YouTube / B站 / TikTok / Instagram（以及 yt-dlp 支持的上千个网站）的链接或整段分享文案，挑清晰度和格式，存下视频、音乐、图片。苹果磨砂玻璃界面，电脑手机都能用。

- 视频：所有可用清晰度；MP4（H.264+AAC，最兼容）、WebM（VP9/AV1）、MKV（原画不转码）
- 音乐：MP3、M4A、Opus、FLAC、WAV
- 图片：图集逐张或全部下载，封面也能下；JPG、PNG、WebP，自动取最大原图
- 只下公开内容，不用任何账号登录；不记录你粘贴的链接

## 在自己电脑上用

需要 Python 3.10+ 和 ffmpeg（Windows：`winget install Python.Python.3.12` 和 `winget install Gyan.FFmpeg`；Mac：`brew install python ffmpeg`）。

- **Windows**：双击 `启动.bat`。第一次会自动准备环境，之后每次启动都会顺手升级下载核心 yt-dlp。
- **Mac / Linux**：运行 `./start.sh`。

启动后会自动打开浏览器，窗口里会打印：

```
电脑打开：http://127.0.0.1:8787
手机连同一个 Wi-Fi 打开：http://192.168.x.x:8787
访问口令：123456
```

手机连同一个 Wi-Fi，打开「手机网址」，输入口令就行（口令存在 `secrets/access-code.txt`，不会进仓库；删掉这个文件，下次启动会换一个新口令）。Windows 第一次可能弹出防火墙提示，点「允许」。

只在本机用、不需要手机访问：`python run.py`（只听 127.0.0.1，不要口令）。

## 在外面也能用：GitHub Pages 网页 + 家里电脑

网页放在 **https://jyb635050-ai.github.io/glint/** ，真正的下载在你家电脑上进行，两者用 Cloudflare 免费隧道连起来：

1. 家里电脑装一次 cloudflared：`winget install Cloudflare.cloudflared`（Mac：`brew install cloudflared`）
2. 双击 `启动.bat`（或 `./start.sh`）——检测到 cloudflared 会自动开隧道，窗口里打印一条专属链接和二维码
3. 手机或电脑打开那条链接（或扫码）：网页会自动连上你家电脑并登录，以后直接开 `jyb635050-ai.github.io/glint` 就行
4. 家里电脑重启 Glint 后外网地址会变，重新打开新打印的链接即可；电脑没开时网页会提示「还没连上你的电脑」

专属链接里带着访问口令（放在 `#` 后面，不会发给任何服务器），别发给不想让他用的人。

## 部署到云端（Hugging Face Docker Space，需要 PRO 付费）

1. 在 huggingface.co 注册账号，Settings → Access Tokens 建一个 **Write** 权限的令牌
2. `pip install huggingface_hub`，设环境变量 `HF_TOKEN=<令牌>`
3. `python deploy/hf_deploy.py`——会建好 Space、随机生成访问口令（只打印一次）并上传代码
4. 几分钟后打开 `https://<用户名>-glint.hf.space`

2026-10 起 Hugging Face 免费账号不能再跑 Docker Space（建 Space 时报 402，要 PRO）。云端在机房网络里，YouTube 常会要求「登录验证」，这时会如实提示平台限制；家里电脑版不受影响。

## 开发与验收

- 接口与界面契约：[tools/SPEC.md](tools/SPEC.md)（冻结）
- 验收脚本：`npm ci --prefix tools/judge && npx --prefix tools/judge playwright install chromium`，然后 `node tools/judge/accept.mjs`（离线 41 项）、`--live`（真实平台）、`--url <线上网址> --code <口令>`、`--prove`（反向验证）
- 代码：`run.py` 启动入口；`glint/net.py` 取链接与防内网访问；`glint/extract.py` 解析；`glint/jobs.py` 下载与格式转换；`glint/app.py` 接口；`static/` 界面

借鉴：[yt-dlp](https://github.com/yt-dlp/yt-dlp)（下载核心）、[cobalt](https://github.com/imputnet/cobalt)（TikTok 图集、Instagram 嵌入页的解析思路，代码为自行实现）。

只下载你有权保存的内容。
