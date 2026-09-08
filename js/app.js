/* 白桦 · 多页站脚本：导航高亮 + 橱窗读取 + 大图查看（无购买） */
(function () {
  var page = (location.pathname || '').split('/').pop() || 'index.html';
  document.querySelectorAll('nav a').forEach(function (a) {
    var h = (a.getAttribute('href') || '').split('#')[0];
    if (h === page) a.classList.add('on');
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 大图 + 设计理念 浮层（点开：大图居中，下方玻璃信息条，无购买按钮） */
  var lb = null;
  function ensureLb() {
    if (lb) return lb;
    lb = document.createElement('div');
    lb.className = 'lb';
    lb.innerHTML =
      '<div class="lb-box">' +
      '<button class="lb-x" type="button">✕</button>' +
      '<div class="lb-img"><img alt="作品大图"></div>' +
      '<div class="lb-info"><div class="lb-name"></div><div class="lb-idea"></div></div></div>';
    document.body.appendChild(lb);
    lb.addEventListener('click', function (e) {
      if (e.target === lb || e.target.classList.contains('lb-x')) closeLb();
    });
    return lb;
  }
  window.openLb = function (img, name, idea) {
    var o = ensureLb();
    var im = o.querySelector('.lb-img img');
    if (img) im.src = img; else im.style.opacity = '.15';
    o.querySelector('.lb-name').textContent = name || '';
    var ie = o.querySelector('.lb-idea');
    ie.textContent = idea || '';
    ie.style.display = idea ? '' : 'none';
    o.classList.add('on');
    document.body.classList.add('lk');
  };
  function closeLb() {
    if (!lb) return;
    lb.classList.remove('on');
    document.body.classList.remove('lk');
  }
  window.closeLb = closeLb;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLb(); });

  /* 橱窗数据读取（桦库 gallery，无购买按钮） */
  window.loadLux = function (host, featuredOnly) {
    if (!host) return;
    if (!window.sbB) { host.innerHTML = '<p class="sec sub">桦库配置缺失</p>'; return; }
    var q = 'gallery?select=name,price,original_price,design_text,image_url,sort_order' +
      (featuredOnly ? '&featured=eq.true' : '') + '&order=sort_order.asc';
    sbB(q).then(function (rows) {
      rows = rows || [];
      if (!rows.length) { host.innerHTML = '<p class="sec sub">橱窗正在整理 ✦</p>'; return; }
      host.innerHTML = rows.map(function (r) {
        var src = window.bImg(r.image_url);
        var ds = String(r.design_text || '').replace(/●/g, '').trim().slice(0, 90);
        return '<div class="card">' +
          '<div class="im"><img src="' + esc(src) + '" alt="' + esc(r.name) + '" loading="lazy" onerror="this.style.opacity=\'.2\'"></div>' +
          '<div class="bd"><div class="nm">' + esc(r.name) + '</div>' +
          '<div class="pr">¥' + esc(String(r.price || '')) + (r.original_price ? '<s>¥' + esc(String(r.original_price)) + '</s>' : '') + '</div>' +
          '<div class="ds">' + esc(ds) + '…</div></div></div>';
      }).join('');
      host.querySelectorAll('.card').forEach(function (c, i) {
        c.addEventListener('click', function () {
          var r = rows[i];
          window.openLb(window.bImg(r.image_url), r.name, String(r.design_text || '').replace(/●/g, ''));
        });
      });
    }).catch(function () { host.innerHTML = '<p class="sec sub">桦库读取失败，请稍后刷新</p>'; });
  };
})();
