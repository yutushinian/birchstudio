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

async function fetchCrystals(SB_URL, SK) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/crystals?select=name,kind,element,meaning&visible=eq.true&order=sort.asc&limit=100", {
      headers: { apikey: SK, Authorization: "Bearer " + SK },
    });
    return r.ok ? await r.json() : [];
  } catch (_) { return []; }
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
      // 五模式统一：输入汇总 → DeepSeek v4-flash 文学分析（含逐石配比+配色+诗）→ 通义按配比生图
      const d = body.design || {};
      const mm = Number(d.mm) || 10;
      const count = mm >= 10 ? 18 : 22;
      const kind = body.kind || "bazi";
      const info = body.info || "";
      let userInfo = "";
      if (kind === "bazi") userInfo = "生辰：出生" + (info.year || "?") + "年" + (info.month || "?") + "月" + (info.day || "?") + "日" + (info.hour || "?") + "时，生肖" + (info.zod || "?") + "，本命五行" + (info.el || "?") + (info.gua ? "，另取卦「" + info.gua + "」" : "");
      else if (kind === "hex") userInfo = "摇卦得「" + (info.name || "") + "（" + (info.sym || "") + "）」，" + (info.idea || "") + "，五行属" + (info.wu || "");
      else if (kind === "zod") userInfo = "本命生肖：" + (info.zod || "") + "，五行" + (info.el || "");
      else if (kind === "star") userInfo = "太阳星座：" + (info.sun || "") + (info.moon ? "，月亮：" + info.moon : "") + (info.rising ? "，上升：" + info.rising : "");
      else if (kind === "union") userInfo = "合盘：我的星座 " + (info.a || "") + "，对方星座 " + (info.b || "") + (info.note ? "；备注：" + info.note : "");
      else if (kind === "free") userInfo = "用户选择「随缘搭配」，无生辰信息：" + (info.note ? "（" + info.note + "）" : "请自由发挥，给出 3-5 种晶石的整套搭配设计与意象。");
      const beadLine = "成串规格：整串统一 " + mm + "mm 同径圆珠，共 " + count + " 颗（用户已选定，勿改）";
      const dbAi2 = await getDbAi(SB_URL, SK) || {};
      const dk2 = Deno.env.get("AI_API_KEY") || dbAi2.key || "";
      const dmodel2 = Deno.env.get("AI_MODEL") || dbAi2.model || "deepseek-chat";
      if (!dk2) return Response.json({ ok: false, error: "后台 AI 密钥未配置（settings.ai）" }, { headers: corsHeaders });
      const sysP2 = [
        "你是白桦的设计师与文案：根据用户信息，为一串水晶手串做完整定制方案（同径整串，" + beadLine + "）。",
        "不要使用任何 * 星号与 markdown 标记。",
        "请严格按以下格式输出（每行一个条目），只输出最终答案本身，不要思考过程、不要解释、不要复述用户信息：",
        "1) 逐石配比：每行「石:海蓝宝|数量:1|色:#7FB5C9」列出 3-5 种晶石与其颗数与代表色（颗数之和须等于 " + count + "，体现主次搭配与调候/五行的平衡）；",
        "2) 设计理念：以「串为……量身定制」开篇，谈季节调候与五行喜忌，逐石点题（与上面石料一致），缀饰与整体意象，共约150-220字；",
        "3) 诗曰：四句七言收尾。",
        "用户信息：" + userInfo
      ].join(String.fromCharCode(10));
      const pa2 = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dk2 },
        body: JSON.stringify({ model: dmodel2, messages: [{ role: "system", content: sysP2 }], temperature: 0.7, max_tokens: 3200, thinking: { type: "disabled" } })
      }).then(r => r.json()).catch(() => null);
      const rawTxt = pa2 && pa2.choices && pa2.choices[0] && pa2.choices[0].message
        ? String((pa2.choices[0].message.content || pa2.choices[0].message.reasoning_content) || "").split("*").join("").trim()
        : "";
      // 取“最终成文”：优先最后一个『设计理念』段；否则取最后石行之后
      var analysis = rawTxt;
      var stones = [];
      {
        var NLf2 = String.fromCharCode(10);
        var from = -1;
        var di = String(rawTxt).lastIndexOf(NLf2 + '设计理念');
        var si2 = String(rawTxt).lastIndexOf(NLf2 + '串为');
        var pi = String(rawTxt).lastIndexOf(NLf2 + '诗曰');
        if (di > -1) from = di;
        else if (si2 > -1) from = si2;
        else if (pi > -1) { var t0 = String(rawTxt).indexOf(NLf2 + '石:'); if (t0 > -1) from = t0; }
        if (from > -1) analysis = String(rawTxt).slice(from + 1).replace(/^\s*/, '');
      }
      const lines = String(rawTxt).split(String.fromCharCode(10))
      lines.forEach(function (ln) {
        ln = ln.trim();
        let m = /石[:：]\s*([^|]+?)\s*\|\s*数量[:：]\s*(\d+)\s*\|\s*色[:：]\s*(#[0-9a-fA-F]{3,6})/.exec(ln);
        if (!m) m = /([\u4e00-\u9fa5]{2,6})(?:珠|石)?\s*[×x*]\s*(\d+)/.exec(ln);
        if (!m) m = /([\u4e00-\u9fa5]{2,6})\s*(\d+)\s*颗/.exec(ln);
        if (m) stones.push({ name: m[1].trim(), count: Number(m[2]), color: m[3] });
      });
      if (!analysis) analysis = "白桦定制：依五行与季节意象取平衡搭配（详见最终设计）";
      if (!stones.length) stones = [{ name: "天然水晶", count: count, color: String(d.color || "#e3c47c") }];
      // 通义（硅基流动 Z-Image）按逐石配比生图
      const imgKey2 = dbAi2.img_key || Deno.env.get("SILICON_KEY") || "";
      const imgBase2 = dbAi2.img_base || "https://api.siliconflow.cn/v1";
      const imgModel2 = dbAi2.img_model || "Tongyi-MAI/Z-Image-Turbo";
      let url = "";
      if (imgKey2) {
        const orderDesc = stones.map(function (s) { return s.name + " x" + s.count + " (" + s.color + ")"; }).join(", ");
        const promptTxt2 = "High-end luxury jewelry brand editorial product photograph of a " + mm + "mm " + count + "-bead real polished crystal bracelet, beads in sequence per design: " + orderDesc + ", photoreal AA-grade crystals with natural inner texture and soft sparkle, elegant neat ring on deep navy-to-black gradient studio background, soft golden rim light, crisp macro focus, against a premium deep space backdrop in the house style: deep navy-to-black gradient with a soft golden vignette and faint stardust glow around the beads, elegant high-end jewelry campaign lighting, crisp macro focus, refined luxury mood, no text, no watermark, 4k.";
        const ir2 = await fetch(imgBase2.replace(/\/$/, "") + "/images/generations", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + imgKey2 },
          body: JSON.stringify({ model: imgModel2, prompt: promptTxt2, image_size: "1024x1024", num_images: 1 })
        });
        const ij2 = await ir2.json().catch(() => null);
        if (ir2.ok && ij2 && ij2.data && ij2.data[0]) {
          const b64b = ij2.data[0].b64_json || "";
          if (b64b) {
            const ts = Date.now();
            const path = "gen/" + ts + "-" + Math.floor(Math.random() * 1e6) + ".png";
            try {
              const bytes = Uint8Array.from(atob(b64b), function (c) { return c.charCodeAt(0); });
              const up = await fetch(SB_URL + "/storage/v1/object/assets/" + path, {
                method: "POST", headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "image/png" }, body: bytes
              });
              if (up.ok) url = SB_URL + "/storage/v1/object/public/assets/" + path;
            } catch (e) {}
            if (!url) url = "data:image/png;base64," + b64b;
          } else if (ij2.data[0].url) url = ij2.data[0].url;
        }
      }
      await recordUsage(SB_URL, SK, 'design', (info.zod || info.sun || info.name || "design"));
      return Response.json({ ok: true, analysis: analysis, stones: stones, url: url, mm: mm, count: count }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
          const pa = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dk }, body: JSON.stringify({ model: dmodel, messages: [{ role: "system", content: sysP }], temperature: 0.7, max_tokens: 700 }) }).then(r=>r.json()).catch(()=>null);
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
      const pr1 = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dk },
        body: JSON.stringify({ model: dmodel, messages: [{ role: "system", content: styleSys }, { role: "user", content: styleUser }], temperature: 0.7, max_tokens: 400 })
      }).then(r => r.json()).catch(() => null);
      if (!pr1 || !pr1.choices || !pr1.choices[0]) return Response.json({ ok: false, error: "DeepSeek 提示词生成失败" }, { headers: corsHeaders });
      const promptTxt = String((pr1.choices[0].message && (pr1.choices[0].message.content || pr1.choices[0].message.reasoning_content)) || "").trim();
      const imgKey = dbAi.img_key || Deno.env.get("SILICON_KEY") || "";
      const imgBase = dbAi.img_base || "https://api.siliconflow.cn/v1";
      const imgModel = dbAi.img_model || "black-forest-labs/FLUX.1-dev";
      if (!imgKey) return Response.json({ ok: false, error: "硅基流动出图密钥未配置：请到后台 AI 设计填 img_key" }, { headers: corsHeaders });
      const ir = await fetch(imgBase.replace(/\/$/, "") + "/images/generations", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + imgKey },
        body: JSON.stringify({ model: imgModel, prompt: promptTxt, image_size: "1024x1024", num_images: 1 })
      });
      const ij = await ir.json().catch(() => null);
      if (!ir.ok || !ij || !ij.data || !ij.data[0]) {
        return Response.json({ ok: false, error: "出图失败：" + String((ij && (ij.message || (ij.error && (ij.error.message || JSON.stringify(ij.error))))) || ir.status) }, { headers: corsHeaders });
      }
      const b64 = ij.data[0].b64_json || "";
      const remoteUrl = ij.data[0].url || "";
      if (!b64 && remoteUrl) return Response.json({ ok: true, url: remoteUrl, b64: "" }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      let url = "";
      if (b64) {
        const ts = Date.now();
        const path = "gen/" + ts + "-" + Math.floor(Math.random() * 1e6) + ".png";
        try {
          try { await fetch(SB_URL + "/storage/v1/bucket/assets", { method: "GET", headers: { apikey: SK, Authorization: "Bearer " + SK } }); }
          catch (e) {}
          const chk = await fetch(SB_URL + "/storage/v1/bucket/assets", { headers: { apikey: SK, Authorization: "Bearer " + SK } });
          if (chk.status === 404 || chk.status === 400) {
            await fetch(SB_URL + "/storage/v1/bucket", { method: "POST", headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" }, body: JSON.stringify({ id: "assets", name: "assets", public: true }) }).catch(() => {});
          }
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const up = await fetch(SB_URL + "/storage/v1/object/assets/" + path, {
            method: "POST", headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "image/png" }, body: bytes
          });
          if (up.ok) url = SB_URL + "/storage/v1/object/public/assets/" + path;
        } catch (e) { /* 回退 b64 */ }
      }
      await recordUsage(SB_URL, SK, 'product_img', String(d.name || ''));
      return Response.json({ ok: true, url: url, b64: url ? "" : b64, analysis: analysis, colors: extraHexes }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

// deploy-trigger 1788877044

// deploy-trigger-2 1788877775

// reconnect-trigger 1788886875
