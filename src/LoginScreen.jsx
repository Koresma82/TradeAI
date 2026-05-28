// src/LoginScreen.jsx
import { useState } from "react";
import { loginWithGoogle } from "./firebase.js";

const T = {
  bg:     "#06061a",
  accent: "#6366f1",
  aLight: "#a5b4fc",
  green:  "#10b981",
  text:   "#e2e8f0",
  muted:  "#6b7280",
  border: "rgba(255,255,255,0.08)",
};

export default function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const ALLOWED_EMAIL = "Koresma@gmail.com";

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loginWithGoogle();
      const email  = result.user?.email || "";
      if (email.toLowerCase() !== ALLOWED_EMAIL.toLowerCase()) {
        await result.user.delete(); // remove conta não autorizada
        setError("Acesso restrito. Esta app é privada.");
      }
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user") {
        setError("Erro ao iniciar sessão. Tenta novamente.");
      }
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh", background: T.bg, display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      backgroundImage:
        "radial-gradient(circle at 20% 20%, rgba(99,102,241,0.12) 0%, transparent 50%), " +
        "radial-gradient(circle at 80% 80%, rgba(16,185,129,0.08) 0%, transparent 50%)",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:none} }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      <div style={{
        width: 420, animation: "fadeUp 0.4s ease",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
      }}>
        {/* Logo */}
        <div style={{
          width: 64, height: 64, borderRadius: 18,
          background: "linear-gradient(135deg,#6366f1,#10b981)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 28, fontWeight: 700, marginBottom: 24,
          boxShadow: "0 0 40px rgba(99,102,241,0.3)",
        }}>◆</div>

        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", color: T.text, marginBottom: 6, textAlign: "center" }}>
          TradeAI Simulator
        </div>
        <div style={{ fontSize: 14, color: T.muted, marginBottom: 40, textAlign: "center", lineHeight: 1.65 }}>
          Bot de trading com IA · Simulação antes de investir dinheiro real
        </div>

        {/* Card */}
        <div style={{
          width: "100%", background: "rgba(255,255,255,0.045)",
          border: `1px solid ${T.border}`, borderRadius: 20,
          backdropFilter: "blur(16px)", padding: "36px 32px",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 6 }}>Entrar na tua conta</div>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 28, lineHeight: 1.65 }}>
            As tuas estratégias, trades e resultados ficam guardados em segurança na tua conta Google.
          </div>

          {/* Google button */}
          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
              background: loading ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.09)",
              border: `1px solid ${loading ? T.border : "rgba(255,255,255,0.18)"}`,
              borderRadius: 12, padding: "14px 20px",
              color: loading ? T.muted : T.text, fontSize: 14, fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit", transition: "all 0.15s",
            }}
          >
            {loading ? (
              <span style={{ animation: "pulse 1.2s infinite" }}>◌  A entrar…</span>
            ) : (
              <>
                {/* Google G icon */}
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
                </svg>
                Continuar com Google
              </>
            )}
          </button>

          {error && (
            <div style={{
              marginTop: 16, padding: "10px 14px", borderRadius: 8,
              background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.3)",
              fontSize: 12, color: "#f87171", textAlign: "center",
            }}>{error}</div>
          )}

          <div style={{ marginTop: 22, padding: "14px 16px", background: "rgba(0,0,0,0.2)", borderRadius: 10 }}>
            <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>O que inclui</div>
            {[
              "◎  Simulação com capital fictício à tua escolha",
              "◆  IA analisa mercados e sugere onde investir",
              "📈  Preços reais (Yahoo Finance + CoinGecko)",
              "🔒  Dados guardados na tua conta, privados",
            ].map(f => (
              <div key={f} style={{ fontSize: 12, color: T.muted, padding: "4px 0", lineHeight: 1.6 }}>{f}</div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 20, fontSize: 11, color: T.muted, textAlign: "center", lineHeight: 1.7 }}>
          Ao entrar, aceitas que os dados sejam guardados no Firebase.<br />
          Nenhuma informação financeira real é partilhada.
        </div>
      </div>
    </div>
  );
}
