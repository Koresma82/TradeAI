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

// Verifica o ID token do Firebase. Devolve { ok, uid } ou { ok:false, error }.
// Os Firebase ID tokens são JWTs assinados pela Google. Validamos a assinatura
// contra as chaves públicas do Firebase (x509) e confimamos os claims (iss/aud/exp).
const crypto = require("crypto");

let _keysCache = { keys: null, exp: 0 };

async function getGooglePublicKeys() {
  // Cache das chaves públicas (a Google indica validade no Cache-Control).
  if (_keysCache.keys && Date.now() < _keysCache.exp) return _keysCache.keys;
  const r = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  if (!r.ok) throw new Error("Não foi possível obter as chaves públicas da Google");
  const keys = await r.json();
  // Validade: 1h por defeito (suficiente; as chaves rodam devagar)
  _keysCache = { keys, exp: Date.now() + 60 * 60 * 1000 };
  return keys;
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function verifyFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, error: "Sem token de autenticação." };
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return { ok: false, error: "Token vazio." };

  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return { ok: false, error: "Token malformado." };

    const header  = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    const payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));

    // 1. Validar claims
    const audOk = payload.aud === PROJECT_ID;
    const issOk = payload.iss === `https://securetoken.google.com/${PROJECT_ID}`;
    const notExpired = payload.exp && (Number(payload.exp) * 1000 > Date.now());
    if (!audOk || !issOk) return { ok: false, error: "Token não pertence a esta app." };
    if (!notExpired)      return { ok: false, error: "Token expirado." };

    // 2. Validar assinatura contra a chave pública correspondente ao 'kid'
    const keys = await getGooglePublicKeys();
    const cert = keys[header.kid];
    if (!cert) return { ok: false, error: "Chave de assinatura não encontrada." };

    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    const sigOk = verifier.verify(cert, b64urlDecode(parts[2]));
    if (!sigOk) return { ok: false, error: "Assinatura do token inválida." };

    return { ok: true, uid: payload.sub || payload.user_id };
  } catch (e) {
    return { ok: false, error: "Falha a verificar token: " + e.message };
  }
}

module.exports = { verifyFirebaseToken, corsHeaders };
