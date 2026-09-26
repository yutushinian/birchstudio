// ============================================================
// 白桦 · Supabase Edge Function：ai-assistant（设置表驱动 v2 · DeepSeek）
// 配置优先级：环境变量（AI_API_KEY / AI_MODEL）> settings 表 key='ai'
//   settings.ai = {"key":"sk-...","model":"deepseek-chat"}（service role 读取；匿名不可见）
// 模式：chat（全站助手）/ stones（AI 荐石，读 crystals 晶石库）
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

async function getDbAi(SB_URL, SK) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/settings?select=value&key=eq.ai", {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const v = rows && rows[0] && rows[0].value;
    if (!v) return null;
    return typeof v === "string" ? JSON.parse(v.replace(/^"(.*)"$/, "$1")) : v;
  } catch (_) { return null; }
}

async function loadConfig(SB_URL, SK) {
  let key = Deno.env.get("AI_API_KEY") || "";
  let model = Deno.env.get("AI_MODEL") || "deepseek-chat";
  if ((!key || !model) && SK) {
    const db = await getDbAi(SB_URL, SK);
    if (db) {
      if (!key) key = db.key || "";
      if (!model) model = db.model || "deepseek-chat";
    }
  }
  return { key, model };
}

async function deepseekChat(apiKey, model, messages) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model: model || "deepseek-chat", messages, temperature: 0.7, max_tokens: 900 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
  const msg = data.choices && data.choices[0] && data.choices[0].message || null;
  const text = msg ? (msg.content || msg.reasoning_content || "") : "";
  return (text || "").trim();
}

async function recordUsage(SB_URL, SK, mode, question) {
  try {
    await fetch(SB_URL + "/rest/v1/ai_usage", {
      method: "POST", headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ mode: mode || "chat", question: String(question || "").slice(0, 200) }),
    });
  } catch (e) { /* 表未建则忽略 */ }
}

async function getDbAiImg(SB_URL, SK) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/app_data?select=data&key=eq.birch_ai_img", {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const v = rows && rows[0] && rows[0].data;
    if (!v) return null;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (_) { return null; }
}

async function fetchCrystals(SB_URL, SK) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/crystals?select=name,kind,element,meaning&visible=eq.true&order=sort.asc&limit=100", {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    });
    return r.ok ? await r.json() : [];
  } catch (_) { return []; }
}

/* ============================================================
 * 出图工具（2026-09-26 修复）
 * 1) fetchT：给每一次上游请求加超时，避免出图卡死把整个函数拖到网关超时；
 * 2) ensureBucket + uploadImage：把 b64 结果落到 Storage 永久地址，
 *    不再直接把硅基流动的临时签名 URL（24h 过期）返回给前端 —— 这正是
 *    「AI 出图时好时坏 / 图过一阵就裂」的根因（线上 storage.buckets 为空）。
 * ============================================================ */
const IMG_BUCKET = "assets";

