/* ============================================================
 * 桦库 · 页面启动前置修复 early.js（20260929）
 * 必须在 js/bundle.js **之前**以普通（非 defer）脚本加载。
 * ------------------------------------------------------------
 * 【它修的是什么】
 *   bundle.js 的收尾顺序是：
 *       try { initPage() } catch (e) { console.warn("页面初始化失败", e) }
 *       ensureSupabase(refreshRemoteData)          // ← 客户端建得太晚
 *   而 initPage() 对**已登录用户**会同步执行：
 *       initLoginBtn()
 *       … try { supabaseClient.rpc("touch_login", …) } catch {}   // 这个有保护
 *       startActiveHeartbeat()                                    // 这个没有
 *   紧接着：
 *       function startActiveHeartbeat(){
 *         … const tick = () => { …; supabaseClient.rpc("touch_active", …) };
 *         tick();                                  // ← 同步调用，无空值保护
 *       }
 *   只要此刻 supabaseClient 还是 null（第三方 CDN 的 supabase-js 尚未加载完、
 *   或被广告拦截插件 / 运营商拦掉），这一行就抛：
 *       TypeError: Cannot read properties of null (reading 'rpc')
 *         at tick … at startActiveHeartbeat … at initPage
 *   initPage 因此**从中断处停止**：其后的 loadCart()、loadMailbox()、
 *   以及大量按钮绑定（包括顶部导航「连点 6 次」进入管理员后台的入口）
 *   全都没有装上 —— 表现就是「连点 6 次完全没反应，也不报错」。
 *
 * 【本文件做两件事】
 *   1) 提前创建客户端：轮询等 supabase-js 就绪，立刻调用 bundle 的
 *      ensureSupabase()，把创建时机从「initPage 之后」提前到之前；
 *   2) 兜住 null 客户端：包装 setTimeout / setInterval / queueMicrotask，
 *      让「因为客户端还没就绪而抛错」的回调排队重放，而不是把初始化打断。
 *      （即使库最终没加载成功，页面也能完整初始化，后台入口照常可用，
 *        并且在真正需要联网时会给出可读提示。）
 * ============================================================ */
(function () {
  'use strict';
  if (window.__b3Early) return;
  window.__b3Early = 1;

  var queued = [];

  /* ---- 1) null 客户端容错：包装定时器与微任务 ---- */
  function looksLikeMissingClient(e) {
    var m = String((e && e.message) || e || '');
    if (/supabaseClient/.test(String((e && e.stack) || ''))) return true;
    return /Cannot read propert|undefined is not an object|null is not an object/i.test(m) &&
           /rpc|from|auth|storage|channel|functions/i.test(m);
  }

  function clientNow() {
    try { return (0, eval)('supabaseClient'); } catch (e) { return undefined; }
  }
  function ensureNow() {
    try {
      var f = (0, eval)('ensureSupabase');
      if (typeof f === 'function') f();
    } catch (e) {}
  }

  /* 客户端就绪后重放一次（最多等 12 秒） */
  function replay(fn, n) {
    n = n || 0;
    if (clientNow()) { try { fn(); } catch (e) {} return; }
    if (n === 0) ensureNow();
    if (n > 48) return;
    setTimeout(function () { replay(fn, n + 1); }, 250);
  }

  var oSetTimeout = window.setTimeout.bind(window);
  var oSetInterval = window.setInterval.bind(window);
  window.setTimeout = function (fn, ms) {
    if (typeof fn !== 'function') return oSetTimeout.apply(null, arguments);
    var rest = Array.prototype.slice.call(arguments, 2);
    return oSetTimeout(function () {
      try { return fn.apply(this, rest); } catch (e) {
        if (looksLikeMissingClient(e)) { replay(function () { try { fn.apply(null, rest); } catch (e2) {} }); return; }
        throw e;
      }
    }, ms);
  };
  window.setInterval = function (fn, ms) {
    if (typeof fn !== 'function') return oSetInterval.apply(null, arguments);
    var rest = Array.prototype.slice.call(arguments, 2);
    return oSetInterval(function () {
      try { return fn.apply(this, rest); } catch (e) {
        if (looksLikeMissingClient(e)) { replay(function () { try { fn.apply(null, rest); } catch (e2) {} }); return; }
        throw e;
      }
    }, ms);
  };
  if (typeof window.queueMicrotask === 'function') {
    var oQM = window.queueMicrotask.bind(window);
    window.queueMicrotask = function (cb) {
      return oQM(function () {
        try { cb(); } catch (e) {
          if (looksLikeMissingClient(e)) { replay(function () { try { cb(); } catch (e2) {} }); return; }
          throw e;
        }
      });
    };
  }
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    if (looksLikeMissingClient(r)) {
      window.__b3LastSbError = String((r && r.message) || r);
      try { ev.preventDefault(); } catch (e) {}
      if (window.console && console.warn) {
        console.warn('[birch] 数据库客户端尚未就绪，相关调用已排队等待（不影响页面其它功能）');
      }
    }
  });

  /* ---- 2) 关键：在 initPage 之前把客户端建好 ----
     浏览器执行顺序：async 的 CDN 脚本 → defer 的 bundle.js → defer 的 early.js
     因此本文件执行时，若 CDN 正常，window.supabase 已经就绪，可以**同步**建好客户端。
     这就是本组修复的核心：把客户端创建时机从「initPage 之后」提前到之前，
     于是 startActiveHeartbeat() 里的 supabaseClient.rpc 不再抛错，initPage 不会被中断，
     后续所有按钮绑定（含「连点 6 次」后台入口）都能正常装上。 */
  var CDN_SELECTOR = 'script[src*=supabase-js]';
  function buildNow(tag) {
    var c0;
    try { c0 = (0, eval)('supabaseClient'); } catch (e) { c0 = undefined; }
    if (c0 && typeof c0.rpc === 'function') return true;
    var lib;
    try { lib = window.supabase; } catch (e) { lib = null; }
    if (!lib || typeof lib.createClient !== 'function') return false;
    try {
      var f = (0, eval)('ensureSupabase');
      if (typeof f === 'function') f();
    } catch (e) {}
    try { c0 = (0, eval)('supabaseClient'); } catch (e) { c0 = undefined; }
    if (c0 && typeof c0.rpc === 'function') {
      if (window.console && console.log) {
        console.log('[birch] 数据库客户端已提前创建（早于 initPage）' + (tag ? ' · ' + tag : ''));
      }
      return true;
    }
    return false;
  }

  /* 2a) 现在就试（库通常已经加载完） */
  buildNow('defer 时已就绪');

  /* 2b) 还没就绪：给库里所有 supabase 脚本挂 load 钩子，加载完成的瞬间就建 */
  function hookLibScripts() {
    var tags = document.querySelectorAll(CDN_SELECTOR);
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (t.__b3Hooked) continue;
      t.__b3Hooked = 1;
      t.addEventListener('load', function () { buildNow('CDN onload'); });
      t.addEventListener('error', function () {
        if (window.console && console.warn) {
          console.warn('[birch] supabase CDN 脚本加载失败：' + (this.src || ''));
        }
      });
    }
  }
  hookLibScripts();

  /* 2c) 兜底轮询：某些浏览器/缓存场景下 load 事件可能已错过 */
  var tries2 = 0;
  (function pollBuild() {
    if (buildNow('轮询')) return;
    if (++tries2 > 400) {
      if (window.console && console.warn) {
        console.warn('[birch] supabase 库未加载成功：登录/后台数据/订单等云端功能将在需要时提示不可用；' +
                     '页面其它功能与「连点 6 次」后台入口不受影响');
      }
      return;
    }
    setTimeout(pollBuild, 25);
  })();

})();

