// ============================================================
// 白桦 · admin-api（桦库版，service-role + 可选 x-bad-token 保护）
// 用法同予光：POST {op, table, id?, set?, row?, limit?}
// op: list/insert/update/delete
// 保护：请求头 x-bad-token 需等于环境变量 B_ADMIN_TOKEN（未设则拒绝）。
// 桦库前端重写时可接入：授权分享库上下架、存档、防伪码管理等。
// ============================================================
const TABLES = ['orders','records','gallery','products','shares','archives','recycle_bin','settings','users'];
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

    if (op === "list") {
      const q = "/rest/v1/" + table + "?select=*&order=" + (table === "shares" || table === "archives" ? "id.desc" : "created_at.desc") + "&limit=" + (body.limit || 200);
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
      const r = await fetch(SB_URL + "/rest/v1/" + table + "?" + w("id", id), { method: "PATCH", headers: auth, body: JSON.stringify(body.set || {}) });
      return new Response(JSON.stringify({ ok: r.ok, error: r.ok ? "" : (await r.text()).slice(0, 200) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (op === "delete") {
      const id = String(body.id || "");
      const r = await fetch(SB_URL + "/rest/v1/" + table + "?" + w("id", id), { method: "DELETE", headers: auth });
      return new Response(JSON.stringify({ ok: r.ok }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    throw new Error("未知操作");
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
