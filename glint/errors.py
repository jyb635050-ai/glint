class Fail(Exception):
    """给用户看的错误：HTTP 状态 + 代码 + 中文人话。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def from_ytdlp(msg: str) -> Fail:
    """把 yt-dlp 的英文报错翻成人话。"""
    m = (msg or '').lower()
    if 'unsupported url' in m:
        return Fail(422, 'no_media', '这个页面里没找到能下载的视频或图片')
    if 'sign in' in m or 'login' in m or 'log in' in m or 'cookies' in m or 'confirm you' in m:
        return Fail(403, 'login_required', '平台要求登录或人机验证才给这个内容，本站只下公开内容')
    if 'private' in m:
        return Fail(403, 'login_required', '这是私密内容，下不了')
    if '429' in m or 'rate' in m and 'limit' in m or 'too many' in m:
        return Fail(429, 'rate_limited', '平台限流了，过一会儿再试')
    if 'not available in your country' in m or 'geo' in m and 'restrict' in m:
        return Fail(403, 'unavailable', '这个内容在服务器所在地区看不了')
    if '404' in m or 'not found' in m or 'does not exist' in m or 'removed' in m or 'unavailable' in m:
        return Fail(404, 'not_found', '内容不存在或已被删除')
    if 'drm' in m:
        return Fail(403, 'unavailable', '这个内容有版权加密（DRM），不支持下载')
    return Fail(424, 'unavailable', '平台暂时没给内容，稍后再试')
