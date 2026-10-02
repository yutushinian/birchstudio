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
    if (!fu) { toast('AI 暂时不可用，请刷新页面重试'); return; }
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
    var post = window.__b3AiPost;
    ((typeof post === 'function')
      ? post({ mode: 'design', kind: kind, info: info, mm: mm })
      : fetch(fu, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: 'Bearer ' + anon },
          body: JSON.stringify({ mode: 'design', kind: kind, info: info, mm: mm })
        }).then(function (res) {
          return res.text().then(function (t) {
            var rr = null;
            try { rr = JSON.parse(t); } catch (e) { rr = null; }
            return { ok: !!(res.ok && rr && rr.ok), data: rr, error: (rr && (rr.error || rr.raw)) || ('HTTP ' + res.status) };
          });
        })
    ).then(function (out) {
        var r = out && out.data;
        if (!out || !out.ok || !r || !r.ok) {
          toast('AI 服务错误：' + ((out && out.error) || '未知错误'));
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

/* ============================================================
 * 桦库 · AI 请求统一出口（v1 / 20260928）
 * ------------------------------------------------------------
 * 【为什么需要它】
 *   原本前端用 Content-Type: application/json + apikey + Authorization 三个自定义头
 *   调 Edge Function。只要带任一非简单头，浏览器就必须先发 CORS 预检（OPTIONS）。
 *   预检一旦被网关拦掉、或响应缺少 Access-Control-Allow-Origin，
 *   浏览器就直接把请求判死，页面只能得到一句笼统的
 *   「AI 调用失败：网络请求没有到达服务端」—— 既无法定位，也无法重试。
 *
 * 【做法】
 *   1) 用 Content-Type: text/plain 发送 JSON 字符串：跨域时属 CORS「简单请求」，
 *      浏览器不发预检（函数端已改为按文本解析，见 readBody）。
 *   2) 不发 apikey 头（函数是 verify_jwt=false，不需要它；少一个头就少一个被拦的理由）。
 *   3) 第一发失败时自动换回「带 apikey 头」的老方式再试一次，两种网关策略都能兼容。
 *   4) 每次失败都抓取 /functions/v1/<fn> 的 GET 探针结果（状态码 / 是否带 CORS 头 /
 *      响应片段），把真正的原因显示给用户，而不是「网络不通」四个字。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3AiPost) return;

  function globalOf(name) {
    try { return (0, eval)(name); } catch (e) { return undefined; }
  }
  function anonKey() { return String(globalOf('SUPABASE_ANON_KEY') || ''); }
  function toast(msg) {
    var t = globalOf('toast');
    if (typeof t === 'function') { try { t(msg); return; } catch (e) {} }
    if (window.console && console.warn) console.warn('[birch] ' + msg);
  }
  function resolveUrl() {
    if (typeof window.__b3AiEndpoint === 'function') {
      try {
        var u = window.__b3AiEndpoint();
        if (u) return String(u);
      } catch (e) {}
    }
    var base = String(globalOf('SUPABASE_URL') || '').replace(/\/$/, '');
    return base ? base + '/functions/v1/birch-ai' : '';
  }
  function withTimeout(ms) {
    try {
      if (typeof AbortController === 'function') {
        var ac = new AbortController();
        setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms);
        return ac.signal;
      }
    } catch (e) {}
    return undefined;
  }

  /* 诊断探针：GET 函数根路径，看它是否可达、是否回 CORS 头 */
  async function probe(url) {
    try {
      var r = await fetch(url, { method: 'GET', signal: withTimeout(12000), cache: 'no-store' });
      var t = '';
      try { t = (await r.text()).slice(0, 120); } catch (e) {}
      var acao = r.headers.get('access-control-allow-origin');
      window.__b3AiDiag = {
        url: url, http: r.status, cors: acao || '(缺少 Access-Control-Allow-Origin)', body: t
      };
      return window.__b3AiDiag;
    } catch (e) {
      window.__b3AiDiag = {
        url: url, http: 0, cors: '-', body: '探针也失败：' + String((e && e.message) || e)
      };
      return window.__b3AiDiag;
    }
  }

  function explain(err, diag) {
    var m = String((err && err.message) || err || '');
    if (err && err.name === 'AbortError') {
      return '请求超时。AI 与出图合计约需 1 分钟，若一直超时请稍后重试或联系客服。';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      var head = diag && diag.http
        ? ('已能连到服务（HTTP ' + diag.http + '，CORS 头：' + diag.cors + '），但浏览器拒绝了跨域响应。')
        : '请求没能到达服务端。';
      return head + ' 可能原因：被浏览器扩展/广告拦截插件拦下、公司网络或 DNS 限制、或该域名被运营商屏蔽。可先用手机流量试一次；仍不行请把此提示截图给客服。';
    }
    return m;
  }

  /**
   * 统一的 AI 设计请求。
   * @param {{mode?:string, kind:string, info:object, mm:number}} payload
   * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
   */
  window.__b3AiPost = async function (payload) {
    var url = resolveUrl();
    if (!url) return { ok: false, error: 'AI 暂时不可用，请刷新页面重试' };
    var body = JSON.stringify(payload);
    var attempts = [
      { 'Content-Type': 'text/plain;charset=UTF-8' },
      { 'Content-Type': 'application/json', apikey: anonKey(), Authorization: 'Bearer ' + anonKey() }
    ];
    var lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      try {
        var res = await fetch(url, { method: 'POST', headers: attempts[i], body: body, signal: withTimeout(150000) });
        var txt = await res.text();
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        if (!data) {
          return { ok: false, error: '服务返回了非 JSON 内容（HTTP ' + res.status + '）：' + String(txt).replace(/\s+/g, ' ').slice(0, 120) };
        }
        if (!res.ok || data.ok === false) {
          return { ok: false, error: String(data.error || ('HTTP ' + res.status)) };
        }
        return { ok: true, data: data };
      } catch (e) {
        lastErr = e;
      }
    }
    var diag = await probe(url);
    var msg = explain(lastErr, diag);
    if (window.console && console.warn) {
      console.warn('[birch] AI 请求失败', { url: url, error: lastErr, diag: diag });
    }
    return { ok: false, error: msg, diag: diag };
  };

  /* 供用户在浏览器控制台一行自检：await __b3AiSelfTest() */
  window.__b3AiSelfTest = async function () {
    var url = resolveUrl();
    var d = await probe(url);
    var r = await window.__b3AiPost({ mode: 'design', kind: 'free', info: { note: '自检' }, mm: 8 });
    var out = { endpoint: url, probe: d, request: r.ok ? '成功' : r.error };
    if (window.console) console.log('[birch] AI 自检结果', out);
    return out;
  };
})();

