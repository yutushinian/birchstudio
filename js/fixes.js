/* ============================================================
 * 桦库 · 邮件收件人修复补丁 fixes.js（v1 / 20260916）
 * ------------------------------------------------------------
 * 【修的是什么 bug】
 *   bundle.js 里有 8 处「通知客户」的邮件流程，都写成同一个错误模式：
 *
 *     const { data: o } = await supabaseClient.rpc("get_user_email",
 *                            { p_username: u.username });
 *     o && await sendOrderMail({ subject: "…", …, 收件账号: u.username });
 *                                         ↑ 客户邮箱 o 查到了却从没用过
 *
 *   而 sendOrderMail 内部是：
 *     const u = mailToList().length ? mailToList() : ["15040690227@163.com"];
 *     const n = Object.assign({}, 传入对象, { to: u });   // to 被后台收件人覆盖
 *
 *   结果：所有客户通知邮件都发到了后台邮箱（MAIL_TO / 默认 163 邮箱），
 *   客户一封都收不到。客户邮箱「查到了但被丢弃」。
 *
 * 【为什么用拦截 fetch 而不是改 bundle.js】
 *   · bundle.js 是 402KB 压缩产物，仓库内无源码，直接改维护性极差；
 *   · sendOrderMail 未暴露到 window，且这些通知都是在同步函数体内直接调用
 *     （如 setOrderTracking 内联 await sendOrderMail(...)），
 *     所以无法用「包装 window.xxx」这类常规补丁拦住；
 *   · 但所有邮件最终都 POST 到同一个 email-send 端点，且请求体里
 *     同时带着「收件账号」（客户用户名）与被覆盖的 to —— 这是一个
 *     统一且稳定的拦截点。
 *
 * 【策略：只修客户通知，绝不动后台通知】
 *   判定规则（保守，宁可不改）：
 *     请求体含「收件账号」→ 意图是发给该客户 → 查邮箱后把 to 换成客户邮箱；
 *     否则（新订单通知 / 防伪码申请 / 新订阅）→ 原样放行，仍送后台。
 *   这样后台「新订单」入口毫发无伤，不会漏单。
 *
 * 【失败时的行为】
 *   任何一步不确定（查不到邮箱、supabaseClient 不可用、取数异常），
 *   一律「原样放行」，即退回旧行为（发后台）——
 *   宁可管理员多收一封，也绝不静默丢信。
 *
 * 加载：由 index.html 在 js/bundle.js 之后加载（见文件末尾的 <script>）。
 * ============================================================ */
