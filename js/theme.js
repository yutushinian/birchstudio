/* ============================================================
 * 白桦 · 光影层 theme.js  v1（20260918）
 * ------------------------------------------------------------
 * 职责边界（只做四件事，其余全交给 CSS）：
 *   1) 给 <html> 加 b-theme 门控类（CSS 里所有隐藏态都挂在它之下）
 *   2) 注入并驱动顶部金色阅读进度条
 *   3) 首屏滚动视差：写 --b-py（只作用于装饰层，不动文字）
 *   4) 入场编排：给「站内 .reveal 未覆盖」的卡片加 .b-rv，
 *      由 IntersectionObserver 加 .b-rv-in；并按同组序号错开延迟
 *
 * 刻意不做的三件事（避免与既有系统打架）
 *   · 不接管 .reveal —— bundle.js 已有 IntersectionObserver，重复接管会双写
 *   · 不改任何元素的 transform —— 站内卡片的 :hover 抬升写在 transform 上
 *   · 不引任何外部库、不发任何网络请求
 *
 * 失败时的行为：全程 try/catch；任何一步失败都只是「少一个动效」，
 * 内容可见性零风险 —— 因为隐藏态是由本脚本自己加的类触发的。
 * ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var body = doc.body;
  if (!body || !root) return;

  var reduced = false;
  try {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  /* ---------- 1) 门控类 ----------
     b-theme 无条件添加：它只管「入场隐藏态」与「纸纹漂移」。
     减弱动效的收尾由 theme.css 的 @media (prefers-reduced-motion) 完成，
     因此这里不需要为 reduced 单独分支。 */
  try { root.classList.add('b-theme'); } catch (e) {}

  /* ---------- 2) 顶部阅读进度条 ---------- */
  var progEl = null;
  try {
    if (!doc.getElementById('b-progress')) {
      progEl = doc.createElement('div');
      progEl.id = 'b-progress';
      progEl.setAttribute('aria-hidden', 'true');
      body.appendChild(progEl);
    } else {
      progEl = doc.getElementById('b-progress');
    }
  } catch (e) { progEl = null; }

  /* ---------- 3) 首屏视差 + 进度条 共用一次 rAF 循环 ---------- */
  var hero = null;
  try { hero = doc.querySelector('#brand .b-hero') || doc.getElementById('top'); } catch (e) {}

  var ticking = false;
  function frame() {
    ticking = false;
    var y = window.pageYOffset || root.scrollTop || 0;

    // 3.1 进度条：整页阅读进度
    if (progEl) {
      var docH = Math.max(
        (doc.documentElement && doc.documentElement.scrollHeight) || 0,
        (body && body.scrollHeight) || 0
      );
      var viewH = window.innerHeight || root.clientHeight || 1;
      var span = docH - viewH;
      var p = span > 0 ? (y / span) : (y > 0 ? 1 : 0);
      if (p < 0) p = 0; else if (p > 1) p = 1;
      root.style.setProperty('--b-prog', p.toFixed(4));
    }

    // 3.2 首屏视差：-1（顶部）→ 1（滚出首屏）
    if (hero) {
      var hh = hero.offsetHeight || 1;
      var py = (y / hh) * 2 - 1;
      if (py < -1) py = -1; else if (py > 1) py = 1;
      root.style.setProperty('--b-py', py.toFixed(3));
      // 首屏滚出后暂停环境动画，省电
      var idle = y > hh + 120;
      if (idle !== hero.classList.contains('b-hero-idle')) {
        hero.classList.toggle('b-hero-idle', idle);
      }
    }
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(frame);
  }
  try {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    frame();
  } catch (e) {}

  /* 3.3 切到后台时暂停全部环境动画（省电，回来继续） */
  try {
    doc.addEventListener('visibilitychange', function () {
      try { root.classList.toggle('b-idle', !!doc.hidden); } catch (e) {}
    });
  } catch (e) {}

  /* ---------- 4) 入场编排 ---------- */
  if (reduced) return;
  if (!('IntersectionObserver' in window)) return;

  /* 只收录「站内 .reveal 未覆盖」的卡片容器子项。
     凡自身或祖先已带 .reveal 的，一律跳过 —— 交给 bundle.js。 */
  var RV_SEL = [
    '#brand .b-func-row .b-func',
    '#brand .b-process-steps > *',
    '#brand .b-wuxing-grid > *',
    '#brand .b-lux-grid > *',
    '#brandLuxPicks > *',
    '#galleryGrid > *',
    '#brand .b-care-grid > *',
    '#brand .b-gua-grid > *'
  ].join(',');

  var groups = Object.create(null);

  function mark(el, i) {
    if (el.__bRv) return;
    if (el.classList.contains('reveal')) return;           // 已有系统，跳过
    if (el.closest && el.closest('.reveal')) return;        // 祖先已有，跳过
    el.__bRv = 1;
    el.classList.add('b-rv');
    // 图片揭幕：卡片含图才加（无图卡片不加，避免空动画）
    try { if (el.querySelector('img')) el.classList.add('b-rv-img'); } catch (e) {}
    // 错开：同组内按序号，最多 8 档（再多会显得拖沓）
    el.style.setProperty('--b-rv-delay', Math.min(i, 8) * 70 + 'ms');
    io.observe(el);
  }

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (!en.isIntersecting) continue;
      en.target.classList.add('b-rv-in');
      io.unobserve(en.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  function scan() {
    try {
      var nodes = doc.querySelectorAll(RV_SEL);
      for (var k = 0; k < nodes.length; k++) {
        var el = nodes[k];
        if (el.__bRv) continue;
        var parent = el.parentNode;
        var key = parent ? (parent.__bKey || (parent.__bKey = ++scan._g)) : 0;
        var idx = groups[key] || 0;
        groups[key] = idx + 1;
        mark(el, idx);
      }
    } catch (e) {}
  }
  scan._g = 0;

  try {
    scan();
    // 动态渲染的内容（橱窗 / 臻选 / 画廊）晚一点再扫一次
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', function () { setTimeout(scan, 60); });
    }
    window.addEventListener('load', function () { setTimeout(scan, 120); });
    setTimeout(scan, 600);
    setTimeout(scan, 1800);

    // 内容由 bundle/birch3 动态插入 —— 轻量 MutationObserver（带节流）
    var t = null;
    var mo = new MutationObserver(function () {
      if (t) return;
      t = setTimeout(function () { t = null; scan(); }, 350);
    });
    mo.observe(body, { childList: true, subtree: true });
    setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 20000);
  } catch (e) {}

  /* 4.1 兜底：8s 后仍未入场的，直接放行 ——
         宁可少一个动效，也绝不让内容留在隐藏态。 */
  try {
    setTimeout(function () {
      var left = doc.querySelectorAll('.b-rv:not(.b-rv-in)');
      for (var i = 0; i < left.length; i++) left[i].classList.add('b-rv-in');
    }, 8000);
  } catch (e) {}
})();
