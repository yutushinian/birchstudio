/* 站点补丁：管理员登录验证 + 站内信投递保护（2026-11-12） */
(function () {
  'use strict';

  /* ---------------- 1. 管理员登录：等 Supabase 就绪，区分网络错误 ---------------- */
  function getClient() {
    try {
      if (typeof supabaseClient !== 'undefined' && supabaseClient) return supabaseClient;
    } catch (e) {}
    return window.supabaseClient || null;
  }

  async function waitClient(ms) {
    try {
      if (typeof b3WaitClient === 'function') return await b3WaitClient(ms);
    } catch (e) {}
    var deadline = Date.now() + (ms || 8000);
    while (Date.now() < deadline) {
      var c = getClient();
      if (c) return c;
      await new Promise(function (r) { setTimeout(r, 200); });
    }
    return getClient();
  }

  function errText(e) {
    if (!e) return '未知错误';
    if (e.message) return e.message;
    try { return JSON.stringify(e); } catch (e2) { return String(e); }
  }

  window.checkPwd = async function () {
    var input = document.getElementById('pwdInput');
    var errEl = document.getElementById('pwdErr');
    var pwd = input ? String(input.value || '').trim() : '';
    if (!pwd) {
      if (errEl) errEl.innerText = '请输入管理员密码';
      return;
    }
    if (errEl) errEl.innerText = '';
    try { if (typeof showLoading === 'function') showLoading('正在验证管理员身份...'); } catch (e) {}

    var ok = false;
    var why = '密码错误，请重试';
    try {
      var client = await waitClient(10000);
      if (!client) throw new Error('网络未就绪');
      var res = await client.rpc('verify_admin_pwd', { pwd: pwd });
      if (res && res.error) throw new Error(res.error.message || '验证请求失败');
      ok = res && res.data === true;
    } catch (e) {
      // 网络 / 服务异常不再伪装成“密码错误”
      why = '验证失败：' + errText(e) + '，请检查网络后重试';
    } finally {
      try { if (typeof hideLoading === 'function') hideLoading(); } catch (e) {}
    }

    if (ok) {
      try { if (typeof closePwdModal === 'function') closePwdModal(); } catch (e) {}
      if (typeof enterAdmin === 'function') await enterAdmin(pwd);
    } else if (errEl) {
      errEl.innerText = why;
    }
  };

  /* ---------------- 2. 站内信：没有收件人就不写任何信箱 ----------------
     原 pushMail(title, body) 在未传 username 时会写到 currentMailKey()，
     也就是当前登录管理员的信箱。会员卡兑换单未绑定账号时，username 为空，
     「完成订单」就会把发货通知投进管理员信箱 —— 这是错误的。
     这里统一拦截：无收件人直接忽略；绑定账号的照常投递。 */
  function guardPushMail() {
    var orig = window.pushMail;
    if (typeof orig !== 'function' || orig.__noTargetGuard) return false;
    var recent = {};
    var guarded = function (title, body, username) {
      var to = (username === null || username === undefined) ? '' : String(username).trim();
      if (!to) return Promise.resolve(false);
      // 会员卡兑换单的站内信已由服务端按“当前绑定账号”发送，
      // 前端可能再发一次；同一收件人 + 同一订单号 5 分钟内只保留第一条。
      var text = String(title || '') + ' ' + String(body || '');
      var hit = text.match(/[A-Z]\d{6,}/);
      var now = Date.now();
      if (hit) {
        // 只用「标题前缀 + 订单号」做键：同一条“已发货”不会重复，
        // 而“订单已完成”是另一个标题，不会被误吞。
        var prefix = String(title || '').replace(/\s+/g, '').slice(0, 4);
        var key = to + '|' + prefix + '|' + hit[0];
        if (recent[key] && now - recent[key] < 300000) return Promise.resolve(false);
        recent[key] = now;
        for (var k in recent) {
          if (now - recent[k] > 300000) delete recent[k];
        }
      }
      return orig(title, body, to);
    };
    guarded.__noTargetGuard = true;
    window.pushMail = guarded;
    return true;
  }

  if (!guardPushMail()) {
    var tries = 0;
    var timer = setInterval(function () {
      if (guardPushMail() || ++tries > 100) clearInterval(timer);
    }, 200);
  }
})();
