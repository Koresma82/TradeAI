// netlify/functions/_auth.js
// Verificação leve do Firebase ID token + CORS restrito.
// Evita que terceiros usem os endpoints (e gastem a tua API key) sem estarem
// autenticados na tua app. Não adiciona dependências: valida o token contra o
// endpoint público da Google.

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "tradeaisimulator-aebcd";

// Origens permitidas. Define ALLOWED_ORIGIN no Netlify (ex: https://oteusite.netlify.app).
// Em dev aceita localhost.
function allowedOrigins() {
  const envOrigin = process.env.ALLOWED_ORIGIN;
  const base = [
    "http://localhost:5173",
    "http://localhost:8888",
    "http://127.0.0.1:5173",
  ];
  if (envOrigin) base.push(...envOrigin.split(",").map(s => s.trim()).filter(Boolean));
  return base;
}

function corsHeaders(origin) {
  const list = allowedOrigins();
  // Se não houver ALLOWED_ORIGIN configurado, cai para "*" (mas o token continua a ser exigido).
  const allowAll = !process.env.ALLOWED_ORIGIN;
  const allow = allowAll ? "*" : (list.includes(origin) ? origin : list[list.length - 1]);
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// Verifica o ID token do Firebase contra a Google. Devolve { ok, uid } ou { ok:false, error }.
async function verifyFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, error: "Sem token de autenticação." };
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return { ok: false, error: "Token vazio." };

  try {
    // Endpoint público de verificação de tokens da Google.
    const r = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    if (!r.ok) return { ok: false, error: "Token inválido ou expirado." };
    const info = await r.json();

    // O token tem de ter sido emitido para ESTE projeto Firebase.
    const audOk = info.aud === PROJECT_ID;
    const issOk = info.iss === `https://securetoken.google.com/${PROJECT_ID}`;
    const notExpired = !info.exp || (Number(info.exp) * 1000 > Date.now());

    if (!audOk || !issOk || !notExpired) {
      return { ok: false, error: "Token não pertence a esta app." };
    }
    return { ok: true, uid: info.sub || info.user_id };
  } catch (e) {
    return { ok: false, error: "Falha a verificar token: " + e.message };
  }
}

module.exports = { verifyFirebaseToken, corsHeaders };
