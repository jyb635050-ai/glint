# BLOCKED（待裁决）

## 1. 这台电脑连不上四个平台 → 真实平台没实测（任务 2）
任务 0 实测（2026-10-06）：`curl -sI https://www.{youtube,bilibili,tiktok,instagram}.com` 全部 000，连接被重置（公司网络拦截）。
`node tools/judge/accept.mjs --only live` 结果：4 个平台视频 🟡、2 个图片帖 🟡，原因都是连不上。yt-dlp 命令行原始报错（四个平台相同）：
`ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: ('Connection aborted.', ConnectionResetError(10054, ...))`
因此以下代码只照公开资料写好、没有在真实平台上跑过：TikTok 图集（imagePost）、Instagram 嵌入页图帖/视频、YouTube 的 JS 运行时（本机有 node，云端镜像带 deno）。
需要：在家里能上这些网的电脑上跑 `node tools/judge/accept.mjs --live`，或部署云端后用 `--url ... --code ...` 考。

## 2. 云端：Hugging Face 免费账号跑不了 Docker Space（任务 3）
2026-10-07 用领导的令牌实测：`create_repo(space_sdk='docker')` 返回 402 Payment Required——「hosting Gradio and Docker Spaces on free cpu-basic requires a PRO subscription」。账号里没建出任何东西。
领导改判：网页放 GitHub Pages（https://jyb635050-ai.github.io/glint/），后端跑在家里电脑，用 Cloudflare 免费隧道连通（`run.py --tunnel`）。已在公司电脑实测打通：Pages 网页 → 隧道 → 本机后端，登录、解析、下载（H.264→VP9 转码 10 秒完整）都通。
自动同步后端地址到公开 gist 的方案被权限拦下（会公开发布家里后端的网址），改为启动时打印「专属链接 + 二维码」，换地址后重开一次即可。要不要做 gist 自动同步，待领导裁决。
以下为原记录：没有 HF_TOKEN → 云端没部署
已备好：`Dockerfile`、`deploy/hf_deploy.py`（建 Docker Space、随机口令设成 Secret、上传）。步骤见 README「部署到云端」。
本机没有 Docker，Dockerfile 没有实际构建过。

## 3. 验收不独立
判卷、样板、暗卷都是管理者写的，执行也在同一个会话里。

## 4. 实现上的取舍（不阻塞，记录在案）
- 平台没给内容、连不上时返回 424 + `unavailable`（契约要求平台限制给 4xx + 干净错误码；最初写成 502，判卷把图片帖判成 ❌，按契约改了）
- `--lan` 时电脑本机访问也要口令（云端在反向代理后面，按来源 IP 免口令会被绕过，所以不做）