async function fetchT(url, init, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms || 90000);
  try {
    return await fetch(url, { ...(init || {}), signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBucket(SB_URL, SK) {
  if (!SB_URL || !SK) return false;
  try {
    const chk = await fetchT(SB_URL + "/storage/v1/bucket/" + IMG_BUCKET, {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    }, 15000);
    if (chk.ok) return true;
    const mk = await fetchT(SB_URL + "/storage/v1/bucket", {
      method: "POST",
      headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" },
      body: JSON.stringify({ id: IMG_BUCKET, name: IMG_BUCKET, public: true, file_size_limit: 10485760 }),
    }, 15000);
    if (mk.ok) return true;
    /* 并发场景下别的实例已经建好了：再查一次 */
    const again = await fetchT(SB_URL + "/storage/v1/bucket/" + IMG_BUCKET, {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    }, 15000);
    return again.ok;
  } catch (_) { return false; }
}

function b64ToBytes(b64) {
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* 上传成功返回永久公开地址；失败返回空串（调用方回退临时地址 / b64） */
async function uploadImage(SB_URL, SK, b64) {
  if (!SB_URL || !SK || !b64) return "";
  try {
    await ensureBucket(SB_URL, SK);
    const path = "gen/" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".png";
    const up = await fetchT(SB_URL + "/storage/v1/object/" + IMG_BUCKET + "/" + path, {
      method: "POST",
      headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "image/png", "x-upsert": "true" },
      body: b64ToBytes(b64),
    }, 60000);
    if (!up.ok) return "";
    return SB_URL + "/storage/v1/object/public/" + IMG_BUCKET + "/" + path;
  } catch (_) { return ""; }
}

function errText(j, status) {
  if (!j) return "HTTP " + status;
  return String(
    (j.message) ||
    (j.error && (j.error.message || JSON.stringify(j.error))) ||
    (j.raw) ||
    ("HTTP " + status)
  ).slice(0, 300);
}

/* 上游只给临时 URL 时，第一时间抓回来转存（签名地址 24 小时后即失效） */
async function fetchAndStore(SB_URL, SK, remoteUrl) {
  if (!remoteUrl) return "";
  try {
    const r = await fetchT(remoteUrl, {}, 60000);
    if (!r.ok) return "";
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > 10485760) return "";
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const stored = await uploadImage(SB_URL, SK, btoa(bin));
    return stored || "";
  } catch (_) { return ""; }
}

/* 硅基流动出图：超时 + 一次重试（5xx/网络抖动重试，4xx 直接给出原因） */
async function siliconGenerate(imgKey, imgBase, imgModel, prompt) {
  const url = String(imgBase || "https://api.siliconflow.cn/v1").replace(/\/$/, "") + "/images/generations";
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchT(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + imgKey },
        body: JSON.stringify({ model: imgModel, prompt: prompt, image_size: "1024x1024", batch_size: 1, num_images: 1, response_format: "b64_json" }),
      }, 100000);
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.data && j.data[0]) {
        const d0 = j.data[0];
        return { b64: d0.b64_json || "", url: d0.url || "", error: "" };
      }
      lastErr = errText(j, r.status);
      if (r.status >= 400 && r.status < 500) break; /* 参数/额度/密钥问题，重试无意义 */
    } catch (e) {
      lastErr = (e && e.name === "AbortError") ? "出图超时（上游 100 秒无响应）" : String((e && e.message) || e);
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return { b64: "", url: "", error: lastErr || "出图服务未返回图片" };
}