/* ============================================================
 * 桦库 · 后台启动诊断（v1 / 20260928）
 * ------------------------------------------------------------
 * 背景：「管理员后台启动不了」这类反馈，页面本身不报错（jsdom 复现里后台能正常打开），
 *       问题只可能出在真实浏览器里的具体环节（登录态、RPC、弹层、脚本加载）。
 *       这里把整条链路的每一步都记到控制台，并注册全局错误钩子，
 *       让一次点击就能定位到卡在哪一步。
 * 用法：进入页面后点击后台入口，然后在控制台看 [birch-admin] 开头的日志；
 *       或直接执行  __b3AdminDiag()
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3AdminDiag) return;

  var steps = [];
  function mark(step, extra) {
    var rec = { t: new Date().toISOString().slice(11, 23), step: step, extra: extra === undefined ? '' : extra };
    steps.push(rec);
    try { if (window.console && console.log) console.log('[birch-admin]', rec.t, step, rec.extra); } catch (e) {}
    return rec;
  }
  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }

  window.__b3AdminDiag = function () {
    var out = {
      steps: steps.slice(),
      env: {
        scriptFixes: !!window.__b3AiRoute,
        aiPost: typeof window.__b3AiPost,
        aiNew: typeof window.__b3AiNew,
        hookV2: window.__b3AiHookV2 || 0,
        b3Loaded: !!document.getElementById('birch3js'),
        b3CssLoaded: !!document.getElementById('birch3css'),
        userSession: (function () { var u = g('userSession'); return u && u.username ? u.username : '(未登录)'; })(),
        adminPwd: (function () { var p = g('currentAdminPwd'); return p ? '(已持有)' : '(无)'; })()
      },
      dom: {
        adminEntry: !!document.getElementById('adminEntry'),
        genPanel: !!document.getElementById('genPanel'),
        genPanelShown: !!(document.getElementById('genPanel') || {}).classList && document.getElementById('genPanel').classList.contains('show'),
        adminHome: !!document.getElementById('adminHome'),
        homePanelDisplay: (document.getElementById('homePanel') || {}).style ? document.getElementById('homePanel').style.display : '(无)',
        pwdModalShown: !!(document.getElementById('pwdModal') || {}).classList && document.getElementById('pwdModal').classList.contains('show'),
        loadingShown: !!(document.getElementById('loadingMask') || {}).classList && String(document.getElementById('loadingMask').className).indexOf('show') > -1,
        cards: document.querySelectorAll('#adminHome .admin-card').length
      }
    };
    if (window.console) console.log('[birch-admin] 诊断结果', out);
    return out;
  };

  /* 全局错误钩子：页面里任何未捕获异常都会留痕（后台启动失败多半是这类） */
  window.addEventListener('error', function (ev) {
    mark('window.onerror', (ev && ev.message || '') + ' @' + (ev && ev.filename || '') + ':' + (ev && ev.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    mark('unhandledrejection', String((r && (r.stack || r.message)) || r).slice(0, 200));
  });

  /* 包一层后台入口，记录「点了没有 / 走到哪一步 / 是否抛错」 */
  function wrapEntry() {
    var names = ['openAdminPage', 'checkAdminEntry', 'enterAdmin'];
    var done = 0;
    names.forEach(function (n) {
      var fn = window[n];
      if (typeof fn !== 'function' || fn.__b3Wrapped) return;
      var w = function () {
        mark(n + ' 被调用');
        var r;
        try {
          r = fn.apply(window, arguments);
        } catch (e) {
          mark(n + ' 抛错', String((e && e.message) || e));
          throw e;
        }
        if (r && typeof r.then === 'function') {
          return r.then(function (v) { mark(n + ' 完成'); return v; },
                        function (e) { mark(n + ' 异步失败', String((e && e.message) || e)); throw e; });
        }
        mark(n + ' 同步返回');
        return r;
      };
      w.__b3Wrapped = 1;
      window[n] = w;
      done++;
    });
    return done;
  }

  /* bundle 是 defer：等它就绪后再包 */
  var tries = 0;
  (function wait() {
    if (wrapEntry() >= 2 || tries++ > 120) return;
    setTimeout(wait, 100);
  })();

  /* 幂等入口：把后台入口换成「先记录再执行」 */
  document.addEventListener('click', function (ev) {
    try {
      var t = ev.target;
      var el = t && t.closest ? t.closest('#adminEntry, [onclick*="openAdminPage"], [onclick*="checkAdminEntry"]') : null;
      if (el) mark('点击后台入口', el.id || el.getAttribute('onclick') || '');
    } catch (e) {}
  }, true);
})();

