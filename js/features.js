/* 桦库整页增强 features.js（运行时补丁：去下单购买等；后续补丁追加到此处） */
(function () {
  // 1) 去下单购买：隐藏购买/购物车/结算类入口（保留 联系/咨询）
  var HIDE_TEXT = ['立即购买', '加入购物车', '去结算', '结算(', '购物车', '确认付款', '我已付款'];
  function clean() {
    var hideCls = '.lb-buy,.gallery-buy,.buy-close,[class*="buy-modal"],[class*="cart-fab"],[class*="checkout"]';
    document.querySelectorAll(hideCls).forEach(function (el) { el.style.display = 'none'; });
    document.querySelectorAll('button,a').forEach(function (el) {
      var t = String(el.textContent || '').trim();
      if (HIDE_TEXT.some(function (k) { return t.indexOf(k) > -1; })) el.style.display = 'none';
    });
  }
  clean();
  new MutationObserver(clean).observe(document.body, { childList: true, subtree: true });
})();
