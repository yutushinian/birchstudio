/* ============================================================
 * 桦库 · 动效运行时 motion.js（v2 / 20260916）
 * ------------------------------------------------------------
 * 职责边界（重要）：
 *   站内 bundle.js 已有一套完整的滚动入场系统 ——
 *     #brand .reveal → IntersectionObserver(threshold .12) 加 .in，
 *     transition:opacity .9s, transform .9s
 *   覆盖品牌页 44 处文字与卡片（11 个板块标题 .b-sec-head、.b-pstep、
 *   .b-wx、.b-step、.b-func-row …）。本脚本【不重复实现】这套逻辑，
 *   其「可见性押在 JS 上」的缺口由 motion.css 的纯 CSS 保底动画补上。
 *
 *   因此本脚本只做两件实测确认必要的事：
 *     1) 给 <html> 加 b-motion 门控类（供 CSS 判定动效层是否就绪）
 *     2) 接管白桦落叶层：动画改由 CSS 变量驱动（可无障碍降级、可省电），
 *        并加滚动视差制造纵深
 *
 * 降级：检测到 prefers-reduced-motion 则完全不做动效接管，交由 CSS 收尾。
 * ============================================================ */
(function () {
  'use strict';

  var doc = document, root = doc.documentElement, body = doc.body;
  if (!body) return;

  var reduced = false;
  try {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  /* 门控类：CSS 里所有「待入场隐藏态」都挂在 html.b-motion 之下，
     本脚本若不执行则不会添加该类，内容始终可见，无白屏风险。 */
  if (!reduced) root.classList.add('b-motion');

  if (reduced) return;

  /* ---------- 落叶层：从内联动画接管到 CSS 变量 + 滚动视差 ---------- */
  var leafLayer = null;
  try {
    var kids = body.children;
    for (var b = 0; b < kids.length; b++) {
      var el = kids[b];
      if (el.tagName !== 'DIV') continue;
      if (el.getAttribute('data-leaf-layer') === '1') { leafLayer = el; break; }
      // 兼容旧结构：按内联样式特征识别
      if (!leafLayer && el.style && el.style.position === 'fixed' &&
          el.style.pointerEvents === 'none' && el.querySelector('div[style*="leafFall"]')) {
        leafLayer = el;
      }
    }
  } catch (e) {}

  if (!leafLayer) return;

  try {
    leafLayer.classList.add('b-leaf-layer');
    var leaves = leafLayer.querySelectorAll('i');
    for (var li = 0; li < leaves.length; li++) {
      var lf = leaves[li];
      // 每片叶子给一点差异：时长/延迟错开，漂移方向左右交替
      var drift = (li % 2 === 0 ? 1 : -1) * (14 + (li * 9) % 22);
      lf.style.setProperty('--lf-drift', drift + 'px');
      lf.style.setProperty('--lf-dur', (16 + li * 2.6).toFixed(1) + 's');
      lf.style.setProperty('--lf-delay', (li * 3.2).toFixed(1) + 's');
      lf.style.animation = '';   // 交还给 .b-leaf-layer i 规则统管
    }
  } catch (e) { return; }

  // 滚动视差：整层轻微反向位移（约 6%，上限 140px），行程可控不喧宾夺主
  var ticking = false, lastY = -1;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = window.pageYOffset || root.scrollTop || 0;
      if (y !== lastY) {
        lastY = y;
        var off = -Math.min(y * 0.06, 140);
        leafLayer.style.transform = 'translate3d(0,' + off.toFixed(1) + 'px,0)';
      }
      ticking = false;
    });
  }, { passive: true });
})();