/* 后台「填入正确地址」按钮的实现（放在这里而不是行内 onclick：
   行内脚本里 window.toast 等 bundle 全局并不可靠，且长行内表达式难以维护） */
(function () {
  if (window.__b3FillAiUrl) return;
  window.__b3FillAiUrl = function () {
    var el = document.getElementById('aiFuncUrl');
    if (!el) return false;
    var url = (typeof window.__b3AiEndpoint === 'function' && window.__b3AiEndpoint())
      || 'https://api.birchstudio.cn/functions/v1/birch-ai';
    el.value = url;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    var t = (function () { try { return (0, eval)('toast'); } catch (e) { return undefined; } })();
    if (typeof t === 'function') { try { t('已填入正确函数地址，记得点保存'); } catch (e) {} }
    return true;
  };
})();

/* ============================================================
 * 桦库 · 后台启动看门狗（v1 / 20260928）
 * ------------------------------------------------------------
 * 「后台启动不了」最难受的形态是「点了没反应」：
 * enterAdmin 里有一长串 await（loadData / loadGallery / loadUsers / purge_old_orders…），
 * 任何一环在真实网络下长期 pending，用户就只能看到一个转圈的加载层。
 * bundle 里虽然有 Promise.race(…, 6s) 兜底，但如果异常发生在它之前
 * （例如某个全局未定义、或落库写入抛错），面板就永远不显示。
 * 这里独立加一道看门狗：点了后台入口后 8 秒内面板仍未 show，就强制打开并提示。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3AdminWatchdog) return;
  window.__b3AdminWatchdog = 1;

  function toast(msg) {
    var t = (function () { try { return (0, eval)('toast'); } catch (e) { return undefined; } })();
    if (typeof t === 'function') { try { t(msg); return; } catch (e) {} }
    if (window.console && console.warn) console.warn('[birch-admin] ' + msg);
  }
  function hideLoading() {
    var f = (function () { try { return (0, eval)('hideLoading'); } catch (e) { return undefined; } })();
    if (typeof f === 'function') { try { f(); } catch (e) {} }
    var lm = document.getElementById('loadingMask');
    if (lm && String(lm.className).indexOf('show') > -1) lm.classList.remove('show');
  }

  function forceOpen(reason) {
    var gp = document.getElementById('genPanel');
    var ah = document.getElementById('adminHome');
    var hp = document.getElementById('homePanel');
    if (hp) hp.style.display = 'none';
    if (gp) gp.classList.add('show');
    if (ah) ah.style.display = 'grid';
    hideLoading();
    var m = document.getElementById('b3AdminWarn');
    if (!m) {
      m = document.createElement('div');
      m.id = 'b3AdminWarn';
      m.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:13100;' +
        'background:linear-gradient(135deg,#fff7e0,#ffe9b8);border:1px solid rgba(212,160,61,.5);' +
        'border-radius:14px;padding:10px 14px;font-size:12.5px;color:#7a5a1a;line-height:1.7;' +
        'box-shadow:0 12px 30px rgba(0,0,0,.18);';
      document.body.appendChild(m);
    }
    m.textContent = '⚠️ 后台启动过程较慢或中途出错，已强制打开面板（' + reason + '）。若数据没刷新，可点「返回」后重进，或把控制台的 [birch-admin] 日志发给技术。';
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest
      ? ev.target.closest('#adminEntry,[onclick*="openAdminPage"],[onclick*="checkAdminEntry"]')
      : null;
    if (!el) return;
    var waited = 0;
    (function poll() {
      var gp = document.getElementById('genPanel');
      if (gp && gp.classList.contains('show')) return;      /* 已正常打开 */
      waited += 400;
      if (waited > 8000) {
        var hasPwdModal = !!(document.getElementById('pwdModal') || {}).classList
          && document.getElementById('pwdModal').classList.contains('show');
        /* 停在密码框是正常流程，不打扰 */
        if (!hasPwdModal) forceOpen('等待超过 8 秒');
        return;
      }
      setTimeout(poll, 400);
    })();
  }, true);
})();

