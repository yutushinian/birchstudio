/* 白桦 · 多页站配置（桦库 Supabase cplyzukenqxdwhfivlqx） */
window.BIRCH = {
  url: 'https://cplyzukenqxdwhfivlqx.supabase.co',
  anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwbHl6dWtlbnF4ZHdoZml2bHF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NTg4ODcsImV4cCI6MjEwMTAzNDg4N30.-QYOqSyk5lCEw32zQ-M44B5TsHYmU132y3oYVCF18Bc',
  imgDir: 'img/'
};
window.sbB = function (pathname, opts) {
  var c = window.BIRCH;
  if (!c.url || !c.anon || c.anon === 'ANON_KEY_HERE') return Promise.resolve(null);
  var url = c.url + '/rest/v1/' + pathname;
  return fetch(url, Object.assign({
    headers: {
      apikey: c.anon, Authorization: 'Bearer ' + c.anon,
      'Content-Type': 'application/json', Prefer: 'return=representation'
    }
  }, opts || {})).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('sb ' + r.status)); });
};
/* 图片：库内 __embed__文件名 → 本地 img/；否则按 http/相对原样 */
window.bImg = function (v) {
  if (!v) return '';
  if (String(v).indexOf('__embed__') === 0) return window.BIRCH.imgDir + String(v).slice(9);
  if (String(v).indexOf('http') === 0 || String(v).indexOf('img/') === 0) return v;
  return window.BIRCH.imgDir + v;
};
