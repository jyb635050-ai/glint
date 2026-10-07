(() => {
  'use strict';
  const I18N = {
    zh: {
      brand: '拾光', h1: '把喜欢的瞬间，<br class="m">留在自己手里', sub: '粘贴链接或整段分享文案，挑清晰度和格式，存下视频、音乐与图片。',
      urlPh: '粘贴链接或分享文案', codePh: '输入访问口令', paste: '粘贴', go: '解析', enter: '进入', bili: 'B站', more: '+ 上千个网站',
      all: '全部图片', quality: '清晰度', format: '格式', foot: '只下载你有权保存的内容 · 不记录你粘贴的链接', theme: '深浅色',
      video: '视频', audio: '音频', image: '图片', cover: '封面', download: '下载', preparing: '准备中…', working: '处理中', saved: '已开始下载',
      retry: '再下一次', empty: '请先粘贴链接', badCode: '口令不对', net: '网络出错了，请重试', items: (n) => `${n} 项`,
      h: { mp4: '最兼容，手机相册直接能放', webm: '体积小，网页播放友好', mkv: '原画封装，不转码最快', mp3: '通用音乐格式', m4a: '苹果设备友好', opus: '小体积高音质', flac: '无损', wav: '无压缩原始音频', jpg: '通用、体积小', png: '无损', webp: '新格式、更小' },
      slow: '高清转 MP4 需要重新编码，长视频会慢一些',
      offTitle: '还没连上你的电脑', offWhy: '下载在你家电脑上进行。', offNone: '在家里电脑双击「启动.bat」，然后打开窗口里打印的链接（或扫二维码），这里就会自动连上。',
      offDown: '你家电脑上的拾光好像没开着，或者外网地址已经换了。重新启动后，打开新打印的链接即可。', apiPh: '也可以把窗口里的链接粘贴到这里', connect: '连接',
    },
    en: {
      brand: 'Glint', h1: 'Keep the moments<br class="m"> you love', sub: 'Paste a link or a whole share message, pick quality and format, save video, music and images.',
      urlPh: 'Paste a link or share text', codePh: 'Access code', paste: 'Paste', go: 'Fetch', enter: 'Enter', bili: 'Bilibili', more: '+ 1000s of sites',
      all: 'All images', quality: 'Quality', format: 'Format', foot: 'Only save what you have the right to keep · Links are never logged', theme: 'Theme',
      video: 'Video', audio: 'Audio', image: 'Image', cover: 'Cover', download: 'Download', preparing: 'Preparing…', working: 'Working', saved: 'Download started',
      retry: 'Download again', empty: 'Paste a link first', badCode: 'Wrong code', net: 'Network error, please retry', items: (n) => `${n} item${n > 1 ? 's' : ''}`,
      h: { mp4: 'Plays everywhere', webm: 'Small, web friendly', mkv: 'Original streams, fastest', mp3: 'Universal', m4a: 'Great on Apple devices', opus: 'Small & clear', flac: 'Lossless', wav: 'Uncompressed', jpg: 'Small & universal', png: 'Lossless', webp: 'Modern & small' },
      slow: 'HD to MP4 needs re-encoding; long videos take a while',
      offTitle: 'Not connected to your computer', offWhy: 'Downloads run on your home computer.', offNone: 'Start Glint on your home computer, then open the link it prints (or scan the QR code).',
      offDown: 'Glint on your computer seems to be off, or its address changed. Restart it and open the new link.', apiPh: 'Or paste the link here', connect: 'Connect',
    },
  };
  const FMT = { video: ['mp4', 'webm', 'mkv'], audio: ['mp3', 'm4a', 'opus', 'flac', 'wav'], image: ['jpg', 'png', 'webp'] };
  const PLAT = { youtube: 'YouTube', bilibili: 'Bilibili', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X', generic: 'Web' };
  const $ = (s, r = document) => r.querySelector(s);
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  let lang = store.get('glint.lang') || 'zh';
  let last = null;
  const t = (k) => I18N[lang][k];

  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = lang === 'zh' ? '拾光 Glint' : 'Glint';
    document.querySelectorAll('[data-i]').forEach((el) => { el.innerHTML = t(el.dataset.i); });
    document.querySelectorAll('[data-i-ph]').forEach((el) => { el.placeholder = t(el.dataset.iPh); });
    document.querySelectorAll('[data-i-title]').forEach((el) => { el.title = t(el.dataset.iTitle); });
    $('#lang').textContent = lang === 'zh' ? 'EN' : '中文';
    if (last) render(last);
  }
  $('#lang').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; store.set('glint.lang', lang); applyLang(); });

  // 深浅色：跟随系统 → 浅 → 深 循环
  const THEMES = ['auto', 'light', 'dark'];
  let theme = store.get('glint.theme') || 'auto';
  const applyTheme = () => { if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; };
  $('#theme').addEventListener('click', () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set('glint.theme', theme); applyTheme(); });
  applyTheme();

  // 跟随指针的镜面光
  const panel = $('#panel');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, px = 0, py = 0;
  panel.addEventListener('pointermove', (e) => {
    if (still.matches) return;
    const r = panel.getBoundingClientRect(); px = e.clientX - r.left; py = e.clientY - r.top;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; panel.style.setProperty('--mx', px + 'px'); panel.style.setProperty('--my', py + 'px'); });
  });

  const err = $('#err');
  const showErr = (m) => { err.textContent = m; err.classList.remove('hide'); };
  const hideErr = () => err.classList.add('hide');

  // 后端在哪：同源部署时为空；放在 GitHub Pages 上时用链接 #api=… 记下来的地址（存在本机）
  const REMOTE = /\.github\.io$/.test(location.hostname);
  let API = REMOTE ? (store.get('glint.api') || '') : '';
  let TOKEN = REMOTE ? (store.get('glint.token') || '') : '';
  const withT = (u) => (TOKEN ? u + (u.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN) : u);
  async function api(path, body) {
    const headers = { accept: 'application/json' };
    if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch(API + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  }
  const msg = (r) => (r.j && r.j.error && r.j.error.message) || t('net');

  // 口令
  function lock(on) { $('#gate').classList.toggle('hide', !on); $('#search').classList.toggle('hide', on); $('#sites').classList.toggle('hide', on); if (on) $('#code').focus(); }
  $('#gate').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr();
    const r = await api('/api/login', { code: $('#code').value.trim() });
    if (r.status === 200) { if (REMOTE && r.j.token) { TOKEN = r.j.token; store.set('glint.token', TOKEN); } lock(false); $('#code').value = ''; $('#url').focus(); } else showErr(r.status === 401 ? t('badCode') : msg(r));
  });

  // 解析
  const go = $('#go');
  async function probe() {
    const text = $('#url').value.trim();
    hideErr();
    if (!text) return showErr(t('empty'));
    go.disabled = true; go.classList.add('busy');
    try {
      const r = await api('/api/probe', { url: text });
      if (r.status === 401) { lock(true); return; }
      if (r.status !== 200) { $('#result').classList.add('hide'); return showErr(msg(r)); }
      last = { ...r.j, src: text };
      render(last);
    } catch { showErr(t('net')); } finally { go.disabled = false; go.classList.remove('busy'); }
  }
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); probe(); });
  $('#paste').addEventListener('click', async () => {
    try { const s = await navigator.clipboard.readText(); if (s) { $('#url').value = s; probe(); } } catch { $('#url').focus(); }
  });

  const qLabel = (q) => (q >= 4320 ? ['8K', q] : q >= 2160 ? ['4K', q] : q >= 1440 ? ['2K', q] : q >= 720 ? [q + 'p', 'HD'] : [q + 'p', '']);
  const fmtDur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

  function render(d) {
    $('#title').textContent = d.title;
    $('#plat').textContent = (PLAT[d.platform] || d.platform || 'Web') + ' · ' + t('items')(d.items.length);
    const box = $('#items'); box.innerHTML = '';
    const imgs = d.items.filter((i) => i.kind === 'image');
    const all = $('#all'); all.classList.toggle('hide', imgs.length < 2);
    all.onclick = () => box.querySelectorAll('[data-item=image] [data-t=download]').forEach((b, i) => setTimeout(() => b.click(), i * 700));
    box.classList.toggle('one', d.items.length === 1);
    for (const it of d.items) box.appendChild(card(d, it));
    $('#result').classList.remove('hide');
  }

  function card(d, it) {
    const el = $('#tpl-item').content.firstElementChild.cloneNode(true);
    el.dataset.item = it.kind;
    const kinds = it.kind === 'video' ? ['video', it.audio !== false && 'audio', it.thumbnail && 'image'].filter(Boolean) : it.kind === 'audio' ? ['audio'] : ['image'];
    const st = { kind: kinds[0], quality: it.qualities ? (it.qualities.find((q) => q <= 1080) || it.qualities[it.qualities.length - 1]) : null, format: FMT[kinds[0]][0] };
    const img = $('img', el), thumb = $('.thumb', el);
    if (it.thumbnail) { img.src = withT(API + it.thumbnail); img.onerror = () => thumb.classList.add('empty'); } else thumb.classList.add('empty');
    if (it.kind === 'image') { thumb.style.aspectRatio = it.width && it.height ? `${Math.max(.6, Math.min(1.9, it.width / it.height))}` : '1'; img.style.objectFit = 'contain'; }
    $('.dur', el).textContent = it.duration ? fmtDur(it.duration) : '';
    $('.dims', el).textContent = it.width ? `${it.width}×${it.height}` : '';
    $('.ititle', el).textContent = it.title || '';
    const seg = $('.kinds', el), quals = $('.quals', el), fmts = $('.fmts', el), hint = $('.hint', el), btn = $('[data-t=download]', el);
    if (kinds.length === 1) seg.classList.add('single');

    function draw() {
      seg.innerHTML = kinds.length === 1 ? '' : kinds.map((k) => `<button type="button" role="tab" data-kind="${k}" class="${st.kind === k ? 'on' : ''}">${k === 'image' && it.kind === 'video' ? t('cover') : t(k)}</button>`).join('');
      $('.qrow', el).classList.toggle('hide', st.kind !== 'video');
      quals.innerHTML = st.kind === 'video' ? it.qualities.map((q) => { const [a, b] = qLabel(q); return `<button type="button" class="chip ${st.quality === q ? 'on' : ''}" data-quality="${q}">${a}${b ? ` <small>${b}</small>` : ''}</button>`; }).join('') : '';
      fmts.innerHTML = FMT[st.kind].map((f) => `<button type="button" class="chip ${st.format === f ? 'on' : ''}" data-format="${f}">${f.toUpperCase()}</button>`).join('');
      hint.textContent = st.kind === 'video' && st.format === 'mp4' && st.quality > 1080 ? t('slow') : t('h')[st.format];
      if (!btn.classList.contains('busy')) setBtn(t('download'));
    }
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (!b) return; st.kind = b.dataset.kind; st.format = FMT[st.kind][0]; draw(); });
    quals.addEventListener('click', (e) => { const b = e.target.closest('[data-quality]'); if (!b) return; st.quality = +b.dataset.quality; draw(); });
    fmts.addEventListener('click', (e) => { const b = e.target.closest('[data-format]'); if (!b) return; st.format = b.dataset.format; draw(); });
    const fill = $('.bar-fill', btn);
    function setBtn(text, p) { $('.dl-txt', btn).textContent = text; fill.style.width = p == null ? '0' : Math.round(p * 100) + '%'; }

    btn.addEventListener('click', async () => {
      if (btn.classList.contains('busy')) return;
      hideErr(); btn.classList.add('busy'); btn.classList.remove('done'); setBtn(t('preparing'), 0.02);
      const body = { url: d.src, item: it.id, kind: st.kind, format: st.format };
      if (st.kind === 'video') body.quality = st.quality;
      try {
        const r = await api('/api/jobs', body);
        if (r.status === 401) { lock(true); throw new Error(msg(r)); }
        if (r.status !== 202) throw new Error(msg(r));
        let s;
        for (;;) {
          await new Promise((ok) => setTimeout(ok, 600));
          const p = await api(r.j.poll);
          s = p.j;
          if (p.status !== 200) throw new Error(msg(p));
          if (s.state === 'done') break;
          if (s.state === 'error') throw new Error(s.error.message);
          setBtn(`${t('working')} ${Math.round((s.progress || 0) * 100)}%`, Math.max(0.04, s.progress || 0));
        }
        const a = document.createElement('a'); a.href = withT(API + s.file); a.download = s.name || ''; document.body.appendChild(a); a.click(); a.remove();
        btn.classList.add('done'); setBtn(t('saved'), 1);
        setTimeout(() => { btn.classList.remove('done'); setBtn(t('retry')); }, 2600);
      } catch (e) { showErr(e.message || t('net')); setBtn(t('download')); } finally { btn.classList.remove('busy'); }
    });
    draw();
    return el;
  }

  applyLang();
  // GitHub Pages 版：先找后端
  const offline = $('#offline');
  function needBackend(on, why) {
    offline.classList.toggle('hide', !on);
    $('#search').classList.toggle('hide', on); $('#sites').classList.toggle('hide', on); $('#gate').classList.add('hide');
    if (on) $('#offmsg').textContent = why || t('offWhy');
  }
  async function connect() {
    if (!REMOTE) return true;
    if (!API) { needBackend(true, t('offNone')); return false; }
    try {
      const r = await fetch(API + '/api/health', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      needBackend(false); return true;
    } catch { needBackend(true, t('offDown')); return false; }
  }
  offline.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#apiurl').value.trim();
    const hash = text.includes('#') ? new URLSearchParams(text.split('#')[1]) : null;
    const m = hash && hash.get('api') ? [hash.get('api')] : /https?:\/\/[^\s#]+/.exec(text);
    if (!m) return;
    API = m[0].replace(/\/+$/, ''); store.set('glint.api', API); TOKEN = ''; store.set('glint.token', '');
    if (!(await connect())) return;
    if (hash && hash.get('code')) {
      const r = await api('/api/login', { code: hash.get('code') }).catch(() => ({ status: 0, j: {} }));
      if (r.status === 200 && r.j.token) { TOKEN = r.j.token; store.set('glint.token', TOKEN); }
    }
    start();
  });
  async function start() {
    const r = await api('/api/me').catch(() => ({ status: 0 }));
    if (r.status === 401) lock(true);
  }
  (async () => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (REMOTE && h.get('api')) {
      API = h.get('api').replace(/\/+$/, ''); store.set('glint.api', API);
      history.replaceState(null, '', location.pathname + location.search);
      if (await connect() && h.get('code')) {
        const r = await api('/api/login', { code: h.get('code') }).catch(() => ({ status: 0, j: {} }));
        if (r.status === 200 && r.j.token) { TOKEN = r.j.token; store.set('glint.token', TOKEN); }
      }
    } else if (!(await connect())) return;
    start();
  })();
})();