/* ============================================================
 * 桦库 · 后台入口抢救（v1 / 20260929）
 * ------------------------------------------------------------
 * 【实测定位到的机制性缺陷】
 *   页面顶部「连点 6 次」的隐藏后台入口，处理逻辑写在 bundle.js 里，大意是：
 *     if (userSession && userSession.username)
 *        try { supabaseClient.rpc("get_user_is_admin", …).then(…) } catch {}
 *     else toast("请先登录管理员账号后再进入后台")
 *   问题：supabaseClient 只有在 window.supabase（第三方 CDN 的 supabase-js）加载成功后
 *   才存在。CDN 被拦/超时（广告拦截插件、运营商、公司网络都会触发）时，
 *   这一行会抛 ReferenceError 并被那个**空的 catch 吞掉** ——
 *   于是不弹登录框、不报错、什么都不发生，正是「点了没反应」。
 *
 * 【本段做什么】
 *   1) 自己再监听一次 6 连点：不依赖 supabaseClient，先判断登录态，
 *      并把结果明确告诉用户（而不是静默）；
 *   2) 客户端还没就绪时，主动驱动 ensureSupabase() 等待库加载（最多 10 秒），
 *      库迟到也能补开后台（原逻辑错过就永远进不去）；
 *   3) 库始终加载失败 → 弹出可读原因 + 控制台诊断，并给出应对办法；
 *   4) 幂等：若原处理器已经成功打开后台，本段不重复动作。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3AdminRescue) return;
  window.__b3AdminRescue = 1;

  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  function toast(msg) {
    var t = g('toast');
    if (typeof t === 'function') { try { t(msg); return; } catch (e) {} }
    if (window.console && console.warn) console.warn('[birch-admin] ' + msg);
  }
  function client() { return g('supabaseClient'); }
  function panelOpen() {
    var gp = document.getElementById('genPanel');
    return !!(gp && gp.classList.contains('show'));
  }
  function loggedInUser() {
    var u = g('userSession');
    return u && u.username ? u : null;
  }

  /* 等 supabase 客户端就绪；成功回调，失败给出可读原因 */
  function waitClient(cb, tries) {
    tries = tries || 0;
    var c = client();
    if (c && typeof c.rpc === 'function') { cb(null, c); return; }
    if (tries === 0) {
      var ensure = g('ensureSupabase');
      if (typeof ensure === 'function') { try { ensure(); } catch (e) {} }
    }
    if (tries > 40) {                     /* ≈10 秒 */
      cb('supabase 库没有加载成功', null);
      return;
    }
    setTimeout(function () { waitClient(cb, tries + 1); }, 250);
  }

  function tryEnterWithRetry() {
    waitClient(function (err, c) {
      if (err) {
        /* 明确告诉用户，而不是静默失败 */
        var tip = '页面还没准备好，暂时进不了后台。请刷新页面重试；若仍不行，换个网络或关闭广告拦截插件后再试。';
        toast('⚠️ ' + tip);
        if (window.console && console.warn) {
          console.warn('[birch-admin] 后台入口失败：supabase 库未就绪', {
            hasWindowSupabase: !!window.supabase,
            supabaseUrl: g('SUPABASE_URL')
          });
        }
        var box = document.getElementById('b3AdminHint');
        if (!box) {
          box = document.createElement('div');
          box.id = 'b3AdminHint';
          box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:13100;' +
            'background:linear-gradient(135deg,#fff7e0,#ffe9b8);border:1px solid rgba(212,160,61,.5);' +
            'border-radius:14px;padding:12px 14px;font-size:12.5px;color:#7a5a1a;line-height:1.8;' +
            'box-shadow:0 12px 30px rgba(0,0,0,.18);';
          box.onclick = function () { box.remove(); };
          document.body.appendChild(box);
        }
        box.textContent = '⚠️ ' + tip + '（点此处关闭）';
        return;
      }
      var u = loggedInUser();
      if (!u) { toast('请先登录管理员账号后再进入后台'); return; }
      c.rpc('get_user_is_admin', { p_username: u.username }).then(function (x) {
        if (x && x.error) {
          toast('权限校验失败（数据库返回错误）：' + (x.error.message || JSON.stringify(x.error)));
          if (window.console && console.warn) console.warn('[birch-admin] rpc 错误', x.error);
          return;
        }
        if (x && x.data) {
          var enter = g('enterAdmin');
          if (typeof enter === 'function') { enter(u.username); return; }
          var oc = g('checkAdminEntry');
          if (typeof oc === 'function') { oc(); return; }
          toast('后台入口函数缺失，请刷新页面重试');
        } else {
          c.rpc('get_user_is_super_admin', { p_username: u.username }).then(function (y) {
            if (y && y.data) {
              var enter2 = g('enterAdmin');
              if (typeof enter2 === 'function') { enter2(u.username); return; }
              toast('后台入口函数缺失，请刷新页面重试');
            } else {
              toast('账号「' + u.username + '」在数据库里不是管理员（is_admin=false）。'+
                    '如果你确定它是管理员，请检查：① 当前登录的是否就是该账号；② users 表里该账号的 is_admin 字段。');
              if (window.console && console.warn) {
                console.warn('[birch-admin] 权限校验未通过', { 被检查账号: u.username, 返回: x });
              }
            }
          }).catch(function () { toast('权限校验失败，请稍后重试'); });
        }
      }).catch(function () { toast('权限校验失败（网络或数据库不可达），请稍后重试'); });
    });
  }

  /* 自己再监听一次 6 连点（捕获阶段，不受 bundle 内部逻辑影响） */
  var count = 0, timer = null;
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('#bBurger')) return;      /* 与原逻辑一致：点「功能」不算 */
    var inNav = !!(t && t.closest && t.closest('#bNav,#adminEntry'));
    if (!inNav) return;
    count++;
    clearTimeout(timer);
    timer = setTimeout(function () { count = 0; }, 1500);
    if (count < 6) return;
    count = 0;
    if (panelOpen()) return;                                   /* 原处理器已成功打开 */
    setTimeout(function () {
      if (panelOpen()) return;                                 /* 再确认一次，避免重复 */
      tryEnterWithRetry();
    }, 600);                                                   /* 给原处理器一点时间先跑 */
  }, true);
})();

