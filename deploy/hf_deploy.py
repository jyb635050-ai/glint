"""把拾光 Glint 部署到 Hugging Face Docker Space（2026-10 实测：免费账号建 Docker Space 会报 402，需要 PRO）。

用法（先 pip install huggingface_hub，并设好环境变量 HF_TOKEN = 有写权限的令牌）：
    python deploy/hf_deploy.py [--space glint]
第一次部署会随机生成访问口令，设成 Space 的 Secret（ACCESS_CODE），并打印出来；以后再部署不会改口令，
要换口令加 --new-code。口令不写进任何文件。
"""
import argparse
import os
import secrets
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPACE_README = """---
title: Glint
emoji: ✨
colorFrom: blue
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
---

拾光 Glint：粘贴链接下载视频、音乐、图片。需要访问口令。
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--space', default='glint')
    ap.add_argument('--new-code', action='store_true')
    a = ap.parse_args()
    token = os.environ.get('HF_TOKEN')
    if not token:
        sys.exit('没有 HF_TOKEN 环境变量（Hugging Face → Settings → Access Tokens，选 Write 权限）')
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    user = api.whoami()['name']
    repo = f'{user}/{a.space}'
    created = False
    try:
        api.repo_info(repo, repo_type='space')
    except Exception:
        api.create_repo(repo, repo_type='space', space_sdk='docker', private=False)
        created = True
    code = None
    if created or a.new_code:
        code = f'{secrets.randbelow(10**8):08d}'
        api.add_space_secret(repo, 'ACCESS_CODE', code)
    with tempfile.TemporaryDirectory() as d:
        for name in ('glint', 'static'):
            shutil.copytree(os.path.join(ROOT, name), os.path.join(d, name), ignore=shutil.ignore_patterns('__pycache__'))
        for name in ('run.py', 'requirements.txt', 'Dockerfile', '.dockerignore'):
            shutil.copy(os.path.join(ROOT, name), d)
        with open(os.path.join(d, 'README.md'), 'w', encoding='utf-8') as f:
            f.write(SPACE_README)
        api.upload_folder(folder_path=d, repo_id=repo, repo_type='space', commit_message='部署拾光 Glint')
    url = f"https://{user.lower()}-{a.space.lower().replace('_', '-').replace('.', '-')}.hf.space"
    print('已部署：', url)
    print('构建要几分钟，可在 https://huggingface.co/spaces/' + repo + ' 看进度')
    if code:
        print('访问口令（只显示这一次，请记下）：', code)


if __name__ == '__main__':
    main()
