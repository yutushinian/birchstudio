const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, name: "birch-probe" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return Response.json({ ok: true, echo: "probe" }, { headers: corsHeaders });
});