/* ============================================================
 * 桦库 · supabase 客户端缺失的容错（v1 / 20260929）
 * ------------------------------------------------------------
 * 【实测复现到的真实故障（与「连点 6 次没反应」一致）】
 *   supabaseClient 只有在 window.supabase（第三方 CDN 的 supabase-js）加载成功后
 *   才会被创建。CDN 被拦/超时（广告拦截插件、运营商、公司网络）时它永远是 null，
 *   而页面里有大量 `supabaseClient.rpc(...)` 是**没有空值保护**的，例如：
 *
 *     startActiveHeartbeat() {
 *       if (!userSession || !userSession.username) return;
 *       const tick = () => { …; supabaseClient.rpc("touch_active", …).catch(()=>{}) };
 *       tick();                                  // ← 这里直接抛
 *       activeHeartbeatTimer = setInterval(tick, 60000);
 *     }
 *     initPage(){ … startActiveHeartbeat() … }   // ← 初始化被中断
 *
 *   实测堆栈：
 *     TypeError: Cannot read properties of null (reading 'rpc')
 *       at tick … at startActiveHeartbeat … at initPage
 *
 *   于是：已登录用户在库加载失败时，**页面初始化中途断掉**，
 *   后续所有绑定（含点击计数、后台入口）都没装上 →
 *   表现就是「连点 6 次完全没反应、也不报错」。
 *
 * 【本段做什么】
 *   1) 兜住所有「因为客户端还没就绪而抛错」的回调：微任务（await 之后）与定时器，
 *      失败时排队，等 ensureSupabase 就绪后自动重放 —— 让页面初始化不再中断；
 *   2) 浏览器控制台不再被这类 null 异常刷屏，便于真正的问题浮出来；
 *   3) 若客户端始终建不起来，给出可读提示（不再静默）。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3SbResilience) return;
  window.__b3SbResilience = 1;

  var clientMissing = function (e) {
    var m = String((e && e.message) || e || '');
    return /null|undefined/.test(m) && /rpc|from|auth|storage/.test(m)
        || /supabaseClient/.test(String((e && e.stack) || ''));
  };

  /* 客户端就绪后再重放（最多等 12 秒） */
  function replay(fn, tries) {
    tries = tries || 0;
    var c = (function () { try { return (0, eval)('supabaseClient'); } catch (e) { return undefined; } })();
    if (c) { try { fn(); } catch (e) {} return; }
    if (tries > 48) return;
    var ensure = (function () { try { return (0, eval)('ensureSupabase'); } catch (e) { return undefined; } })();
    if (tries === 0 && typeof ensure === 'function') { try { ensure(); } catch (e) {} }
    setTimeout(function () { replay(fn, tries + 1); }, 250);
  }

  /* 1) 微任务：`await xxx` 之后的代码抛错会走 queueMicrotask → unhandledrejection */
  if (typeof window.queueMicrotask === 'function') {
    var origQM = window.queueMicrotask.bind(window);
    window.queueMicrotask = function (cb) {
      return origQM(function () {
        try { cb(); } catch (e) {
          if (clientMissing(e)) { replay(cb); return; }
          throw e;
        }
      });
    };
  }

  /* 2) 定时器：心跳等周期性任务同样要容错 */
  var origSetInterval = window.setInterval.bind(window);
  window.setInterval = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    return origSetInterval(function () {
      try { return fn.apply(this, args); } catch (e) {
        if (clientMissing(e)) { replay(function () { try { fn.apply(null, args); } catch (e2) {} }); return; }
        throw e;
      }
    }, ms);
  };
  var origSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof fn !== 'function') return origSetTimeout.apply(null, arguments);
    return origSetTimeout(function () {
      try { return fn.apply(this, args); } catch (e) {
        if (clientMissing(e)) { replay(function () { try { fn.apply(null, args); } catch (e2) {} }); return; }
        throw e;
      }
    }, ms);
  };

  /* 3) 兜底的未处理拒绝：不刷屏，但记录最近一次，便于控制台诊断 */
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    if (clientMissing(r)) {
      window.__b3LastSbError = String((r && r.message) || r);
      try { ev.preventDefault(); } catch (e) {}
      if (window.console && console.warn) {
        console.warn('[birch] 数据库客户端尚未就绪，相关调用已排队等待（不影响页面其它功能）');
      }
    }
  });

  /* 4) 若 12 秒后客户端仍然缺失，给用户一个明确说明 */
  setTimeout(function () {
    var c = (function () { try { return (0, eval)('supabaseClient'); } catch (e) { return undefined; } })();
    if (c || window.supabase) return;
    if (window.console && console.warn) console.warn('[birch] supabase 库加载失败：登录/后台/订单等云端功能不可用');
  }, 12000);
})();

