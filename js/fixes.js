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