const SYSTEM = [
  "你是「白桦」官网（birchstudio.cn · 白桦定制水晶）的 AI 助手。品牌：天然水晶定制——东方五行/生肖/八卦、节气能量、生辰测石、消磁养护文化；作品支持官方码验真。",
  "网站功能导航：五行晶石、八卦图鉴、节气能量、需求选石、消磁净化、生辰测石（生辰/摇卦/随缘搭配，AI 出设计方案与诗句）、臻品橱窗、官方验证（扫码/输入官方码核验真伪与定制信息）、转盘优惠（联系微信立减）、抽一签/答案之书、白桦来信订阅；购买与定制走客服微信（页脚/联系我们）。",
  "红线（务必遵守）：",
  "1) 不预测命运、运势、结果；绝不承诺任何效果（转运/复合/发财/疗愈等）；不宣传开光、法力、辟邪保证；",
  "2) 涉及生肖五行八卦星座星盘等，一律标注「文化意象参考，不构成任何承诺」；",
  "3) 情感/迷茫问题：温暖陪伴、鼓励自我关照（先照亮自己，再谈遇见），绝不替用户做人生决定；",
  "4) 医疗/健康/心理疾病类问题：温和建议咨询专业机构；",
  "5) 未成年人相关命运类话题请引导由监护人陪同了解；",
  "6) 回答简洁、中文、口语化、有温度、适当分点；不确定就引导联系客服微信。",
].join("\n");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, name: "白桦 ai-assistant" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const mode = body.mode || "chat";
    const SB_URL = Deno.env.get("SUPABASE_URL") || "";
    const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const { key: apiKey, model } = await loadConfig(SB_URL, SK);
    if (!apiKey) {
      return Response.json({ ok: false, error: "AI 未配置：settings.ai 或 AI_API_KEY" }, { headers: corsHeaders });
    }

    if (mode === "stones") {
      const need = String(body.need || "").trim() || "日常佩戴";
      const crystals = await fetchCrystals(SB_URL, SK);
      const crystalText = crystals.length
        ? crystals.map((c) => `${c.name}（${c.kind || c.element || ""}）${c.meaning || ""}`).join("；")
        : "（晶石库暂未配置内容）";
      const out = await deepseekChat(apiKey, model, [
        { role: "system", content: SYSTEM },
        { role: "user", content: `用户需求：「${need}」。已知晶石：${crystalText}。请给出 2-4 个「文化意象参考」建议（含可考虑的款式方向与一句白桦风格的光语），并提醒不构成任何效果承诺。` },
      ]);
      await recordUsage(SB_URL, SK, 'stones', need);
      return Response.json({ ok: true, answer: out }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (mode === "design") {
      // 输入 → DeepSeek v4-flash（严格颗数规则 + 配比/串序 + 设计理念 + 诗曰）→ 通义按串序出图
      const d = body.design || {};
      const mm = Number(d.mm || body.mm) || 10;
      const count = mm >= 10 ? 18 : 22;   // 硬性：10mm=18颗，8mm=22颗
      const kind = body.kind || "bazi";
      const info = body.info || "";
      let userInfo = "";
      if (kind === "bazi") userInfo = "生辰：出生" + (info.year || "?") + "年" + (info.month || "?") + "月" + (info.day || "?") + "日" + (info.hour || "?") + "时，生肖" + (info.zod || "?") + "，本命五行" + (info.el || "?") + (info.gua ? "，另取卦「" + info.gua + "」" : "") + (info.ganzhi ? "，四柱：" + info.ganzhi : "") + (info.dayMaster ? "，日主" + info.dayMaster : "") + (info.wuxing ? "，五行分布：" + info.wuxing : "");
      else if (kind === "hex") userInfo = "摇卦得「" + (info.name || "") + "（" + (info.sym || "") + "）」，" + (info.idea || "") + "，五行属" + (info.wu || "");
      else if (kind === "zod") userInfo = "本命生肖：" + (info.zod || "") + "，五行" + (info.el || "");
      else if (kind === "star") userInfo = "太阳星座：" + (info.sun || "") + (info.moon ? "，月亮：" + info.moon : "") + (info.rising ? "，上升：" + info.rising : "");
      else if (kind === "union") userInfo = "合盘：我的星座 " + (info.a || "") + "，对方星座 " + (info.b || "") + (info.note ? "；备注：" + info.note : "");
      else if (kind === "free") userInfo = "用户选择「随缘搭配」，无生辰信息：" + (info.note ? "（" + info.note + "）" : "请自由发挥，给出 3-5 种晶石的整套搭配设计与意象。");

      const dbAi2 = await getDbAi(SB_URL, SK) || {};
      const dk2 = Deno.env.get("AI_API_KEY") || dbAi2.key || "";
      const dmodel2 = Deno.env.get("AI_MODEL") || dbAi2.model || "deepseek-chat";
      if (!dk2) return Response.json({ ok: false, error: "后台 AI 密钥未配置（settings.ai）" }, { headers: corsHeaders });

      const NL = String.fromCharCode(10);
      const sysP2 = [
        "你是白桦的设计师与文案。根据用户信息，为这位客户设计一串最适合他的水晶手串。",
        "【硬性规格】整串同径圆珠，全部珠子直径一致。10mm 整串必须正好 18 颗；8mm 整串必须正好 22 颗。",
        "本次规格：整串统一 " + mm + "mm 同径圆珠，必须正好 " + count + " 颗（不得多一颗、少一颗，不得混径）。",
        "不要使用任何 * 星号与 markdown 标记，不要复述用户信息，不要思考过程，只输出下面三部分：",
        "第一部分·配比（仅用于后台出图，客户看不到）：",
        "  1) 每种石一行：「石:海蓝宝|数量:7|色:#7FB5C9」，写 3-5 种，" + count + " 颗之和必须正好等于 " + count + "；",
        "  2) 再另起一行输出完整串序（顺时针逐颗排列）：「石序:海蓝宝,海蓝宝,月光石,海蓝宝,…」，必须逐颗列出、正好 " + count + " 个名字，且与上面的数量完全一致；",
        "第二部分·设计理念：以「串为……」开篇，结合季节调候与本命喜忌，逐石点题（与配比一致），交代缀饰与整体意象，150-220 字；",
        "第三部分·诗曰：必须另起一行，以「诗曰：」开头，随后四行，每行一句七言（共四句），不要写成段落。",
        "用户信息：" + userInfo
      ].join(NL);

      const pa2 = await fetchT("https://api.deepseek.com/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dk2 },
        body: JSON.stringify({ model: dmodel2, messages: [{ role: "system", content: sysP2 }], temperature: 0.7, max_tokens: 3200, thinking: { type: "disabled" } })
      }, 90000).then(r => r.json()).catch(() => null);
      const rawTxt = pa2 && pa2.choices && pa2.choices[0] && pa2.choices[0].message
        ? String((pa2.choices[0].message.content || pa2.choices[0].message.reasoning_content) || "").split("*").join("").trim()
        : "";

      // ---- 解析：配比 / 串序 / 设计理念 / 诗曰 ----
      const lines = String(rawTxt).split(NL);
      let stones = [];
      lines.forEach(function (ln) {
        const t = ln.trim();
        let m = /石[:：]\s*([^|]+?)\s*\|\s*数量[:：]\s*(\d+)\s*\|\s*色[:：]\s*(#[0-9a-fA-F]{3,6})/.exec(t);
        if (!m) m = /石[:：]\s*([^|]+?)\s*\|\s*数量[:：]\s*(\d+)/.exec(t);
        if (m && !/石序/.test(t)) stones.push({ name: m[1].trim(), count: Number(m[2]), color: m[3] || "" });
      });
      let seq = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        const m = /石序[:：]\s*(.+)$/.exec(t);
        if (m) {
          seq = m[1].split(/[,，、\s]+/).map(function (x) { return x.replace(/[0-9]+$/, "").trim(); }).filter(Boolean);
          break;
        }
      }
      if (!stones.length) {
        if (seq.length) {
          const tally = {};
          seq.forEach(function (n) { tally[n] = (tally[n] || 0) + 1; });
          stones = Object.keys(tally).map(function (n) { return { name: n, count: tally[n], color: "" }; });
        } else {
          stones = [{ name: "天然水晶", count: count, color: String(d.color || "#e3c47c") }];
        }
      }
      // 串序校正：不足则按配比补齐，超出则截断，保证正好 count 颗
      if (!seq.length) {
        stones.forEach(function (st) { for (let k = 0; k < st.count; k++) seq.push(st.name); });
      }
      if (seq.length > count) seq = seq.slice(0, count);
      while (seq.length < count && stones.length) seq.push(stones[seq.length % stones.length].name);

      // ---- 诗曰（优先按“诗曰”标记；失败取末尾四行短句兜底） ----
      let poem = "";
      let poemAt = rawTxt.search(/诗\s*[曰：:]/);
      if (poemAt > -1) {
        const poemRaw = rawTxt.slice(poemAt).replace(/^[^\n]*诗\s*[曰：:]?[：:]?\s*/, "");
        const pl = poemRaw.split(NL)
          .map(function (t) { return t.replace(/^\s*(?:\d+[.)、]\s*)/, "").trim(); })
          .filter(function (t) { return t && !/^[\s：:，,。.、；;！!？?‘’“”'"「」『』\-—·]+$/.test(t); })
          .slice(0, 4);
        if (pl.length >= 2) poem = pl.join(NL);
      }
      if (!poem) {
        const cand = lines
          .filter(function (ln) {
            const t = ln.replace(/^\s*(?:\d+[.)、]\s*)/, "").trim();
            return t && !/石[:：]|石序|数量[:：]|色[:：]|设计理念/.test(t);
          })
          .map(function (ln) { return ln.replace(/^\s*(?:\d+[.)、]\s*)/, "").trim(); });
        const tail4 = cand.slice(-4);
        if (tail4.length === 4 && tail4.every(function (t) { return t.length >= 5 && t.length <= 12; })) {
          poem = tail4.join(NL);
          poemAt = rawTxt.lastIndexOf(tail4[0]);
        }
      }

      // ---- 设计理念：配比之后、诗曰之前 ----
      let analysis = "";
      const di = rawTxt.lastIndexOf("设计理念");
      const si = rawTxt.lastIndexOf("串为");
      let from = -1;
      if (di > -1) from = di; else if (si > -1) from = si;
      const endAt = (poem && from > -1 && poemAt > from) ? poemAt : -1;
      if (from > -1) {
        analysis = rawTxt.slice(from, endAt > -1 ? endAt : rawTxt.length).replace(/^设计理念[:：]?\s*/, "").trim();
      }
      analysis = analysis.split(NL).filter(function (ln) {
        return !/石[:：]|石序|数量[:：]|色[:：]/.test(ln);
      }).join(NL).trim();
      if (!analysis) {
        analysis = lines.filter(function (ln) {
          return !/石[:：]|石序|数量[:：]|色[:：]|诗[曰：:]/.test(ln) && ln.trim();
        }).join(NL).trim();
      }
      if (!analysis) analysis = "白桦定制：依五行与季节意象取平衡搭配（详见最终设计）";

      // ---- 通义（硅基流动 Z-Image）严格按串序出图 ----
      const imgCfg2 = await getDbAiImg(SB_URL, SK) || {};
      const imgKey2 = dbAi2.img_key || imgCfg2.key || Deno.env.get("SILICON_KEY") || "";
      const imgBase2 = dbAi2.img_base || imgCfg2.base || "https://api.siliconflow.cn/v1";
      const imgModel2 = dbAi2.img_model || imgCfg2.model || "Tongyi-MAI/Z-Image-Turbo";
      let url = "";
      let imgError = "";
      if (!imgKey2) {
        /* 出图失败不再静默：以前前端只看到「没有图」，无从判断是密钥、额度还是网络 */
        imgError = "出图密钥未配置：请在后台「AI 智能设计」填写出图 Key（img_key），或设置 Supabase Secret SILICON_KEY";
      } else {
        const colorOf = {};
        stones.forEach(function (st) { if (st.color) colorOf[st.name] = st.color; });
        const seqDesc = seq.map(function (n) { return n + (colorOf[n] ? "(" + colorOf[n] + ")" : ""); }).join(" -> ");
        const promptTxt2 = "High-end luxury jewelry brand editorial product photograph of a real polished crystal bead bracelet with EXACTLY " + count + " round beads, every bead EXACTLY " + mm + "mm in diameter, all beads the same size, forming one neat closed ring. Beads arranged strictly in this clockwise order from the top: " + seqDesc + ". Photoreal AA-grade natural crystals with inner texture and soft sparkle (not illustration), elegant high-end jewelry campaign lighting, deep navy-to-black gradient studio background with soft golden rim light, crisp macro focus, no text, no watermark, 4k.";
        const gen2 = await siliconGenerate(imgKey2, imgBase2, imgModel2, promptTxt2);
        if (gen2.error) {
          imgError = gen2.error;
        } else if (gen2.b64) {
          url = await uploadImage(SB_URL, SK, gen2.b64);
          if (!url) {
            url = "data:image/png;base64," + gen2.b64;
            imgError = "Storage 上传未成功（assets 桶或权限问题），本次使用内嵌图片，刷新后可能不再显示";
          }
        } else if (gen2.url) {
          url = await fetchAndStore(SB_URL, SK, gen2.url);
          if (!url) {
            url = gen2.url;
            imgError = "图片转存未成功，当前为 24 小时有效的临时地址，请检查 assets 存储桶";
          }
        } else {
          imgError = "出图服务未返回图片";
        }
      }
      await recordUsage(SB_URL, SK, 'design', (info.zod || info.sun || info.name || "design"));
      // 返回：分析=设计理念，poem=诗曰；配比/串序(stones/seq)仅供后台与出图用
      return Response.json({ ok: true, analysis: analysis, poem: poem, stones: stones, seq: seq, url: url, img_error: imgError, mm: mm, count: count }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (mode === "product_img") {
      const d = body.design || {};
      const bz = body.bazi || null;
      const hx = body.hex || null;
      // 1) DeepSeek 结构化分析（八字/卦）：给出五行喜用、主配石、多色配色与设计理念（无星号）
      const dbAi = await getDbAi(SB_URL, SK) || {};
      const dk = Deno.env.get("AI_API_KEY") || dbAi.key || "";
      const dmodel = Deno.env.get("AI_MODEL") || dbAi.model || "deepseek-chat";
      if (!dk) return Response.json({ ok: false, error: "后台 AI 密钥未配置（settings.ai）" }, { headers: corsHeaders });
      let analysis = "";
      let extraHexes = [];
      if (bz || hx) {
        const ctx = bz ? ("生辰：" + bz.year + "年" + bz.month + "月" + bz.day + "日" + (bz.hour || "?") + "时，生肖" + (bz.zod || "") + "，本命" + (bz.el || "") + (bz.gua ? "，另取卦" + bz.gua : "")) : ("卦：" + hx.name + "（" + hx.sym + "），" + (hx.idea || "") + "，五行属" + (hx.wu || "")) + "；成串规格：整串统一 " + (d.mm || 10) + "mm，共 " + (d.mm >= 10 ? 18 : 22) + " 颗同径圆珠";
        const sysP = ['你是白桦的设计师与文案：根据给定的生辰八字或卦象，为一串定制水晶手串写一段有东方韵味的完整分析文案。整串珠径已定（见信息），所有珠子同径同颗数，只需决定配色与石种（可3-5种颜色与晶石，不必只有两种）。不要用任何 * 星号、不用 markdown 标记。请按以下段落输出：', '第一段：以命局/卦意开篇（如：串为XX日主、XX月XX之命，量身定制……），结合季节调候、五行生克谈喜忌走向（字数约90-130字）。', '第二段：逐石点题：按上述走向挑选 3-5 种晶石与颜色，每种一两句诗意理由（如：取XX之XX色，润秋燥而不寒……），并交代整串是统一 8mm 或 10mm 的 22/18 颗同径珠。', '第三段：缀饰与整体意象（垫片/工艺/整体色感，2-3句，如：全串清而不冽，暖而不燥……）。', '最后：以四句诗收尾（每行一句诗，共四句）。', '整体约250-380字，优美克制，勿出现任何平台名。', '信息：' + ctx].join('');
        try {
          const pa = await fetchT("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dk }, body: JSON.stringify({ model: dmodel, messages: [{ role: "system", content: sysP }], temperature: 0.7, max_tokens: 700 }) }, 90000).then(r=>r.json()).catch(()=>null);
          if (pa && pa.choices && pa.choices[0]) analysis = String((pa.choices[0].message && (pa.choices[0].message.content || pa.choices[0].message.reasoning_content)) || "").split("*").join("").trim();
          const hm = String(analysis).match(/#[0-9a-fA-F]{6}/g);
          if (hm) extraHexes = hm.slice(0, 4);
        } catch (e) {}

      }
      if (!analysis) {
        analysis = "五行意象｜主石 " + (d.stone || "天然水晶") + (d.aux ? "，配石 " + d.aux : "") + "；设计理念｜依本命五行与卦意取阴阳平和、五行相生之石，整串" + (d.mm || 10) + "mm 同径" + (d.count || 18) + "颗，作日常陪伴的一枚光。";
      }
      if (!extraHexes.length) { if (d.color) extraHexes.push(String(d.color)); if (d.accent) extraHexes.push(String(d.accent)); }
            const designLine = [
        "品名：" + String(d.name || '白桦手串'),
        "主石材质意向：" + String(d.stone || '天然水晶') + (d.aux ? "；配石点缀：" + String(d.aux) : ""),
        "双色：" + String(d.color || '#e3c47c') + " 与 " + String(d.accent || '同色') + " 等径交替成串" + (extraHexes.length ? "；分析配色：" + extraHexes.join(",") : ""),
        "珠径：" + (d.mm || 10) + "mm，颗数：" + (d.count || 18),
        "主色：" + String(d.color || '#e3c47c'),
        "符号/刻印：" + String(d.glyph || ''),
        "光语：" + String(d.quote || '')
      ].join("\n");
      const styleSys = "You write concise English e-commerce product-photo prompts for real crystal bead bracelets. Output ONLY the prompt, no preamble.";
      const styleUser = "Design:\n" + designLine + "\n\nWrite one refined English prompt (under 150 words) for a high-end luxury jewelry brand editorial product photograph of the bracelet: real polished translucent crystal beads in the exact multi-tone palette specified by the design (main tone dominant, 1-3 accent tones strictly per the listed hex colors), beautiful natural inner texture and soft sparkle (photoreal, absolutely not illustration), beads arranged in an elegant neat ring, on a deep navy-to-black gradient studio background with soft umbrella lighting and a subtle warm golden accent, crisp macro focus, premium minimal composition like a flagship jewelry e-commerce hero image, no text, no watermark, no props, 4k.";
      const pr1 = await fetchT("https://api.deepseek.com/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dk },
        body: JSON.stringify({ model: dmodel, messages: [{ role: "system", content: styleSys }, { role: "user", content: styleUser }], temperature: 0.7, max_tokens: 400 })
      }, 90000).then(r => r.json()).catch(() => null);
      if (!pr1 || !pr1.choices || !pr1.choices[0]) return Response.json({ ok: false, error: "DeepSeek 提示词生成失败" }, { headers: corsHeaders });
      const promptTxt = String((pr1.choices[0].message && (pr1.choices[0].message.content || pr1.choices[0].message.reasoning_content)) || "").trim();
      const imgCfg = await getDbAiImg(SB_URL, SK) || {};
      const imgKey = dbAi.img_key || imgCfg.key || Deno.env.get("SILICON_KEY") || "";
      const imgBase = dbAi.img_base || imgCfg.base || "https://api.siliconflow.cn/v1";
      const imgModel = dbAi.img_model || imgCfg.model || "Tongyi-MAI/Z-Image-Turbo";
      if (!imgKey) return Response.json({ ok: false, error: "出图密钥未配置：请到后台「AI 智能设计」填 img_key，或设置 Supabase Secret SILICON_KEY" }, { headers: corsHeaders });
      const gen = await siliconGenerate(imgKey, imgBase, imgModel, promptTxt);
      if (gen.error) {
        return Response.json({ ok: false, error: "出图失败：" + gen.error }, { headers: corsHeaders });
      }
      // 优先永久存储 → 临时地址 → b64 回退
      let url = await uploadImage(SB_URL, SK, gen.b64);
      if (!url && gen.url) url = await fetchAndStore(SB_URL, SK, gen.url);
      const remoteUrl = url ? "" : (gen.url || "");
      await recordUsage(SB_URL, SK, 'product_img', String(d.name || ''));
      return Response.json({ ok: true, url: url || remoteUrl, b64: (url || remoteUrl) ? "" : gen.b64, analysis: analysis, colors: extraHexes }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const question = String(body.question || "").trim();
    if (!question) return Response.json({ ok: false, error: "缺少问题内容" }, { headers: corsHeaders });
    const history = Array.isArray(body.history) ? body.history : [];
    const answer = await deepseekChat(apiKey, model, [
      { role: "system", content: SYSTEM },
      ...history.slice(-8),
      { role: "user", content: question },
    ]);
    await recordUsage(SB_URL, SK, 'chat', question);
    return Response.json({ ok: true, answer }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
