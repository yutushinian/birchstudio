/* ============================================================
 * 桦库 birch3 运行时功能模块（v2026-09-08）
 * 在「原白桦整页」(bundle.js) 之上按需求补全：
 *   1) 晒单评论 + 同意授权分享 → 审核通过减免（shares 表）
 *   2) 客户分享墙（已上墙卡片）+ 评论弹幕播放
 *   3) 管理后台「分享审核库」：一行一条、通过/下架/改减免/删除
 *   4) 生辰测石 AI 走 ai-assistant（DeepSeek 方案+绝句 → 通义出图）
 *   5) 下单/购物车入口改为「联系微信」（删除线上购买闭环）
 * 依赖桦库整页 bundle.js 的全局函数/变量；随 js/features.js 之后加载。
 * ============================================================ */
(function () {
  'use strict';
  /* ---------- 桥：读取 bundle 全局（含 let/const 词法绑定） ---------- */
  function get(name) {
    try { return (0, eval)(name); } catch (e) { return void 0; }
  }
  function call(name, args, ctx) {
    var v = get(name);
    if (typeof v === 'function') { try { return v.apply(ctx || window, args || []); } catch (e) { return void 0; } }
    return v;
  }
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    var f = get('escapeHtml');
    if (typeof f === 'function') { try { return f(s); } catch (e) {} }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(msg) { call('toast', [msg]); }
  function dbHint(e, action) {
    var m = e && (e.message || String(e)) || '';
    if (/shares|permission denied|does not exist|relation|row.?level security|could not find the function|function .* not found/i.test(m)) {
      toast((action ? action + '失败：' : '') + '请先在 Supabase SQL Editor 执行「桦库-完整SQL.sql」建库（含 shares 表与审核函数）后重试');
      return true;
    }
    return false;
  }
  function sup() {
    var c = get('supabaseClient');
    if (c) return c;
    var ok = false;
    call('ensureSupabase', [function () { ok = true; }]);
    return get('supabaseClient');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var SUPABASE_URL = get('SUPABASE_URL') || '';
  var SUPABASE_ANON = get('SUPABASE_ANON_KEY') || '';
  var AI_DEFAULT_URL = (SUPABASE_URL ? SUPABASE_URL.replace(/\/$/, '') : '') + '/functions/v1/birch-ai';
  var CFG_KEY = 'birch_share_discount';
  var LOCAL_KEY = 'birch3_shares_v1';

  function localMap() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function localSave(map) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(map)); } catch (e) {} }
  function localState(code) { return localMap()[String(code)] || null; }

  function firstImg(u) {
    if (!u) return '';
    var f = get('splitImages');
    if (typeof f === 'function') { try { var a = f(u); if (a && a.length) return a[0]; } catch (e) {} }
    return String(u).split(/[|,;\n]/)[0] || '';
  }
  function isVideo(u) { return /\.(mp4|webm|mov)(\?|$)/i.test(String(u || '')); }
  function fmtTime(t) {
    if (!t) return '';
    try {
      var d = new Date(t);
      if (isNaN(d.getTime())) return String(t).slice(0, 16);
      var p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }
  function wechatBtn() {
    var w = call('BRAND_CONTACT', []) || {};
    var list = w.wechats || [];
    if (!list.length) return '';
    var parts = [];
    for (var i = 0; i < list.length && i < 2; i++) {
      parts.push('<button class="b3-btn b3-btn-gold" style="width:auto;padding:8px 16px;font-size:13px;" onclick="window.__b3CopyWx(' + i + ')">微信 ' + esc(list[i]) + ' · 复制</button>');
    }
    return '<div class="b3-row" style="justify-content:center;">' + parts.join('') + '</div>';
  }
  window.__b3CopyWx = function (i) { call('copyWechat', [i]); };

  /* ============================================================
   * 遮罩/面板工厂
   * ============================================================ */
  function makeMask() {
    var m = document.createElement('div');
    m.className = 'b3-mask';
    m.onclick = function () { closeAll(); };
    document.body.appendChild(m);
    return m;
  }
  function makePanel(id, wide) {
    var p = document.createElement('div');
    p.className = 'b3-panel' + (wide ? ' b3-wall-panel' : '');
    p.id = id;
    document.body.appendChild(p);
    return p;
  }
  var mask = null;
  var openStack = [];
  function ensureMask() { if (!mask) mask = makeMask(); return mask; }
  function showPanel(p) {
    ensureMask().classList.add('show');
    p.classList.add('show');
    openStack.push(p);
    call('lockScroll', [true]);
  }
  function hidePanel(p) {
    p.classList.remove('show');
    var i = openStack.indexOf(p);
    if (i > -1) openStack.splice(i, 1);
    if (!openStack.length) {
      mask.classList.remove('show');
      var any = call('anyOverlayOpen', []);
      if (!any) call('lockScroll', [false]);
    }
  }
  function closeAll() {
    while (openStack.length) hidePanel(openStack[openStack.length - 1]);
    stopDanmaku();
  }
  function head(title, id) {
    return '<div class="b3-head"><h3>' + title + '</h3><button class="b3-close" onclick="window.__b3Close(\'' + id + '\')">✕</button></div>';
  }
  window.__b3Close = function (id) { var p = $(id); if (p) hidePanel(p); var dm = $('b3DmStage'); if (id === 'b3WallPanel' || !id) stopDanmaku(); };

  /* ============================================================
   * 客户授权分享区（首页「臻选推荐」正上方内嵌）+ 留言弹幕
   * ============================================================ */
  var dmTimer = null, dmQueue = [], dmColors = ['b3-dm-1', 'b3-dm-2', 'b3-dm-3'], b3SData = [];
  var EMAIL_URL = (get('SUPABASE_URL') || '').replace(/\/$/, '') + '/functions/v1/email-send';
  function sendShareMail(row, subject) {
    try {
      if (!EMAIL_URL) return;
      fetch(EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'share',
          subject: subject || '【白桦】新授权晒单（弹幕库）',
          fields: {
            官方码: row.code || '', 品名: row.name || '', 专属编号: row.batch || '',
            留言: row.comment || '（未留言）', 提交时间: new Date().toLocaleString('zh-CN')
          }
        })
      }).catch(function () {});
    } catch (e) {}
  }
  function ensureShareSection() {
    var sec = $('b3ShareSec');
    if (sec) return sec;
    sec = document.createElement('section');
    sec.className = 'b3-shares';
    sec.id = 'b3ShareSec';
    sec.innerHTML =
      '<div class="b3-shares-inner">' +
      '<header class="b3-shares-head">' +
      '<div class="b3-shares-tt">' +
      '<span class="b3-shares-eyebrow">CUSTOMER · 客户授权晒单</span>' +
      '<h2>客户晒单</h2>' +
      '</div>' +
      '<a class="b3-shares-cta" href="javascript:void 0" onclick="window.__b3GoVerify()">持有官方码？晒单展示 →</a>' +
      '</header>' +
      '<div class="b3-dm-line" id="b3DmLine" style="display:none;"><span class="b3-dm-hint">💬 客户留言弹幕</span><div class="b3-dm-layer" id="b3DmLayerI"></div></div>' +
      '<div class="b3-share-grid" id="b3ShareGrid"></div>' +
      '</div>';
    var lux = document.getElementById('bLux');
    if (lux && lux.parentNode) lux.parentNode.insertBefore(sec, lux);
    else document.body.appendChild(sec);
    /* 可见时才播弹幕 */
    try {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0] && entries[0].isIntersecting) { if (dmQueue.length) startDanmaku(); }
        else stopDanmaku();
      }, { threshold: 0.05 });
      io.observe(sec);
    } catch (e) {}
    return sec;
  }
  window.__b3GoVerify = function () {
    closeAll();
    setTimeout(function () { call('showVerifyOptions', []); }, 60);
  };
  function bulletText(s) {
    var t = String(s || '').trim().replace(/\s+/g, ' ');
    return t.length > 42 ? t.slice(0, 42) + '…' : t;
  }
  function pushBullet(txt) {
    var layer = $('b3DmLayerI');
    if (!layer || !txt) return;
    var b = document.createElement('div');
    b.className = 'b3-dm-bullet ' + dmColors[Math.floor(Math.random() * dmColors.length)];
    b.innerHTML = txt;
    b.style.top = (18 + Math.random() * 52) + '%';
    var dur = 9 + Math.random() * 8;
    b.style.animationDuration = dur + 's';
    b.style.animationDelay = (-Math.random() * 6) + 's';
    layer.appendChild(b);
    setTimeout(function () { try { layer.removeChild(b); } catch (e) {} }, dur * 1000 + 9000);
  }
  function startDanmaku() {
    stopDanmaku();
    if (!dmQueue.length) return;
    var i = 0;
    dmTimer = setInterval(function () {
      if (document.hidden) return;
      var line = $('b3DmLine');
      if (!line || line.style.display === 'none') return;
      if (i >= dmQueue.length) i = 0;
      var q = dmQueue[i++];
      if (!q) return;
      pushBullet(esc(q.txt));
    }, 1100);
  }
  function stopDanmaku() {
    if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
    var layer = $('b3DmLayerI');
    if (layer) layer.innerHTML = '';
  }
  async function loadSectionData() {
    var sb = sup();
    if (!sb) return { rows: [], recMap: {} };
    try {
      var r = await sb.from('shares').select('*').eq('approved', true).order('created_at', { ascending: false }).limit(50);
      if (r.error) throw r.error;
      var rows = r.data || [];
      var recMap = {};
      var codes = rows.filter(function (x) { return x.code; }).map(function (x) { return String(x.code); });
      if (codes.length) {
        try {
          var rr = await sb.from('records').select('id,product_name,batch_no,message,image_url').in('id', codes.slice(0, 50)).limit(60);
          if (!rr.error && rr.data) {
            rr.data.forEach(function (rc) { recMap[String(rc.id)] = rc; });
          }
        } catch (e) {}
      }
      return { rows: rows, recMap: recMap };
    } catch (e) { dbHint(e, ''); return { rows: [], recMap: {} }; }
  }
  /* 订单图 → 可显示地址（与橱窗一致走 fullImg 解析） */
  function absImg(u) {
    if (!u) return '';
    var f = get('fullImg');
    if (typeof f === 'function') { try { var a = f(u); if (a) return a; } catch (e) {} }
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    return u;
  }
  /* 卡片与臻品橱窗(gallery-item)完全一致：图片 + 居中品名；点击看图（说明含设计理念） */
  function shareCard(s, rc) {
    var img = absImg(s.img || (rc && rc.image_url) || '');
    var name = s.name || (rc && rc.product_name) || '白桦定制';
    var idea = rc && rc.message ? String(rc.message) : (s.idea || '');
    var idx = b3SData.length;
    b3SData.push({ img: img, name: name, idea: idea });
    var media = img ? (isVideo(img) ? '<video src="' + esc(img) + '" muted loop playsinline></video>'
      : '<img src="' + esc(img) + '" alt="' + esc(name) + '" loading="lazy">')
      : '<div style="width:100%;height:160px;display:flex;align-items:center;justify-content:center;background:#e8f5ef;font-size:30px;">💎</div>';
    return '<div class="gallery-item b3-share-item" onclick="window.__b3OpenShareImg(' + idx + ')">' +
      media +
      '<div class="gallery-name">' + esc(name) + '</div>' +
      '</div>';
  }
  function renderShareSection(rows, recMap) {
    var grid = $('b3ShareGrid');
    if (!grid) return;
    var approved = (rows || []).filter(function (s) { return s.approved === true; });
    var cardRows = approved.filter(function (s) { return s.code && String(s.code).trim() !== ''; });
    dmQueue = approved.filter(function (s) { return s.comment && String(s.comment).trim().length > 1; })
      .map(function (s) { return { name: (s.name || '白桦精选').slice(0, 12), txt: bulletText(s.comment), extra: '' }; });
    var line = $('b3DmLine');
    if (line) line.style.display = dmQueue.length ? 'block' : 'none';
    if (!cardRows.length) {
      grid.innerHTML = '<div class="b3-empty2">✨ 还没有客户授权晒单<br>持有官方码 → 官方验证 → 授权晒单（可选留言）→ 提交后自动展示于此<br><button class="b3-btn b3-btn-gold" style="margin-top:12px;" onclick="window.__b3GoVerify()">📸 去授权晒单</button></div>';
      return;
    }
    b3SData = [];
    grid.innerHTML = cardRows.slice(0, 30).map(function (s) {
      var rc = recMap ? recMap[String(s.code)] : null;
      return shareCard(s, rc);
    }).join('');
  }
  window.__b3OpenShareImg = function (i) {
    var o = b3SData[i];
    if (o) window.__b3Lightbox(o.idea, o.img, o.name);
  };
  async function refreshShares() {
    try {
      ensureShareSection();
      var d = await loadSectionData();
      renderShareSection(d.rows, d.recMap);
      var s = $('b3ShareSec');
      if (s) {
        var r = s.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0 && dmQueue.length) startDanmaku();
      }
    } catch (e) {}
  }
  window.__b3RefreshShares = function () { refreshShares(); };
  window.__b3GoShares = function () {
    closeAll();
    setTimeout(function () {
      var s = $('b3ShareSec');
      if (s && s.scrollIntoView) { try { s.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { s.scrollIntoView(); } }
      setTimeout(function () { refreshShares(); }, 500);
    }, 80);
  };
  window.openShareWall = window.__b3GoShares; /* 兼容旧引用 */
  window.__b3Lightbox = function (comment, img, name) {
    var lb = $('b3Lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'b3Lightbox';
      lb.className = 'b3-lightbox';
      lb.innerHTML = '<div id="b3LbMedia"></div><div class="cap" id="b3LbCap"></div><button class="b3-btn b3-btn-gold" style="margin-top:4px;" onclick="window.__b3CloseLb()">关闭</button>';
      lb.addEventListener('click', function (e) { if (e.target === lb) window.__b3CloseLb(); });
      document.body.appendChild(lb);
    }
    var m = $('b3LbMedia');
    if (img) {
      m.innerHTML = isVideo(img) ? '<video src="' + esc(img) + '" controls autoplay loop playsinline></video>' : '<img src="' + esc(img) + '" alt="">';
    } else {
      m.innerHTML = '<div style="font-size:60px;padding:20px;">💎</div>';
    }
    $('b3LbCap').textContent = (name ? name + ' · ' : '') + (comment ? '“' + comment + '”' : '');
    lb.classList.add('show');
  };
  window.__b3CloseLb = function () { var lb = $('b3Lightbox'); if (lb) lb.classList.remove('show'); };

  /* ============================================================
   * 晒单评论 · 授权分享 → 减免（入口：验证结果卡）
   * ============================================================ */
  async function getDiscountCfg() {
    try {
      var sb = sup();
      if (sb) {
        var r = await sb.rpc('get_app_text', { p_key: CFG_KEY });
        if (r && !r.error && r.data) { var n = Number(String(r.data).trim()); if (n > 0) return Math.round(n); }
      }
    } catch (e) {}
    return 10;
  }
  function shareModalHTML(rec, discount, state) {
    var img0 = rec && rec.image_url ? firstImg(rec.image_url) : '';
    var preview =
      '<div style="display:flex;gap:12px;align-items:center;background:#fff;border:1px solid rgba(74,124,89,.3);border-radius:14px;padding:10px;margin-bottom:6px;">' +
      (img0 ? (isVideo(img0) ? '<video style="width:64px;height:64px;border-radius:10px;object-fit:cover;flex:0 0 64px;" src="' + esc(img0) + '" muted playsinline></video>'
        : '<img style="width:64px;height:64px;border-radius:10px;object-fit:cover;flex:0 0 64px;" src="' + esc(img0) + '" loading="lazy" onerror="this.style.opacity=.15">')
        : '<div style="width:64px;height:64px;border-radius:10px;flex:0 0 64px;display:flex;align-items:center;justify-content:center;background:#eef2ea;font-size:22px;">💎</div>') +
      '<div style="flex:1;min-width:0;">' +
      '<div style="font-size:14px;font-weight:700;color:#2f5c40;">' + esc(rec ? rec.product_name || '白桦定制' : '白桦定制') + '</div>' +
      '<div style="font-size:11px;color:#8a9a88;margin-top:3px;font-family:monospace;">官方码 ' + esc(rec ? rec.id || '' : '') + (rec && rec.batch_no ? ' · ' + esc(rec.batch_no) : '') + '</div>' +
      '<div style="font-size:11px;color:#8a9a88;margin-top:3px;">将按订单原样展示图片与信息（无需另选）</div>' +
      '</div></div>';
    var prefix = '<div class="b3-form">';
    if (state && state.approved) {
      return prefix + '<div class="b3-status ok"><div class="big">✅ 已授权展示</div>该晒单当前展示在首页「客户晒单」区（留言以弹幕播放）。<br>联系微信可了解更多。<br><br>' + wechatBtn() + '</div></div>';
    }
    if (state && !state.approved) {
      return prefix + '<div class="b3-status warn"><div class="big">ℹ️ 当前未展示</div>该官方码曾授权晒单，目前首页未展示（可能已被品牌方隐藏或删除）。<br>如需重新晒单请点下方按钮。<br><br><div class="b3-row" style="justify-content:center;">' + wechatBtn() + '</div><div class="b3-row" style="justify-content:center;margin-top:8px;"><button class="b3-btn b3-btn-soft" style="width:auto;padding:8px 16px;font-size:13px;" onclick="window.__b3RefreshState()">↻ 刷新状态</button><button class="b3-btn b3-btn-soft" style="width:auto;padding:8px 16px;font-size:13px;" onclick="window.__b3ResetShare()">✎ 重新晒单</button></div></div></div>';
    }
    return prefix +
      '<div class="b3-quote">同意授权后，您的订单将按原样展示在首页「客户晒单」区（图片 / 品名 / 设计理念取自订单记录）；<br>下方可选是否留言，留言会以弹幕播放。</div>' +
      preview +
      '<label>留言（选填，可不留言）</label>' +
      '<textarea id="b3Comment" maxlength="120" placeholder="想说点什么就说点什么（≤120 字）：佩戴感受、给白桦的话… 留了言会以弹幕滚动播放；不填则只展示订单。"></textarea>' +
      '<label class="b3-check"><input type="checkbox" id="b3Consent" checked><span><b>我同意授权</b>：白桦可将我该订单的图片、产品信息与官方码展示于官网「客户授权分享」区；若我填写留言，则一并公开展示并作为弹幕播放。仅用于品牌展示，不另作他用。</span></label>' +
      '<div class="b3-row" style="justify-content:center;margin-top:14px;">' +
      '<button class="b3-btn b3-btn-main" id="b3SubmitShare">✅ 同意授权 · 提交晒单</button></div>' +
      '<div class="b3-muted" style="text-align:center;margin-top:8px;">提交后由品牌方后台审核；如需撤下可联系客服。</div></div>';
  }
  window.__b3PickImg = function (el, i) {
    var all = el.parentNode.querySelectorAll('.b3-imgchip');
    for (var k = 0; k < all.length; k++) all[k].classList.remove('on');
    el.classList.add('on');
    el.parentNode.setAttribute('data-pick', i);
  };
  window.__b3RefreshState = function () {
    var id = get('currentVerifyId');
    if (id) renderSharePanel(id);
  };
  window.__b3ResetShare = function () {
    var id = get('currentVerifyId');
    if (!id) { toast('请先完成官方验证'); return; }
    if (!window.confirm('将清除本机该码的晒单记录并重新填写。若旧评论仍在后台待审，可在后台删除旧条目。继续吗？')) return;
    var map = localMap();
    delete map[String(id)];
    localSave(map);
    renderSharePanel(id);
  };
  var sharePanel = null, shareRec = null, shareDiscount = 10;
  function ensureSharePanel() {
    if (sharePanel) return sharePanel;
    sharePanel = makePanel('b3SharePanel');
    document.body.appendChild(sharePanel);
    return sharePanel;
  }
  async function renderSharePanel(code) {
    var sb = sup();
    shareRec = null;
    if (sb) {
      try {
        var r = await sb.from('records').select('id,product_name,batch_no,message,image_url').eq('id', code).limit(1);
        if (!r.error && r.data && r.data.length) shareRec = r.data[0];
      } catch (e) {}
    }
    shareDiscount = await getDiscountCfg();
    var local = localState(code) || null;
    var approved = null;
    if (sb && local) {
      try {
        var q = await sb.from('shares').select('id,discount,comment,approved').eq('code', String(code)).eq('approved', true).limit(1);
        if (!q.error && q.data && q.data.length) approved = q.data[0];
      } catch (e) {}
    }
    var st = approved ? { approved: true, discount: approved.discount || shareDiscount } : (local ? { approved: false, discount: local.discount || shareDiscount } : null);
    var p = ensureSharePanel();
    p.innerHTML = head('晒单授权', 'b3SharePanel') + '<div class="b3-body">' + shareModalHTML(shareRec, shareDiscount, st) + '</div>';
    showPanel(p);
    var btn = $('b3SubmitShare');
    if (btn) btn.onclick = function () { submitShare(code); };
  }
  async function submitShare(code) {
    var sb = sup();
    if (!sb) { toast('数据库未就绪，请刷新重试'); return; }
    var comment = ($('b3Comment') ? $('b3Comment').value : '').trim();
    var consentEl = $('b3Consent');
    if (consentEl && !consentEl.checked) { toast('请勾选「同意授权」后再提交'); return; }
    var img = shareRec && shareRec.image_url ? firstImg(shareRec.image_url) : '';
    var btn = $('b3SubmitShare');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    try {
      var row = {
        code: String(code), name: shareRec ? (shareRec.product_name || '') : '',
        batch: shareRec ? (shareRec.batch_no || '') : '', idea: '',
        img: img, comment: comment, discount: shareDiscount,
        contact: '', consent: true, approved: true
      };
      var r = await sb.from('shares').insert([row]);
      if (r.error) throw r.error;
      var map = localMap();
      map[String(code)] = { approved: true, discount: shareDiscount, ts: Date.now() };
      localSave(map);
      sendShareMail(row);
      hidePanel(sharePanel);
      var p = ensureSharePanel();
      var msgLine = comment ? '· 您的留言将<b>以弹幕</b>滚动播放' : '· 未留言：仅展示订单卡片';
      p.innerHTML = head('提交成功 🎉', 'b3SharePanel') + '<div class="b3-body"><div class="b3-status ok"><div class="big">📨 晒单已提交</div>已即时展示在首页<b>「客户晒单」</b>区<br>' + msgLine + '<br>· 已自动<b>邮件通知品牌方</b>（可在后台弹幕管理库调整显示）<br><br>' + wechatBtn() + '</div><div class="b3-row" style="justify-content:center;margin-top:10px;"><button class="b3-btn b3-btn-soft" style="width:auto;" onclick="window.__b3GoShares()">⬆️ 查看客户晒单区</button></div></div>';
      showPanel(p);
      toast('✅ 已提交并展示，已邮件通知品牌方');
    } catch (e) {
      if (!dbHint(e, '提交')) toast('提交失败：' + (e && e.message ? e.message : e));
      if (btn) { btn.disabled = false; btn.textContent = '✅ 同意授权 · 提交晒单'; }
    }
  }

  /* ---- 验证结果卡上注入「晒单」入口 ---- */
  var ctaInjected = false;
  function injectShareCta() {
    var resultTitle = $('resultTitle');
    var rp = $('resultPanel');
    if (!rp || !resultTitle) return;
    var ok = resultTitle.classList && (resultTitle.classList.contains('title-success') || resultTitle.classList.contains('title-warn'));
    var id = get('currentVerifyId');
    var exist = rp.querySelector('.b3-share-cta');
    if (!ok || !id) {
      ctaInjected = false;
      if (exist) exist.parentNode.removeChild(exist);
      return;
    }
    if (exist) return;
    var wrap = document.createElement('div');
    wrap.className = 'b3-share-cta';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:2px 0 10px;';
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    d.innerHTML = '<button class="b3-btn b3-btn-main" style="flex:1;min-width:150px;font-size:13.5px;padding:10px 14px;" onclick="window.__b3OpenShare()">✅ 晒单授权分享</button>' +
      '<button class="b3-btn b3-btn-gold" id="b3WheelCta" style="flex:1;min-width:120px;font-size:13.5px;padding:10px 14px;" onclick="window.__b3Wheel()">🎡 幸运转盘减免</button>';
    wrap.appendChild(d);
    var tip = document.createElement('div');
    tip.className = 'b3-muted';
    tip.style.cssText = 'font-size:11px;color:#6b7a66;';
    tip.textContent = '同意授权晒单（图片 / 品名 / 设计理念取自订单），提交后即展示在首页「客户晒单」区，并邮件通知品牌方；留言以弹幕播放';
    wrap.appendChild(tip);
    var browse = $('browseBtn');
    if (browse && browse.parentNode === rp) rp.insertBefore(wrap, browse);
    else rp.appendChild(wrap);
    try { window.__b3SyncWheelCta(id); } catch (e) {}
    ctaInjected = true;
  }
  window.__b3OpenShare = function () {
    var id = get('currentVerifyId');
    if (!id) { toast('请先完成官方验证'); return; }
    renderSharePanel(id);
  };
  window.__b3Wheel = function () {
    var codeId = get('currentVerifyId');
    closeAll();
    setTimeout(function () {
      if (codeId) { try { window.__b3OpenCodeWheel(codeId); } catch (e) { call('openWheel', []); } }
      else call('openWheel', []);
    }, 80);
  };

  function watchVerifyResult() {
    var rp = $('resultPanel');
    if (!rp) return;
    var obs = new MutationObserver(function () { injectShareCta(); });
    obs.observe(rp, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    injectShareCta();
  }

  /* ============================================================
   * 管理后台：弹幕管理库（每行一条晒单/留言；可显隐/删除；自动邮件）
   * ============================================================ */
  var secSharesEl = null, secTab = 'approved';
  function ensureAdminUI() {
    var home = $('adminHome');
    if (!home) return;
    // 1) 后台卡片
    if (!$('b3AdminCard')) {
      var grid = home.querySelector('.admin-grid');
      if (grid) {
        var card = document.createElement('div');
        card.className = 'admin-card';
        card.id = 'b3AdminCard';
        card.setAttribute('onclick', "openAdminSection('secShares')");
        card.innerHTML = '<div class="admin-card-cover"><span class="admin-chip">📣</span></div><div class="admin-card-info"><div class="admin-card-name">弹幕管理库</div><div class="admin-card-desc" style="font-size:11px;color:var(--text-light);">晒单/留言自动入库 · 每行一条 · 可显隐/删除</div></div>';
        grid.appendChild(card);
      }
    }
    // 2) 审核区页面
    if (!$('secShares')) {
      secSharesEl = document.createElement('div');
      secSharesEl.className = 'admin-section-page';
      secSharesEl.id = 'secShares';
      secSharesEl.innerHTML =
        '<button class="back-btn" onclick="goBackAdmin()">← 返回</button>' +
        '<h3 style="margin-bottom:6px;color:var(--text-dark)">💬 弹幕管理库（客户晒单 · 每行一条）</h3>' +
        '<p style="font-size:12px;color:var(--text-light);margin-bottom:8px;line-height:1.9;">客户「官方验证 → 授权晒单（可选留言）」后<b>自动入库并即时展示</b>，同时自动发邮件到后台指定邮箱（设置 → 邮件设置可改收件人）。此处统一管理：<b>显示 / 隐藏 / 删除</b>某条（隐藏后不再上首页卡片与弹幕）。</p>' +
        '<div class="b3-row" style="margin:2px 0 10px;"><span style="flex:1"></span>' +
        '<span style="font-size:12px;color:var(--text-light);" id="b3SecStats"></span>' +
        '<button class="b3-tab" onclick="window.__b3RefreshShares()">↻ 刷新</button></div>' +
        '<div class="b3-admin-tabs">' +
        '<button class="b3-tab on" data-t="approved" onclick="window.__b3SecTab(\'approved\')">✅ 显示中</button>' +
        '<button class="b3-tab" data-t="pending" onclick="window.__b3SecTab(\'pending\')">🙈 已隐藏</button>' +
        '<button class="b3-tab" data-t="all" onclick="window.__b3SecTab(\'all\')">全部</button></div>' +
        '<div style="display:flex;gap:6px;align-items:center;margin:8px 0 10px;flex-wrap:wrap;background:rgba(255,255,255,.7);border:1px solid rgba(74,124,89,.3);border-radius:12px;padding:8px;">' +
        '<span style="font-size:12.5px;color:#2f5c40;font-weight:700;">＋ 手动新增弹幕</span>' +
        '<input id="b3ManualText" placeholder="弹幕内容（≤120 字）" style="flex:1;min-width:150px;border:1px solid rgba(74,124,89,.4);border-radius:8px;padding:8px 10px;font-size:13px;background:#fff;">' +
        '<input id="b3ManualName" placeholder="署名（默认 白桦精选）" style="width:120px;border:1px solid rgba(74,124,89,.4);border-radius:8px;padding:8px 10px;font-size:12.5px;background:#fff;">' +
        '<button class="b3-mini ok" style="flex:0 0 auto;" onclick="window.__b3ManualAdd()">添加</button></div>' +
        '<div id="b3AdminList" class="b3-admin-list" style="margin-top:10px;"></div>';
      var ref = document.getElementById('secNotice') || document.getElementById('secGallery') || home.nextElementSibling;
      if (ref && ref.parentNode) ref.parentNode.insertBefore(secSharesEl, ref);
      else document.body.appendChild(secSharesEl);
    }
  }
  window.__b3SecTab = function (t) {
    secTab = t;
    var tabs = document.querySelectorAll('#secShares .b3-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-t') === t);
    renderSharesAdmin();
  };
  function adminPwd() { var p = get('currentAdminPwd'); return p || null; }
  window.__b3SaveDiscountCfg = async function () {
    var v = Number(($('b3DiscountCfg') || {}).value);
    var pwd = adminPwd();
    if (!v || v < 0) { toast('请填写正确的减免金额'); return; }
    if (!pwd) { toast('请先登录管理员账号进入后台'); return; }
    var sb = sup();
    if (!sb) return;
    call('showLoading', ['正在保存减免配置…']);
    try {
      var r = await sb.rpc('set_app_data', { p_key: CFG_KEY, p_data: JSON.stringify(String(v)), p_pwd: pwd });
      if (r.error || r.data === false) { toast('保存失败：' + (r.error ? r.error.message : '密码无效')); return; }
      toast('✅ 默认减免 ¥' + v + ' 已保存');
    } finally { call('hideLoading', []); }
  };
  async function listSharesAll() {
    var pwd = adminPwd();
    if (!pwd) { toast('请先登录管理员账号进入后台'); return null; }
    var sb = sup();
    if (!sb) return null;
    var r = await sb.rpc('list_shares', { p_pwd: pwd });
    if (r.error) { if (!dbHint(r.error, '读取')) toast('读取失败：' + r.error.message); return null; }
    return r.data || [];
  }
  function adminRow(s) {
    var img = firstImg(s.img);
    var media = img ? (isVideo(img) ? '<video class="b3-card-img" src="' + esc(img) + '" muted playsinline></video>' : '<img class="b3-card-img" src="' + esc(img) + '" loading="lazy" onerror="this.style.display=\'none\'">') : '<div class="b3-card-img-ph" style="width:58px;height:58px;flex:0 0 58px;font-size:20px;">💎</div>';
    var st = s.approved ? '<span style="color:#4a7c59;font-weight:700;">✅ 显示中</span>' : '<span style="color:#d4a03d;font-weight:700;">🙈 已隐藏</span>';
    return '<div class="b3-arow" data-id="' + s.id + '">' + media +
      '<div class="b3-arow-info"><div class="t">' + esc(s.name || '白桦定制') + '　' + st + '</div>' +
      '<div class="c">码 ' + esc(s.code || '') + (s.batch ? ' · ' + esc(s.batch) : '') + ' · ' + fmtTime(s.created_at) + (s.consent ? ' · 已授权' : ' · ⚠️未授权') + '</div>' +
      (s.comment ? '<div class="m">💬 ' + esc(s.comment) + '</div>' : '') +
      (s.idea ? '<div class="m" style="background:#f2f4ef;">✨ ' + esc(s.idea) + '</div>' : '') +
      '<div class="b3-arow-ops">' +
      (s.approved
        ? '<button class="b3-mini off" onclick="window.__b3SetShare(' + s.id + ',false)">🙈 隐藏</button>'
        : '<button class="b3-mini ok" onclick="window.__b3SetShare(' + s.id + ',true)">✅ 显示</button>') +
      '<button class="b3-mini del" onclick="window.__b3DelShare(' + s.id + ')">🗑 删除</button>' +
      '</div></div></div>';
  }
  async function renderSharesAdmin() {
    var listEl = $('b3AdminList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="b3-empty">加载中…</div>';
    var rows = await listSharesAll();
    if (rows === null) { listEl.innerHTML = '<div class="b3-empty">读取失败：请确认已用管理员账号进入后台（管理员密码在左侧顶栏登录）。</div>'; return; }
    var all = rows;
    window.__b3AdminRows = all;
    var filtered = secTab === 'all' ? all : all.filter(function (s) { return secTab === 'approved' ? s.approved : !s.approved; });
    var st = $('b3SecStats');
    if (st) {
      var on = all.filter(function (s) { return s.approved; }).length;
      var off = all.length - on;
      st.textContent = '共 ' + all.length + ' 条 · 显示中 ' + on + ' · 已隐藏 ' + off;
    }
    if (!filtered.length) {
      listEl.innerHTML = '<div class="b3-empty">' + (secTab === 'pending' ? '🙈 暂无已隐藏条目' : (secTab === 'approved' ? '✅ 暂无显示中的晒单' : '暂无记录')) + '<br>客户晒单提交后自动进入此库（已发邮件通知）。</div>';
      return;
    }
    listEl.innerHTML = filtered.map(adminRow).join('');
  }
  window.__b3SetShare = async function (id, approved) {
    var pwd = adminPwd();
    if (!pwd) return;
    call('showLoading', [approved ? '正在显示…' : '正在隐藏…']);
    try {
      var sb = sup();
      var r = await sb.rpc('set_share_approved', { p_id: id, p_approved: approved, p_pwd: pwd });
      if (r.error || r.data === false) { toast('操作失败：' + (r.error ? r.error.message : '管理员校验未通过')); return; }
      toast(approved ? '✅ 已显示（首页卡片与弹幕已恢复）' : '🙈 已隐藏（首页与弹幕同步移除）');
      refreshShares();
      renderSharesAdmin();
      if (typeof loadWallData === 'function') { /* 下次打开自动刷新 */ }
    } finally { call('hideLoading', []); }
  };
  window.__b3SetDiscount = async function (id, btn) {
    var row = btn.closest('.b3-arow');
    var inp = row ? row.querySelector('[data-discount]') : null;
    var v = Number(inp ? inp.value : 0);
    if (!v || v < 0) { toast('请填写金额'); return; }
    var pwd = adminPwd();
    if (!pwd) return;
    var sb = sup();
    var r = await sb.rpc('set_share_discount', { p_id: id, p_discount: v, p_pwd: pwd });
    if (r.error || r.data === false) { toast('保存失败：' + (r.error ? r.error.message : '管理员校验未通过')); return; }
    toast('✅ 该条减免已改为 ¥' + v);
  };
  window.__b3ManualAdd = async function () {
    var txt = ($('b3ManualText') ? $('b3ManualText').value : '').trim();
    if (txt.length < 1 || txt.length > 120) { toast('弹幕内容需 1~120 字'); return; }
    var nm = ($('b3ManualName') ? $('b3ManualName').value : '').trim() || '白桦精选';
    var sb = sup();
    if (!sb) { toast('数据库未就绪'); return; }
    try {
      var r = await sb.from('shares').insert([{
        code: '', name: nm, batch: '', idea: '', img: '', comment: txt,
        consent: true, approved: true
      }]);
      if (r.error) throw r.error;
      toast('✅ 已新增弹幕并展示');
      if ($('b3ManualText')) $('b3ManualText').value = '';
      refreshShares();
      renderSharesAdmin();
    } catch (e) {
      if (!dbHint(e, '新增')) toast('新增失败：' + ((e && e.message) || e));
    }
  };
  window.__b3DelShare = async function (id) {
    if (!window.confirm('确定删除该条弹幕/晒单吗？删除后首页卡片与弹幕同步移除，不可恢复。')) return;
    var pwd = adminPwd();
    if (!pwd) return;
    var sb = sup();
    var r = await sb.rpc('delete_share', { p_id: id, p_pwd: pwd });
    if (r.error || r.data === false) { toast('删除失败：' + (r.error ? r.error.message : '管理员校验未通过')); return; }
    toast('🗑 已删除');
    renderSharesAdmin();
  };

  /* ---- 幸运转盘按码开关（records.wheel_enabled） ---- */
  var dbWheelBusy = false;
  function __b3DbWheelUI() {
    var wrap = $('dbListWrap');
    if (!wrap || dbWheelBusy) return;
    var sb = sup();
    if (!sb) return;
    dbWheelBusy = true;
    sb.from('records').select('id,wheel_enabled,wheel_spun').limit(300).then(function (r) {
      dbWheelBusy = false;
      var st = {}, st2 = {};
      if (!r.error && r.data) r.data.forEach(function (x) { st[String(x.id)] = x.wheel_enabled !== false; st2[String(x.id)] = !!x.wheel_spun; });
      var rows = wrap.querySelectorAll('.db-record');
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i].getAttribute('data-id');
        var box = rows[i].querySelector('.b3-wheel-box');
        if (box && !box.querySelector('.b3-spun-ctl')) {
          var sc = document.createElement('span');
          sc.className = 'b3-spun-ctl';
          sc.style.cssText = 'margin-left:auto;font-size:11px;';
          sc.innerHTML = '<span data-spun style="color:#c25c5c;font-weight:700;display:none;">已抽</span>' +
            '<button data-reset style="display:none;font-size:11px;color:#2f5c40;background:none;border:1px solid #4a7c59;border-radius:999px;padding:2px 8px;cursor:pointer;">重置抽奖</button>';
          sc.addEventListener('click', function (ev) {
            var btn = ev.target.closest('[data-reset]');
            if (!btn) return;
            var rowEl = btn.closest('.db-record');
            var rid = rowEl ? rowEl.getAttribute('data-id') : '';
            if (!rid) return;
            var pwd = adminPwd();
            if (!pwd) { toast('请先登录管理员账号'); return; }
            var s3 = sup();
            if (!s3) return;
            s3.rpc('reset_record_wheel', { p_id: rid, p_pwd: pwd }).then(function (rr) {
              if (rr.error || rr.data === false) { if (!dbHint(rr.error, '重置')) toast('重置失败'); return; }
              toast('✅ 已重置：该码可再次抽奖一次');
              __b3DbWheelUI();
            });
          });
          box.appendChild(sc);
        }
        if (!box) {
          box = document.createElement('div');
          box.className = 'b3-wheel-box';
          box.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0 2px;flex-wrap:wrap;';
          box.innerHTML = '<span style="font-size:11.5px;color:#6b7a66;">🎡 扫码弹转盘:</span>' +
            '<button class="b3-mini ok" data-w="1">允许</button>' +
            '<button class="b3-mini off" data-w="0">禁止</button>';
          box.addEventListener('click', function (ev) {
            var btn = ev.target.closest('button');
            if (!btn) return;
            var rowEl = btn.closest('.db-record');
            var rid = rowEl ? rowEl.getAttribute('data-id') : '';
            var en = btn.getAttribute('data-w') === '1';
            if (!rid) return;
            var pwd = adminPwd();
            if (!pwd) { toast('请先登录管理员账号'); return; }
            var s2 = sup();
            if (!s2) return;
            s2.rpc('update_record_wheel', { p_id: rid, p_enabled: en, p_pwd: pwd }).then(function (rr) {
              if (rr.error || rr.data === false) { if (!dbHint(rr.error, '转盘开关')) toast('操作失败：' + ((rr.error && rr.error.message) || '校验未通过')); return; }
              toast(en ? '✅ 该码扫码后允许弹幸运转盘' : '该码扫码后不再弹幸运转盘');
              __b3DbWheelUI();
            });
          });
          var main = rows[i].querySelector('.db-record-main') || rows[i];
          main.appendChild(box);
        }
        var on = st[id] !== undefined ? st[id] : true;
        var bs = box.querySelectorAll('button');
        if (bs.length) { bs[0].style.opacity = on ? '1' : '.45'; bs[0].style.boxShadow = on ? '0 0 0 2px rgba(74,124,89,.35)' : 'none'; bs[1].style.opacity = on ? '.45' : '1'; bs[1].style.boxShadow = on ? 'none' : '0 0 0 2px rgba(201,169,110,.45)'; }
        var spun = !!st2[id];
        var ctl = box.querySelector('.b3-spun-ctl');
        if (ctl) {
          var t1 = ctl.querySelector('[data-spun]'), r1 = ctl.querySelector('[data-reset]');
          if (t1) t1.style.display = spun ? 'inline' : 'none';
          if (r1) r1.style.display = spun ? 'inline' : 'none';
        }
      }
    }).catch(function () { dbWheelBusy = false; });
  }
  var oRdl = window.renderDbList;
  if (typeof oRdl === 'function') {
    window.renderDbList = function () {
      var ret = oRdl.apply(window, arguments);
      setTimeout(__b3DbWheelUI, 80);
      return ret;
    };
  }
  /* 验证结果：按码决定是否显示「幸运转盘」入口 */
  window.__b3SyncWheelCta = function (code) {
    var el = $('b3WheelCta');
    if (!el || !code) return;
    var sb = sup();
    if (!sb) { el.style.display = ''; return; }
    sb.from('records').select('wheel_enabled,wheel_spun').eq('id', String(code)).limit(1).then(function (r) {
      var en = true, spun = false;
      if (!r.error && r.data && r.data.length) { en = r.data[0].wheel_enabled !== false; spun = !!r.data[0].wheel_spun; }
      if (!en) { el.style.display = 'none'; return; }
      if (spun) { el.textContent = '🎡 该码已抽过'; el.disabled = true; el.style.opacity = '.6'; }
      else { el.textContent = '🎡 幸运转盘减免（限 1 次）'; el.disabled = false; el.style.opacity = '1'; }
    }).catch(function () {});
  };

  /* ---- 幸运转盘：绑定官方码 · 后台允许下每码仅一次（扫NFC/二维码=同一防伪码） ---- */
  var WSPIN_KEY = 'b3_code_spin_v1';
  function spinRead(code) { try { var m = JSON.parse(localStorage.getItem(WSPIN_KEY) || '{}') || {}; return m[String(code)] || null; } catch (e) { return null; } }
  function spinSave(code, amt) { try { var m = JSON.parse(localStorage.getItem(WSPIN_KEY) || '{}') || {}; m[String(code)] = { amt: amt, ts: Date.now() }; localStorage.setItem(WSPIN_KEY, JSON.stringify(m)); } catch (e) {} }
  var codeSpinBusy = false;
  window.__b3OpenCodeWheel = async function (code) {
    if (!code) { toast('请先完成官方验证'); return; }
    var rec = null;
    var sb = sup();
    if (sb) {
      try {
        var r = await sb.from('records').select('wheel_enabled,wheel_spun').eq('id', String(code)).limit(1);
        if (!r.error && r.data && r.data.length) rec = r.data[0];
      } catch (e) {}
    }
    if (rec && rec.wheel_enabled === false) { toast('该官方码未开放幸运转盘'); return; }
    if (rec && rec.wheel_spun) { toast('该官方码已抽过一次奖'); return; }
    if (!rec && spinRead(code)) { toast('该官方码已抽过一次奖'); return; }
    window.__b3WheelCode = String(code);
    try { call('renderWheel', []); } catch (e) {}
    var w = $('wheel'); if (w) w.style.transform = 'rotate(0deg)';
    var wr = $('wheelResult'); if (wr) wr.style.display = 'none';
    var m = $('wheelModal'); if (m) { m.style.zIndex = '11600'; m.classList.add('show'); }
    call('lockScroll', [true]);
    toast('该官方码可抽奖 1 次 · 点「抽奖」开转 🎡');
  };
  function wheelPick(cfg) {
    var amounts = [];
    try { var wf = get('wheelAmounts'); if (typeof wf === 'function') amounts = wf(); } catch (e) {}
    if (!amounts || amounts.length < 4) { var mn = Number(cfg.min) || 28, mx = Number(cfg.max) || 88, ev = (mx - mn) / 3; amounts = [mn, Math.round(mn + ev), Math.round(mn + ev * 2), mx]; }
    var probs = (cfg.probs && cfg.probs.length === 4) ? cfg.probs : [25, 25, 25, 25];
    var sum = probs.reduce(function (a, b) { return a + b; }, 0) || 100;
    var t = Math.random() * sum, idx = 0, acc = 0;
    for (var i = 0; i < 4; i++) { acc += probs[i]; if (t <= acc) { idx = i; break; } }
    return { index: idx, amount: amounts[idx] };
  }
  var oSpin = window.spinWheel;
  window.spinWheel = function () {
    if (!window.__b3WheelCode) return oSpin ? oSpin.apply(window, arguments) : undefined;
    if (codeSpinBusy) return;
    codeSpinBusy = true;
    var code = window.__b3WheelCode;
    var cfg = null;
    try { cfg = get('wheelCfg'); } catch (e) {}
    cfg = cfg || { min: 28, max: 88, probs: [25, 25, 25, 25] };
    var seg = wheelPick(cfg);
    var w = $('wheel');
    var rot = 720 + (360 - (45 + 90 * seg.index)) % 360;
    if (w) w.style.transform = 'rotate(' + rot + 'deg)';
    var wr = $('wheelResult');
    if (wr) { wr.style.display = 'block'; wr.innerHTML = '<div style="color:var(--text-light);font-size:13px;">✨ 幸运转盘揭晓中...</div>'; }
    setTimeout(function () {
      codeSpinBusy = false;
      try { call('showWheelResult', [seg.amount, '该官方码抽奖完成 · 联系微信定制时出示即可使用']); } catch (e) {}
      spinSave(code, seg.amount);
      var s2 = sup();
      if (s2) { try { s2.rpc('try_claim_wheel', { p_code: code }).catch(function () {}); } catch (e2) {} }
      try {
        var r2 = $('wheelResult');
        if (r2 && !r2.querySelector('.b3-next-share')) {
          var b = document.createElement('button');
          b.className = 'b3-btn b3-btn-main';
          b.style.cssText = 'margin-top:10px;width:100%;';
          b.textContent = '下一步：授权晒单 →';
          b.onclick = function () { try { call('closeWheel', []); } catch (e) {} window.__b3OpenShare(); };
          r2.appendChild(b);
        }
      } catch (e3) {}
    }, 3300);
  };
  window.__b3OpenShare = function () {
    var id = get('currentVerifyId');
    if (!id) { toast('请先完成官方验证'); return; }
    renderSharePanel(id);
  };

  /* ============================================================
   * 下单/购物车清理：一律引导「联系微信」
   * ============================================================ */
  function cleanBuy() {
    var origBuyModal = window.openBuyModal;
    window.openBuyModal = function () {
      var close = get('closeBuyModal'); if (typeof close === 'function') close();
      call('openBuy', []);
    };
    var origCart = window.openCart;
    window.openCart = function () {
      var close = get('closeCart'); if (typeof close === 'function') close();
      call('openBuy', []);
    };
    if (typeof window.cartCheckoutBtn === 'function') {
      window.cartCheckoutBtn = function () { call('openBuy', []); };
    }
    /* 转盘文案：不再提「下单」 */
    var origWheel = window.showWheelResult;
    if (typeof origWheel === 'function') {
      window.showWheelResult = function (d, note) {
        var fixed = note;
        if (typeof note === 'string' && note.indexOf('下单') > -1) fixed = '联系微信定制时出示即可享此优惠';
        return origWheel.call(window, d, fixed);
      };
    }
  }

  /* ---- 文案修正：联系购买 → 联系我们（全局实时，含动态渲染） ---- */
  var textFixOn = false;
  function fixContactText() {
    var HIT = '联系购买', REP = '联系我们';
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    var changed = false;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.indexOf(HIT) > -1) {
        n.nodeValue = n.nodeValue.split(HIT).join(REP);
        changed = true;
      }
    }
    if (changed) {
      /* 标题/按钮若整段被替换为空则回退(保险) */
      return true;
    }
    return false;
  }
  function startTextFix() {
    if (textFixOn) return;
    textFixOn = true;
    try { fixContactText(); } catch (e) {}
    try {
      new MutationObserver(function () { try { fixContactText(); } catch (e) {} })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
  }

  /* ============================================================
   * AI 生辰测石适配：ai-assistant（DeepSeek → 通义出图）
   * ============================================================ */
  var origAiDesign = window.aiDesign;
  var ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
  function zodiacOf(year) {
    var y = Number(year);
    if (!y) return '';
    return ZODIAC[((y - 4) % 12 + 12) % 12];
  }
  function grabInput(id) {
    var el = $(id);
    if (!el) return '';
    var v = (el.value || '').trim();
    return v;
  }
  async function aiDesignNew(mode) {
    var q = call('getAiQuotaLeft', []);
    if (q === 0) {
      var us = get('userSession');
      toast(us && us.username ? '今日 AI 分析次数已用完（10/10），明天 0 点后可继续使用' : '未登录仅可分析 2 次，请先登录账号（每天 10 次）');
      return;
    }
    if (mode === 'bazi' && !get('lastBaziInfo')) { toast('请先点击「测算喜用」获得排盘结果'); return; }
    if (mode === 'hex') {
      var lh0 = get('lastHex');
      if (!lh0 || !lh0.name) { toast('请先摇卦，再让 AI 分析'); return; }
    }
    var fu = AI_DEFAULT_URL || '';
    try {
      var cfg = get('aiConfig');
      // 只信任指向 birch-ai / ai-assistant 的旧配置；其余（含旧 ai-design）一律用默认 birch-ai，
      // 避免把请求发给无 design 模式的老函数（报“缺少问题内容”）
      if (cfg && cfg.funcUrl && /birch-ai|ai-assistant/i.test(cfg.funcUrl)) fu = cfg.funcUrl;
    } catch (e) {}
    var kind = mode === 'hex' ? 'hex' : mode === 'bazi' ? 'bazi' : 'free';
    var info = {};
    if (mode === 'bazi') {
      var y = grabInput('baziYear'), mo = grabInput('baziMonth'), d = grabInput('baziDay'), h = grabInput('baziHour');
      info = { year: y, month: mo, day: d, hour: h, zod: zodiacOf(y) };
      var lb = get('lastBaziInfo');
      if (lb && lb.ganzhi) info.ganzhi = lb.ganzhi;
      if (lb && lb.dayMaster) info.dayMaster = lb.dayMaster;
      if (lb && lb.wuxing) info.wuxing = lb.wuxing;
    } else if (mode === 'hex') {
      var lh = get('lastHex') || {};
      info = { name: lh.name || '', sym: lh.sym || '', idea: lh.idea || '', wu: lh.wu || '' };
    } else {
      info = { note: '自由发挥：请给出一串 3-5 种晶石的整套搭配设计、配色与意象（无生辰信息）' };
    }
    var size = get('braceletSize');
    var mm = size === 10 ? 10 : 8;
    window.aiStartTime = Date.now();
    call('showLoading', ['小桦正在生成 AI 定制方案与效果图\n（约需 1 分钟，请稍候）', 'ai']);
    var tip0 = $('b3AiQuickTip');
    if (tip0) tip0.textContent = '⏳ AI 生成中…（约 1 分钟，请勿关闭页面）';
    try {
      var res = await fetch(fu, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON },
        body: JSON.stringify({ mode: 'design', kind: kind, info: info, mm: mm })
      });
      var text = await res.text();
      var r = null;
      try { r = JSON.parse(text); } catch (e) { r = { raw: text.slice(0, 300) }; }
      if (!res.ok || !r || !r.ok) {
        var err = (r && (r.error || r.raw)) || ('HTTP ' + res.status);
        toast('AI 服务错误：' + err);
        if (mode === 'random') { try { call('randomBracelet', []); toast('已用本地随缘搭配代替 ✨'); } catch (e2) {} }
        if (/未配置|密钥|SILICON|img_key/i.test(String(err))) {
          setTimeout(function () { alert('AI 出图密钥未配置：\n请确认已执行「桦库-完整SQL.sql」的 AI 配置段（img_key 已内置予光同款通义密钥），或到 Supabase Secrets 设置 SILICON_KEY。'); }, 80);
        } else if (/DeepSeek|API|401|403/.test(String(err))) {
          setTimeout(function () { alert('DeepSeek 密钥未配置：请到 Supabase Settings → Secrets 设置 AI_API_KEY / AI_MODEL，或在 settings 表 ai.key/ai.model 配置后重新部署 birch-ai。'); }, 80);
        }
        return;
      }
      /* 渲染容器（沿用原站 AI 样式类） */
      var boxId = mode === 'hex' ? 'aiDesignTop' : mode === 'bazi' ? 'baziResult' : 'aiRandomResult';
      var o = $(boxId);
      if (o) {
        o.style.display = 'block';
        var analysis = String(r.analysis || '');
        var poem = '';
        var lines = analysis.split(/\n/);
        var poemIdx = -1;
        for (var i = 0; i < lines.length; i++) {
          if (/^\s*(?:\d+[.)、]\s*)?诗[曰：:]\s*/.test(lines[i])) { poemIdx = i; break; }
        }
        if (poemIdx > -1) {
          var got = [];
          for (var pi = poemIdx; pi < lines.length && got.length < 4; pi++) {
            var ln = lines[pi].replace(/^\s*(?:\d+[.)、]\s*)?诗[曰：:]\s*/, '').trim();
            if (ln) got.push(ln);
          }
          poem = got.join('\n');
        }
        if (!poem && r.poem) poem = String(r.poem);
        var beadsHtml = (r.stones || []).map(function (b) {
          return '<span class="ai-bead">' + esc(b.name) + ' ×' + b.count + (b.color ? ' <i style="font-style:normal;display:inline-block;width:9px;height:9px;border-radius:50%;background:' + esc(b.color) + ';vertical-align:-1px;margin-left:2px;"></i>' : '') + '</span>';
        }).join('');
        var imgHtml = '';
        if (r.url) {
          imgHtml = '<div style="margin-top:12px;text-align:center;"><img src="' + esc(r.url) + '" alt="AI 设计图" style="max-width:100%;max-height:340px;border-radius:14px;box-shadow:0 14px 34px rgba(0,0,0,.18);border:1px solid rgba(201,169,110,.5);" onclick="window.__b3Lightbox(\'\',\'' + esc(r.url).replace(/'/g, '') + '\',\'AI 设计图\')"></div><div style="font-size:10.5px;color:var(--text-light);margin-top:6px;text-align:center;">AI 生图预览（点击放大）· 实物以定制为准</div>';
        }
        o.innerHTML =
          '<div class="ai-design-box">' +
          '<div class="ai-robot"><span>小桦 · 设计助手</span></div>' +
          '<div class="ai-title">' + (mode === 'hex' ? '卦象分析' : mode === 'bazi' ? '生辰设计' : '随缘搭配') + '</div>' +
          '<div class="ai-text">' + (function () { var f = get('fmtAiAnalysis'); try { if (typeof f === 'function') return f(analysis); } catch (e) {} return esc(analysis).replace(/\n/g, '<br>'); })() + '</div>' +
          (beadsHtml ? '<div class="ai-beads">' + beadsHtml + '</div>' : '') +
          (poem ? '<div class="ai-poem">' + esc(poem).replace(/\n/g, '<br>') + '</div>' : '') +
          imgHtml +
          '<div style="font-size:10px;color:var(--text-light);margin-top:8px;">以上分析为文化意象参考 · 不构成任何承诺</div>' +
          '</div>';
        /* 生成后自动滚到效果图 */
        try {
          setTimeout(function () {
            if (o && o.scrollIntoView) { try { o.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { o.scrollIntoView(); } }
          }, 400);
        } catch (e) {}
        var tip2 = $('b3AiQuickTip');
        if (tip2) tip2.textContent = '✅ 已生成：效果图在上方 ↑ 可点图放大';
      }
      /* 按 DeepSeek 配比刷新手串预览 */
      var cb = call('clearBracelet', []);
      var beads = r.stones || [];
      var lib = [];
      try { lib = call('availableCrystals', []) || []; } catch (e) {}
      var pushed = [];
      for (var bi = 0; bi < beads.length; bi++) {
        var need = Number(beads[bi].count) || 0;
        var found = null;
        for (var li = 0; li < lib.length; li++) { if (lib[li].name === beads[bi].name) { found = lib[li]; break; } }
        if (found) {
          for (var k2 = 0; k2 < need && pushed.length < mmTotal(mm); k2++) pushed.push(found);
        }
      }
      while (pushed.length < mmTotal(mm) && lib.length) pushed.push(lib[Math.floor(Math.random() * lib.length)]);
      var bb = get('braceletBeads');
      if (Array.isArray(bb)) {
        bb.length = 0;
        for (var p2 = 0; p2 < pushed.length; p2++) bb.push(pushed[p2]);
        call('drawBracelet', []);
      }
      toast('✅ AI 设计完成：' + (r.stones || []).length + ' 种晶石 · ' + mmTotal(mm) + ' 颗 · 已出图');
      var qc = call('consumeAiQuota', []);
    } catch (e) {
      toast('AI 调用失败：' + (e && e.message ? e.message : e));
      if (mode === 'random') { try { call('randomBracelet', []); toast('已用本地随缘搭配代替 ✨'); } catch (e2) {} }
    } finally {
      call('hideLoading', []);
    }
  }
  function mmTotal(mm) { return mm >= 10 ? 18 : 22; }
  function hookAi() {
    if (typeof origAiDesign === 'function') {
      /* 三种模式一律走新 birch-ai design；不再把旧地址(如 ai-design)当老路径转发，
         老函数没有 design 模式只会报“缺少问题内容” */
      window.aiDesign = function (mode) {
        if (mode === 'bazi' || mode === 'hex' || mode === 'random') return aiDesignNew(mode);
        return origAiDesign.call(window, mode);
      };
    }
    /* 接管「智能搭配」按钮：三种模式无条件走新 AI（birch-ai design），
       避免旧逻辑把 mode 直接发给函数导致 chat 分支报“缺少问题内容” */
    var oOneClick = window.oneClickConfig;
    if (typeof oOneClick === 'function') {
      window.oneClickConfig = function (mode) {
        if (mode === 'bazi' || mode === 'hex' || mode === 'random') {
          try {
            if (typeof window.aiDesign === 'function') {
              window.aiDesign(mode);
              return;
            }
          } catch (e) {}
        }
        return oOneClick.apply(window, arguments);
      };
    }
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  /* ---- 手机端「AI 定制」快捷条：吸顶常驻，不再翻来翻去 ---- */
  function curAIMode() {
    var b = $('custBirth'), h = $('custHex'), r = $('custRandom');
    if (b && b.style && b.style.display !== 'none') return 'bazi';
    if (h && h.style && h.style.display !== 'none') return 'hex';
    if (r && r.style && r.style.display !== 'none') return 'random';
    return null;
  }
  var __b3QuickInited = false;
  function initCustomizeQuick() {
    if (__b3QuickInited) return;
    __b3QuickInited = true;
    var p = $('customizePanel');
    if (!p) { setTimeout(initCustomizeQuick, 600); return; }
    if (!$('b3AiQuick')) {
      var bar = document.createElement('div');
      bar.id = 'b3AiQuick';
      bar.className = 'b3-ai-quick';
      bar.innerHTML = '<button class="b3-aiq-btn" id="b3AiQuickBtn" type="button">' +
        '<span style="font-size:16px;line-height:1.3;">✨ AI 智能定制</span>' +
        '<span class="b3-aiq-tip" id="b3AiQuickTip"></span></button>' +
        '<a class="b3-aiq-contact" id="b3AiQuickContact" href="javascript:void 0">💬 联系</a>';
      var grid = p.querySelector('.customize-grid');
      if (grid) p.insertBefore(bar, grid); else p.appendChild(bar);
      $('b3AiQuickBtn').onclick = function () {
        var mode = curAIMode();
        if (!mode) { toast('请先切换到 生辰 / 摇卦 / 随缘 任一模式'); return; }
        var tip = $('b3AiQuickTip');
        if (tip) tip.textContent = '⏳ AI 生成中…（约 1 分钟，请勿关闭页面）';
        try { window.oneClickConfig(mode); } catch (e) { toast('启动 AI 失败：' + (e && e.message || e)); }
      };
      var ct = $('b3AiQuickContact');
      if (ct) ct.onclick = function () { try { call('openCustomContact', []); } catch (e) {} };
    }
    function updTip() {
      var tip = $('b3AiQuickTip');
      if (!tip) return;
      var mode = curAIMode();
      if (mode === 'bazi') tip.textContent = '生辰测石 · 先点「测算喜用」再按 AI（约 1 分钟）';
      else if (mode === 'hex') tip.textContent = '摇卦定制 · 先点「摇卦」再按 AI（约 1 分钟）';
      else if (mode === 'random') tip.textContent = '随缘搭配 · 一键 AI 设计 + 出图（约 1 分钟）';
      else tip.textContent = '手动模式 · 可切到 生辰 / 摇卦 / 随缘 使用 AI';
    }
    updTip();
    var oSM = window.startCustomizeMode;
    if (typeof oSM === 'function' && !window.__b3SMwrapped) {
      window.__b3SMwrapped = 1;
      window.startCustomizeMode = function (m) {
        var ret = oSM.apply(window, arguments);
        setTimeout(updTip, 90);
        return ret;
      };
    }
  }
  var started = false;
  function init() {
    if (started) return;
    started = true;
    if (!document.body) { setTimeout(init, 200); return; }
    try { refreshShares(); } catch (e) {}
    try { startTextFix(); } catch (e) {}
    try { initCustomizeQuick(); } catch (e) {}
    try { ensureAdminUI(); } catch (e) {}
    try { watchVerifyResult(); } catch (e) {}
    try { cleanBuy(); } catch (e) {}
    try { hookAi(); } catch (e) {}
    /* 官方码识别归一：纯码 / ?code= 链接 / NFC·QR 里的 birchstudio.cn 网址 → 同一防伪码 */
    try {
      var oExt = window.extractVerifyId;
      if (typeof oExt === 'function' && !window.__b3ExtWrapped) {
        window.__b3ExtWrapped = 1;
        window.extractVerifyId = function (v) {
          var r = null;
          try { r = oExt(v); } catch (e) {}
          if (r) return r;
          var s2 = String(v || '');
          var m = s2.match(/(?:[?&#](?:code|c|id|verify|anti)=)([A-Za-z0-9_-]{2,48})/i);
          if (m) return m[1];
          var m2 = s2.match(/(?:birchstudio.cn|cplyzukenqxdwhfivlqx)[^A-Za-z0-9]{0,4}([A-Za-z0-9_-]{2,48})/i);
          return m2 ? m2[1] : null;
        };
      }
    } catch (e) {}
    /* 后台每次打开分享审核页刷新 */
    var oOpen = window.openAdminSection;
    if (typeof oOpen === 'function') {
      window.openAdminSection = function (id) {
        if (id === 'secShares') setTimeout(function () { renderSharesAdmin(); }, 60);
        return oOpen.apply(window, arguments);
      };
    }
    /* 轮询等后台就绪后补 UI（动态出现时） */
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      try { ensureAdminUI(); } catch (e) {}
      if (document.getElementById('adminHome')) { /* home 已在静态 DOM，仅当进入时注入 */ }
      if (tries > 30) clearInterval(t);
    }, 800);
    setTimeout(function () { clearInterval(t); }, 26000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