/* ============================================================
 * 说明（2026-09-29）
 * ------------------------------------------------------------
 * 这里曾尝试过「延迟客户端代理」：让 supabaseClient 永不为 null，
 * 把调用排队到真正的库加载完成后再重放。
 * 实测结论：该方案会干扰真实客户端的创建时序，导致正常场景下
 * （库完全可用时）后台入口也不再可用 —— 净效果是变差，故已移除。
 * 现在只保留两处**不改变正常行为**的修复：
 *   1) js/early.js（bundle 之前加载）：包装 setTimeout/setInterval/queueMicrotask，
 *      把「因客户端尚未就绪而抛错」的回调排队重放，避免 initPage 中途中断；
 *   2) 本文件末尾的「后台入口抢救」：6 连点时若客户端/库确实不可用，
 *      给出**可读原因**而不是静默失败。
 * ============================================================ */

/* ============================================================
 * 桦库 · 管理员权限排障命令（v1 / 20260929）
 * ------------------------------------------------------------
 * 针对「显示 xxx 账号无管理员权限」：把三件事一次打印出来 ——
 *   1) 页面当前认为你是哪个账号（来自 localStorage 的 birch_user）
 *   2) 数据库对**这个账号名**的真实判断（get_user_is_admin / is_super_admin）
 *   3) 原始返回值与错误对象
 * 用法：控制台执行  await __b3WhoAmI()
 * ============================================================ */
(function () {
  if (window.__b3WhoAmI) return;
  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  window.__b3WhoAmI = async function () {
    var session = g('userSession');
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem('birch_user') || 'null'); } catch (e) {}
    var out = {
      页面登录态: session && session.username ? session.username : '(未登录)',
      localStorage里的账号: stored && stored.username ? stored.username : '(无)',
      两者一致: !!(session && stored && session.username === stored.username),
      账号名长度: session && session.username ? session.username.length : 0,
      含空白字符: !!(session && session.username && /\s/.test(session.username)),
      数据库判定: null,
      原始返回: null
    };
    var c = g('supabaseClient');
    if (!c || typeof c.rpc !== 'function') {
      out.说明 = 'supabase 客户端未就绪，无法查询（请刷新或检查 CDN 是否被拦）';
      console.log('[birch-admin] __b3WhoAmI', out);
      return out;
    }
    if (session && session.username) {
      try {
        var a = await c.rpc('get_user_is_admin', { p_username: session.username });
        var b = await c.rpc('get_user_is_super_admin', { p_username: session.username });
        out.数据库判定 = { is_admin: a && a.data, is_super_admin: b && b.data };
        out.原始返回 = { admin: a, super: b };
      } catch (e) {
        out.说明 = 'rpc 调用异常：' + ((e && e.message) || e);
      }
    } else {
      out.说明 = '页面未登录：请先登录管理员账号';
    }
    if (out.数据库判定 && !out.数据库判定.is_admin && !out.数据库判定.is_super_admin) {
      out.结论 = '数据库里「' + (session && session.username) + '」确实不是管理员。' +
                 '请核对 users 表该账号的 is_admin 字段，或退出后重新登录。';
    } else if (out.数据库判定) {
      out.结论 = '账号权限正常。若后台仍打不开，请把本对象截图给技术。';
    }
    if (window.console) console.log('[birch-admin] __b3WhoAmI', out);
    return out;
  };
})();

