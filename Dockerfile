# 拾光 Glint 云端镜像（Hugging Face Docker Space 用 7860 端口）
FROM python:3.12-slim
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 user
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir -U "yt-dlp[default]"
COPY glint ./glint
COPY static ./static
COPY run.py .
ENV GLINT_TMP=/tmp/glint GLINT_TRUST_PROXY=1 PYTHONUNBUFFERED=1 PYTHONUTF8=1
USER user
EXPOSE 7860
CMD ["python", "run.py", "--host", "0.0.0.0", "--port", "7860"]
