#!/usr/bin/env bash
# 拾光 Glint 启动脚本（Mac / Linux）。需要先装 python3 和 ffmpeg（Mac：brew install python ffmpeg）。
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "没找到 ffmpeg，Mac 上请运行：brew install ffmpeg"; exit 1; }
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
.venv/bin/python -m pip install -q --disable-pip-version-check -U "yt-dlp[default]"
echo "手机连同一个 Wi-Fi，打开下面的「手机网址」并输入口令。按 Ctrl+C 停止。"
exec .venv/bin/python run.py --lan --port 8787 --open
