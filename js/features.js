/* ============================================================
 * 桦库整页运行时补丁 features.js（v3 loader）
 *   A) 去下单购买（隐藏购买/购物车/结算，保留联系/咨询）
 *   B) 加载 birch3（晒单分享/弹幕/审核/AI适配等）
 * 说明：本文件由 index.html 在 js/bundle.js 之后同步加载，
 *       因此可安全访问 bundle 暴露的全局函数。
 * ============================================================ */
(function () {
  'use strict';
  // ---------- A) 去下单购买 ----------
  var HIDE_TEXT = ['立即购买', '加入购物车', '去结算', '结算(', '购物车', '确认付款', '我已付款', '去支付', '提交订单'];
  function clean() {
    try {
      var hideCls = '.lb-buy,.gallery-buy,.buy-close,[class*="buy-modal"],[class*="cart-fab"],[class*="checkout"],[class*="cart"]';
      document.querySelectorAll(hideCls).forEach(function (el) { el.style.display = 'none'; });
      document.querySelectorAll('button,a').forEach(function (el) {
        var t = String(el.textContent || '').trim();
        if (HIDE_TEXT.some(function (k) { return t.indexOf(k) > -1; })) el.style.display = 'none';
      });
    } catch (e) {}
  }
  clean();
  try { new MutationObserver(clean).observe(document.body, { childList: true, subtree: true }); } catch (e) {}

  // ---------- B) 加载 birch3 模块 ----------
  function loadBirch3() {
    try {
      if (document.getElementById('birch3css')) return;
      var link = document.createElement('link');
      link.id = 'birch3css';
      link.rel = 'stylesheet';
      link.href = 'js/birch3.css?v=20260909g';
      document.head.appendChild(link);
    } catch (e) {}
    try {
      if (document.getElementById('birch3js')) return;
      var s = document.createElement('script');
      s.id = 'birch3js';
      s.src = 'js/birch3.js?v=20260909g';
      s.onerror = function () { if (window.console) console.warn('birch3.js 加载失败（网络/CDN 缓存），请稍后刷新'); };
      document.body.appendChild(s);
    } catch (e) {}
  }
  if (document.body) {
    loadBirch3();
  } else {
    document.addEventListener('DOMContentLoaded', loadBirch3);
  }
})();