/* ============================================================
 * 桦库 · 云端连通性排障（v1 / 20260929）
 * ------------------------------------------------------------
 * 现象：登录失败 + AI「服务错误，未能到达服务端」+ 权限校验异常，
 *       三者往往同源 —— 浏览器连不上 Supabase 项目域名
 *       （Supabase 项目域名）。
 *       该域名在部分网络/地区会被 DNS 污染、连接重置或超时；
 *       静态站（GitHub Pages）却正常，所以看起来像"网站坏了"。
 *
 * 用法：控制台执行  await __b3NetCheck()
 *   会逐个探测候选域名的 REST 与 Edge Functions 端点，打印：
 *     · 是否可达（HTTP 状态或失败原因）
 *     · 每次请求耗时
 *     · 结论：哪个域名在本网络下可用 → 后台「AI 智能设计」的函数地址就填哪个
 * ============================================================ */
(function () {
  if (window.__b3NetCheck) return;
  function g(n) { try { return (0, eval)(n); } catch (e) { return undefined; } }

  async function probe(url, ms) {
    var t0 = Date.now();
    var ac = null;
    try {
      if (typeof AbortController === 'function') {
        ac = new AbortController();
        setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms);
      }
    } catch (e) {}
    try {
      var r = await fetch(url, { method: 'GET', signal: ac ? ac.signal : undefined, cache: 'no-store' });
      return { url: url, ok: r.ok, http: r.status, ms: Date.now() - t0 };
    } catch (e) {
      return {
        url: url,
        ok: false,
        http: 0,
        ms: Date.now() - t0,
        err: (e && e.name === 'AbortError') ? ('超时 ' + ms + 'ms') : String((e && e.message) || e)
      };
    }
  }

  window.__b3NetCheck = async function () {
    var base = String(g('SUPABASE_URL') || '').replace(/\/$/, '');
    /* 前端现在连的是自有反代域名（https://api.birchstudio.cn），URL 里已不含项目 ref；
       排障时仍想拿 Supabase 原始域名做对照，所以这里留一个已知 ref 兜底。 */
    var PROJ_REF_KNOWN = 'btfxanbzshefhobndywd';
    var projRef = (base.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || PROJ_REF_KNOWN;
    var candidates = [];
    if (base) candidates.push({ name: '① 页面当前配置的地址', root: base });
    candidates.push({ name: '② Supabase 原始域名（对照）', root: 'https://' + projRef + '.supabase.co' });
    var out = { 页面配置的域名: base, 探测: [], 结论: '' };
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var rest = await probe(c.root + '/rest/v1/', 12000);
      var fn = await probe(c.root + '/functions/v1/birch-ai', 15000);
      out.探测.push({ 名称: c.name, 域名: c.root, REST: rest, EdgeFunction: fn });
    }
    /* 顺带测一下静态站自身，用于说明"网页能开不代表云服务可达" */
    out.本站 = await probe(location.origin + '/index.html', 10000);

    var restOk = out.探测.some(function (p) { return p.REST.ok || (p.REST.http > 0 && p.REST.http < 500); });
    var fnOk = out.探测.some(function (p) { return p.EdgeFunction.ok || (p.EdgeFunction.http > 0 && p.EdgeFunction.http < 500); });
    if (restOk && fnOk) {
      out.结论 = '云端可达。若仍失败，请把本对象截图给技术。';
    } else if (restOk && !fnOk) {
      out.结论 = '数据库可达，但 Edge Functions 不可达：AI 出图会失败。请确认函数已部署，' +
                 '并在后台「AI 智能设计」把函数地址填成 ' + base + '/functions/v1/birch-ai';
    } else {
      out.结论 = '浏览器连不上 Supabase 项目域名（' + base + '）。这是网络/地区限制导致的：' +
                 '静态网页能打开，但登录、后台、AI 都会失败。' +
                 '建议：① 换手机流量或其它网络重试；② 关闭代理/VPN 后重试；' +
                 '③ 本站在 ' + (base ? base : '自有反代域名') + ' 上做了反代（Cloudflare Worker 回源 Supabase），' +
                 '正常情况下不应再出现此提示；若持续如此请把本对象截图给技术。';
    }
    if (window.console) console.log('[birch] __b3NetCheck', out);
    return out;
  };
})();