(function () {
  'use strict';

  var MARK = '__birchMailFix';

  /* 统一取 bundle 作用域内的全局对象。
     bundle.js 是经典脚本，其顶层 var 声明（如 supabaseClient）
     在全局作用域可见，但用 (0, eval) 间接调用最稳妥
     —— 与 index.html 里 b3-ai-shim 的做法一致。 */
  function globalOf(name) {
    try { return (0, eval)(name); } catch (e) { return undefined; }
  }

  function isEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  // 邮箱缓存：同一次会话里同一账号只查一次，避免重复 RPC
  var cache = Object.create(null);

  /* 三种查找结果必须严格区分，否则会误丢信：
       · 邮箱字符串      → 改投客户
       · ''（确实是空）  → 客户未登记邮箱 → 跳过（符合「直发客户」的预期）
       · FAILED          → 我方查不了（client 缺失 / 网络或 RPC 异常）
                           → 原样放行给后台：宁可管理员多收一封，也绝不丢信 */
  var FAILED = { failed: true };

  function lookupEmail(username) {
    if (!username) return Promise.resolve('');
    var key = String(username);
    if (key in cache) return Promise.resolve(cache[key]);
    var sb = globalOf('supabaseClient');
    if (!sb || typeof sb.rpc !== 'function') return Promise.resolve(FAILED);
    return sb.rpc('get_user_email', { p_username: key }).then(function (res) {
      var d = res && res.data;
      var mail = '';
      if (typeof d === 'string') mail = d;
      else if (d && typeof d.email === 'string') mail = d.email;
      mail = isEmail(mail) ? mail.trim() : '';
      cache[key] = mail;
      return mail;
    }).catch(function () { return FAILED; });
  }

  /* ---------- 安装 fetch 拦截 ---------- */
  if (window[MARK]) return;             // 幂等：重复加载不重复包装
  window[MARK] = true;

  var nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;   // 环境异常：什么都不做

  var ENTRY_KEY = '\u6536\u4ef6\u8d26\u53f7';      // 收件账号

  window.fetch = function (input, init) {
    var url = '';
    try {
      url = typeof input === 'string' ? input
          : (input && input.url ? input.url : String(input));
    } catch (e) { url = ''; }

    // 只处理发信端点，其余流量完全不碰
    if (url.indexOf('email-send') === -1) {
      return nativeFetch.apply(this, arguments);
    }

    // 只处理我们能在放行前完成改写的 POST + 字符串 body
    var method = (init && init.method) || (input && input.method) || 'GET';
    var body = init && init.body;
    if (String(method).toUpperCase() !== 'POST' || typeof body !== 'string') {
      return nativeFetch.apply(this, arguments);
    }

    var payload;
    try { payload = JSON.parse(body); } catch (e) { payload = null; }
    if (!payload || typeof payload !== 'object') {
      return nativeFetch.apply(this, arguments);
    }

    // 没有「收件账号」→ 不是客户通知（新订单 / 防伪码申请 / 新订阅），原样放行
    var username = payload[ENTRY_KEY];
    if (typeof username !== 'string' || !username.trim()) {
      return nativeFetch.apply(this, arguments);
    }
    username = username.trim();

    var self = this, args = arguments;
    return lookupEmail(username).then(function (mail) {
      if (mail === FAILED) {
        // 我们查不到邮箱（client 缺失 / RPC 异常）→ 不冒险，原样放行给后台
        if (window.console && console.warn) {
          console.warn('[birch] 无法查询客户邮箱，本次通知仍发后台：' + username);
        }
        return nativeFetch.apply(self, args);
      }
      if (!mail) {
        // 确认客户未登记邮箱：按「直发客户」的预期跳过，不回落后台；
        // 但要留痕，便于日后排查客户没收到信的原因
        if (window.console && console.warn) {
          console.warn('[birch] 客户未登记邮箱，已跳过通知：' + username);
        }
        return new Response(JSON.stringify({
          ok: true, skipped: true, reason: '客户未登记邮箱', account: username
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      payload.to = mail;                       // 关键修复：改投客户邮箱
      delete payload[ENTRY_KEY];               // 去掉内部字段，不外发用户名
      var nextInit = Object.assign({}, init, { body: JSON.stringify(payload) });
      if (window.console && console.info) {
        console.info('[birch] 客户通知改投：' + username + ' → ' + mail);
      }
      return nativeFetch.call(self, input, nextInit);
    }).catch(function () {
      // 兜底：出任何差错都退回旧行为（发后台），绝不丢信
      return nativeFetch.apply(self, args);
    });
  };

  // 便利方法：保留原生 fetch 的直通引用，便于日后调试
  window[MARK + '_native'] = nativeFetch;
})();

/* ============================================================
 * 桦库 · AI 出图/定制链路修复 patch（v1 / 20260926）
 * ------------------------------------------------------------
 * 【修的是什么 bug】
 *   1) 端点错位：后台 app_data.birch_ai_config.funcUrl 里存的是
 *      https://<ref>.functions.supabase.co/ai-design，
 *      而实际部署的 Edge Function 是 <ref>.supabase.co/functions/v1/birch-ai。
 *      ai-design 根本不存在 → 404。表现为「AI 智能搭配点了没反应/报错」。
 *   2) 契约错位：bundle.js 的旧 aiDesign 发的是 {mode:'bazi', bazi:{...}}，
 *      而 birch-ai 只认 mode:'design' + {kind, info, mm}，直接调必然失败。
 *   3) 出图失败是静默的：旧链路没有任何 img_error 提示，用户只看到「没图」。
 *
 * 【策略】
 *   · 不注入新变量：一律通过 getter 惰性读取（bundle 的 const/let 不会成为
 *     window 属性，动态脚本里必须用 (0,eval) 才能读到）。
 *   · 真正的 AI 实现统一交给 js/birch3.js 的 window.__b3AiNew
 *     （它用 mode:'design' 契约，并渲染效果图 + 失败原因）。
 *   · birch3 尚未加载完时排队等待（最多 12 秒），不再退回旧 ai-design 链路。
 *   · 顺带兜底修正后台误存/误点的函数地址，避免下次又写坏。
 *
 * 加载：由 index.html 在 js/bundle.js 之后、b3-ai-shim 之前加载。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3AiRoute) return;      // 幂等
  var MARK = '__b3AiRoute';
  window[MARK] = 1;

  function globalOf(name) {
    try { return (0, eval)(name); } catch (e) { return undefined; }
  }
  function sbUrl() {
    var u = globalOf('SUPABASE_URL');
    return String(u || '').replace(/\/$/, '');
  }
  /* 解析规则（务必与 birch3.js 中 __b3AiEndpoint 一致）：
       1) 后台配置里形如 .../functions/v1/birch-ai 的地址优先；
       2) 任何指向不存在的 ai-design 的地址一律忽略；
       3) 兜底用 bundle 里的 SUPABASE_URL 拼出绝对地址。 */
  function endpoint() {
    var base = sbUrl();
    var cfg = globalOf('aiConfig');
    var cu = cfg && cfg.funcUrl ? String(cfg.funcUrl) : '';
    if (/^https?:\/\//i.test(cu) && /birch-ai|ai-assistant/i.test(cu) && !/ai-design/i.test(cu)) return cu;
    return base ? base + '/functions/v1/birch-ai' : '';
  }
  window.__b3AiEndpoint = endpoint;

  function toast(msg) {
    var t = globalOf('toast');
    if (typeof t === 'function') { try { t(msg); return; } catch (e) {} }
    if (window.console && console.warn) console.warn('[birch] ' + msg);
  }
  function showLoading(msg) {
    var f = globalOf('showLoading');
    if (typeof f === 'function') { try { f(msg, 'ai'); } catch (e) {} }
  }
  function hideLoading() {
    var f = globalOf('hideLoading');
    if (typeof f === 'function') { try { f(); } catch (e) {} }
  }

  /* 直接按 birch-ai 的 design 契约生成（birch3.js 缺席时的自足兜底） */
  function directGenerate(mode) {
    var fu = endpoint();
    if (!fu) { toast('AI 服务地址未就绪，请刷新页面后重试'); return; }
    var anon = String(globalOf('SUPABASE_ANON_KEY') || '');
    var kind = mode === 'hex' ? 'hex' : mode === 'bazi' ? 'bazi' : 'free';
    var info = {};
    if (mode === 'bazi') {
      var lb = globalOf('lastBaziInfo');
      if (!lb) { toast('请先点击「测算喜用」获得排盘结果'); return; }
      var val = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
      var y = val('baziYear');
      var ZOD = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
      info = {
        year: y, month: val('baziMonth'), day: val('baziDay'), hour: val('baziHour'),
        zod: y ? ZOD[((Number(y) - 4) % 12 + 12) % 12] : ''
      };
      if (lb.ganzhi) info.ganzhi = lb.ganzhi;
      if (lb.dayMaster) info.dayMaster = lb.dayMaster;
      if (lb.wuxing) info.wuxing = lb.wuxing;
      if (lb.xiyong) info.el = lb.xiyong;
    } else if (mode === 'hex') {
      var lh = globalOf('lastHex');
      if (!lh || !lh.name) { toast('请先摇卦，再让 AI 分析'); return; }
      info = { name: lh.name, sym: lh.sym || '', idea: lh.idea || '', wu: lh.wu || '' };
    } else {
      info = { note: '自由发挥：请给出一串 3-5 种晶石的整套搭配设计、配色与意象（无生辰信息）' };
    }
    var size = globalOf('braceletSize');
    var mm = Number(size) === 10 ? 10 : 8;
    showLoading('小桦正在生成 AI 定制方案与效果图\n（约需 1 分钟，请稍候）');
    fetch(fu, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: 'Bearer ' + anon },
      body: JSON.stringify({ mode: 'design', kind: kind, info: info, mm: mm })
    }).then(function (res) {
      return res.text().then(function (t) {
        var r = null;
        try { r = JSON.parse(t); } catch (e) { r = null; }
        if (!res.ok || !r || !r.ok) {
          toast('AI 服务错误：' + ((r && (r.error || r.raw)) || ('HTTP ' + res.status)));
          return;
        }
        var boxId = mode === 'hex' ? 'aiDesignTop' : mode === 'bazi' ? 'baziResult' : 'aiRandomResult';
        var box = document.getElementById(boxId);
        if (box) {
          box.style.display = 'block';
          var esc = globalOf('escapeHtml') || function (s) { return String(s == null ? '' : s); };
          var img = r.url
            ? '<div class="ai-img-wrap"><img class="ai-img" src="' + esc(r.url) + '" alt="AI 设计图"></div><div class="ai-img-cap">AI 生图预览 · 实物以定制为准</div>'
            : '<div class="ai-img-warn">⚠️ 方案已生成，但<b>效果图没有出</b>：' + esc(String(r.img_error || '出图服务未返回图片')) + '</div>';
          box.innerHTML = '<div class="ai-design-box">' +
            '<div class="ai-title">' + (mode === 'hex' ? '卦象分析' : mode === 'bazi' ? '生辰设计' : '随缘搭配') + '</div>' +
            '<div class="ai-text">' + esc(String(r.analysis || '')).replace(/\n/g, '<br>') + '</div>' +
            (r.poem ? '<div class="ai-poem">' + esc(String(r.poem)).replace(/\n/g, '<br>') + '</div>' : '') +
            img + '</div>';
        }
        toast(r.url ? '✅ AI 设计完成，已出图' : '✅ 方案已生成 · ⚠️ 效果图未出');
      });
    }).catch(function (e) {
      toast('AI 调用失败：' + ((e && e.message) || e));
    }).then(function () { hideLoading(); });
  }

  function route(mode) {
    var impl = window.__b3AiNew;
    if (typeof impl === 'function') { impl(mode); return; }
    /* 首次点击可能早于 birch3.js 注入完成（features.js 动态插入，最长 12s 兜底）：
       排队等待，期间只提示一次，绝不再回落到已废弃的 ai-design 链路。 */
    var tries = 0;
    toast('正在准备 AI 服务，请稍候…');
    (function wait() {
      if (typeof window.__b3AiNew === 'function') { window.__b3AiNew(mode); return; }
      if (tries++ > 40) { directGenerate(mode); return; }   /* 10s 未就绪 → 自足实现 */
      setTimeout(wait, 250);
    })();
  }

  /* ---- 接管所有「AI 智能搭配」入口 ----
     三种模式无条件走 birch-ai design；非三种模式原样交回旧实现。 */
  ['aiDesign', 'oneClickConfig'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (mode) {
      if (mode === 'bazi' || mode === 'hex' || mode === 'random' || mode === 'free') {
        route(mode);
        return;
      }
      return orig.apply(window, arguments);
    };
  });
  /* 兼容旧版内部调用（maybeAiAnalyze / 其它地方可能直接引用词法名） */
  window.__b3AiHookV2 = 1;

  /* ---- 兜底：后台若又把函数地址存成不存在的 ai-design，保存时纠正 ---- */  var nativeFetchForRpc = window.fetch;
  if (typeof nativeFetchForRpc === 'function') {
    var AI_URL_RE = /^https?:\/\/[a-z0-9-]+\.functions\.supabase\.co\/ai-design\/?$/i;
    function fixConfigPayload(text) {
      if (typeof text !== 'string' || text.indexOf('ai-design') === -1) return text;
      try {
        var p = JSON.parse(text);
        if (p && p.p_key === 'birch_ai_config' && typeof p.p_data === 'string') {
          var cfg = JSON.parse(p.p_data);
          var fixed = endpoint();
          if (!cfg.funcUrl || AI_URL_RE.test(String(cfg.funcUrl))) cfg.funcUrl = fixed;
          if (!cfg.hasKey) cfg.hasKey = true;
          if (cfg.enabled === undefined) cfg.enabled = true;
          p.p_data = JSON.stringify(cfg);
          return JSON.stringify(p);
        }
      } catch (e) {}
      return text;
    }
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var body = init && init.body;
        if (url.indexOf('set_app_data') > -1 && typeof body === 'string') {
          var next = fixConfigPayload(body);
          if (next !== body) {
            init = Object.assign({}, init, { body: next });
            if (window.console && console.info) console.info('[birch] 已纠正后台 AI 函数地址');
          }
        }
      } catch (e) {}
      return nativeFetchForRpc.apply(this, [input, init]);
    };
  }
})();

