// netlify/functions/ai.js
// Proxy seguro para a Anthropic API — a key NUNCA chega ao browser.
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

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada nas variáveis de ambiente do Netlify." }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 1000, 1), 4000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      body.model || "claude-sonnet-4-5",
        max_tokens: maxTokens,
        system:     body.system,
        messages:   body.messages,
      }),
    });

    const data = await response.json();
    return { statusCode: response.ok ? 200 : response.status, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
