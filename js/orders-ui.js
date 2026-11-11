/* ============================================================
   后台「待处理订单」界面增强（2026-11-11）
   1) 重排订单卡片：状态胶囊 + 三列关键信息 + 折叠的防伪码区
   2) 四个操作按钮统一成圆角按钮（不用方形块）
   3) 「撤回待处理」改走 recall_order，修复会员卡兑换单撤回后被
      自动改回已发货的问题（旧接口作为兜底）
   依赖 bundle.js 暴露的 orderList / currentAdminPwd / toast 等全局。
   ============================================================ */
(function () {
  'use strict';
  if (window.__uoOrdersUiReady) {
    return;
  }
  window.__uoOrdersUiReady = 1;

  function esc(value) {
    if (typeof escapeHtml === 'function') {
      return escapeHtml(value == null ? '' : value);
    }
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function when(value) {
    if (!value) {
      return '—';
    }
    var d = new Date(value);
    if (isNaN(d.getTime())) {
      return String(value);
    }
    var now = new Date();
    var date = d.getFullYear() === now.getFullYear()
      ? pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      : d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return date + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function money(value) {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    var num = Number(value);
    if (isNaN(num)) {
      return '¥' + value;
    }
    var text = (Math.round(num * 100) / 100).toString();
    return '¥' + text;
  }

  function row(label, value, mono) {
    if (value === null || value === undefined || value === '') {
      return '';
    }
    return '<div class="uo-row"><span class="uo-k">' + label + '</span>' +
      '<span class="uo-v' + (mono ? ' mono' : '') + '">' + esc(value) + '</span></div>';
  }

  function facts(order) {
    return '<div class="uo-facts">' +
      '<div class="uo-fact"><em>商品</em><b>' + esc(order.product_name || '—') + '</b></div>' +
      '<div class="uo-fact"><em>实付</em><b>' + money(order.final_price) + '</b></div>' +
      '<div class="uo-fact"><em>手机</em><b>' + esc(order.phone || '—') + '</b></div>' +
      '</div>';
  }

  function detailsBlock(order) {
    var hasUser = !!(order.nickname || order.username);
    return '<div class="uo-rows">' +
      (hasUser ? row('👤 账号', (order.nickname || '—') + '　' + (order.username || '—')) : '') +
      row('🔑 订单密码', order.order_pwd || '—', true) +
      row('🧾 交易单号', order.trade_no || '—') +
      row('📮 收货', (order.receiver || '—') + '　' + (order.phone || '')) +
      row('🏠 地址', order.address || '—') +
      '</div>';
  }

  function codeForm(order) {
    var hint = order.anti_code
      ? '<span class="uo-mini">已生成 ' + esc(order.anti_code) + '</span>'
      : '<span class="uo-sub-inline">未生成，先填写名称再导出</span>';
    return '<details class="uo-fold"' + (order.anti_code ? '' : ' open') + '>' +
      '<summary>🧾 防伪码信息　' + hint + '</summary>' +
      '<div id="ordCode_' + order.id + '" class="uo-code-tip">' +
      (order.anti_code ? '✅ 官方码：' + esc(order.anti_code) : '') + '</div>' +
      '<div class="uo-form">' +
      '<label class="uo-field">产品名称<input id="ordName_' + order.id + '" value="' + esc(order.product_name) + '" placeholder="产品名称"></label>' +
      '<label class="uo-field">专属定制编号<input id="ordBatch_' + order.id + '" value="' + esc(order.order_no) + '" placeholder="专属定制编号"></label>' +
      '<label class="uo-field uo-full">白桦寄语<textarea id="ordMsg_' + order.id + '" rows="2" placeholder="选填，会印在卡片上">' + esc(order.note || '') + '</textarea></label>' +
      '<label class="uo-field uo-full">图片文件名<input id="ordImg_' + order.id + '" value="' + esc(order.image_url || '') + '" placeholder="选填，多个用英文逗号分隔"></label>' +
      '<label class="uo-chk-line uo-full"><input type="checkbox" id="ordExpMsg_' + order.id + '"> 卡片上导出寄语</label>' +
      '</div>' +
      '</details>';
  }

  function card(order) {
    var shipped = order.status === 'shipped';
    var merged = !shipped && /合并自：/.test(order.note || '');
    var cls = shipped ? ' is-shipped' : (merged ? ' is-merged' : '');
    var pill = shipped
      ? '<span class="uo-pill ok">✅ 已发货</span>'
      : (merged ? '<span class="uo-pill merged">🧩 已合并</span>' : '<span class="uo-pill">⏳ 待处理</span>');

    var html = '<article class="uo-card' + cls + '">' +
      '<div class="uo-head">' + pill +
      '<span class="uo-no">' + esc(order.order_no) + '</span>' +
      '<span class="uo-time">' + when(order.created_at) + '</span>' +
      (shipped ? '' : '<label class="uo-check"><input type="checkbox" class="merge-chk" data-id="' + order.id + '" onchange="updateMergeSel()"></label>') +
      '</div>';

    html += facts(order);
    html += detailsBlock(order);

    if (shipped) {
      html += '<div class="uo-track">🚚 运单号 ' +
        (order.tracking_no
          ? '<span class="uo-track-no">' + esc(order.tracking_no) + '</span>' +
            '<button class="uo-mini" onclick="copyTracking(\'' + esc(order.tracking_no) + '\')">📋 复制</button>'
          : '<span>暂无运单号</span>') +
        (order.anti_code ? '<span>· 官方码 ' + esc(order.anti_code) + '</span>' : '') +
        '</div>';
      html += '<div class="uo-actions uo-actions-3">' +
        '<button class="uo-btn uo-btn-ghost" onclick="setOrderTracking(' + order.id + ')">📦 运单号</button>' +
        '<button class="uo-btn uo-btn-warn" onclick="recallShippedOrder(' + order.id + ')">↩️ 撤回待处理</button>' +
        '<button class="uo-btn uo-btn-soft" onclick="bindOrderAccount(\'' + esc(order.anti_code || '') + '\')">👤 添加到账号</button>' +
        '</div>' +
        '<div class="uo-actions" style="margin-top:8px;">' +
        '<button class="uo-btn uo-btn-danger" onclick="deleteOrder(' + order.id + ')">🗑️ 删除订单</button>' +
        '</div>';
    } else {
      html += codeForm(order);
      if (order.note) {
        html += '<div class="uo-note">📝 备注：' + esc(order.note) + '</div>';
      }
      html += '<div class="uo-actions">' +
        '<button class="uo-btn uo-btn-ghost" onclick="exportOrderCodeImg(' + order.id + ')">📷 导出防伪码</button>' +
        '<button class="uo-btn uo-btn-ghost" onclick="saveOrderRowEdit(' + order.id + ')">💾 保存修改</button>' +
        '<button class="uo-btn uo-btn-primary" onclick="finishOrder(' + order.id + ')">✅ 完成订单</button>' +
        '<button class="uo-btn uo-btn-danger" onclick="deleteOrder(' + order.id + ')">🗑️ 删除订单</button>' +
        '</div>' +
        '<div class="uo-actions" style="margin-top:8px;">' +
        (merged ? '<button class="uo-btn uo-btn-warn" onclick="splitMergedOrder(' + order.id + ')">🔀 拆分此单</button>' : '') +
        '<button class="uo-btn uo-btn-soft" onclick="bindOrderAccount(\'' + esc(order.anti_code || '') + '\')">👤 添加到账号</button>' +
        '</div>';
    }

    html += '</article>';
    return html;
  }

  function renderOrders() {
    var wrap = document.getElementById('ordersListWrap');
    if (!wrap) {
      return;
    }
    var input = document.getElementById('orderSearch');
    var keyword = ((input && input.value) || '').trim().toLowerCase();
    var all = (typeof orderList !== 'undefined' && orderList) || [];
    var list;

    if (keyword) {
      list = all.filter(function (o) {
        if (o.status === 'deleted') {
          return false;
        }
        var hay = [o.order_no, o.order_pwd, o.username, o.nickname, o.phone, o.product_name];
        for (var i = 0; i < hay.length; i++) {
          if ((hay[i] || '').toString().toLowerCase().indexOf(keyword) >= 0) {
            return true;
          }
        }
        return false;
      });
    } else if (window.showAllOrders) {
      list = all.filter(function (o) {
        return o.status !== 'deleted';
      });
    } else {
      list = all.filter(function (o) {
        return o.status !== 'shipped' && o.status !== 'merged' && o.status !== 'deleted';
      });
    }

    var pendingCount = all.filter(function (o) {
      return !o.status || (o.status !== 'shipped' && o.status !== 'merged' && o.status !== 'deleted');
    }).length;
    var shippedCount = all.filter(function (o) {
      return o.status === 'shipped';
    }).length;

    if (!all.length) {
      wrap.innerHTML = '<div class="uo-empty"><span class="uo-empty-emoji">📭</span>' +
        '<span>暂无订单</span><span style="font-size:11px;">客户下单后会自动出现在这里</span></div>';
      return;
    }

    var bar = '<div class="uo-bar">' +
      '<button class="uo-seg' + (window.showAllOrders ? ' is-on' : '') + '" onclick="window.showAllOrders=!window.showAllOrders;renderOrders()">' +
      (window.showAllOrders ? '📋 全部订单' : '🕐 只看待处理') + '</button>' +
      '<button class="uo-seg" onclick="uoSelAllPending()">☑️ 全选</button>' +
      '<button class="uo-seg uo-seg-ok" onclick="batchFinishOrders()">✅ 批量完成</button>' +
      '<button class="uo-seg uo-seg-del" onclick="batchDeleteOrders()">🗑️ 批量删除</button>' +
      '</div>' +
      '<div class="uo-sum"><span>共 <b>' + all.length + '</b> 单</span>' +
      '<span class="uo-sep"></span><span>待处理 <b>' + pendingCount + '</b></span>' +
      '<span class="uo-sep"></span><span>已发货 <b>' + shippedCount + '</b></span>' +
      '<span style="margin-left:auto;"><b id="mergeSelInfo">已选 0 单</b></span>' +
      '</div>';

    if (!list.length) {
      wrap.innerHTML = bar + '<div class="uo-empty"><span class="uo-empty-emoji">🎉</span>' +
        '<span>' + (keyword ? '没有匹配的订单，换个关键词试试' : '没有待处理订单，全部已发货') + '</span></div>';
      return;
    }

    wrap.innerHTML = bar + list.map(card).join('');
  }

  /* ---------- 撤回待处理：优先 recall_order ---------- */
  async function doRecall(id) {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
      return false;
    }
    try {
      var res = await supabaseClient.rpc('recall_order', {
        p_id: Number(id),
        p_pwd: currentAdminPwd
      });
      if (!res.error) {
        return res.data !== false;
      }
    } catch (err) {
      /* 函数不存在时走旧接口 */
    }
    try {
      var old = await supabaseClient.rpc('update_order', {
        p_id: Number(id),
        p_status: 'pending',
        p_pwd: currentAdminPwd
      });
      return !old.error && old.data !== false;
    } catch (err2) {
      return false;
    }
  }

  window.recallShippedOrder = async function (id) {
    if (!currentAdminPwd) {
      return toast('管理员密码已过期');
    }
    var order = (orderList || []).find(function (o) {
      return o.id === id;
    });
    if (!order || order.status !== 'shipped') {
      return toast('该订单不是已发货状态');
    }
    if (!confirm('确定把订单 ' + order.order_no + ' 撤回为待处理吗？\n\n撤回后可在待处理列表重新填写运单号并发货。')) {
      return;
    }
    showLoading('正在撤回订单...');
    try {
      var ok = await doRecall(id);
      if (!ok) {
        return toast('撤回失败：状态没有改动，请刷新后重试');
      }
      await loadOrders();
      if (typeof logSession === 'function') {
        logSession('recallOrder', ['订单 ' + order.order_no]);
      }
      toast('✅ 订单 ' + order.order_no + ' 已撤回待处理');
    } finally {
      hideLoading();
    }
  };

  window.recallOrderByCode = async function (antiCode) {
    if (!currentAdminPwd) {
      return toast('管理员密码已过期');
    }
    var order = (orderList || []).find(function (o) {
      return o.anti_code === antiCode;
    });
    if (!order) {
      return toast('未找到关联订单');
    }
    if (order.status !== 'shipped') {
      return toast('仅已发货订单可退回待处理');
    }
    if (!confirm('确定把订单 ' + order.order_no + ' 退回为待处理吗？\n\n退回后需在「待处理订单」里重新完成发货。')) {
      return;
    }
    showLoading('正在退回订单...');
    try {
      var ok = await doRecall(order.id);
      if (!ok) {
        return toast('退回失败：状态没有改动，请刷新后重试');
      }
      await loadOrders();
      if (typeof loadData === 'function') {
        await loadData();
      }
      if (typeof logSession === 'function') {
        logSession('recallOrder', ['订单 ' + order.order_no + '（防伪码 ' + antiCode + '）']);
      }
      toast('✅ 订单 ' + order.order_no + ' 已退回待处理');
    } finally {
      hideLoading();
    }
  };

  window.renderOrders = renderOrders;
  window.uoOrdersUi = { render: renderOrders };
})();
