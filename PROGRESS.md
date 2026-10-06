# 拾光 Glint 进度

## 开工回执（2026-10-06）
- 目标：按 tools/SPEC.md 做本地可用的下载站（后端 + 玻璃界面），本地判卷 41/41、--prove 13/13；真实平台与云端等有网络/令牌再做。
- 顺序：后端（解析/下载/格式转换/安全/口令）→ 前端玻璃界面 → 启动脚本 → 全量/反向验证 → Dockerfile 与部署说明 → push。
- 最大风险：平台专用代码在这台电脑无法实测；长转码在云端的网关超时。
- 任务 0：Node 24.19、Python 3.12.10、ffmpeg 8.1.2；指纹 93a07e50…2f2a 一致；空仓库判卷 B1 失败、退出码 1；四平台全被拦、无 HF_TOKEN（见 BLOCKED.md）。

## 进度
- 任务 1 后端：glint/{net,extract,jobs,app}.py + run.py（FastAPI + yt-dlp 2026.08.19 + ffmpeg）。坑：解析后的信息里留着 yt-dlp 默认选中的格式，直接拿去下载会照旧合并 1080 VP9（音频下载因此失败）——下载前清掉 requested_formats 等字段；yt-dlp 自带的封装修复也关掉（反正自己再用 ffmpeg 封装）
- 任务 1 前端：static/{index.html,style.css,app.js}。坑：背景色块用 filter: blur 边动边缩放，无头 Chrome 只有 15 帧/秒；改成径向渐变柔边后 60 帧（3 秒 181 帧）
- 本地全量 41/41、退出码 0；--prove 13/13、退出码 1
- 启动.bat：中文写在 .bat 里会被 cmd 拆坏，改成批处理只用英文、中文提示由 run.py --tips 打印；口令存 secrets/access-code.txt（不进仓库）
- 任务 2：本机连不上四个平台，--live 6 个 🟡（见 BLOCKED.md 1）
- 任务 3：无 HF_TOKEN，备好 Dockerfile + deploy/hf_deploy.py（见 BLOCKED.md 2）
