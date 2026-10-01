// ============================================================
// 白桦 · admin-api（桦库版，service-role + 可选 x-bad-token 保护）
// 用法同予光：POST {op, table, id?, set?, row?, limit?}
// op: list/insert/update/delete
// 保护：请求头 x-bad-token 需等于环境变量 B_ADMIN_TOKEN（未设则拒绝）。
// 桦库前端重写时可接入：授权分享库上下架、存档、防伪码管理等。
// ------------------------------------------------------------
// 【2026-10-02 修复】原实现假定所有表都有 id + created_at：
//   · records / recycle_bin 实际没有 created_at（用 create_time / create_timestamp）→ list 报 42703
//   · settings 主键是 key，没有 id → update / delete 定位不到行
//   · products / archives 在本库根本不存在 → 调用只会上游 404
//   现按表分别指定排序键与主键。
// ============================================================
const TABLES = ['orders', 'records', 'gallery', 'shares', 'recycle_bin', 'settings', 'users'];
/* 排序键：默认 created_at.desc；下表例外 */
const ORDER_BY = { shares: 'id.desc', records: 'id.desc', recycle_bin: 'id.desc', settings: 'key.asc' };
/* 主键列：默认 id；settings 是 key */
const PK = { settings: 'key' };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-bad-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
function hdr(SK) { return { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" }; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const token = Deno.env.get("B_ADMIN_TOKEN") || "";
  if (!token || (req.headers.get("x-bad-token") || "") !== token) {
    return new Response(JSON.stringify({ ok: false, error: "未授权（需 x-bad-token）" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const op = body.op || "list";
    const table = String(body.table || "");
    if (TABLES.indexOf(table) === -1) throw new Error("不允许的表：" + table);
    const SB_URL = Deno.env.get("SUPABASE_URL") || "";
    const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const auth = hdr(SK);
    const w = (k, v) => k + "=eq." + encodeURIComponent(v);
    const pk = PK[table] || "id";   // settings 用 key 定位，其余用 id

    if (op === "list") {
      const q = "/rest/v1/" + table + "?select=*&order=" + (ORDER_BY[table] || "created_at.desc") + "&limit=" + (body.limit || 200);
      const r = await fetch(SB_URL + q, { headers: auth });
      const rows = await r.json();
      return new Response(JSON.stringify({ ok: r.ok, rows }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (op === "insert") {
      const r = await fetch(SB_URL + "/rest/v1/" + table, { method: "POST", headers: { ...auth, Prefer: "return=representation" }, body: JSON.stringify(body.row || {}) });
      const rows = await r.json();
      return new Response(JSON.stringify({ ok: r.ok, row: Array.isArray(rows) ? rows[0] : rows }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (op === "update") {
      const id = String(body.id || "");
      const r = await fetch(SB_URL + "/rest/v1/" + table + "?" + w(pk, id), { method: "PATCH", headers: auth, body: JSON.stringify(body.set || {}) });
      return new Response(JSON.stringify({ ok: r.ok, error: r.ok ? "" : (await r.text()).slice(0, 200) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (op === "delete") {
      const id = String(body.id || "");
      const r = await fetch(SB_URL + "/rest/v1/" + table + "?" + w(pk, id), { method: "DELETE", headers: auth });
      return new Response(JSON.stringify({ ok: r.ok }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    throw new Error("未知操作");
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
