/* ============================================================
 * 桦库 · 动效运行时 motion.js（v1 / 20260916）
 * ------------------------------------------------------------
 * 职责：
 *   1) 滚动渐进入场：观察标记好的 .b-reveal，进入视口时加 .b-in
 *   2) 同组交错：按序号分配 --rv-delay，形成层次而非齐刷刷弹出
 *   3) 落叶层：接管内联动画（换取可降级/可省电）+ 滚动视差纵深
 *   4) 兜底：任何异常都在 2.6s 内强制显示，绝不留下空白内容
 * ------------------------------------------------------------
 * 依赖：js/motion.css
 * 门控：本脚本第一件事是给 <html> 加 .b-motion，
 *       而 CSS 中所有「隐藏待入场」规则都挂在 html.b-motion 之下。
 *       因此本脚本若不执行/报错，内容始终可见，不存在白屏风险。
 * 无障碍：检测到 prefers-reduced-motion 则整体不启用。
 * ============================================================ */
(function () {
  'use strict';

  var doc = document, root = doc.documentElement, body = doc.body;
  if (!body) return;

  /* ---------- 尽快上锁（脚本在 body 末尾同步执行，此处即首帧渲染前） ---------- */
  var reduced = false;
  try {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  if (!reduced) root.classList.add('b-motion');

  /* ---------- 渐进入场目标 ----------
     重要：站内（js/bundle.js）已有一套滚动入场 —— 给带 .reveal 的元素加 .in
     （threshold .12 / rootMargin -6%，transition .9s）。因此本层只接管
     **既有系统未覆盖的区块容器**，绝不重复叠加：
       ✅ 收录：.b-story / .b-lux-grid / .b-jieqi / .b-wuxing-grid /
                .b-gua-grid / .b-process-steps 等整块容器
       ❌ 排除：.b-sec-head（每处都已带 .reveal，由既有系统负责）
                .b-pstep / .b-wx / .b-step 等（子项带 .reveal，父级刻意留白）
     位移走 translate 通道，与既有 .reveal 的 transform 过渡互不干扰。 */
  var REVEAL_TARGETS = [
    '#brand .b-story',
    '#brand .b-lux-grid',
    '#brand .b-jieqi',
    '#brand .b-wuxing-grid',
    '#brand .b-gua-grid',
    '#brand .b-process-steps'
  ];

  var STAGGER = 56;       // 与 --motion-stagger 一致
  var STAGGER_CAP = 420;  // 同组最大交错总时长，避免末位等太久
  var PASSIVE = { passive: true };

  var marked = [];        // 已打类的元素
  var io = null;

  /* ---------- 视口观察 ---------- */
  if (!reduced && 'IntersectionObserver' in window) {
    try {
      io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          entries[i].target.classList.add('b-in');
          io.unobserve(entries[i].target);
        }
      }, { threshold: 0.06, rootMargin: '0px 0px -4% 0px' });
    } catch (e) { io = null; }
  }

  /* ---------- 标记 + 分组交错 ---------- */
  function mark() {
    for (var t = 0; t < REVEAL_TARGETS.length; t++) {
      var found;
      try { found = doc.querySelectorAll(REVEAL_TARGETS[t]); } catch (e) { continue; }
      for (var i = 0; i < found.length; i++) {
        var el = found[i];
        if (el.classList.contains('b-reveal')) continue;
        el.classList.add('b-reveal');
        el.setAttribute('data-b-reveal-item', '1');
        // 同组交错：按同选择器内的出现顺序排延迟
        el.style.setProperty('--rv-delay', Math.min(i * STAGGER, STAGGER_CAP) + 'ms');
        marked.push(el);
        if (io) io.observe(el);
        else el.classList.add('b-in');   // 无观察器则直接显示
      }
    }
  }

  /* ---------- 兜底：绝不能因动效失败而隐藏内容 ---------- */
  var failsafe = null;
  function armFailsafe(ms) {
    if (failsafe) clearTimeout(failsafe);
    failsafe = setTimeout(function () {
      for (var i = 0; i < marked.length; i++) marked[i].classList.add('b-in');
    }, ms);
  }

  try {
    mark();
  } catch (e) {
    // 标记过程出任何问题：撤掉门控类，让一切回归「本来就这样」
    root.classList.remove('b-motion');
    return;
  }
  if (marked.length) {
    armFailsafe(2600);
    var once = function () {
      armFailsafe(700);
      doc.removeEventListener('scroll', once, PASSIVE);
      doc.removeEventListener('pointerdown', once, PASSIVE);
      doc.removeEventListener('keydown', once, PASSIVE);
    };
    doc.addEventListener('scroll', once, PASSIVE);
    doc.addEventListener('pointerdown', once, PASSIVE);
    doc.addEventListener('keydown', once, PASSIVE);
  }

  /* 说明：此处刻意不挂 MutationObserver。
     观察目标都是随整站发布的静态区块，标记一次即足够；对这些区块做
     「属性变更即重扫」既无必要，又会与站内高频的 class/style 改动相互触发。
     若日后新增需要渐进的目标，只需往 REVEAL_TARGETS 里加一行。 */

  /* ---------- 落叶层：接管动画 + 滚动视差 ---------- */
  if (reduced) return;

  var leafLayer = null;
  try {
    var kids = body.children;
    for (var b = 0; b < kids.length; b++) {
      var el2 = kids[b];
      if (el2.tagName !== 'DIV') continue;
      if (el2.getAttribute('data-leaf-layer') === '1') { leafLayer = el2; break; }
      // 兼容旧结构：按内联样式特征识别
      if (!leafLayer && el2.style && el2.style.position === 'fixed' &&
          el2.style.pointerEvents === 'none' && el2.querySelector('div[style*="leafFall"]')) {
        leafLayer = el2;
      }
    }
  } catch (e) {}

  if (!leafLayer) return;

  try {
    leafLayer.classList.add('b-leaf-layer');
    var leaves = leafLayer.querySelectorAll('i');
    for (var li = 0; li < leaves.length; li++) {
      var lf = leaves[li];
      // 每片给一点差异，画面更自然（大小/时长/延迟/漂移方向）
      var drift = (li % 2 === 0 ? 1 : -1) * (14 + (li * 9) % 22);
      lf.style.setProperty('--lf-drift', drift + 'px');
      lf.style.setProperty('--lf-dur', (16 + li * 2.6).toFixed(1) + 's');
      lf.style.setProperty('--lf-delay', (li * 3.2).toFixed(1) + 's');
      lf.style.animation = '';   // 交还给 .b-leaf-layer i 规则统管
    }
  } catch (e) { return; }

  // 滚动视差：整层轻微反向位移，形成背景纵深（约 6%，上限 140px）
  var ticking = false;
  var lastY = -1;
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
  }, PASSIVE);
})();