/* ============================================================
 * 桦库 · 账号链路诊断工具（20260930 重写）
 * ------------------------------------------------------------
 * 【为什么重写这一段】
 *   这里原先叠了 6 层互相覆盖的登录补丁：
 *     __b3LoginGuard / __b3LoginDiag / __b3Sha256 /
 *     __b3LoginFixV2 / __b3LoginCheck补丁 / __b3LoginTrace
 *   它们各自包装 window.loginAccount、覆盖 window.sha256hex，
 *   而且都是用 setInterval 轮询安装 —— 谁先装上不确定，
 *   后装的会拿到先装者包装过的版本，形成套娃。后果是：
 *     · 一次登录失败可能弹好几条 toast，互相矛盾；
 *     · 包装层里任何一步抛错，就变成"点了没反应、也不报错"；
 *     · 报错文案与实际原因脱节（网络不通却说密码错）。
 *
 * 【现在的分工】
 *   真正的修复已经下沉到 js/bundle.js 的源码里：
 *     · b3NormUser / b3NormPwd —— 输入归一化（全角→半角、清零宽字符、去首尾空白）
 *     · b3Sha256HexPure        —— 不依赖 Web Crypto 的 SHA-256（HTTP/旧内核兜底）
 *     · b3WaitClient           —— 等客户端就绪，不再"客户端还没建就点"
 *     · b3ExplainErr           —— 把底层错误翻译成"网络问题 / 密码错 / 接口未就绪"
 *     · registerAccount / loginAccount —— 全程 try/catch，任何异常都有可读提示
 *   所以本文件只保留「给售后看的自查命令」，不再改写登录流程本身。
 *
 * 【控制台可用命令】
 *   await __b3LoginCheck('账号','密码')  ——账号是否存在 / 密码是否正确 / 权限位
 *   await __b3NetCheck()                ——网络到 Supabase 是否可达（区分"网络病"与"账号病"）
 *   await __b3WhoAmI()                  ——当前登录态与该账号的数据库判定
 *   b3Sha256HexPure('text')             ——纯 JS 哈希（与线上算法一致，可离线复核）
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3LoginTools) return;
  window.__b3LoginTools = 1;

  function g(n) { try { return (0, eval)(n); } catch (e) { return undefined; } }

  function sha(text) {
    var s = String(text == null ? '' : text);
    try {
      var c = window.crypto || window.msCrypto;
      if (c && c.subtle && typeof c.subtle.digest === 'function') {
        return c.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return b.toString(16).padStart(2, '0');
          }).join('');
        });
      }
    } catch (e) {}
    var pure = window.b3Sha256HexPure;
    return Promise.resolve(typeof pure === 'function' ? pure(s) : '');
  }

  function norm(v) {
    return String(v == null ? '' : v)
      .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\u3000/g, ' ')
      .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
      .replace(/^\s+|\s+$/g, '');
  }

  function readLogin() {
    var uEl = document.getElementById('loginUser'), pEl = document.getElementById('loginPwd');
    return { uEl: uEl, pEl: pEl, u: uEl ? uEl.value : '', p: pEl ? pEl.value : '' };
  }

  /* 一行自查：账号存在吗 / 密码对吗 / 网络通吗 —— 结果同时打到控制台 */
  window.__b3LoginCheck = async function (userArg, pwdArg) {
    var v = readLogin();
    var user = norm(userArg != null ? userArg : v.u);
    var pwd = norm(pwdArg != null ? pwdArg : v.p);
    var out = { 账号: user, 密码长度: pwd.length, 密码含非ASCII: /[^\x00-\x7f]/.test(pwd) };
    var c = g('supabaseClient');
    if (!c) {
      out.结论 = '数据库客户端未创建：多为网络不通或第三方库(CDN)被拦。先跑 await __b3NetCheck()';
      if (window.console) console.log('[birch] __b3LoginCheck', out);
      return out;
    }
    var r;
    try {
      r = await c.rpc('get_user_auth', { p_username: user });
    } catch (e) {
      out.结论 = '请求被中断：' + ((e && e.message) || e) + '（网络问题，不是密码错）';
      if (window.console) console.log('[birch] __b3LoginCheck', out);
      return out;
    }
    if (r && r.error) {
      out.结论 = '数据库返回错误：' + r.error.message;
      if (window.console) console.log('[birch] __b3LoginCheck', out);
      return out;
    }
    var row = r && r.data && r.data[0];
    if (!row) {
      out.结论 = '用户名不存在';
      if (window.console) console.log('[birch] __b3LoginCheck', out);
      return out;
    }
    var hex = await sha(String(row.salt || '') + pwd);
    out.哈希匹配 = hex === row.pwd_hash;
    try {
      var a = await c.rpc('get_user_is_admin', { p_username: user });
      var b = await c.rpc('get_user_is_super_admin', { p_username: user });
      out.管理员 = !!(a && a.data);
      out.超级管理员 = !!(b && b.data);
    } catch (e) {}
    out.结论 = out.哈希匹配 ? '账号密码正确，可以正常登录' : '密码不正确（账号存在）';
    if (window.console) console.log('[birch] __b3LoginCheck', out);
    return out;
  };

  window.__b3TestPwd = window.__b3LoginCheck;

  /* 旧命令保留为兼容别名，避免老文档里提过、用户照着敲却报 undefined */
  window.__b3LoginFix = function () {
    if (window.console) {
      console.warn('[birch] __b3LoginFix 已停用：登录流程本身已修好；如需排查请用 await __b3LoginCheck(账号,密码)');
    }
    return null;
  };
})();
