/* ============================================================
 * 白桦 · 会员卡模块（前台 + 管理后台 + NFC 免密入口）
 * 依赖：supabase-js（站点已异步加载）、RPC 见 SQL/会员卡-v1.sql
 * 入口：window.MC
 * ============================================================ */
(function () {
  'use strict';

  var MC_URL = 'https://api.birchstudio.cn';
  var MC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0ZnhhbmJ6c2hlZmhvYm5keXdkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4Njg4NDksImV4cCI6MjEwNjQ0NDg0OX0.QNmkT4uZL9JvhsUI1vDeAHcvQksJ8Ftfm1HyWQ3-dLQ';
  var SITE = 'https://birchstudio.cn';
  var SS_CARD = 'birch_mc_card';

  var cli = null, booted = false;
  var S = { card: null, hash: '', view: 'login', gifts: [], nfc: null };
  var A = { cards: [], gifts: [], orders: [], detail: null, giftTab: 'list', orderFilter: '' };

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) { return '¥' + num(v).toFixed(2); }
  function pts(v) { var n = Math.round(num(v) * 100) / 100; return String(n); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function when(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function kindText(kind) {
    var m = {
      create: '开卡', consume: '消费', recharge: '充值', points_add: '积分增加',
      points_sub: '积分扣减', redeem: '礼品兑换', adjust: '调整'
    };
    return m[kind] || kind || '记录';
  }
  function kindIcon(kind) {
    var m = { create: '💳', consume: '🛒', recharge: '💰', points_add: '➕', points_sub: '➖', redeem: '🎁', adjust: '📝' };
    return m[kind] || '•';
  }

  /* ---------------- Supabase ---------------- */
  function db() {
    if (cli) return cli;
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      try {
        cli = window.supabase.createClient(MC_URL, MC_KEY, {
          auth: { persistSession: false, autoRefreshToken: false }
        });
      } catch (e) { cli = null; }
    }
    return cli;
  }
  function waitDb(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        var c = db();
        if (c) return resolve(c);
        if (Date.now() - t0 > (ms || 9000)) return resolve(null);
        setTimeout(poll, 150);
      })();
    });
  }
  function rpc(fn, args) {
    return waitDb().then(function (c) {
      if (!c) throw new Error('网络未就绪，请刷新页面后重试');
      return c.rpc(fn, args || {});
    }).then(function (r) {
      if (!r || r.error) throw new Error((r && r.error && r.error.message) || '请求失败');
      return r.data;
    });
  }

  /* ---------------- 提示 / 弹窗 ---------------- */
  function toast(msg, type) {
    var wrap = $('mcToast');
    if (!wrap) { try { alert(msg); } catch (e) {} return; }
    var d = document.createElement('div');
    d.className = 'mc-toast' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
    d.textContent = msg;
    wrap.appendChild(d);
    setTimeout(function () {
      d.style.transition = 'opacity .25s,transform .25s';
      d.style.opacity = '0';
      d.style.transform = 'translateY(-6px)';
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 260);
    }, type === 'err' ? 3600 : 2400);
  }

  function openModal(html) {
    ensureUI();
    $('mcModalBox').innerHTML = html;
    $('mcModal').classList.add('show');
  }
  function closeModal() { if ($('mcModal')) $('mcModal').classList.remove('show'); }

  /* ---------------- 面板骨架 ---------------- */
  function ensureUI() {
    if ($('mcPanel')) return;
    var host = document.createElement('div');
    host.id = 'mcHost';
    host.innerHTML =
      '<div class="mc-panel" id="mcPanel"><div class="mc-sheet">' +
      '<div class="mc-head"><div class="mc-title">白桦 · 会员卡<em>BIRCH CARD</em></div>' +
      '<button class="mc-x" id="mcClose" type="button" aria-label="关闭">✕</button></div>' +
      '<div class="mc-body" id="mcBody"></div></div></div>' +
      '<div class="mc-modal" id="mcModal"><div class="mc-modal-box" id="mcModalBox"></div></div>' +
      '<div class="mc-toast-wrap" id="mcToast"></div>';
    document.body.appendChild(host);
    $('mcClose').onclick = closePanel;
    $('mcModal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  }

  function openPanel() {
    ensureUI();
    $('mcPanel').classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closePanel() {
    if ($('mcPanel')) $('mcPanel').classList.remove('show');
    document.body.style.overflow = '';
  }

  /* ---------------- 前台：登录 ---------------- */
  function renderLogin(login, tip, errText) {
    S.view = 'login';
    openPanel();
    $('mcBody').innerHTML =
      '<div style="text-align:center;margin:4px 0 16px;">' +
      '<div style="font-size:16px;font-weight:700;color:#3d3229;">会员卡登录</div>' +
      '<div class="mc-hint" style="margin-top:6px;">账号可填会员卡号或登录账号；刷 NFC 会员卡可免密进入</div></div>' +
      (tip ? '<div class="mc-hint warn" style="margin-bottom:12px;">' + esc(tip) + '</div>' : '') +
      '<div class="mc-field"><label>账号</label><input class="mc-input" id="mcLoginId" value="' + esc(login || '') + '"' +
      (login ? ' readonly' : '') + ' placeholder="会员卡号 / 登录账号"></div>' +
      '<div class="mc-field"><label>密码</label><input class="mc-input" id="mcLoginPwd" type="password" placeholder="请输入密码" autocomplete="current-password"></div>' +
      '<button class="mc-btn primary" id="mcDoLogin" style="width:100%;margin-top:4px;">登录</button>' +
      '<div class="mc-hint err" id="mcLoginErr" style="margin-top:10px;min-height:18px;">' + esc(errText || '') + '</div>';

    $('mcDoLogin').onclick = doLogin;
    var pwd = $('mcLoginPwd');
    pwd.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    setTimeout(function () { try { pwd.focus(); } catch (e) {} }, 120);
  }

  function doLogin() {
    var idEl = $('mcLoginId'), pwdEl = $('mcLoginPwd'), btn = $('mcDoLogin');
    if (!idEl || !pwdEl || !btn) return;
    var id = (idEl.value || '').trim(), pw = pwdEl.value || '';
    if (!id || !pw) return setLoginErr('请填写账号和密码');
    btn.disabled = true; btn.textContent = '登录中…';
    rpc('mc_login', { p_login: id, p_pwd: pw }).then(function (d) {
      applyCard(d);
      toast('欢迎回来，' + (d.nickname || d.card_no), 'ok');
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '登录';
      setLoginErr(e.message);
    });
  }
  function setLoginErr(msg) {
    var el = $('mcLoginErr');
    if (el) el.textContent = msg || '';
  }

  function applyCard(d) {
    S.card = d;
    S.hash = d.auth_hash || '';
    try {
      sessionStorage.setItem(SS_CARD, JSON.stringify({
        card_no: d.card_no, login_id: d.login_id, hash: S.hash
      }));
    } catch (e) {}
    renderHome();
  }

  function logout() {
    S.card = null; S.hash = '';
    try { sessionStorage.removeItem(SS_CARD); } catch (e) {}
    renderLogin('', '', '');
  }

  /* ---------------- 前台：首页 ---------------- */
  function renderHome() {
    if (!S.card) return renderLogin('', '', '');
    var c = S.card;
    S.view = 'home';
    openPanel();
    $('mcBody').innerHTML =
      '<div class="mc-card-visual">' +
      '<div class="mc-cv-top"><span>白桦会员卡 · BIRCH</span><span>' + (c.status === 'active' ? '正常' : '已停用') + '</span></div>' +
      '<div class="mc-cv-no">' + esc(c.card_no) + '</div>' +
      '<div class="mc-cv-name">' + esc(c.nickname || '尊贵会员') + '　·　账号 ' + esc(c.login_id) + '</div>' +
      '</div>' +
      '<div class="mc-stats">' +
      '<div class="mc-stat"><span>可用积分</span><b>' + pts(c.points) + '<i>分</i></b></div>' +
      '<div class="mc-stat"><span>账户余额</span><b>' + money(c.balance) + '</b></div>' +
      '</div>' +
      '<div class="mc-actions">' +
      '<button class="mc-btn" onclick="MC.txns()">📋 积分明细</button>' +
      '<button class="mc-btn primary" onclick="MC.gifts()">🎁 礼品兑换</button>' +
      '<button class="mc-btn" onclick="MC.pwd()">🔒 修改密码</button>' +
      '<button class="mc-btn" onclick="MC.logout()">退出</button>' +
      '</div>' +
      '<div class="mc-sect-title" style="margin-top:16px;">物流提醒</div>' +
      '<div id="mcLogistics" class="mc-empty">加载中…</div>' +
      '<div class="mc-sect-title" style="margin-top:16px;">账号绑定</div>' +
      '<div id="mcBindBox" class="mc-empty">加载中…</div>' +
      '<div class="mc-hint" style="margin-top:14px;">消费 1 元累计 1 积分；积分可在「礼品兑换」中换取礼品。' +
      '兑换成功后请填写收货信息，客服会尽快安排发货，运单号会出现在上方「物流提醒」。</div>';
    loadLogistics();
    renderBindBox();
  }

  /* ---------------- 前台：账号绑定 ---------------- */
  function renderBindBox() {
    var box = $('mcBindBox');
    if (!box || !S.card) return;
    var user = S.card.bind_username || '';
    if (user) {
      box.className = '';
      box.innerHTML =
        '<div class="mc-bind">' +
        '<div class="mc-bind-h"><b>已绑定账号</b><span class="mc-badge">' + esc(user) + '</span></div>' +
        '<div class="mc-bind-t">兑换发货通知会同时发送到该账号的「消息中心」，本卡「物流提醒」也一直保留。' +
        '如需换绑或解绑，直接在下方操作即可。</div>' +
        '<div class="mc-actions" style="margin-top:8px;">' +
        '<button class="mc-btn" onclick="MC.bindToPhone()">📱 卡号改为该账号手机号</button>' +
        '<button class="mc-btn danger" onclick="MC.unbind()">解除绑定</button></div>' +
        '</div>';
      return;
    }
    box.className = '';
    box.innerHTML =
      '<div class="mc-bind">' +
      '<div class="mc-bind-h"><b>绑定网站账号</b><span class="mc-badge off">未绑定</span></div>' +
      '<div class="mc-bind-t">绑定后兑换发货会同时通知该账号；不绑定则只记在本卡「物流提醒」。</div>' +
      '<div class="mc-field"><label>网站账号（用户名或手机号）</label>' +
      '<input class="mc-input" id="mcBindUser" placeholder="如 zhangsan 或 13800000000" autocomplete="username"></div>' +
      '<div class="mc-field"><label style="display:flex;gap:6px;align-items:center;font-size:13px;">' +
      '<input type="checkbox" id="mcBindToPhone"> 同时把会员卡号改为该账号的手机号</label></div>' +
      '<div class="mc-actions"><button class="mc-btn primary" id="mcBindOk" onclick="MC.doBind()">🔗 绑定账号</button></div>' +
      '<div class="mc-hint" style="margin-top:8px;">改卡号后旧 NFC 标签会失效，需要在后台重新生成 NFC 码。</div>' +
      '</div>';
  }

  function bindCard(user, toPhone, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    return rpc('mc_self_bind', {
      p_login: S.card.card_no, p_hash: S.hash,
      p_username: user || '', p_to_phone: !!toPhone
    }).then(function (r) {
      S.card.card_no = r.card_no;
      S.card.bind_username = r.bind_username || '';
      S.hash = r.auth_hash || S.hash;
      try {
        sessionStorage.setItem(SS_CARD, JSON.stringify({
          card_no: S.card.card_no, login_id: S.card.login_id, hash: S.hash
        }));
      } catch (e) {}
      var changed = r.old_card_no && r.old_card_no !== r.card_no;
      toast(changed ? '已绑定，卡号改为 ' + r.card_no : (r.bind_username ? '已绑定账号 ' + r.bind_username : '已解除绑定'), 'ok');
      renderHome();
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🔗 绑定账号'; }
      toast(e.message, 'err');
    });
  }

  function doBind() {
    var el = $('mcBindUser');
    var user = el ? String(el.value || '').trim() : '';
    var pick = $('mcBindToPhone');
    var toPhone = !!(pick && pick.checked);
    if (!user) return toast('请填写要绑定的账号', 'err');
    if (toPhone && !confirm('确定把会员卡号从 ' + S.card.card_no + ' 改为该账号的手机号吗？\n\n改后旧 NFC 卡需要重新生成。')) return;
    bindCard(user, toPhone, $('mcBindOk'));
  }

  function unbind() {
    if (!confirm('确定解除绑定吗？解除后发货通知只留在本卡「物流提醒」。')) return;
    bindCard('', false, null);
  }

  function bindToPhone() {
    if (!S.card.bind_username) return toast('请先绑定账号', 'err');
    if (!confirm('确定把会员卡号改为「' + S.card.bind_username + '」的手机号吗？\n\n改后旧 NFC 卡需要重新生成。')) return;
    bindCard(S.card.bind_username, true, null);
  }

  /* ---------------- 前台：物流提醒 ---------------- */
  function loadLogistics() {
    if (!S.card) return;
    rpc('mc_my_logistics', { p_login: S.card.card_no, p_hash: S.hash }).then(function (rows) {
      var box = $('mcLogistics');
      if (!box) return;
      if (!rows || !rows.length) {
        box.className = 'mc-empty';
        box.textContent = '暂无物流信息，兑换发货后会显示在这里';
        return;
      }
      box.className = '';
      box.innerHTML = rows.map(function (o) {
        var shipped = o.status === 'shipped' || !!o.tracking;
        return '<div class="mc-logi">' +
          '<div class="mc-logi-i">' + (shipped ? '🚚' : '📦') + '</div>' +
          '<div class="mc-logi-m"><b>' + esc(o.product || '兑换礼品') + '</b>' +
          '<span>单号 ' + esc(o.order_no || '') + ' · ' + when(o.created_at) + '</span>' +
          (o.tracking ? '<span>运单号 <b style="display:inline;color:#1f7a4d;">' + esc(o.tracking) + '</b></span>' : '') +
          '</div>' +
          '<span class="mc-logi-tag' + (shipped ? '' : ' wait') + '">' + (shipped ? '已发货' : '待发货') + '</span>' +
          '</div>';
      }).join('');
    }).catch(function (e) {
      var box2 = $('mcLogistics');
      if (box2) { box2.className = 'mc-empty'; box2.textContent = e.message; }
    });
  }

  function refreshCard() {
    if (!S.card) return Promise.resolve(null);
    return rpc('mc_login_hash', { p_login: S.card.card_no, p_hash: S.hash }).then(function (d) {
      S.card = d; S.hash = d.auth_hash || S.hash;
      return d;
    });
  }

  /* ---------------- 前台：明细 ---------------- */
  function viewTxns() {
    if (!S.card) return renderLogin('', '', '');
    openPanel();
    S.view = 'txns';
    $('mcBody').innerHTML = header('积分明细') +
      '<div class="mc-hint" style="margin-bottom:10px;">仅保留最近 <b>5 天</b>的消费与积分记录，更早的记录自动清理。</div>' +
      '<div id="mcTxnList" class="mc-empty">加载中…</div>';
    rpc('mc_my_txns', { p_login: S.card.card_no, p_hash: S.hash, p_limit: 100 }).then(function (rows) {
      var list = $('mcTxnList');
      if (!list) return;
      if (!rows || !rows.length) { list.className = 'mc-empty'; list.textContent = '最近 5 天暂无记录，刷卡消费后会自动记录'; return; }
      list.className = '';
      list.innerHTML = rows.map(function (t) {
        var plus = num(t.points) > 0, minus = num(t.points) < 0;
        var delta = num(t.points) === 0 ? (num(t.amount) !== 0 ? '¥' + num(t.amount).toFixed(2) : '—')
          : (plus ? '+' : '') + pts(t.points);
        return '<div class="mc-txn"><div class="mc-txn-i">' + kindIcon(t.kind) + '</div>' +
          '<div class="mc-txn-m"><b>' + esc(t.title || kindText(t.kind)) + '</b>' +
          '<span>' + when(t.created_at) + ' · ' + kindText(t.kind) +
          (t.ref_no ? ' · ' + esc(t.ref_no) : '') + '</span></div>' +
          '<div class="mc-txn-v ' + (plus ? 'plus' : minus ? 'minus' : '') + '">' + delta + '</div></div>';
      }).join('');
    }).catch(function (e) {
      var list = $('mcTxnList');
      if (list) { list.className = 'mc-empty'; list.textContent = e.message; }
    });
  }

  /* ---------------- 前台：礼品兑换 ---------------- */
  function viewGifts() {
    if (!S.card) return renderLogin('', '', '');
    openPanel();
    S.view = 'gifts';
    $('mcBody').innerHTML = header('礼品兑换') +
      '<div class="mc-hint" style="margin-bottom:12px;">当前积分 <b>' + pts(S.card.points) + '</b> 分，兑换后自动扣除。</div>' +
      '<div id="mcGiftList" class="mc-empty">加载中…</div>';
    rpc('mc_gift_list', {}).then(function (rows) {
      S.gifts = rows || [];
      paintGifts();
    }).catch(function (e) {
      var el = $('mcGiftList');
      if (el) { el.className = 'mc-empty'; el.textContent = e.message; }
    });
  }

  function paintGifts() {
    var box = $('mcGiftList');
    if (!box) return;
    if (!S.gifts.length) { box.className = 'mc-empty'; box.textContent = '暂无可兑换礼品'; return; }
    box.className = 'mc-gift-grid';
    box.innerHTML = S.gifts.map(function (g) {
      var sold = g.sold_out === true;
      var enough = num(S.card.points) >= num(g.points_cost);
      var style = g.image_url ? ' style="background-image:url(' + esc(g.image_url) + ')"' : '';
      return '<div class="mc-gift"><div class="mc-gift-img"' + style + '></div>' +
        '<b>' + esc(g.name) + '</b>' +
        '<div class="cost">' + pts(g.points_cost) + ' 积分' +
        (g.stock == null ? '' : ' · 剩余 ' + g.stock) + '</div>' +
        '<button class="mc-btn sm ' + (sold || !enough ? '' : 'primary') + '" ' +
        (sold ? 'disabled' : '') + ' data-gift="' + g.id + '">' +
        (sold ? '已兑完' : enough ? '立即兑换' : '积分不足') + '</button></div>';
    }).join('');
    var btns = box.querySelectorAll('button[data-gift]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var id = Number(this.getAttribute('data-gift'));
        var gift = null;
        for (var j = 0; j < S.gifts.length; j++) if (Number(S.gifts[j].id) === id) gift = S.gifts[j];
        if (gift) startRedeem(gift);
      });
    }
  }

  function startRedeem(g) {
    if (num(S.card.points) < num(g.points_cost)) {
      toast('积分不足：当前 ' + pts(S.card.points) + ' 分，兑换需 ' + pts(g.points_cost) + ' 分', 'err');
      return;
    }
    openModal('<h3>兑换 · ' + esc(g.name) + '</h3>' +
      '<div class="mc-hint">将扣除 <b>' + pts(g.points_cost) + '</b> 积分，当前 ' + pts(S.card.points) + ' 分；兑换后剩余 ' +
      pts(num(S.card.points) - num(g.points_cost)) + ' 分。</div>' +
      '<div class="mc-gap"></div>' +
      '<div class="mc-field"><label>收货人 *</label><input class="mc-input" id="mcRcvName" value="' + esc(S.card.nickname || '') + '"></div>' +
      '<div class="mc-field"><label>手机号 *</label><input class="mc-input" id="mcRcvPhone" value="' + esc(S.card.phone || '') + '" inputmode="tel"></div>' +
      '<div class="mc-field"><label>收货地址 *</label><textarea class="mc-input" id="mcRcvAddr" placeholder="省 / 市 / 区 + 详细地址"></textarea></div>' +
      '<div class="mc-field"><label>备注</label><input class="mc-input" id="mcRcvNote" placeholder="选填"></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcRcvOk">确认兑换</button></div>');
    $('mcRcvOk').onclick = function () { doRedeem(g, this); };
  }

  function doRedeem(g, btn) {
    var name = ($('mcRcvName').value || '').trim();
    var phone = ($('mcRcvPhone').value || '').trim();
    var addr = ($('mcRcvAddr').value || '').trim();
    var note = ($('mcRcvNote').value || '').trim();
    if (!name || !phone || !addr) { toast('请填写收货人、手机号和地址', 'err'); return; }
    btn.disabled = true; btn.textContent = '提交中…';
    rpc('mc_redeem', {
      p_login: S.card.card_no, p_hash: S.hash, p_gift_id: g.id,
      p_nickname: name, p_phone: phone, p_address: addr, p_note: note
    }).then(function (r) {
      S.card.points = r.points;
      $('mcModalBox').innerHTML = '<h3>兑换成功</h3>' +
        '<div class="mc-hint">订单号 <b>' + esc(r.order_no) + '</b><br>礼品：' + esc(r.gift_name) +
        '<br>扣除积分：' + pts(r.points_cost) + ' 分<br>剩余积分：' + pts(r.points) + ' 分<br>' +
        '收货信息：' + esc(name) + '　' + esc(phone) + '<br>' + esc(addr) + '</div>' +
        '<div class="mc-hint warn" style="margin-top:12px;">已提交为「待发货」，并已通知客服邮箱，请留意物流信息。</div>' +
        '<div class="mc-gap"></div><button class="mc-btn primary" style="width:100%;" onclick="MC.closeModal();MC.gifts()">继续逛逛</button>';
      sendRedeemMail(r, name, phone, addr);
      toast('兑换成功，已通知客服', 'ok');
      setTimeout(function () { refreshCard().then(function () { if (S.view === 'home') renderHome(); }).catch(function () {}); }, 600);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '确认兑换';
      toast(e.message, 'err');
    });
  }

  function sendRedeemMail(r, name, phone, addr) {
    try {
      fetch('https://api.birchstudio.cn/functions/v1/email-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'member_redeem',
          subject: '【白桦】会员卡礼品兑换待发货 ' + r.order_no,
          fields: {
            '订单号': r.order_no,
            '会员卡号': r.card_no,
            '礼品': r.gift_name,
            '扣除积分': r.points_cost,
            '剩余积分': r.points,
            '收货信息': name + ' / ' + phone + ' / ' + addr
          }
        })
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 前台：修改密码 ---------------- */
  function viewPwd() {
    if (!S.card) return renderLogin('', '', '');
    openPanel();
    S.view = 'pwd';
    $('mcBody').innerHTML = header('修改会员卡密码') +
      '<div class="mc-hint warn" style="margin-bottom:12px;">修改成功后，已写入旧密码的 NFC 卡会立即失效；需要联系管理员重新生成 NFC 码才能免密进入。</div>' +
      '<div class="mc-field"><label>原密码</label><input class="mc-input" id="mcOldPwd" type="password" autocomplete="current-password"></div>' +
      '<div class="mc-field"><label>新密码（至少 6 位）</label><input class="mc-input" id="mcNewPwd" type="password" autocomplete="new-password"></div>' +
      '<div class="mc-field"><label>确认新密码</label><input class="mc-input" id="mcNewPwd2" type="password" autocomplete="new-password"></div>' +
      '<button class="mc-btn primary" id="mcPwdOk" style="width:100%;">保存新密码</button>' +
      '<div class="mc-hint err" id="mcPwdErr" style="margin-top:10px;min-height:18px;"></div>';
    $('mcPwdOk').onclick = function () {
      var oldP = $('mcOldPwd').value || '', n1 = $('mcNewPwd').value || '', n2 = $('mcNewPwd2').value || '';
      var errEl = $('mcPwdErr');
      if (!oldP || !n1) { errEl.textContent = '请填写原密码和新密码'; return; }
      if (n1.length < 6) { errEl.textContent = '新密码至少 6 位'; return; }
      if (n1 !== n2) { errEl.textContent = '两次输入的新密码不一致'; return; }
      var btn = this; btn.disabled = true; btn.textContent = '保存中…';
      rpc('mc_change_pwd', { p_login: S.card.card_no, p_old: oldP, p_new: n1 }).then(function (r) {
        S.hash = r.auth_hash || S.hash;
        try { sessionStorage.setItem(SS_CARD, JSON.stringify({ card_no: S.card.card_no, login_id: S.card.login_id, hash: S.hash })); } catch (e) {}
        toast('密码已修改，旧 NFC 码已失效', 'ok');
        renderHome();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '保存新密码';
        errEl.textContent = e.message;
      });
    };
  }

  function header(title) {
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
      '<button class="mc-btn sm" onclick="MC.home()">← 返回</button>' +
      '<div style="font-size:15px;font-weight:700;color:#3d3229;">' + esc(title) + '</div></div>';
  }

  /* ---------------- NFC 深链 ---------------- */
  function parseNfc() {
    var raw = (location.hash || '') + '&' + (location.search || '');
    function pick(k) {
      var m = new RegExp('[?&#]' + k + '=([^&]*)').exec(raw);
      return m ? decodeURIComponent(m[1].replace(/\+/g, '%20')) : '';
    }
    var card = pick('mc'), key = pick('k');
    if (!card) return null;
    return { card: card, key: key };
  }
  function cleanUrl() {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }

  function handleNfc(n) {
    var us = null;
    try { us = JSON.parse(localStorage.getItem('birch_user') || 'null'); } catch (e) { us = null; }
    var pre = (us && us.username)
      ? rpc('get_user_is_admin', { p_username: us.username }).catch(function () { return false; })
      : Promise.resolve(false);

    pre.then(function (isAdmin) {
      if (isAdmin) {
        var pwd = '';
        try { pwd = sessionStorage.getItem('birch_admin_pwd') || ''; } catch (e) {}
        if (!pwd) {
          try { sessionStorage.setItem('birch_admin_pwd', us.username); pwd = us.username; } catch (e) {}
        }
        if (pwd) { adminOpenCardFromNfc(n.card); return; }
      }
      frontNfc(n);
    });
  }

  function frontNfc(n) {
    openPanel();
    $('mcBody').innerHTML = '<div class="mc-empty">正在读取会员卡…</div>';
    if (!n.key) {
      renderLogin(n.card, '请输入该会员卡的密码', '');
      return;
    }
    rpc('mc_login_hash', { p_login: n.card, p_hash: n.key }).then(function (d) {
      applyCard(d);
      toast('NFC 会员卡已识别：' + d.card_no, 'ok');
    }).catch(function (e) {
      renderLogin(n.card, 'NFC 免密凭证已失效（可能修改过密码），请输入当前密码', e.message);
    });
  }

  /* ---------------- 后台：入口与骨架 ---------------- */
  function ensureAdminVisible() {
    var gen = $('genPanel');
    if (gen && !gen.classList.contains('show')) gen.classList.add('show');
    var hp = $('homePanel');
    if (hp && hp.style.display !== 'none') hp.style.display = 'none';
  }

  function showAdminSection(id) {
    ensureAdminVisible();
    if (typeof window.openAdminSection === 'function') { window.openAdminSection(id); return; }
    var all = document.querySelectorAll('.admin-section-page');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('show');
    var el = $(id);
    if (el) el.classList.add('show');
    var home = $('adminHome');
    if (home) home.style.display = 'none';
  }

  function mountAdmin() {
    var home = $('adminHome');
    if (!home) return;
    var grid = home.querySelector('.admin-grid');

    if (grid && !$('mcAdminEntry')) {
      var c1 = document.createElement('div');
      c1.className = 'admin-card';
      c1.id = 'mcAdminEntry';
      c1.innerHTML = '<div class="admin-card-cover"><span class="admin-chip">💳</span></div>' +
        '<div class="admin-card-info"><div class="admin-card-name">会员卡管理</div></div>';
      c1.addEventListener('click', function () { adminOpenCards(); });
      grid.appendChild(c1);

      var c2 = document.createElement('div');
      c2.className = 'admin-card';
      c2.id = 'mcGiftEntry';
      c2.innerHTML = '<div class="admin-card-cover"><span class="admin-chip">🎁</span></div>' +
        '<div class="admin-card-info"><div class="admin-card-name">礼品兑换</div></div>';
      c2.addEventListener('click', function () { adminOpenGifts(); });
      grid.appendChild(c2);
    }

    var gen = $('genPanel');
    if (gen && !$('mcAdminSec')) {
      var s1 = document.createElement('div');
      s1.className = 'admin-section-page';
      s1.id = 'mcAdminSec';
      s1.innerHTML = '<div class="mc-admin" id="mcAdminBody"></div>';
      gen.appendChild(s1);

      var s2 = document.createElement('div');
      s2.className = 'admin-section-page';
      s2.id = 'mcGiftSec';
      s2.innerHTML = '<div class="mc-admin" id="mcGiftBody"></div>';
      gen.appendChild(s2);
    }
  }

  function adminPwd() {
    var p = '';
    try { p = sessionStorage.getItem('birch_admin_pwd') || ''; } catch (e) {}
    if (!p) throw new Error('管理员会话已过期，请返回后台首页重新进入');
    return p;
  }

  function adminOpenCards() {
    mountAdmin();
    showAdminSection('mcAdminSec');
    A.detail = null;
    $('mcAdminBody').innerHTML =
      '<button class="back-btn" onclick="MC.backHome()">← 返回</button>' +
      '<h3 style="font-size:17px;margin-bottom:10px;">会员卡管理</h3>' +
      '<p style="font-size:12px;color:#6b5d4d;margin-bottom:12px;">会员卡号与登录账号相互独立；初始密码 123456。删除会员卡不可恢复。</p>' +
      '<div class="mc-admin-bar"><input class="mc-input" id="mcKw" placeholder="搜卡号 / 账号 / 昵称 / 手机" style="max-width:240px;">' +
      '<button class="mc-btn" onclick="MC.adminSearch()">搜索</button>' +
      '<button class="mc-btn primary" onclick="MC.adminNew()">＋ 新建会员卡</button>' +
      '<button class="mc-btn" onclick="MC.adminRefresh()">刷新</button></div>' +
      '<div class="mc-tbl-wrap"><table class="mc-tbl"><thead><tr>' +
      '<th>会员卡号</th><th>登录账号</th><th>昵称</th><th>手机</th><th>积分</th><th>余额</th><th>状态</th></tr></thead>' +
      '<tbody id="mcCardRows"><tr><td colspan="7">加载中…</td></tr></tbody></table></div>';
    $('mcKw').addEventListener('keydown', function (e) { if (e.key === 'Enter') adminSearch(); });
    loadAdminCards('');
  }

  function loadAdminCards(kw) {
    rpc('mc_admin_list', { p_pwd: adminPwd(), p_kw: kw || '' }).then(function (rows) {
      A.cards = rows || [];
      paintAdminCards();
    }).catch(function (e) {
      var tb = $('mcCardRows');
      if (tb) tb.innerHTML = '<tr><td colspan="7" style="color:#c25c5c;">' + esc(e.message) + '</td></tr>';
    });
  }

  function paintAdminCards() {
    var tb = $('mcCardRows');
    if (!tb) return;
    if (!A.cards.length) { tb.innerHTML = '<tr><td colspan="7">还没有会员卡，点「新建会员卡」发卡</td></tr>'; return; }
    tb.innerHTML = A.cards.map(function (c) {
      return '<tr data-no="' + esc(c.card_no) + '">' +
        '<td>' + esc(c.card_no) + '</td><td>' + esc(c.login_id) + '</td>' +
        '<td>' + esc(c.nickname || '—') + '</td><td>' + esc(c.phone || '—') + '</td>' +
        '<td class="num">' + pts(c.points) + '</td><td class="num">' + money(c.balance) + '</td>' +
        '<td><span class="mc-badge ' + (c.status === 'active' ? '' : 'off') + '">' +
        (c.status === 'active' ? '正常' : '停用') + '</span></td></tr>';
    }).join('');
    tb.onclick = function (e) {
      var tr = e.target.closest ? e.target.closest('tr') : null;
      if (!tr) return;
      var no = tr.getAttribute('data-no');
      if (no) adminOpenCard(no);
    };
  }

  function adminSearch() { loadAdminCards(($('mcKw') && $('mcKw').value || '').trim()); }
  function adminRefresh() { if (A.detail) adminOpenCard(A.detail.card_no); else adminSearch(); }

  function adminOpenCard(cardNo) {
    mountAdmin();
    showAdminSection('mcAdminSec');
    rpc('mc_admin_card', { p_pwd: adminPwd(), p_card_no: cardNo }).then(function (d) {
      A.detail = d;
      paintAdminDetail();
      loadAdminTxns(cardNo);
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function paintAdminDetail() {
    var d = A.detail;
    if (!d) return;
    $('mcAdminBody').innerHTML =
      '<button class="back-btn" onclick="MC.adminOpenCards()">← 返回列表</button>' +
      '<h3 style="font-size:17px;margin-bottom:6px;">会员卡 ' + esc(d.card_no) + '</h3>' +
      '<p style="font-size:12px;color:#6b5d4d;margin-bottom:12px;">消费 1 元累计 1 积分；消费 / 积分记录只保留最近 5 天。卡号可通过「绑定账号」改为该账号手机号。</p>' +
      '<div class="mc-detail-grid">' +
      kv('可用积分', pts(d.points) + ' 分') + kv('账户余额', money(d.balance)) +
      kv('开卡时间', when(d.created_at)) + kv('最近更新', when(d.updated_at)) +
      '</div><div class="mc-gap"></div>' +
      '<div class="mc-detail-grid">' +
      '<div><label style="font-size:12px;color:#6b5d4d;">会员卡号（只读）</label><input class="mc-input" value="' + esc(d.card_no) + '" readonly></div>' +
      '<div><label style="font-size:12px;color:#6b5d4d;">登录账号</label><input class="mc-input" id="mcE_Login" value="' + esc(d.login_id) + '"></div>' +
      '<div><label style="font-size:12px;color:#6b5d4d;">昵称</label><input class="mc-input" id="mcE_Nick" value="' + esc(d.nickname || '') + '"></div>' +
      '<div><label style="font-size:12px;color:#6b5d4d;">手机号</label><input class="mc-input" id="mcE_Phone" value="' + esc(d.phone || '') + '"></div>' +
      '<div><label style="font-size:12px;color:#6b5d4d;">状态</label><select class="mc-input" id="mcE_Status">' +
      '<option value="active"' + (d.status === 'active' ? ' selected' : '') + '>正常</option>' +
      '<option value="disabled"' + (d.status !== 'active' ? ' selected' : '') + '>停用</option></select></div>' +
      '<div><label style="font-size:12px;color:#6b5d4d;">备注</label><input class="mc-input" id="mcE_Note" value="' + esc(d.note || '') + '"></div>' +
      '</div>' +
      '<div class="mc-detail-ops">' +
      '<button class="mc-btn primary" onclick="MC.adminSave()">保存资料</button>' +
      '<button class="mc-btn gold" onclick="MC.adminConsume()">💳 消费扣款</button>' +
      '<button class="mc-btn" onclick="MC.adminPoints()">➕ 积分增减</button>' +
      '<button class="mc-btn" onclick="MC.adminBalance()">💰 余额调整</button>' +
      '<button class="mc-btn" onclick="MC.adminResetPwd()">🔑 重置密码</button>' +
      '<button class="mc-btn" onclick="MC.adminNfc()">📡 生成 NFC 码</button>' +
      '<button class="mc-btn danger" onclick="MC.adminDelete()">删除会员卡</button>' +
      '</div>' +
      '<div class="mc-sect-title" style="margin-top:18px;">绑定前台账号</div>' +
      '<p style="font-size:12px;color:#6b5d4d;margin-bottom:8px;">会员可在前台会员卡界面自助绑定 / 解绑；这里留给管理员代绑。' +
      '绑定后该卡的兑换发货通知会同时进入对方「消息中心」；未绑定只记在本卡「物流提醒」。' +
      '勾选下方选项可把会员卡号改成该账号的手机号（改后旧 NFC 码失效，需重新生成）。</p>' +
      '<div class="mc-detail-grid">' +
      '<div><label style="font-size:12px;color:#6b5d4d;">账号用户名（留空解除绑定）</label>' +
      '<input class="mc-input" id="mcE_Bind" value="' + esc(d.bind_username || '') + '" placeholder="如 zhangsan"></div>' +
      '<div style="display:flex;align-items:flex-end;padding-bottom:4px;">' +
      '<label style="font-size:12px;color:#6b5d4d;display:flex;gap:6px;align-items:center;">' +
      '<input type="checkbox" id="mcE_ToPhone"> 同时把会员卡号改为该账号手机号</label></div>' +
      '</div>' +
      '<div class="mc-detail-ops">' +
      '<button class="mc-btn" onclick="MC.adminBind()">🔗 保存绑定</button>' +
      '</div>' +
      '<div class="mc-sect-title" style="margin-top:18px;">消费 / 积分记录</div>' +
      '<div id="mcAdminTxn" class="mc-empty">加载中…</div>';
  }

  function kv(k, v) {
    return '<div class="mc-kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>';
  }

  function loadAdminTxns(cardNo) {
    rpc('mc_admin_txns', { p_pwd: adminPwd(), p_card_no: cardNo, p_limit: 80 }).then(function (rows) {
      var box = $('mcAdminTxn');
      if (!box) return;
      if (!rows || !rows.length) { box.className = 'mc-empty'; box.textContent = '最近 5 天暂无记录'; return; }
      box.className = '';
      box.innerHTML = rows.map(function (t) {
        var plus = num(t.points) > 0, minus = num(t.points) < 0;
        var v = num(t.points) !== 0 ? ((plus ? '+' : '') + pts(t.points) + ' 分') : (num(t.amount) ? money(Math.abs(num(t.amount))) : '—');
        return '<div class="mc-txn"><div class="mc-txn-i">' + kindIcon(t.kind) + '</div>' +
          '<div class="mc-txn-m"><b>' + esc(t.title || kindText(t.kind)) + '</b>' +
          '<span>' + when(t.created_at) + ' · ' + esc(t.operator || '') +
          (t.ref_no ? ' · ' + esc(t.ref_no) : '') + '</span></div>' +
          '<div class="mc-txn-v ' + (plus ? 'plus' : minus ? 'minus' : '') + '">' + esc(v) + '</div></div>';
      }).join('');
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function adminBind() {
    var d = A.detail;
    if (!d) return;
    var el = $('mcE_Bind');
    var user = el ? String(el.value || '').trim() : '';
    var pick = $('mcE_ToPhone');
    var toPhone = !!(pick && pick.checked);
    if (toPhone && !user) {
      return toast('要改成手机号，请先填账号用户名', 'err');
    }
    if (toPhone && !confirm('确定把会员卡号从 ' + d.card_no + ' 改为该账号绑定的手机号吗？\n\n改后旧 NFC 卡需要重新生成。')) return;
    rpc('mc_admin_bind', { p_pwd: adminPwd(), p_card_no: d.card_no, p_username: user, p_to_phone: toPhone })
      .then(function (r) {
        toast(r.card_no !== d.card_no ? '已绑定，卡号改为 ' + r.card_no : '绑定已保存', 'ok');
        adminOpenCard(r.card_no);
      }).catch(function (e) { toast(e.message, 'err'); });
  }

  function adminSave() {
    var d = A.detail; if (!d) return;
    rpc('mc_admin_update', {
      p_pwd: adminPwd(), p_card_no: d.card_no,
      p_login_id: $('mcE_Login').value.trim(),
      p_nickname: $('mcE_Nick').value,
      p_phone: $('mcE_Phone').value,
      p_note: $('mcE_Note').value,
      p_status: $('mcE_Status').value
    }).then(function () {
      toast('资料已保存', 'ok');
      adminOpenCard(d.card_no);
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function adminNew() {
    openModal('<h3>新建会员卡</h3>' +
      '<div class="mc-field"><label>会员卡号（留空自动生成）</label><input class="mc-input" id="mcN_Card" placeholder="如 BC20260001"></div>' +
      '<div class="mc-field"><label>登录账号（留空同卡号）</label><input class="mc-input" id="mcN_Login" placeholder="与卡号分开，可自定义"></div>' +
      '<div class="mc-field"><label>昵称</label><input class="mc-input" id="mcN_Nick"></div>' +
      '<div class="mc-field"><label>手机号</label><input class="mc-input" id="mcN_Phone" inputmode="tel"></div>' +
      '<div class="mc-row"><div class="mc-field"><label>初始余额（元）</label><input class="mc-input" id="mcN_Bal" value="0" inputmode="decimal"></div>' +
      '<div class="mc-field"><label>初始积分</label><input class="mc-input" id="mcN_Pts" value="0" inputmode="decimal"></div></div>' +
      '<div class="mc-field"><label>初始密码</label><input class="mc-input" id="mcN_Pwd" value="123456"></div>' +
      '<div class="mc-field"><label>备注</label><input class="mc-input" id="mcN_Note"></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcNOk">开卡</button></div>');
    $('mcNOk').onclick = function () {
      var btn = this; btn.disabled = true; btn.textContent = '开卡中…';
      rpc('mc_admin_create', {
        p_pwd: adminPwd(),
        p_card_no: $('mcN_Card').value.trim() || null,
        p_login_id: $('mcN_Login').value.trim() || null,
        p_nickname: $('mcN_Nick').value,
        p_phone: $('mcN_Phone').value,
        p_points: safeNum($('mcN_Pts').value),
        p_balance: safeNum($('mcN_Bal').value),
        p_note: $('mcN_Note').value,
        p_init_pwd: $('mcN_Pwd').value.trim() || '123456'
      }).then(function (r) {
        closeModal();
        toast('开卡成功：' + r.card_no + '（初始密码 ' + r.init_pwd + '）', 'ok');
        adminOpenCard(r.card_no);
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '开卡';
        toast(e.message, 'err');
      });
    };
  }

  function safeNum(v) { var n = Number(String(v).replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; }

  /* 计算器：允许 300-12 这类算式 */
  function calc(expr) {
    var s = String(expr == null ? '' : expr)
      .replace(/[×xX✕]/g, '*').replace(/[÷]/g, '/').replace(/[－—]/g, '-').replace(/[＋]/g, '+')
      .replace(/[^\d+\-*/().\s]/g, '');
    if (!s.trim()) throw new Error('请输入金额');
    if (!/^[\d+\-*/().\s]+$/.test(s)) throw new Error('金额格式不正确');
    var v;
    try { v = Function('"use strict";return (' + s + ')')(); } catch (e) { throw new Error('算式无法计算'); }
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('算式无法计算');
    return Math.round(v * 100) / 100;
  }

  function adminConsume() {
    var d = A.detail; if (!d) return;
    openModal('<h3>消费扣款 · ' + esc(d.card_no) + '</h3>' +
      '<div class="mc-hint">当前余额 <b>' + money(d.balance) + '</b>，积分 <b>' + pts(d.points) + '</b> 分。<br>扣余额的同时按消费金额 1:1 累计积分。</div>' +
      '<div class="mc-field" style="margin-top:12px;"><label>消费金额（可直接输入算式，如 300-12）</label>' +
      '<input class="mc-input" id="mcCalcIn" placeholder="288" inputmode="text"></div>' +
      '<div class="mc-calc-out" id="mcCalcOut">已消费 <b>¥0.00</b>，获得积分 <b>0</b></div>' +
      '<div class="mc-hint err" id="mcCalcErr" style="margin-top:6px;min-height:16px;"></div>' +
      '<div class="mc-row" style="margin-top:10px;"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcCalcOk">确认扣款</button></div>');

    var input = $('mcCalcIn'), out = $('mcCalcOut'), errEl = $('mcCalcErr');
    function sync() {
      try {
        var v = calc(input.value);
        out.innerHTML = '已消费 <b>' + money(v) + '</b>，获得积分 <b>' + pts(v) + '</b>';
        errEl.textContent = v <= 0 ? '金额需大于 0' : (v > num(d.balance) ? '余额不足（当前 ' + money(d.balance) + '）' : '');
      } catch (e) {
        out.innerHTML = '已消费 <b>¥0.00</b>，获得积分 <b>0</b>';
        errEl.textContent = input.value ? e.message : '';
      }
    }
    input.addEventListener('input', sync);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') $('mcCalcOk').click(); });
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 100);

    $('mcCalcOk').onclick = function () {
      var btn = this, amount;
      try { amount = calc(input.value); } catch (e) { errEl.textContent = e.message; return; }
      if (amount <= 0) { errEl.textContent = '金额需大于 0'; return; }
      btn.disabled = true; btn.textContent = '扣款中…';
      rpc('mc_admin_consume', { p_pwd: adminPwd(), p_card_no: d.card_no, p_amount: amount }).then(function (r) {
        closeModal();
        openModal('<h3>扣款成功</h3>' +
          '<div class="mc-hint">已消费 <b>' + money(r.consumed) + '</b><br>获得积分 <b>' + pts(r.earned) + '</b> 分<br>' +
          '剩余余额 <b>' + money(r.balance) + '</b><br>当前积分 <b>' + pts(r.points) + '</b> 分</div>' +
          '<div class="mc-gap"></div><button class="mc-btn primary" style="width:100%;" onclick="MC.closeModal();MC.adminRefresh()">完成</button>');
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '确认扣款';
        errEl.textContent = e.message;
      });
    };
  }

  function adminPoints() {
    var d = A.detail; if (!d) return;
    openModal('<h3>积分增减 · ' + esc(d.card_no) + '</h3>' +
      '<div class="mc-hint">当前积分 <b>' + pts(d.points) + '</b> 分。正数增加，负数扣减。</div>' +
      '<div class="mc-field" style="margin-top:12px;"><label>变动积分</label><input class="mc-input" id="mcPtDelta" value="10" inputmode="decimal"></div>' +
      '<div class="mc-row" style="margin-bottom:10px;">' +
      '<button class="mc-btn sm" onclick="MC.setVal(\'mcPtDelta\',10)">+10</button>' +
      '<button class="mc-btn sm" onclick="MC.setVal(\'mcPtDelta\',50)">+50</button>' +
      '<button class="mc-btn sm" onclick="MC.setVal(\'mcPtDelta\',100)">+100</button>' +
      '<button class="mc-btn sm" onclick="MC.setVal(\'mcPtDelta\',-10)">-10</button></div>' +
      '<div class="mc-field"><label>原因（写入记录）</label><input class="mc-input" id="mcPtReason" placeholder="如：活动赠送 / 兑换扣减 / 人工修正"></div>' +
      '<div class="mc-hint err" id="mcPtErr" style="min-height:16px;"></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcPtOk">确认</button></div>');
    $('mcPtOk').onclick = function () {
      var btn = this, delta = safeNum($('mcPtDelta').value);
      if (!delta) { $('mcPtErr').textContent = '变动积分不能为 0'; return; }
      btn.disabled = true; btn.textContent = '提交中…';
      rpc('mc_admin_points', { p_pwd: adminPwd(), p_card_no: d.card_no, p_delta: delta, p_reason: $('mcPtReason').value })
        .then(function (r) {
          closeModal(); toast('积分已更新：' + pts(r.points) + ' 分', 'ok'); adminOpenCard(d.card_no);
        }).catch(function (e) { btn.disabled = false; btn.textContent = '确认'; $('mcPtErr').textContent = e.message; });
    };
  }

  function adminBalance() {
    var d = A.detail; if (!d) return;
    openModal('<h3>余额调整 · ' + esc(d.card_no) + '</h3>' +
      '<div class="mc-hint">当前余额 <b>' + money(d.balance) + '</b>。正数为充值，负数为扣减。</div>' +
      '<div class="mc-field" style="margin-top:12px;"><label>变动金额（元，可输入算式）</label><input class="mc-input" id="mcBalDelta" value="100" inputmode="text"></div>' +
      '<div class="mc-field"><label>原因（写入记录）</label><input class="mc-input" id="mcBalReason" placeholder="如：线下充值 / 退款"></div>' +
      '<div class="mc-hint err" id="mcBalErr" style="min-height:16px;"></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcBalOk">确认</button></div>');
    $('mcBalOk').onclick = function () {
      var btn = this, delta;
      try { delta = calc($('mcBalDelta').value); } catch (e) { $('mcBalErr').textContent = e.message; return; }
      if (!delta) { $('mcBalErr').textContent = '变动金额不能为 0'; return; }
      btn.disabled = true; btn.textContent = '提交中…';
      rpc('mc_admin_balance', { p_pwd: adminPwd(), p_card_no: d.card_no, p_delta: delta, p_reason: $('mcBalReason').value })
        .then(function (r) { closeModal(); toast('余额已更新：' + money(r.balance), 'ok'); adminOpenCard(d.card_no); })
        .catch(function (e) { btn.disabled = false; btn.textContent = '确认'; $('mcBalErr').textContent = e.message; });
    };
  }

  function adminResetPwd() {
    var d = A.detail; if (!d) return;
    openModal('<h3>重置密码 · ' + esc(d.card_no) + '</h3>' +
      '<div class="mc-hint warn">重置后旧 NFC 码立即失效，需要重新生成。</div>' +
      '<div class="mc-field" style="margin-top:12px;"><label>新密码</label><input class="mc-input" id="mcRpPwd" value="123456"></div>' +
      '<div class="mc-hint err" id="mcRpErr" style="min-height:16px;"></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcRpOk">重置</button></div>');
    $('mcRpOk').onclick = function () {
      var btn = this, pw = $('mcRpPwd').value.trim();
      if (pw.length < 6) { $('mcRpErr').textContent = '密码至少 6 位'; return; }
      btn.disabled = true; btn.textContent = '重置中…';
      rpc('mc_admin_reset_pwd', { p_pwd: adminPwd(), p_card_no: d.card_no, p_new_pwd: pw }).then(function (r) {
        closeModal();
        toast('密码已重置为 ' + r.init_pwd + '，请重新生成 NFC 码', 'ok');
        adminOpenCard(d.card_no);
      }).catch(function (e) { btn.disabled = false; btn.textContent = '重置'; $('mcRpErr').textContent = e.message; });
    };
  }

  function adminDelete() {
    var d = A.detail; if (!d) return;
    if (!window.confirm('确定删除会员卡「' + d.card_no + '」吗？\n删除后积分、余额与记录一并清除，不可恢复。')) return;
    rpc('mc_admin_delete', { p_pwd: adminPwd(), p_card_no: d.card_no }).then(function () {
      toast('会员卡已删除', 'ok');
      A.detail = null;
      adminOpenCards();
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function adminNfc() {
    var d = A.detail; if (!d) return;
    var payload = SITE + '/#mc=' + encodeURIComponent(d.card_no) + '&k=' + encodeURIComponent(d.nfc_hash || '');
    openModal('<h3>NFC 码 · ' + esc(d.card_no) + '</h3>' +
      '<div class="mc-hint">把下面这段写入 NFC 标签（NDEF 选「URI / 网址」类型，或纯文本），' +
      '刷卡后即可免密进入该会员卡。标签等同于密码，请勿外传；会员自行改密后此码自动失效。</div>' +
      '<div class="mc-field" style="margin-top:12px;"><label>NFC 内容</label>' +
      '<textarea class="mc-input" id="mcNfcText" readonly style="min-height:84px;">' + esc(payload) + '</textarea></div>' +
      '<div id="mcQr" style="text-align:center;margin:10px 0;"></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.copyNfc()">复制内容</button>' +
      '<button class="mc-btn primary" onclick="MC.closeModal()">完成</button></div>' +
      '<div class="mc-hint" id="mcCopyTip" style="margin-top:8px;min-height:16px;"></div>');
    var box = $('mcQr');
    try {
      if (window.QRCode && box) { new window.QRCode(box, { text: payload, width: 170, height: 170 }); }
    } catch (e) {}
  }

  function copyNfc() {
    var el = $('mcNfcText');
    if (!el) return;
    var text = el.value;
    function done() { var t = $('mcCopyTip'); if (t) t.textContent = '已复制，去写卡工具粘贴即可'; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else { fallback(); }
    } catch (e) { fallback(); }
    function fallback() {
      try { el.removeAttribute('readonly'); el.select(); document.execCommand('copy'); el.setAttribute('readonly', 'readonly'); done(); }
      catch (e) { toast('复制失败，请手动选中文本', 'err'); }
    }
  }

  function setVal(id, v) { var el = $(id); if (el) el.value = v; }

  /* ---------------- 后台：礼品 ---------------- */
  function adminOpenGifts() {
    mountAdmin();
    showAdminSection('mcGiftSec');
    $('mcGiftBody').innerHTML =
      '<button class="back-btn" onclick="MC.backHome()">← 返回</button>' +
      '<h3 style="font-size:17px;margin-bottom:10px;">礼品兑换</h3>' +
      '<p style="font-size:12px;color:#6b5d4d;margin-bottom:8px;">礼品名称与所需积分即前台兑换页展示的内容。</p>' +
      '<div class="mc-hint" style="margin-bottom:12px;">积分兑换产生的订单统一进入 <b>订单管理 → 待处理订单</b>，与普通商品一样填运单号发货；' +
      '发货后自动写入会员卡「物流提醒」，绑定了前台账号的还会通知对方消息中心。</div>' +
      '<div class="mc-admin-bar">' +
      '<button class="mc-btn primary" id="mcGiftTab1" onclick="MC.giftTab(\'list\')">礼品设置</button>' +
      '<button class="mc-btn" onclick="MC.giftAdd()">＋ 新增礼品</button></div>' +
      '<div id="mcGiftPane"></div>';
    giftTab('list');
  }

  function giftTab(tab) {
    A.giftTab = tab;
    var b1 = $('mcGiftTab1');
    if (b1) b1.className = 'mc-btn' + (tab === 'list' ? ' primary' : '');
    loadAdminGifts();
  }

  function adminGotoOrders() {
    ensureAdminVisible();
    if (typeof window.openAdminSection === 'function') {
      window.openAdminSection('secOrders');
      return;
    }
    toast('请从后台首页进入「订单管理 → 待处理订单」');
  }

  function loadAdminGifts() {
    $('mcGiftPane').innerHTML = '<div class="mc-empty">加载中…</div>';
    rpc('gift_admin_list', { p_pwd: adminPwd() }).then(function (rows) {
      A.gifts = rows || [];
      if (!A.gifts.length) { $('mcGiftPane').innerHTML = '<div class="mc-empty">还没有礼品，点「新增礼品」添加</div>'; return; }
      $('mcGiftPane').innerHTML = '<div class="mc-tbl-wrap"><table class="mc-tbl"><thead><tr>' +
        '<th>礼品名称</th><th>所需积分</th><th>库存</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        A.gifts.map(function (g) {
          return '<tr><td>' + esc(g.name) + '</td><td class="num">' + pts(g.points_cost) + '</td>' +
            '<td>' + (g.stock == null ? '不限' : g.stock) + '</td>' +
            '<td><span class="mc-badge ' + (g.active ? '' : 'off') + '">' + (g.active ? '上架' : '下架') + '</span></td>' +
            '<td><button class="mc-btn sm" data-edit="' + g.id + '">编辑</button> ' +
            '<button class="mc-btn sm danger" data-del="' + g.id + '">删除</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      $('mcGiftPane').onclick = function (e) {
        var t = e.target;
        if (!t.getAttribute) return;
        var ed = t.getAttribute('data-edit'), del = t.getAttribute('data-del');
        if (ed) giftEdit(Number(ed));
        if (del) giftDelete(Number(del), t);
      };
    }).catch(function (e) { $('mcGiftPane').innerHTML = '<div class="mc-empty">' + esc(e.message) + '</div>'; });
  }

  function giftEdit(id) {
    var g = null;
    for (var i = 0; i < A.gifts.length; i++) if (Number(A.gifts[i].id) === id) g = A.gifts[i];
    if (!g) return;
    openModal('<h3>编辑礼品</h3>' +
      '<div class="mc-field"><label>礼品名称</label><input class="mc-input" id="mcG_Name" value="' + esc(g.name) + '"></div>' +
      '<div class="mc-row"><div class="mc-field"><label>所需积分</label><input class="mc-input" id="mcG_Pts" value="' + pts(g.points_cost) + '" inputmode="decimal"></div>' +
      '<div class="mc-field"><label>库存（留空不限）</label><input class="mc-input" id="mcG_Stock" value="' + (g.stock == null ? '' : g.stock) + '" inputmode="numeric"></div></div>' +
      '<div class="mc-field"><label>图片地址（选填）</label><input class="mc-input" id="mcG_Img" value="' + esc(g.image_url || '') + '"></div>' +
      '<div class="mc-field"><label>排序（小的在前）</label><input class="mc-input" id="mcG_Sort" value="' + (g.sort || 0) + '" inputmode="numeric"></div>' +
      '<div class="mc-field"><label><input type="checkbox" id="mcG_Active" ' + (g.active ? 'checked' : '') + '> 上架（前台可见）</label></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcG_Ok">保存</button></div>');
    $('mcG_Ok').onclick = function () { saveGift(id); };
  }

  function giftAdd() {
    if (A.giftTab !== 'list') giftTab('list');
    openModal('<h3>新增礼品</h3>' +
      '<div class="mc-field"><label>礼品名称</label><input class="mc-input" id="mcG_Name" placeholder="如：白桦定制书签"></div>' +
      '<div class="mc-row"><div class="mc-field"><label>所需积分</label><input class="mc-input" id="mcG_Pts" value="100" inputmode="decimal"></div>' +
      '<div class="mc-field"><label>库存（留空不限）</label><input class="mc-input" id="mcG_Stock" placeholder="不限" inputmode="numeric"></div></div>' +
      '<div class="mc-field"><label>图片地址（选填）</label><input class="mc-input" id="mcG_Img" placeholder="https://..."></div>' +
      '<div class="mc-field"><label>排序（小的在前）</label><input class="mc-input" id="mcG_Sort" value="0" inputmode="numeric"></div>' +
      '<div class="mc-field"><label><input type="checkbox" id="mcG_Active" checked> 上架（前台可见）</label></div>' +
      '<div class="mc-row"><button class="mc-btn" onclick="MC.closeModal()">取消</button>' +
      '<button class="mc-btn primary" id="mcG_Ok">保存</button></div>');
    $('mcG_Ok').onclick = function () { saveGift(null); };
  }

  function saveGift(id) {
    var name = ($('mcG_Name').value || '').trim();
    var cost = safeNum($('mcG_Pts').value);
    if (!name) { toast('请填写礼品名称', 'err'); return; }
    if (cost < 0) { toast('积分不能为负', 'err'); return; }
    var stockRaw = ($('mcG_Stock').value || '').trim();
    var stock = stockRaw === '' ? null : Math.floor(safeNum(stockRaw));
    var btn = $('mcG_Ok'); btn.disabled = true; btn.textContent = '保存中…';
    rpc('gift_admin_save', {
      p_pwd: adminPwd(), p_id: id, p_name: name, p_points: cost,
      p_stock: stock, p_active: $('mcG_Active').checked,
      p_image: ($('mcG_Img').value || '').trim(), p_sort: Math.floor(safeNum($('mcG_Sort').value))
    }).then(function () { closeModal(); toast('礼品已保存', 'ok'); loadAdminGifts(); })
      .catch(function (e) { btn.disabled = false; btn.textContent = '保存'; toast(e.message, 'err'); });
  }

  function giftDelete(id, btn) {
    if (!window.confirm('确定删除这个礼品吗？前台将不再显示。')) return;
    btn.disabled = true;
    rpc('gift_admin_delete', { p_pwd: adminPwd(), p_id: id }).then(function () {
      toast('礼品已删除', 'ok'); loadAdminGifts();
    }).catch(function (e) { btn.disabled = false; toast(e.message, 'err'); });
  }

  /* ---------------- NFC 进后台 ---------------- */
  function adminOpenCardFromNfc(cardNo) {
    ensureUI();
    mountAdmin();
    showAdminSection('mcAdminSec');
    // 后台容器可能还没展开，直接渲染到会员卡区
    var body = $('mcAdminBody');
    if (body) body.innerHTML = '<div class="mc-empty">正在打开会员卡 ' + esc(cardNo) + '…</div>';
    rpc('mc_admin_card', { p_pwd: adminPwd(), p_card_no: cardNo }).then(function (d) {
      A.detail = d;
      paintAdminDetail();
      loadAdminTxns(cardNo);
      toast('已按 NFC 打开会员卡 ' + cardNo, 'ok');
    }).catch(function (e) {
      toast(e.message, 'err');
      frontNfc({ card: cardNo, key: '' });
    });
  }

  /* ---------------- 导航入口 ---------------- */
  function mountNav() {
    var links = document.querySelector('.b-links');
    if (links && !$('mcNavLink')) {
      var a = document.createElement('a');
      a.id = 'mcNavLink';
      a.href = '#';
      a.textContent = '会员卡';
      a.addEventListener('click', function (e) { e.preventDefault(); openEntry(); });
      links.appendChild(a);
    }
    var drawer = document.querySelector('.drawer-list');
    if (drawer && !$('mcDrawerLink')) {
      var d = document.createElement('a');
      d.id = 'mcDrawerLink';
      d.href = '#';
      d.innerHTML = '<i>💳</i><span>会员卡</span><small>积分 · 余额 · 礼品兑换</small>';
      d.addEventListener('click', function (e) { e.preventDefault(); openEntry(); });
      drawer.insertBefore(d, drawer.lastElementChild);
    }
  }

  function openEntry() {
    if (S.card) { renderHome(); return; }
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SS_CARD) || 'null'); } catch (e) {}
    if (saved && saved.hash) {
      openPanel();
      $('mcBody').innerHTML = '<div class="mc-empty">正在恢复登录…</div>';
      rpc('mc_login_hash', { p_login: saved.card_no, p_hash: saved.hash }).then(function (d) {
        applyCard(d);
      }).catch(function () {
        try { sessionStorage.removeItem(SS_CARD); } catch (e) {}
        renderLogin('', '', '');
      });
      return;
    }
    renderLogin('', '', '');
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (booted) return;
    booted = true;
    ensureUI();
    mountNav();
    mountAdmin();

    var n = parseNfc();
    if (n) {
      cleanUrl();
      handleNfc(n);
      return;
    }
    // 非 NFC 进入时不打扰用户，仅恢复会话
    try {
      var saved = JSON.parse(sessionStorage.getItem(SS_CARD) || 'null');
      if (saved && saved.hash) {
        rpc('mc_login_hash', { p_login: saved.card_no, p_hash: saved.hash }).then(function (d) {
          S.card = d; S.hash = d.auth_hash || saved.hash;
        }).catch(function () { try { sessionStorage.removeItem(SS_CARD); } catch (e) {} });
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
  // 页面内路由变化（hash 变化）时也可响应 NFC 链接
  window.addEventListener('hashchange', function () {
    var n = parseNfc();
    if (n) { cleanUrl(); handleNfc(n); }
  });

  window.MC = {
    open: openEntry,
    closePanel: closePanel,
    closeModal: closeModal,
    home: renderHome,
    logout: logout,
    txns: viewTxns,
    gifts: viewGifts,
    pwd: viewPwd,
    adminOpenCards: adminOpenCards,
    adminOpenGifts: adminOpenGifts,
    adminGotoOrders: adminGotoOrders,
    adminOpenCard: adminOpenCard,
    adminSearch: adminSearch,
    adminRefresh: adminRefresh,
    adminSave: adminSave,
    adminNew: adminNew,
    adminConsume: adminConsume,
    adminPoints: adminPoints,
    adminBalance: adminBalance,
    adminBind: adminBind,
    adminResetPwd: adminResetPwd,
    adminDelete: adminDelete,
    adminNfc: adminNfc,
    copyNfc: copyNfc,
    setVal: setVal,
    giftTab: giftTab,
    giftAdd: giftAdd,
    doBind: doBind,
    unbind: unbind,
    bindToPhone: bindToPhone,
    backHome: function () {
      if (typeof window.backToAdminHome === 'function') { window.backToAdminHome(); return; }
      if (typeof window.goBackAdmin === 'function') { window.goBackAdmin(); return; }
      var home = $('adminHome');
      if (home) home.style.display = 'grid';
      var all = document.querySelectorAll('.admin-section-page');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('show');
    }
  };
})();