/* ============================================================
 * 3) 让 startActiveHeartbeat 不再同步抛错（本组修复的关键一击）
 * ------------------------------------------------------------
 * 时序：bundle.js(defer) → early.js(defer) → DOMContentLoaded → initPage()
 * 也就是说本文件执行时 initPage 还没被调用，可以安全地把
 * startActiveHeartbeat 换成"先确保客户端存在、再执行原逻辑"的版本。
 *
 * 原函数内部（bundle 源码）：
 *   const tick = () => { …; supabaseClient.rpc("touch_active", …).catch(()=>{}) };
 *   tick();                                   // ← 客户端为 null 时同步抛错
 * 这个同步抛错会让 initPage() 中断，其后的所有绑定都不再执行 ——
 * 正是「连点 6 次没反应」的原因。
 * ============================================================ */
(function () {
  var wrapped = false;
  function wrapHeartbeat() {
    if (wrapped) return true;
    var orig = window.startActiveHeartbeat;
    if (typeof orig !== 'function') return false;
    window.startActiveHeartbeat = function () {
      var c;
      try { c = (0, eval)('supabaseClient'); } catch (e) { c = undefined; }
      if (!c || typeof c.rpc !== 'function') {
        /* 客户端还没就绪：不要抛错，改为等待就绪后再补一次心跳 */
        var n = 0;
        (function retry() {
          var cc;
          try { cc = (0, eval)('supabaseClient'); } catch (e) { cc = undefined; }
          if (cc && typeof cc.rpc === 'function') { try { orig.apply(window, arguments); } catch (e) {} return; }
          if (++n > 48) {
            if (window.console && console.warn) {
              console.warn('[birch] 数据库客户端不可用，已跳过在线心跳（不影响页面与后台入口）');
            }
            return;
          }
          setTimeout(retry, 250);
        })();
        return;
      }
      try {
        return orig.apply(window, arguments);
      } catch (e) {
        if (window.console && console.warn) console.warn('[birch] 心跳启动失败（已忽略）:', e && e.message);
      }
    };
    wrapped = true;
    if (window.console && console.log) console.log('[birch] startActiveHeartbeat 已加固（不会因客户端未就绪而中断页面初始化）');
    return true;
  }
  /* bundle 已在本文件之前执行完，函数应已挂到 window；没有则短暂重试 */
  if (!wrapHeartbeat()) {
    var tries = 0;
    var t = setInterval(function () {
      if (wrapHeartbeat() || ++tries > 20) clearInterval(t);
    }, 25);
  }
})();

/* ============================================================
 * 4) 启动自检（一行日志，便于远程定位「连点 6 次没反应」）
 *    -- 正常应看到：客户端已提前创建
 *    -- 若看到：库未加载成功 → 就是 CDN 被拦，后台数据功能会不可用
 * ============================================================ */
(function () {
  setTimeout(function () {
    var lib = null, c = null;
    try { lib = !!window.supabase; } catch (e) {}
    try { c = (0, eval)('supabaseClient'); } catch (e) {}
    var u = null;
    try { u = (0, eval)('userSession'); } catch (e) {}
    var hb = false;
    try { hb = /已加固|__b3/.test(String(window.startActiveHeartbeat)); } catch (e) {}
    if (window.console && console.log) {
      console.log('[birch] 启动自检', {
        '库已加载': lib,
        '客户端已创建': !!(c && typeof c.rpc === 'function'),
        '登录态': (u && u.username) ? u.username : '(未登录)',
        '心跳加固': hb,
        '提示': (lib && c) ? '一切正常' : '若后台/出图异常，请把本行截图给技术'
      });
    }
  }, 3000);
})();
