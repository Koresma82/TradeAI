// netlify/functions/ai.js
// Proxy seguro para a Anthropic API — a key NUNCA chega ao browser

exports.handler = async (event) => {
  // Só aceita POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada nas variáveis de ambiente do Netlify." }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            ANTHROPIC_API_KEY,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      body.model      || "claude-sonnet-4-20250514",
        max_tokens: body.max_tokens || 1000,
        system:     body.system,
        messages:   body.messages,
      }),
    });

    const data = await response.json();

    return {
      statusCode: response.ok ? 200 : response.status,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