/* ============================================================
 * 桦库 · AI 效果图放大兜底（v1 / 20260926）
 * ------------------------------------------------------------
 * 【修的是什么 bug】
 *   birch3.js 渲染效果图时挂的是 onclick="window.__b3Lightbox('','<url>','AI 设计图')"，
 *   但 window.__b3Lightbox 从未定义 —— 用户点图没有任何反应（图片下方却写着
 *   「点击放大」）。实测全局里只有 bundle 的 openLightbox，它要求传对象。
 *
 * 【策略】
 *   1) 定义 window.__b3Lightbox(url, name)：优先转调 bundle 的 openLightbox
 *      （沿用现有灯箱动效），失败则回退到自建遮罩；
 *   2) 给所有 .ai-img 补一个委托点击（含旧实现渲染出的图），双击不会有副作用；
 *   3) 图片加载失败时给出可读提示，而不是留一个碎图标。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3LightboxFallback) return;
  window.__b3LightboxFallback = 1;

  function openWithBundle(url) {
    var f = (function () { try { return (0, eval)('openLightbox'); } catch (e) { return undefined; } })();
    if (typeof f !== 'function') return false;
    try {
      /* bundle 的 openLightbox 形态不定，逐种形态试探，全部失败则返回 false */
      f({ url: url, name: 'AI 设计图', design: '', price: '' });
      return true;
    } catch (e) {}
    try { f(url); return true; } catch (e) {}
    return false;
  }

  function fallbackLightbox(url) {
    var old = document.getElementById('b3LightboxMask');
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'b3LightboxMask';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'AI 设计图预览');
    box.style.cssText = 'position:fixed;inset:0;z-index:12900;background:rgba(14,20,17,.92);' +
      'display:flex;align-items:center;justify-content:center;padding:18px;cursor:zoom-out;' +
      '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);';
    var img = document.createElement('img');
    img.src = url;
    img.alt = 'AI 设计图';
    img.style.cssText = 'max-width:96vw;max-height:88vh;border-radius:16px;' +
      'box-shadow:0 28px 80px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.12);';
    var tip = document.createElement('div');
    tip.textContent = '点击任意处关闭';
    tip.style.cssText = 'position:absolute;bottom:22px;left:0;right:0;text-align:center;' +
      'color:rgba(250,248,243,.75);font-size:12.5px;letter-spacing:.1em;';
    box.appendChild(img);
    box.appendChild(tip);
    box.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    document.body.appendChild(box);
  }

  window.__b3Lightbox = function (_a, url, name) {
    var u = String(url || _a || '');
    if (!u) return;
    if (openWithBundle(u)) return;
    fallbackLightbox(u);
  };

  /* 图片加载失败提示（临时地址过期、网络不通时不再只留一个碎图） */
  function markBroken(img) {
    if (!img || img.getAttribute('data-b3broken')) return;
    img.setAttribute('data-b3broken', '1');
    var cap = img.parentNode && img.parentNode.parentNode
      ? img.parentNode.parentNode.querySelector('.ai-img-cap') : null;
    if (cap) cap.textContent = '⚠️ 效果图加载失败（可能是图片地址已过期），可重新生成一次';
    img.style.display = 'none';
  }

  function decorate(root) {
    var nodes = (root || document).querySelectorAll ? (root || document).querySelectorAll('.ai-img') : [];
    for (var i = 0; i < nodes.length; i++) {
      var img = nodes[i];
      if (img.getAttribute('data-b3zoom')) continue;
      img.setAttribute('data-b3zoom', '1');
      img.addEventListener('error', function () { markBroken(this); });
      if (!img.getAttribute('onclick')) {
        (function (el) {
          el.addEventListener('click', function () {
            var u = el.getAttribute('src');
            if (u) window.__b3Lightbox('', u, 'AI 设计图');
          });
        })(img);
      }
    }
  }

  if (document.body) {
    decorate(document.body);
    try {
      new MutationObserver(function () { decorate(document.body); })
        .observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  } else {
    document.addEventListener('DOMContentLoaded', function () { decorate(document.body); });
  }
})();
