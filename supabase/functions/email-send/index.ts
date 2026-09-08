// ============================================================
// 白桦 · Supabase Edge Function：email-send（设置表驱动 v2）
// 配置来源（优先级）：环境变量 > settings 表（service role 读取，管理员可在 Table Editor 改）
//   settings 表 key='mail'：{"smtp_user","smtp_pass","smtp_host","smtp_port","to":["a@x.com","b@x.com"]}
// 环境变量可覆盖：SMTP_USER/SMTP_PASS/SMTP_HOST/SMTP_PORT/MAIL_TO/FUNC_TOKEN
// 前端调用：POST https://<ref>.supabase.co/functions/v1/email-send {kind,subject?,fields?,to?}
// ============================================================
import nodemailer from "npm:nodemailer@6.9.9";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-func-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

async function getDbMail(SB_URL, SK) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/settings?select=value&key=eq.mail", {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const v = rows && rows[0] && rows[0].value;
    if (!v) return null;
    return typeof v === "string" ? JSON.parse(v.replace(/^"(.*)"$/, "$1")) : v;
  } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      ok: true, name: "白桦 email-send",
      smtpUser: Deno.env.get("SMTP_USER") || "(settings 表 mail.smtp_user)",
      note: "POST {kind,fields} 发通知邮件；收件人取 settings.mail.to 列表",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  try {
    const FUNC_TOKEN = Deno.env.get("FUNC_TOKEN") || "";
    if (FUNC_TOKEN && req.headers.get("x-func-token") !== FUNC_TOKEN) {
      return new Response(JSON.stringify({ ok: false, error: "token 校验失败" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const payload = await req.json();
    const SB_URL = Deno.env.get("SUPABASE_URL") || "";
    const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const db = SK ? await getDbMail(SB_URL, SK) : null;

    const smtpUser = Deno.env.get("SMTP_USER") || (db && db.smtp_user) || "";
    const smtpPass = Deno.env.get("SMTP_PASS") || (db && db.smtp_pass) || "";
    const smtpHost = Deno.env.get("SMTP_HOST") || (db && db.smtp_host) || "smtp.qq.com";
    const smtpPort = Number(Deno.env.get("SMTP_PORT") || (db && db.smtp_port) || 465);
    if (!smtpUser || !smtpPass) throw new Error("发件邮箱未配置（settings.mail 或 Secrets）");

    // 收件人：请求 to > settings.mail.to > 环境 MAIL_TO > 后台预置默认邮箱（管理员收件）
    const DEFAULT_TO = ["15040690227@163.com"];
    const dbTo = (db && db.to) || [];
    const envTo = String(Deno.env.get("MAIL_TO") || "").split(/[,，;；\s]+/).filter(Boolean);
    const list = payload.to ? String(payload.to).split(/[,，;；\s]+/).filter(Boolean)
      : (Array.isArray(dbTo) && dbTo.length ? dbTo : (envTo.length ? envTo : DEFAULT_TO.slice()));
    if (!list.length) throw new Error("未配置收件邮箱（settings.mail.to）");

    const kind = payload.kind || "message";
    const title = kind === "order" ? "【白桦】新定制意向"
      : kind === "gallery_submit" ? "【白桦】光集投稿意向"
      : kind === "message" ? "【白桦】新留言" : "【白桦】新消息";
    const lines = Object.entries(payload.fields || payload)
      .filter(([k]) => !["kind", "subject", "to"].includes(k))
      .map(([k, v]) => k + "：" + (v && typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)));

    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort, secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
    await transporter.sendMail({
      from: `白桦定制 <${smtpUser}>`,
      to: list,
      subject: payload.subject || title,
      text: "白桦收到一条新的客户信息：\n\n" + lines.join("\n") + "\n\n—— 白桦 BIRCH",
    });
    return new Response(JSON.stringify({ ok: true, to: list }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
