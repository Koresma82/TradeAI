// netlify/functions/groq.js
// Proxy para Groq API — ultra-rápido e barato para day trading scans

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return {
    statusCode: 500,
    body: JSON.stringify({ error: "GROQ_API_KEY não configurada nas variáveis de ambiente do Netlify." }),
  };

  try {
    const body = JSON.parse(event.body || "{}");
    const r    = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:       body.model       || "llama-3.3-70b-versatile", // melhor modelo Groq para análise financeira
        max_tokens:  body.max_tokens  || 1500,
        temperature: body.temperature || 0.3,  // mais determinístico para trading
        messages:    body.messages,
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Groq error ${r.status}`);

    // Normalizar resposta para o mesmo formato que Claude
    const text = data.choices?.[0]?.message?.content || "{}";
    // Estimar custo: Groq ~$0.00059/1K tokens input, ~$0.00079/1K output (llama-3.3-70b)
    const inTok  = data.usage?.prompt_tokens     || 300;
    const outTok = data.usage?.completion_tokens || 500;
    const cost   = +((inTok * 0.00059 + outTok * 0.00079) / 1000).toFixed(6);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        content: [{ type: "text", text }],
        usage:   { input_tokens: inTok, output_tokens: outTok },
        _cost:   cost,
        _model:  "groq/llama-3.3-70b",
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
