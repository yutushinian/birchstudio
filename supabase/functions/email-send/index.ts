// ============================================================
// 白桦 · Supabase Edge Function：email-send（设置表驱动 v2）
// 配置来源（优先级）：环境变量 > settings 表（service role 读取，管理员可在 Table Editor 改）
//   settings 表 key='mail'：{"smtp_user","smtp_pass","smtp_host","smtp_port","to":["a@x.com","b@x.com"]}
// 环境变量可覆盖：SMTP_USER/SMTP_PASS/SMTP_HOST/SMTP_PORT/MAIL_TO/FUNC_TOKEN/ALLOWED_ORIGIN
// 前端调用：POST https://<ref>.supabase.co/functions/v1/email-send {kind,subject?,fields?,to?}
// ------------------------------------------------------------
// 2026-10-02 部署说明（本次采用「加固版」为基线，另按前端契约放开 to）：
//   1) 前端 sendEmailTo()/sendOrderMail() 会主动传 to（如给订阅者群发），
//      故 to 必须生效；若把 to 限制成「必须带 FUNC_TOKEN」会直接打坏订阅群发。
//   2) 保留加固版的防滥用措施：字段数 ≤30、单值 ≤500 字、主题 ≤120 字。
//   3) 收件人兜底由旧的 15040690227@163.com（历史遗留，非本站邮箱）
//      改为本站管理员邮箱 2132389280@qq.com。
//   4) CORS 默认放行本站域名 + GitHub Pages 备用域名；
//      若日后需要临时放开全部来源，在项目 Secrets 里设 ALLOWED_ORIGIN="*" 即可。
// ============================================================
import nodemailer from "npm:nodemailer@6.9.9";

// 只允许自有域名（可用 Secrets 覆盖：ALLOWED_ORIGIN="https://a.com,https://b.com" 或 "*"）
const ALLOWED_LIST = (Deno.env.get("ALLOWED_ORIGIN") ||
  "https://birchstudio.cn,https://www.birchstudio.cn,http://birchstudio.cn,https://yutushinian.github.io,http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map(function (x) { return x.trim(); }).filter(Boolean);
function corsFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowAll = ALLOWED_LIST.indexOf("*") > -1;
  const hit = allowAll || (origin && ALLOWED_LIST.indexOf(origin) > -1);
  return {
    "Access-Control-Allow-Origin": hit ? (origin || "*") : (ALLOWED_LIST[0] || "*"),
    "Access-Control-Allow-Headers": "Content-Type, x-func-token",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}

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
  const CH = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CH });
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      ok: true, name: "白桦 email-send",
      smtpUser: Deno.env.get("SMTP_USER") || "(settings 表 mail.smtp_user)",
      note: "POST {kind,fields} 发通知邮件；收件人取 settings.mail.to 列表",
    }), { headers: { ...CH, "Content-Type": "application/json" } });
  }
  try {
    const FUNC_TOKEN = Deno.env.get("FUNC_TOKEN") || "";
    const providedToken = req.headers.get("x-func-token") || "";
    const tokenOk = !!FUNC_TOKEN && providedToken === FUNC_TOKEN;
    if (FUNC_TOKEN && !tokenOk) {
      return new Response(JSON.stringify({ ok: false, error: "token 校验失败" }), {
        status: 403, headers: { ...CH, "Content-Type": "application/json" },
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

    // 收件人：请求 to > settings.mail.to > 环境 MAIL_TO > 本站管理员邮箱兜底
    const DEFAULT_TO = ["2132389280@qq.com"];
    const dbTo = (db && db.to) || [];
    const envTo = String(Deno.env.get("MAIL_TO") || "").split(/[,，;；\s]+/).filter(Boolean);
    const reqTo = payload.to ? String(payload.to).split(/[,，;；\s]+/).filter(Boolean) : [];
    const list = reqTo.length ? reqTo
      : (Array.isArray(dbTo) && dbTo.length ? dbTo : (envTo.length ? envTo : DEFAULT_TO.slice()));
    if (!list.length) throw new Error("未配置收件邮箱（settings.mail.to）");

    const kind = payload.kind || "message";
    const title = kind === "order" ? "【白桦】新定制意向"
      : kind === "gallery_submit" ? "【白桦】光集投稿意向"
      : kind === "message" ? "【白桦】新留言"
      : kind === "share" ? "【白桦】新授权晒单（弹幕库）" : "【白桦】新消息";
    // 内容长度上限，防滥用
    const lines = Object.entries(payload.fields || payload)
      .filter(([k]) => !["kind", "subject", "to"].includes(k))
      .slice(0, 30)
      .map(([k, v]) => String(k).slice(0, 40) + "：" + (v && typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)).slice(0, 500));
    const subjectTxt = String(payload.subject || title).slice(0, 120);

    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort, secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
    await transporter.sendMail({
      from: `白桦定制 <${smtpUser}>`,
      to: list,
      subject: subjectTxt,
      text: "白桦收到一条新的客户信息：\n\n" + lines.join("\n") + "\n\n—— 白桦 BIRCH",
    });
    return new Response(JSON.stringify({ ok: true, to: list }), {
      headers: { ...CH, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...CH, "Content-Type": "application/json" },
    });
  }
});
