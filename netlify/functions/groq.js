// netlify/functions/groq.js
// Proxy para Groq API — rápido e barato para day trading scans.
// Exige um Firebase ID token válido (utilizador autenticado na app).

const { verifyFirebaseToken, corsHeaders } = require("./_auth.js");

exports.handler = async (event) => {
  const origin  = event.headers?.origin || event.headers?.Origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  // Exigir utilizador autenticado
  const auth = await verifyFirebaseToken(
    event.headers?.authorization || event.headers?.Authorization
  );
  if (!auth.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: auth.error }) };

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "GROQ_API_KEY não configurada nas variáveis de ambiente do Netlify." }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 1500, 1), 4000);
    const temp = Math.min(Math.max(Number(body.temperature) ?? 0.3, 0), 1);

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:       body.model || "llama-3.1-8b-instant",
        max_tokens:  maxTokens,
        temperature: temp,
        messages:    body.messages,
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Groq error ${r.status}`);

    const text   = data.choices?.[0]?.message?.content || "{}";
    const inTok  = data.usage?.prompt_tokens     || 300;
    const outTok = data.usage?.completion_tokens || 500;
    const totTok = data.usage?.total_tokens       || (inTok + outTok);
    const cost   = +((inTok * 0.00059 + outTok * 0.00079) / 1000).toFixed(6);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        content: [{ type: "text", text }],
        usage:   { input_tokens: inTok, output_tokens: outTok, total_tokens: totTok },
        _cost:   cost,
        _model:  data.model || "groq",
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
