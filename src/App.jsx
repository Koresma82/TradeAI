import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "./AuthContext.jsx";
import { logout, getIdToken } from "./firebase.js";
import LoginScreen from "./LoginScreen.jsx";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── AI HELPER ───────────────────────────────────────────────────────────────
// Chama a Netlify Function proxy — a API key fica no servidor, nunca no browser
const AI_ENDPOINT = "/.netlify/functions/ai";

async function callAI({ messages, system, max_tokens = 1000 }) {
  const doCall = async (forceToken) => {
    const u = (await import("./firebase.js")).auth?.currentUser;
    const token = u ? await u.getIdToken(forceToken).catch(() => null) : await getIdToken();
    const res = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens, system, messages }),
    });
    return res;
  };
  let res = await doCall(false);
  // Se o token expirou (401), renova à força e tenta uma vez mais
  if (res.status === 401) {
    res = await doCall(true);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || data?.error || "Erro na API");
  const text = data.content?.[0]?.text || "{}";
  // Estimar custo: input ~€0.003/1K tokens, output ~€0.015/1K tokens (Sonnet)
  const inTok  = data.usage?.input_tokens  || 400;
  const outTok = data.usage?.output_tokens || max_tokens * 0.6;
  const cost   = +((inTok * 0.003 + outTok * 0.015) / 1000).toFixed(5);
  const result = JSON.parse(text.replace(/```json|```/g, "").trim());
  return { result, cost };
}

// ─── GROQ (Day Trading — rápido e barato) ────────────────────────────────────
async function callGroq({ messages, system, max_tokens = 1500, temperature = 0.3 }) {
  const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
  const token = await getIdToken();
  const res  = await fetch("/.netlify/functions/groq", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ max_tokens, temperature, messages: msgs }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || data?.error || "Erro Groq");
  const text  = data.content?.[0]?.text || "{}";
  const cost  = data._cost || 0;
  const tokens = data.usage?.total_tokens || 0;
  const result = JSON.parse(text.replace(/```json|```/g, "").trim());
  return { result, cost, tokens };
}

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const T = {
  bg:    "#07071c",
  base:  "#0d0d28",
  card:  "rgba(255,255,255,0.05)",
  cardHi:"rgba(255,255,255,0.08)",
  border:"rgba(255,255,255,0.09)",
  accent:"#7c7aff",
  aLight:"#b4bcff",
  green: "#10d98a",
  red:   "#fb5a78",
  gold:  "#fbbf24",
  blue:  "#3b82f6",
  cyan:  "#22d3ee",
  purple:"#a855f7",
  pink:  "#ec4899",
  text:  "#e8ecf8",
  muted: "#7a8195",
  // Gradientes para um visual mais vibrante e dinâmico
  gradAccent: "linear-gradient(135deg, #7c7aff 0%, #a855f7 100%)",
  gradGreen:  "linear-gradient(135deg, #10d98a 0%, #22d3ee 100%)",
  gradGold:   "linear-gradient(135deg, #fbbf24 0%, #fb923c 100%)",
  gradCard:   "linear-gradient(160deg, rgba(124,122,255,0.08) 0%, rgba(168,85,247,0.03) 100%)",
  glow:       "0 0 40px rgba(124,122,255,0.15)",
};

// ─── MARKET HOURS ────────────────────────────────────────────────────────────
const MARKET_HOURS = {
  btc:    { label:"24/7 — Sempre aberto",              always: true },
  eth:    { label:"24/7 — Sempre aberto",              always: true },
  wti:    { label:"NYSE: 14:30–21:00 UTC (seg–sex)",   openH:14.5, closeH:21, weekdays:true },
  gold:   { label:"COMEX: 14:30–21:00 UTC (seg–sex)",  openH:14.5, closeH:21, weekdays:true },
  silver: { label:"COMEX: 14:30–21:00 UTC (seg–sex)",  openH:14.5, closeH:21, weekdays:true },
  spy:    { label:"NYSE: 14:30–21:00 UTC (seg–sex)",   openH:14.5, closeH:21, weekdays:true },
  qqq:    { label:"NYSE: 14:30–21:00 UTC (seg–sex)",   openH:14.5, closeH:21, weekdays:true },
  eurusd: { label:"Forex: 00:00–21:00 UTC (seg–sex)",  openH:0,    closeH:21, weekdays:true },
};

// Horários por categoria (fallback quando o ativo não está em MARKET_HOURS).
// Crypto = sempre aberto; Forex = seg–sex; Commodity/ETF/ação = sessão US.
const CATEGORY_HOURS = {
  Crypto:    { always: true },
  Forex:     { openH: 0,    closeH: 21, weekdays: true },
  Commodity: { openH: 14.5, closeH: 21, weekdays: true },
  ETF:       { openH: 14.5, closeH: 21, weekdays: true },
  Ação:      { openH: 14.5, closeH: 21, weekdays: true },
};

function marketRule(id) {
  if (MARKET_HOURS[id]) return MARKET_HOURS[id];
  // Procura a categoria do ativo
  const a = (typeof ASSETS !== "undefined") ? ASSETS.find(x => x.id === id) : null;
  if (a && CATEGORY_HOURS[a.cat]) return CATEGORY_HOURS[a.cat];
  return null;
}

function isMarketOpen(id) {
  const h = marketRule(id);
  if (!h || h.always) return true;
  const now  = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const dow  = now.getUTCDay(); // 0=Dom, 6=Sáb
  if (h.weekdays && (dow === 0 || dow === 6)) return false;
  return utcH >= h.openH && utcH < h.closeH;
}

// ─── ASSETS ──────────────────────────────────────────────────────────────────
// Qual broker trata cada ativo (espelha o routing do bot). Usado para position
// sizing por saldo de broker. Crypto → alpaca (default); resto → alpaca.
const CRYPTO_ASSET_IDS = new Set(["btc","eth","bnb","sol","xrp","doge","ada","avax","dot","link"]);
function brokerForAsset(assetId) {
  // Default igual ao DEFAULT_ROUTING do bot: tudo na Alpaca. Se mudares o routing
  // no bot (ex.: crypto na Binance), ajusta aqui para a sugestão bater certo.
  return CRYPTO_ASSET_IDS.has(assetId) ? "alpaca" : "alpaca";
}

const ASSETS = [
  { id:"btc",    name:"Bitcoin",        sym:"BTC",     cat:"Crypto",    base:67420,  icon:"₿",  vol:0.0038, cg:"bitcoin",         trade:true  },
  { id:"eth",    name:"Ethereum",       sym:"ETH",     cat:"Crypto",    base:3580,   icon:"Ξ",  vol:0.0045, cg:"ethereum",        trade:true  },
  { id:"wti",    name:"Petróleo WTI",   sym:"WTI",     cat:"Commodity", base:78.42,  icon:"🛢", vol:0.0022, cg:null,              trade:true  },
  { id:"gold",   name:"Ouro",           sym:"XAU",     cat:"Commodity", base:2341,   icon:"🥇", vol:0.0009, cg:null,              trade:true  },
  { id:"silver", name:"Prata",          sym:"XAG",     cat:"Commodity", base:27.85,  icon:"🥈", vol:0.0026, cg:null,              trade:true  },
  { id:"spy",    name:"S&P 500 ETF",    sym:"SPY",     cat:"ETF",       base:524.3,  icon:"📈", vol:0.0011, cg:null,              trade:true  },
  { id:"qqq",    name:"Nasdaq ETF",     sym:"QQQ",     cat:"ETF",       base:448.6,  icon:"💻", vol:0.0014, cg:null,              trade:true  },
  { id:"eurusd", name:"EUR/USD",        sym:"EUR/USD", cat:"Forex",     base:1.0842, icon:"💶", vol:0.0003, cg:null,              trade:true  },
  // ── Crypto extra ──
  { id:"bnb",    name:"BNB",            sym:"BNB",     cat:"Crypto",    base:420,    icon:"🔶", vol:0.0040, cg:"binancecoin",     trade:false },
  { id:"sol",    name:"Solana",         sym:"SOL",     cat:"Crypto",    base:145,    icon:"◎",  vol:0.0055, cg:"solana",          trade:false },
  { id:"xrp",    name:"XRP",            sym:"XRP",     cat:"Crypto",    base:0.52,   icon:"✕",  vol:0.0048, cg:"ripple",          trade:false },
  { id:"ada",    name:"Cardano",        sym:"ADA",     cat:"Crypto",    base:0.45,   icon:"₳",  vol:0.0050, cg:"cardano",         trade:false },
  { id:"doge",   name:"Dogecoin",       sym:"DOGE",    cat:"Crypto",    base:0.12,   icon:"🐕", vol:0.0065, cg:"dogecoin",        trade:false },
  { id:"avax",   name:"Avalanche",      sym:"AVAX",    cat:"Crypto",    base:28,     icon:"🔺", vol:0.0058, cg:"avalanche-2",     trade:false },
  { id:"dot",    name:"Polkadot",       sym:"DOT",     cat:"Crypto",    base:6.8,    icon:"⬤",  vol:0.0052, cg:"polkadot",        trade:false },
  { id:"link",   name:"Chainlink",      sym:"LINK",    cat:"Crypto",    base:13.5,   icon:"⬡",  vol:0.0048, cg:"chainlink",       trade:false },
  // ── Commodities extra ──
  { id:"brent",  name:"Petróleo Brent", sym:"BRENT",   cat:"Commodity", base:82.15,  icon:"⛽", vol:0.0020, cg:null,              trade:false },
  { id:"natgas", name:"Gás Natural",    sym:"NG",      cat:"Commodity", base:2.45,   icon:"🔥", vol:0.0035, cg:null,              trade:false },
  { id:"copper", name:"Cobre",          sym:"HG",      cat:"Commodity", base:4.12,   icon:"🔶", vol:0.0025, cg:null,              trade:false },
  { id:"plat",   name:"Platina",        sym:"PL",      cat:"Commodity", base:985,    icon:"🪙", vol:0.0018, cg:null,              trade:false },
  { id:"wheat",  name:"Trigo",          sym:"ZW",      cat:"Commodity", base:545,    icon:"🌾", vol:0.0028, cg:null,              trade:false },
  { id:"corn",   name:"Milho",          sym:"ZC",      cat:"Commodity", base:425,    icon:"🌽", vol:0.0024, cg:null,              trade:false },
  // ── ETFs extra ──
  { id:"iwm",    name:"Russell 2000",   sym:"IWM",     cat:"ETF",       base:198,    icon:"📊", vol:0.0015, cg:null,              trade:false },
  { id:"gld",    name:"Gold ETF",       sym:"GLD",     cat:"ETF",       base:218,    icon:"🏅", vol:0.0010, cg:null,              trade:false },
  { id:"tlt",    name:"US Bonds ETF",   sym:"TLT",     cat:"ETF",       base:95,     icon:"📋", vol:0.0008, cg:null,              trade:false },
  { id:"xle",    name:"Energy ETF",     sym:"XLE",     cat:"ETF",       base:88,     icon:"⚡", vol:0.0016, cg:null,              trade:false },
  { id:"eem",    name:"Emerging Mkts",  sym:"EEM",     cat:"ETF",       base:42,     icon:"🌍", vol:0.0012, cg:null,              trade:false },
  { id:"vti",    name:"Total Market",   sym:"VTI",     cat:"ETF",       base:245,    icon:"🇺🇸", vol:0.0010, cg:null,             trade:false },
  // ── Forex extra ──
  { id:"gbpusd", name:"GBP/USD",        sym:"GBP/USD", cat:"Forex",     base:1.268,  icon:"💷", vol:0.0004, cg:null,              trade:false },
  { id:"usdjpy", name:"USD/JPY",        sym:"USD/JPY", cat:"Forex",     base:149.5,  icon:"¥",  vol:0.0003, cg:null,              trade:false },
  { id:"usdchf", name:"USD/CHF",        sym:"USD/CHF", cat:"Forex",     base:0.908,  icon:"🇨🇭", vol:0.0003, cg:null,             trade:false },
  { id:"audusd", name:"AUD/USD",        sym:"AUD/USD", cat:"Forex",     base:0.652,  icon:"🇦🇺", vol:0.0004, cg:null,             trade:false },
  { id:"usdcad", name:"USD/CAD",        sym:"USD/CAD", cat:"Forex",     base:1.361,  icon:"🇨🇦", vol:0.0003, cg:null,             trade:false },
]

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const uid   = () => Math.random().toString(36).slice(2,9);
const eur   = v => `€${Math.abs(v).toFixed(2)}`;
const sign  = v => v >= 0 ? "+" : "−";
const fmt   = (p, id) => id === "eurusd" ? p.toFixed(4) : p >= 1000 ? p.toFixed(2) : p.toFixed(3);
// Comissão ida-e-volta estimada (€) — espelha o broker: cripto 0.25%/lado
// (0.5% ida-volta), ações/ETF/restantes 0. `cat` vem do ativo (ex.: "Crypto").
const roundTripFeeFor = (cat, amount) =>
  +((cat === "Crypto" ? 0.005 : 0) * Math.abs(amount || 0)).toFixed(4);
const pctFmt = v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const riskC = r => r === "ALTO" ? T.red : r === "MÉDIO" ? T.gold : T.green;
// Cor por PERFIL (do mais defensivo ao mais arriscado).
const perfilC = p => ({
  conservador: T.green, scalper: T.green,
  moderado: T.blue, equilibrado: T.blue,
  volatil: T.gold, agressivo: T.red,
}[p] || T.blue);
const genH  = (base, n = 64) => {
  let p = base * 0.97;
  return Array.from({ length: n }, (_, i) => {
    p += (Math.random() - 0.492) * p * 0.013;
    return { i, v: +p.toFixed(5) };
  });
};

// ─── PRIMITIVES ──────────────────────────────────────────────────────────────
function Glass({ children, style = {}, glow, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: glow ? T.gradCard : T.card,
      border: `1px solid ${glow ? T.accent + "44" : T.border}`,
      borderRadius: 18,
      backdropFilter: "blur(18px)",
      boxShadow: glow
        ? `0 8px 32px rgba(124,122,255,0.16), inset 0 1px 0 rgba(255,255,255,0.07)`
        : `0 4px 20px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.045)`,
      transition: "transform 0.18s ease, box-shadow 0.18s ease",
      ...style,
    }}>{children}</div>
  );
}

// Grupo colapsável das Definições: cabeçalho clicável + descrição + conteúdo.
// aberto/onToggle vêm do estado do componente principal (não usa hooks aqui).
function SettingsGroup({ titulo, desc, icon, cor = T.accent, aberto, onToggle, children }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${aberto ? cor + "44" : T.border}`, borderRadius: 16, overflow: "hidden", transition: "border-color 0.2s" }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", cursor: "pointer", background: aberto ? `${cor}0c` : "transparent" }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{titulo}</div>
          {desc && <div style={{ fontSize: 10.5, color: T.muted, marginTop: 2, lineHeight: 1.4 }}>{desc}</div>}
        </div>
        <span style={{ fontSize: 13, color: T.muted, transform: aberto ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
      </div>
      {aberto && <div style={{ padding: "4px 20px 20px", display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>}
    </div>
  );
}



function Badge({ label, color = T.accent }) {
  return (
    <span style={{
      background: `${color}18`, color, border: `1px solid ${color}33`,
      borderRadius: 99, padding: "2px 10px", fontSize: 10, fontWeight: 700,
      letterSpacing: "0.07em", whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

// Pílula que mostra se o mercado de um ativo está aberto ou fechado agora
function MarketBadge({ assetId, showLabel = false }) {
  const open = isMarketOpen(assetId);
  const c = open ? T.green : T.muted;
  const hours = MARKET_HOURS[assetId];
  return (
    <span title={hours?.label || ""} style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: `${c}14`, color: c, border: `1px solid ${c}33`,
      borderRadius: 99, padding: "2px 9px", fontSize: 9, fontWeight: 700,
      whiteSpace: "nowrap", cursor: hours?.label ? "help" : "default",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c,
        animation: open ? "pulse 1.4s infinite" : "none", display: "inline-block" }} />
      {open ? "Mercado aberto" : "Mercado fechado"}
      {showLabel && hours?.label && !hours.always && <span style={{ opacity: 0.7, fontWeight: 500 }}>· {hours.label}</span>}
    </span>
  );
}

// Controlo "só lucro": input do alvo + botão de sugestão.
// Mantém estado local para o valor da caixa atualizar de imediato ao carregar
// na sugestão (sem esperar pelo round-trip ao bot/Firestore).
function LucroAlvoControl({ t, vol, cmdToBot }) {
  const sugerido = Math.round((0.5 + (vol ?? 0.004) * 800) * 2) / 2; // arredonda a 0,5
  const [alvo, setAlvo] = useState(t.lucroAlvo || 2);
  // Ressincroniza se o valor confirmado pelo bot mudar externamente.
  useEffect(() => { setAlvo(t.lucroAlvo || 2); }, [t.lucroAlvo]);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      <input type="number" min={0.5} step={0.5} value={alvo}
        onChange={(e) => setAlvo(e.target.value)}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (v > 0) cmdToBot({ type: "POS_VENDER_LUCRO", posId: t.id, ativar: true, lucroAlvo: v }, `🎯 ${t.assetSym || t.assetId}: alvo atualizado para +${v}%`);
        }}
        style={{ width: 40, padding: "2px 4px", borderRadius: 5, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.green, fontSize: 9, textAlign: "right" }} />
      <span style={{ fontSize: 9, color: T.muted }}>%</span>
      <button onClick={() => {
        setAlvo(sugerido);
        cmdToBot({ type: "POS_VENDER_LUCRO", posId: t.id, ativar: true, lucroAlvo: sugerido }, `💡 ${t.assetSym || t.assetId}: alvo sugerido +${sugerido}% (volatilidade)`);
      }} title={`Sugestão baseada na volatilidade de ${t.assetSym || t.assetId}: +${sugerido}%. Cobre taxas e a oscilação típica do ativo.`}
      style={{ padding: "2px 6px", borderRadius: 5, fontSize: 8.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: `${T.gold}18`, border: `1px solid ${T.gold}44`, color: T.gold, whiteSpace: "nowrap" }}>
        💡 {sugerido}%
      </button>
    </span>
  );
}

function KPI({ label, value, sub, color = T.text, xl }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: xl ? 32 : 22, fontWeight: 700, color, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Btn({ children, onClick, color = T.accent, solid, sm, disabled, full, style = {} }) {
  // Botões sólidos accent/green/gold ganham gradiente para um look mais vibrante.
  const grad = solid && (color === T.accent ? T.gradAccent : color === T.green ? T.gradGreen : color === T.gold ? T.gradGold : null);
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: grad || (solid ? color : `${color}15`),
      color: solid ? "#fff" : color,
      border: `1px solid ${solid ? "transparent" : color + "44"}`,
      borderRadius: sm ? 9 : 11,
      padding: sm ? "6px 13px" : "11px 22px",
      fontSize: sm ? 11 : 12.5, fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "inherit", opacity: disabled ? 0.45 : 1,
      transition: "all 0.16s", letterSpacing: "0.04em",
      boxShadow: solid && !disabled ? `0 4px 16px ${color}44` : "none",
      width: full ? "100%" : "auto", ...style,
    }}>{children}</button>
  );
}

function SectionLabel({ children }) {
  return <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}

// ─── APP ─────────────────────────────────────────────────────────────────────
// ── Assistente DCA (componente de módulo — identidade estável p/ não perder estado) ──
function DCAAssistente({ carteiraAtual, onAplicar, callAI, ASSETS, T, Glass, brokersDisp = [] }) {
  const [aberto, setAberto] = useState(carteiraAtual.length === 0);
  const [objetivo, setObjetivo] = useState("ferias");
  const [horizonte, setHorizonte] = useState("2-5");
  const [perfil, setPerfil] = useState("equilibrado");
  const [tipo, setTipo] = useState("misto"); // misto | cripto | etf — define o que a IA sugere e o modo
  const [valor, setValor] = useState(50);
  const [freq, setFreq] = useState("semanal");
  const [loading, setLoading] = useState(false);
  const [sugestao, setSugestao] = useState(null);
  const [erro, setErro] = useState(null);

  if (!aberto) {
    return (
      <Glass style={{ padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: T.muted }}>Queres refazer o plano com ajuda da IA?</span>
        <button onClick={() => setAberto(true)} style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${T.accent}`, background: `${T.accent}1a`, color: T.accent, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>🤖 Abrir assistente</button>
      </Glass>
    );
  }

  const pedirSugestao = async () => {
    setLoading(true); setErro(null); setSugestao(null);
    // Universo restrito ao que os brokers DISPONÍVEIS conseguem negociar. Assim
    // a IA nunca sugere algo que não consegues comprar. XTB = ETF/ações/commodity;
    // Binance = cripto. Se não houver info de brokers, usa o conjunto seguro (XTB).
    const brokersAtivos = brokersDisp.length ? brokersDisp : [{ assetClasses: ["etf", "stock", "commodity"], nome: "XTB" }];
    const classesOk = new Set();
    brokersAtivos.forEach(b => (b.assetClasses || []).forEach(c => classesOk.add(c)));
    const catParaClasseLocal = { Crypto: "crypto", ETF: "etf", "Ação": "stock", Commodity: "commodity", Forex: "forex" };
    let universoAtivos = ASSETS.filter(a => classesOk.has(catParaClasseLocal[a.cat]));
    // Filtra pelo tipo de plano escolhido: cripto-only, etf-only, ou misto.
    if (tipo === "cripto") universoAtivos = universoAtivos.filter(a => a.cat === "Crypto");
    else if (tipo === "etf") universoAtivos = universoAtivos.filter(a => a.cat === "ETF" || a.cat === "Commodity" || a.cat === "Ação");
    const universo = universoAtivos.map(a => `${a.id} (${a.name}, ${a.cat})`).join(", ");
    const nomesBrokers = brokersAtivos.map(b => b.nome).join(" + ");
    const instrucaoTipo = tipo === "cripto"
      ? "Este é um plano SÓ DE CRIPTO. Sugere apenas criptomoedas (3 a 4), nunca ETFs nem ações."
      : tipo === "etf"
      ? "Este é um plano SÓ DE ETFs/AÇÕES. Sugere apenas ETFs e commodities, nunca criptomoedas."
      : "Este é um plano MISTO. Podes combinar ETFs e cripto conforme o perfil.";
    try {
      const { result } = await callAI({
        max_tokens: 900,
        system: "És um educador financeiro que explica investimento passivo a leigos em português de Portugal. Sugeres carteiras diversificadas e simples para DCA. NÃO és consultor financeiro e deixas isso claro. Respondes SÓ em JSON puro, sem markdown.",
        messages: [{ role: "user", content:
`Um utilizador leigo quer montar um plano DCA. Dados:
- Objetivo: ${objetivo}
- Horizonte: ${horizonte} anos
- Tolerância a risco: ${perfil}
- Investe €${valor} ${freq}
- Brokers disponíveis: ${nomesBrokers}

${instrucaoTipo}

Ativos disponíveis (usa SÓ estes ids — são os que os brokers do utilizador conseguem comprar): ${universo}

Sugere uma carteira diversificada e simples (3 a 5 ativos), adequada ao perfil e horizonte. Mais conservador = mais ETFs amplos e ouro, menos/nada de crypto. Mais arrojado = pode incluir uma fatia pequena de crypto SE houver um broker de cripto disponível. NUNCA sugiras um ativo cujo id não esteja na lista acima. Os pesos têm de somar 100.

Responde SÓ com este JSON:
{"carteira":[{"id":"spy","peso":50},{"id":"gld","peso":30},{"id":"tlt","peso":20}],"explicacao":"frase curta em pt-PT a explicar a lógica","aviso":"1 frase a lembrar que não é aconselhamento e que há risco"}` }],
      });
      if (!result?.carteira?.length) throw new Error("Resposta sem carteira");
      // Salvaguarda: filtra qualquer ativo que a IA tenha sugerido fora do universo.
      const idsOk = new Set(universoAtivos.map(a => a.id));
      result.carteira = result.carteira.filter(c => idsOk.has(c.id));
      if (!result.carteira.length) throw new Error("A IA sugeriu ativos indisponíveis — tenta de novo");
      setSugestao(result);
    } catch (e) {
      setErro(e.message || "Falha ao contactar a IA");
    } finally { setLoading(false); }
  };

  const Opt = ({ val, cur, set, children }) => (
    <button onClick={() => set(val)} style={{ padding: "7px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
      border: `1px solid ${cur === val ? T.accent : T.border}`, background: cur === val ? `${T.accent}1a` : "transparent", color: cur === val ? T.accent : T.muted }}>{children}</button>
  );

  return (
    <Glass style={{ padding: "20px 24px", border: `1px solid ${T.accent}33` }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>🤖 Assistente de Plano</div>
      <div style={{ fontSize: 11, color: T.muted, marginBottom: 18, lineHeight: 1.6 }}>Responde a 4 perguntas simples e a IA sugere-te uma carteira. Podes ajustar tudo depois.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Tipo de plano</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Opt val="cripto" cur={tipo} set={setTipo}>🤖 Cripto (automático)</Opt>
            <Opt val="etf" cur={tipo} set={setTipo}>🔔 ETFs/Ações (manual)</Opt>
            <Opt val="misto" cur={tipo} set={setTipo}>Misto (cripto + ETFs)</Opt>
          </div>
          <div style={{ fontSize: 9.5, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
            {tipo === "cripto" ? "Só cripto (BTC, ETH…). O bot compra sozinho no Binance — ideal para automação."
              : tipo === "etf" ? "Só ETFs/ações. Compras tu no XTB quando o bot avisar (manual)."
              : "Mistura cripto (automática) e ETFs (manual). A parte de ETFs precisa de confirmação tua."}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Para que é o dinheiro?</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Opt val="ferias" cur={objetivo} set={setObjetivo}>Férias / objetivo a médio prazo</Opt>
            <Opt val="reforma" cur={objetivo} set={setObjetivo}>Poupança longa / reforma</Opt>
            <Opt val="crescer" cur={objetivo} set={setObjetivo}>Fazer crescer dinheiro extra</Opt>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Quando vais querer usá-lo?</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Opt val="1-2" cur={horizonte} set={setHorizonte}>1-2 anos</Opt>
            <Opt val="2-5" cur={horizonte} set={setHorizonte}>2-5 anos</Opt>
            <Opt val="5+" cur={horizonte} set={setHorizonte}>Mais de 5 anos</Opt>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Como te sentes sobre altos e baixos?</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Opt val="conservador" cur={perfil} set={setPerfil}>Prefiro seguro</Opt>
            <Opt val="equilibrado" cur={perfil} set={setPerfil}>Equilibrado</Opt>
            <Opt val="arrojado" cur={perfil} set={setPerfil}>Aceito risco por mais retorno</Opt>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Quanto por compra (€)?</div>
            <input type="number" min={1} value={valor} onChange={(e) => setValor(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 14, fontWeight: 700 }} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8 }}>Com que frequência?</div>
            <select value={freq} onChange={(e) => setFreq(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 13 }}>
              <option value="semanal">Semanal</option>
              <option value="quinzenal">Quinzenal</option>
              <option value="mensal">Mensal</option>
            </select>
          </div>
        </div>

        <button onClick={pedirSugestao} disabled={loading} style={{ padding: "11px", borderRadius: 9, border: "none", background: loading ? T.border : T.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: loading ? "default" : "pointer" }}>
          {loading ? "A pensar…" : "✨ Sugerir carteira"}
        </button>

        {erro && <div style={{ fontSize: 11, color: T.red }}>⚠ {erro}</div>}

        {sugestao && (
          <div style={{ background: `${T.green}0c`, border: `1px solid ${T.green}33`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Carteira sugerida:</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {sugestao.carteira.map(c => {
                const a = ASSETS.find(x => x.id === c.id);
                const eur = +((Number(valor) || 0) * (c.peso / 100)).toFixed(2);
                return (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                    <span>{a ? `${a.icon || ""} ${a.name}` : c.id}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, color: T.aLight }}>€{eur}</span>
                      <span style={{ fontSize: 10, color: T.muted, minWidth: 32, textAlign: "right" }}>{c.peso}%</span>
                    </span>
                  </div>
                );
              })}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, paddingTop: 8, marginTop: 2, borderTop: `1px solid ${T.border}` }}>
                <span style={{ color: T.muted }}>Total por compra ({freq})</span>
                <span style={{ fontWeight: 800, color: T.green }}>€{(Number(valor) || 0).toFixed(2)}</span>
              </div>
            </div>
            {sugestao.explicacao && <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginBottom: 8 }}>{sugestao.explicacao}</div>}
            {sugestao.aviso && <div style={{ fontSize: 10, color: T.gold, lineHeight: 1.5, marginBottom: 12 }}>⚠️ {sugestao.aviso}</div>}
            <button onClick={() => { onAplicar({ carteira: sugestao.carteira, valorPeriodico: valor, frequencia: freq, modoExecucao: tipo === "cripto" ? "auto" : tipo === "etf" ? "manual" : undefined }); setAberto(false); }}
              style={{ width: "100%", padding: "10px", borderRadius: 8, border: `1px solid ${T.green}`, background: `${T.green}1a`, color: T.green, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              ✓ Usar esta carteira
            </button>
          </div>
        )}
      </div>
    </Glass>
  );
}

// ── Card de ordem manual (módulo — estado estável) ──
function OrdemManualCard({ ordem, ASSETS, T, Glass, precoAtual, onConfirmar }) {
  const nomeAtivo = (id) => { const a = ASSETS.find(x => x.id === id); return a ? `${a.icon || ""} ${a.name}` : id; };
  // Estado local: preço por item (sugerido = preço atual ou o que veio na ordem).
  const [precos, setPrecos] = useState(() => {
    const o = {};
    (ordem.itens || []).forEach(it => { o[it.assetId] = it.precoSugerido || precoAtual(it.assetId) || ""; });
    return o;
  });
  const [feito, setFeito] = useState(false);

  return (
    <Glass style={{ padding: "18px 22px", border: `1px solid ${T.gold}55`, background: `${T.gold}0c` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800 }}>🔔 Compra pendente — {ordem.planNome}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.gold }}>€{(ordem.valorTotal || 0).toFixed(2)}</div>
      </div>
      <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6, marginBottom: 14 }}>
        Está na hora da compra deste plano. Compra estes valores no teu broker, confirma o preço a que compraste (ou deixa o sugerido), e carrega em "Já comprei". A posição fica registada no teu relatório.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        {(ordem.itens || []).map(it => (
          <div key={it.assetId} style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{nomeAtivo(it.assetId)}</div>
              <div style={{ fontSize: 10, color: T.muted }}>Comprar <b style={{ color: T.aLight }}>€{it.eur.toFixed(2)}</b></div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: T.muted }}>preço:</span>
              <input type="number" step="0.01" value={precos[it.assetId]}
                onChange={(e) => setPrecos(p => ({ ...p, [it.assetId]: e.target.value }))}
                style={{ width: 84, padding: "6px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 12, textAlign: "right" }} />
            </div>
          </div>
        ))}
      </div>

      <button disabled={feito} onClick={() => {
        const itens = (ordem.itens || []).map(it => ({ assetId: it.assetId, eur: it.eur, preco: parseFloat(precos[it.assetId]) || it.precoSugerido || 0 }));
        if (itens.some(i => !i.preco)) return;
        setFeito(true);
        onConfirmar(itens);
      }} style={{ width: "100%", padding: "11px", borderRadius: 9, border: "none", background: feito ? T.border : T.green, color: "#fff", fontWeight: 700, fontSize: 13, cursor: feito ? "default" : "pointer" }}>
        {feito ? "✓ Registado" : "✓ Já comprei — registar no plano"}
      </button>
    </Glass>
  );
}

export default function TradeAI() {
  const { user, loading: authLoading } = useAuth();
  const [dbLoaded, setDbLoaded] = useState(false); // flag: firestore carregado
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" && window.innerWidth < 820);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const INIT_BAL = 10000;

  // ── Simulação separada ──
  const [simCapital, setSimCapital]   = useState(1000);   // capital definido pelo user
  const [simBalance, setSimBalance]   = useState(1000);   // saldo actual da simulação
  const [simPositions, setSimPositions] = useState([]);   // posições abertas SIM
  const [simClosed,   setSimClosed]   = useState([]);     // trades fechados SIM
  const [simSummary,  setSimSummary]  = useState(null);   // resultado final mostrado no modal
  const [archivedSims, setArchivedSims] = useState([]);   // histórico de simulações arquivadas
  const [dailyArchives, setDailyArchives] = useState([]); // arquivos diários (bot, à meia-noite)
  const [simMode, setSimMode] = useState(() => {
    // Lembra a última escolha (Simulação/Live) entre recarregamentos.
    try { const v = localStorage.getItem("tradeai_simMode"); if (v !== null) return v === "true"; } catch {}
    return true; // por defeito: simulação (mais seguro)
  });
  useEffect(() => { try { localStorage.setItem("tradeai_simMode", String(simMode)); } catch {} }, [simMode]);
  const simModeRef = useRef(true);
  const [brokerBalances, setBrokerBalances] = useState(null); // { alpaca: n, binance: n, ... } via Firestore (bot)
  const brokerBalancesRef = useRef(null);
  // ── Definições separadas por MODO ──────────────────────────────────────────
  // Três conjuntos independentes: simulação, paper e real. O bot lê o conjunto
  // certo conforme o MODE em que arranca (settings / paperSettings / realSettings
  // no Firestore). Real começa conservador por defeito (proteção de capital).
  const CAT_AJUSTE_DEFAULT = { Crypto: 1.5, Commodity: 1.0, ETF: 0.7, Forex: 0.4, "Ação": 1.1 };
  const PER_ORIGEM_DEFAULT = { estrategias: { valorFixo: 0, maxValorTrade: 0 }, aibrain: { valorFixo: 0, maxValorTrade: 0 }, daytrading: { valorFixo: 0, maxValorTrade: 0 }, manual: { valorFixo: 0, maxValorTrade: 0 } };
  // ── Config DCA (Dollar-Cost Averaging) — o núcleo passivo, sempre ativo ──
  // dcaAtivo: o motor passivo está ligado (compra periódica + reequilíbrio).
  // aiTradeAtivo: toggle do modo ativo (Cérebro AI, day-trade, manuais). Off por
  //   defeito. Quando on, corre EM PARALELO com o DCA, mas numa fatia separada.
  // dcaPctCapital: % do capital reservado ao DCA (o resto fica livre p/ AI Trade).
  // dcaValorPeriodico: € a investir em cada compra periódica.
  // dcaFrequencia: "semanal" | "quinzenal" | "mensal".
  // dcaCarteira: [{ id, peso }] — alvo de alocação (somam 100).
  // dcaReequilibrar: reequilíbrio automático quando os pesos derivam.
  // dcaDerivaPct: deriva (em pontos) que dispara reequilíbrio (ex.: 5 = ±5%).
  const DCA_DEFAULTS = {
    dcaAtivo: true,
    aiTradeAtivo: false,
    // Controlo granular do trading ativo (cada fonte tem o seu interruptor).
    aiBrainMestre: false,      // chave-mestra (opção C): desbloqueia as fontes
    aiEstrategias: false,      // estratégias automáticas
    aiManualAutonomo: false,   // Cérebro AI compra sozinho
    aiManualSugestao: true,    // IA dá opinião quando peço (sem executar) — ligado, é grátis até clicar
    aiDayTrading: false,       // day-trade automático
    dcaPctCapital: 80,
    dcaValorPeriodico: 50,
    dcaFrequencia: "semanal",
    dcaCarteira: [],          // vazio = ainda não configurado (mostra assistente)
    dcaReequilibrar: true,
    dcaDerivaPct: 5,
    dcaProximaCompra: null,   // timestamp da próxima compra agendada (o bot gere)
    // ── DCA multi-plano ──
    dcaValorMensal: 100,      // o "bolo" por período repartido pelos planos
    dcaPlanos: [],            // [{ id, nome, carteira, alocacao:{tipo,valor}, frequencia, dataInicio, reequilibrar }]
    dcaAiTradePct: 20,        // % do capital reservado ao trading ativo
    dcaAiTradeValor: 0,       // OU € fixo (>0 sobrepõe a %)
    xtbSaldo: null,           // saldo manual do XTB (introduzido pelo utilizador)
  };
  const PAPER_DEFAULTS = { capitalTotal: 1000, modoValor: "percentagem", valorFixo: 50,
    percentagem: 3, riscoPerfil: "moderado",
    maxPosicoesAbertas: 5, stopLossPadrao: 6, takeProfitPadrao: 12, autoInvestir: false,
    maxValorTrade: 100, maxPosicoesTotal: 40, maxAiBrain: 3, ...DCA_DEFAULTS,
    catAjuste: { ...CAT_AJUSTE_DEFAULT }, perOrigem: JSON.parse(JSON.stringify(PER_ORIGEM_DEFAULT)) };
  const REAL_DEFAULTS  = { capitalTotal: 1000, modoValor: "fixo", valorFixo: 25,
    percentagem: 2, riscoPerfil: "conservador",
    maxPosicoesAbertas: 3, stopLossPadrao: 5, takeProfitPadrao: 10, autoInvestir: false,
    maxValorTrade: 50, maxPosicoesTotal: 10, maxAiBrain: 2, ...DCA_DEFAULTS, dcaValorPeriodico: 25,
    catAjuste: { ...CAT_AJUSTE_DEFAULT }, perOrigem: JSON.parse(JSON.stringify(PER_ORIGEM_DEFAULT)) };
  const [paperSettings, setPaperSettings] = useState({ ...PAPER_DEFAULTS });
  const [realSettings,  setRealSettings]  = useState({ ...REAL_DEFAULTS });
  const paperSettingsRef = useRef({ ...PAPER_DEFAULTS });
  const realSettingsRef  = useRef({ ...REAL_DEFAULTS });
  const paperLoadedRef   = useRef(false); // true quando paperSettings veio do Firestore (trava a migração do legado)
  const [botPaused, setBotPaused] = useState(false); // pausa de novas entradas do bot (settings/botControl)
  useEffect(() => { paperSettingsRef.current = paperSettings; }, [paperSettings]);
  useEffect(() => { realSettingsRef.current  = realSettings;  }, [realSettings]);
  // liveSettings/liveSettingsRef (paper ou real conforme o modo do bot) são
  // derivados mais abaixo, depois de botModoReal estar disponível.
  const liveSettingsRef = useRef({ ...PAPER_DEFAULTS });
  const [histTab, setHistTab] = useState("sim");   // "sim" | "live"
  // O separador do histórico segue o toggle principal: ao mudar de Simulação
  // para Live (paper/real), o histórico mostra logo os trades desse modo.
  useEffect(() => { setHistTab(simMode ? "sim" : "live"); }, [simMode]);
  const [botLogs, setBotLogs] = useState([]); // eventos publicados pelo bot (tab Mensagens)
  const [regimeLog, setRegimeLog] = useState([]); // registo de liga/desliga do Modo Dinâmico
  const [priceStats, setPriceStats] = useState({}); // estatísticas históricas por ativo (máx/mín/médias)
  const [msgFiltro, setMsgFiltro] = useState("todos"); // filtro do tab Mensagens
  // ── Day Trading ──
  const [dtActive,     setDtActive]     = useState(false);    // monitor activo
  const [dtAssets,     setDtAssets]     = useState([]);       // ativos a monitorizar com AI
  const [dtTrades,     setDtTrades]     = useState([]);       // trades do dia
  const [dtLoading,    setDtLoading]    = useState(false);    // a analisar
  const [dtScanResult, setDtScanResult] = useState(null);     // ultima análise
  const [dtProfitTarget, setDtProfitTarget] = useState(6);    // % lucro alvo
  const [dtMaxLoss,    setDtMaxLoss]    = useState(3);        // % perda max por trade
  const [dtAmount,     setDtAmount]     = useState(100);      // € por operação
  const [dtMinConf,    setDtMinConf]    = useState(75);       // % confiança mínima para auto-comprar
  const [dtDailyPnl,   setDtDailyPnl]  = useState(0);        // P&L do dia em €
  const dtTimerRef = useRef(null);                            // intervalo de scan
  const [histCat, setHistCat] = useState("Todos"); // categoria filtro histórico
  const [histOrigem, setHistOrigem] = useState("Todas"); // filtro por origem (AI Brain, estratégias, etc.)
  const [histSortKey, setHistSortKey] = useState("abertura"); // coluna de ordenação do histórico
  const [histSortDir, setHistSortDir] = useState("desc");     // "asc" | "desc"
  const [histOpenDay, setHistOpenDay] = useState(null); // dia de arquivo expandido no histórico
  const [histCorte, setHistCorte] = useState("");       // data de corte p/ comparar antes vs depois (ex.: dia que ligaste o regime)
  const [arqSortKey, setArqSortKey] = useState("pnl");   // coluna de sort dentro de um dia
  const [arqSortDir, setArqSortDir] = useState("desc");
  const [simStartedAt, setSimStartedAt] = useState(null); // timestamp início
  const simBalRef   = useRef(1000);
  const simPosRef   = useRef([]);
  const simStartedRef = useRef(false); // true quando a simulação está em curso

  const [tab, setTab]             = useState(() => {
    // Deep-link: ?tab=dca abre direto no separador (usado no link do Telegram).
    // Persistência: ao carregar F5, mantém o separador atual (URL > localStorage).
    if (typeof window !== "undefined") {
      const validos = ["dashboard", "dca", "relatorio", "portfolio", "markets", "history", "sugestoes", "settings", "resumo"];
      try {
        const t = new URLSearchParams(window.location.search).get("tab");
        if (t && validos.includes(t)) return t;
      } catch {}
      try {
        const saved = localStorage.getItem("tradeai_tab");
        if (saved && validos.includes(saved)) return saved;
      } catch {}
      if (window.innerWidth < 820) return "resumo";
    }
    return "dashboard";
  });
  // Sempre que o separador muda, grava no URL (?tab=) e em localStorage, para
  // sobreviver a um F5 sem voltar ao Dashboard.
  useEffect(() => {
    if (typeof window === "undefined" || !tab) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState({}, "", url);
    } catch {}
    try { localStorage.setItem("tradeai_tab", tab); } catch {}
  }, [tab]);
  // Resumo é um separador só-mobile: num ecrã grande, cai no Dashboard.
  useEffect(() => { if (!isMobile && tab === "resumo") setTab("dashboard"); }, [isMobile, tab]);
  const tabRef = useRef("dashboard");
  const [balance, setBalance]     = useState(INIT_BAL);
  const [assets, setAssets]       = useState(() =>
    ASSETS.map(a => ({ ...a, price: a.base, hist: genH(a.base), change: (Math.random() - 0.48) * 3.5 }))
  );
  // Resolve um ativo a partir de uma posição/trade de forma robusta:
  // tenta id, depois símbolo, depois nome. Tolera trades antigos guardados com id errado (ex: "xag").
  const resolveAsset = useCallback((ref) => {
    if (!ref) return undefined;
    const norm = s => String(s || "").toLowerCase().trim();
    const byId   = ref.assetId   ?? ref.id;
    const bySym  = ref.assetSym  ?? ref.sym;
    const byName = ref.assetName ?? ref.nome ?? ref.name;
    return assets.find(x => x.id === byId)
        || assets.find(x => norm(x.sym) === norm(byId))
        || assets.find(x => norm(x.sym) === norm(bySym))
        || assets.find(x => norm(x.name) === norm(byName));
  }, [assets]);

  // Comissão estimada — espelha a fórmula do bot (broker.js): crypto 0.25% por
  // lado (0.5% round-trip); ETF/ação/commodity/forex = 0% na Alpaca. Usado para
  // mostrar o P&L não realizado JÁ LÍQUIDO (coerente com os trades fechados).
  const feeRateApp = useCallback((ref) => {
    // Posições manuais no XTB: 0% de comissão (até 100k€/mês), mas 0,5% de
    // conversão de moeda se o ETF não for em EUR (verificado primeiro, antes de
    // resolver o ativo, porque ref aqui é o objeto-posição).
    if (ref && typeof ref === "object" && ref.manualReal) {
      return 0.005;
    }
    const a = resolveAsset(ref);
    return a && a.cat === "Crypto" ? 0.0025 : 0;
  }, [resolveAsset]);
  const roundTripFeeApp = useCallback((ref, amount) =>
    Math.abs(amount || 0) * feeRateApp(ref) * 2, [feeRateApp]);

  const [positions, setPositions] = useState([]);
  const [manualOrders, setManualOrders] = useState([]); // ordens DCA manuais pendentes
  const [dcaAportes, setDcaAportes] = useState({}); // contabilidade de aportes confirmados por plano
  const [planoAberto, setPlanoAberto] = useState(null); // acordeão dos planos DCA (estado no topo p/ não violar regras de hooks)
  // Grupos colapsáveis das Definições. DCA aberto por defeito (é o núcleo);
  // Trading Ativo fechado (só interessa se usares o AI Brain).
  const [defGrupo, setDefGrupo] = useState({ geral: true, dca: true, ai: false, perigo: false });
  // Colunas opcionais da tabela de histórico (o utilizador liga/desliga).
  const [colsVisiveis, setColsVisiveis] = useState({ abertura: true, investido: true, sltp: false, mercado: true, duracao: false });
  const [portfolioHist, setPortfolioHist] = useState([]); // pontos diários do valor da carteira
  const [closed, setClosed]       = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [objective, setObjective]   = useState("");
  const [aiLoading, setAiLoading]   = useState(false);
  const [aiRec, setAiRec]           = useState(null);
  const [aiSuggestions, setAiSuggestions] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [toasts, setToasts]         = useState([]);
  const [confirmModal, setConfirmModal] = useState(null); // { title, message, lines, danger, confirmLabel, onConfirm }
  const [suggestCats, setSuggestCats] = useState([]); // categorias selecionadas ([] = todas)
  const [editAmounts, setEditAmounts] = useState({}); // { [opId]: valor € a investir por sugestão }
  const [tick, setTick]             = useState(0);
  const [liveData, setLiveData]     = useState(false);
  // Estado do bot 24/7 (Railway). Quando vivo, a app não opera — só mostra.
  const [botStatus, setBotStatus]   = useState(null); // { alive, mode, lastSeen, features }
  const botActiveRef = useRef(false);
  const dtLoadedRef  = useRef(false); // garante que o flag do monitor só é sincronizado uma vez

  // ── Definições ──
  const [settings, setSettings] = useState({
    capitalTotal:        5000,
    modoValor:           "percentagem",
    valorFixo:           100,
    percentagem:         5,
    riscoPerfil:         "moderado",
    maxPosicoesAbertas:  5,
    maxManuais:          5,
    maxEstrategias:      5,
    maxAiBrain:          3,
    maxDayTrading:       5,
    maxValorTrade:       100,   // teto € por trade (enviado ao bot)
    maxPosicoesTotal:    40,    // limite global de posições abertas (enviado ao bot)
    rotacaoAtiva:        false,
    regimeDinamico:      false,  // ajustar exposição automaticamente ao regime de mercado
    stopLossPadrao:      6,
    takeProfitPadrao:    12,
    autoInvestir:        false,
    // ── Cérebro AI autónomo ──
    aiBrain:             false,  // a IA compra/vende sozinha com base nos sinais
    aiBrainConfianca:    78,     // confiança mínima (%) para a IA agir
    trailingStop:        false,  // protege lucros movendo o stop-loss para cima
    trailingStopPct:     4,      // distância (%) do trailing stop abaixo do pico
    aiExitOnFlip:        true,   // sair quando a IA muda de COMPRAR para VENDER
    aiSignalsMin:        15,     // intervalo (min) entre análises AI do bot — poupa tokens
    catAjuste:           { Crypto: 1.5, Commodity: 1.0, ETF: 0.7, Forex: 0.4, "Ação": 1.1 }, // multiplicador de SL/TP/queda por categoria
    perOrigem:           { estrategias: { valorFixo: 0, maxValorTrade: 0 }, aibrain: { valorFixo: 0, maxValorTrade: 0 }, daytrading: { valorFixo: 0, maxValorTrade: 0 }, manual: { valorFixo: 0, maxValorTrade: 0 } },
  });
  const balRef    = useRef(INIT_BAL);
  const stratRef  = useRef([]);
  const posRef    = useRef([]);
  const closedRef = useRef([]);
  const assRef    = useRef(assets);
  const mktDataRef = useRef({}); // preços reais do feed (market.js) — fonte de verdade quando existem
  const highs     = useRef({});
  const cds       = useRef({});
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    setOrderAmount(settings.modoValor === "fixo" ? settings.valorFixo : Math.max(10, +(INIT_BAL * settings.percentagem / 100).toFixed(0)));
  }, [settings]);
  const calcTradeAmount = useCallback(() => {
    // Use refs only — avoids stale closure and initialization order issues
    const s   = simModeRef.current ? settingsRef.current : liveSettingsRef.current;
    const bal = simModeRef.current ? simBalRef.current   : balRef.current;
    if (!s) return 100; // fallback seguro
    if (s.modoValor === "percentagem") return Math.max(10, +(bal * s.percentagem / 100).toFixed(2));
    return s.valorFixo || 100;
  }, []); // sem dependências — usa só refs

  // ── Sugestão de quantia a investir, com base em: perfil de risco (Definições),
  //    confiança da IA e saldo DISPONÍVEL do broker que vai executar o ativo.
  //    Em sim/sem broker usa o saldo livre da simulação. Devolve € a investir.
  const suggestInvestAmount = useCallback((assetId, confianca) => {
    const s   = simModeRef.current ? settingsRef.current : liveSettingsRef.current;
    // Saldo disponível: do broker (se a app o tiver via Firestore) ou da simulação.
    let avail = simModeRef.current ? simBalRef.current : balRef.current;
    const bb = brokerBalancesRef.current; // { alpaca: 123, binance: 45, ... } ou null
    if (!simModeRef.current && bb) {
      const bid = brokerForAsset(assetId); // qual broker trata este ativo
      if (bid && typeof bb[bid] === "number") avail = bb[bid];
    }
    if (!avail || avail <= 0) return 10;

    const perfil = (s?.riscoPerfil || "moderado").toLowerCase();
    // Teto por posição (% do saldo) e fração-base por perfil.
    const PERFIL = {
      conservador: { teto: 0.10, base: 0.04 },
      scalper:     { teto: 0.12, base: 0.05 },
      moderado:    { teto: 0.20, base: 0.08 },
      equilibrado: { teto: 0.18, base: 0.07 },
      volatil:     { teto: 0.22, base: 0.09 },
      agressivo:   { teto: 0.33, base: 0.14 },
    };
    const cfg = PERFIL[perfil] || PERFIL.moderado;

    // Escalão de confiança (a IA dá 0–100). Multiplica a fração-base.
    const c = Math.max(0, Math.min(100, confianca || 0));
    const mult = c >= 90 ? 2.0 : c >= 80 ? 1.5 : c >= 70 ? 1.1 : c >= 60 ? 0.8 : 0.5;

    let amount = avail * cfg.base * mult;
    amount = Math.min(amount, avail * cfg.teto); // nunca acima do teto do perfil
    amount = Math.max(10, Math.min(amount, avail)); // mínimo €10, nunca mais que o saldo
    return +amount.toFixed(2);
  }, []);

  // Stable refs for interval


  useEffect(() => { balRef.current = balance; }, [balance]);
  useEffect(() => { simModeRef.current = simMode; }, [simMode]);
  useEffect(() => { brokerBalancesRef.current = brokerBalances; }, [brokerBalances]);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => { simBalRef.current = simBalance; }, [simBalance]);
  // Persistir day trading trades + P&L (com debounce simples)
  useEffect(() => {
    if (!user || !dbLoaded) return;
    const t = setTimeout(() => {
      import("./firebase.js").then(({ saveSetting }) =>
        saveSetting(user.uid, "dtState", {
          trades: dtTrades, dailyPnl: dtDailyPnl,
          profitTarget: dtProfitTarget, maxLoss: dtMaxLoss, amount: dtAmount, minConf: dtMinConf,
          active: dtActive, assets: dtAssets.map(a => a.id),
        }).catch(()=>{}));
    }, 1000);
    return () => clearTimeout(t);
  }, [dtTrades, dtDailyPnl, dtProfitTarget, dtMaxLoss, dtAmount, dtMinConf, dtActive, dtAssets, user, dbLoaded]);

  useEffect(() => { simPosRef.current = simPositions; }, [simPositions]);
  useEffect(() => { simStartedRef.current = !!simStartedAt; }, [simStartedAt]);
  // Bot 24/7 considerado ativo se o heartbeat foi nos últimos 3 min E o modo bate certo
  const botHeartbeatRecente = !!(botStatus?.alive && botStatus?.lastSeen && (Date.now() - botStatus.lastSeen < 3 * 60 * 1000));
  const botModoBate = !botStatus?.mode || (simMode === (botStatus.mode === "sim"));
  const botAtivo = botHeartbeatRecente && botModoBate;
  // Distinguir paper (dinheiro fictício na corretora) de real (dinheiro a sério).
  // A app só tinha sim/live; o bot publica o modo verdadeiro no heartbeat.
  const botModoReal  = botStatus?.mode === "real";
  const botModoPaper = botStatus?.mode === "paper";
  // ── Câmbio (exibição) ───────────────────────────────────────────────────────
  // O bot publica a moeda REAL dos valores (USD em paper/real, porque a Alpaca e
  // a Binance operam em dólares) e a taxa EUR/USD ao vivo. Os números do motor
  // (saldo, P&L) estão nessa moeda; aqui convertemos só para EXIBIR em euros.
  // 1 EUR = fxEurUsd USD  →  euros = usd / fxEurUsd.
  const brokerCurrency = botStatus?.currency || (simMode ? "EUR" : "USD");
  const fxEurUsd = Number(botStatus?.fxEurUsd) > 0 ? Number(botStatus.fxEurUsd) : null;
  const valoresEmUSD = brokerCurrency === "USD";
  // Converte um valor da moeda do broker para euros (para exibição). Se não
  // houver taxa ou os valores já forem euros, devolve tal e qual.
  const toEur = (v) => (valoresEmUSD && fxEurUsd ? v / fxEurUsd : v);
  // Conjunto de definições "live" efetivo: real se o bot está em real, senão
  // paper. É isto que a app usa para sizing/preview quando não está em sim.
  const liveSettings = botModoReal ? realSettings : paperSettings;
  useEffect(() => { liveSettingsRef.current = botModoReal ? realSettings : paperSettings; }, [botModoReal, paperSettings, realSettings]);
  // Se o utilizador está num separador de trading ativo e desliga a respetiva
  // fonte, volta ao início (senão ficaria numa página agora escondida). Tem de
  // estar DEPOIS de liveSettings ser definido (senão dá erro de inicialização).
  useEffect(() => {
    // Sub-abas do Laboratório (trading ativo) só são acessíveis com o AI Brain
    // mestre ligado. Se desligar o mestre estando lá, volta ao início.
    const tabsLab = ["strategies", "daytrading", "ai"];
    const mestre = liveSettings.aiTradeAtivo || liveSettings.aiBrainMestre;
    if (tabsLab.includes(tab) && !mestre) setTab("dashboard");
  }, [liveSettings.aiTradeAtivo, liveSettings.aiBrainMestre, tab]);
  // Rótulo claro e único para qualquer modo do bot — evita mostrar "LIVE"
  // genérico que confunde paper com real. Usar em todo o lado.
  const modoLabelBot = (m) => m === "real" ? "DINHEIRO REAL" : m === "paper" ? "Paper" : m === "sim" ? "Simulação" : "—";
  useEffect(() => { botActiveRef.current = botAtivo; }, [botAtivo]);
  useEffect(() => { stratRef.current = strategies; }, [strategies]);
  useEffect(() => { posRef.current = positions; }, [positions]);
  useEffect(() => { closedRef.current = closed; }, [closed]);
  useEffect(() => { assRef.current = assets; }, [assets]);

  // ── Toast ──
  const toast = useCallback((msg, type = "info") => {
    const id = uid();
    setToasts(p => [...p.slice(-4), { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 6000);
  }, []);

  // ── CoinGecko real prices (SÓ quando o bot está inativo) ──
  // Quando o bot está ativo, ele publica os preços no Firestore (marketPrices) e
  // a app lê de lá — não bate nas APIs. Isto evita chamadas duplicadas e poupa
  // créditos (CoinGecko/Netlify). Este loop é só fallback para quando não há bot.
  useEffect(() => {
    const fetch_ = async () => {
      if (botActiveRef.current) return; // bot ativo → preços vêm do Firestore
      try {
        const r = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true"
        );
        if (!r.ok) return;
        const d = await r.json();
        setAssets(prev => prev.map(a => {
          if (a.id === "btc" && d.bitcoin)  return { ...a, price: d.bitcoin.usd,  change: d.bitcoin.usd_24h_change  ?? a.change };
          if (a.id === "eth" && d.ethereum) return { ...a, price: d.ethereum.usd, change: d.ethereum.usd_24h_change ?? a.change };
          return a;
        }));
        setLiveData(true);
      } catch { /* offline / rate-limit */ }
    };
    fetch_();
    const iv = setInterval(fetch_, 60000);
    return () => clearInterval(iv);
  }, []);

  // ── Price engine + strategy execution ──
  useEffect(() => {
    const iv = setInterval(() => {
      setTick(prev => {
        const t = prev + 1;

        // 1. Update prices — pausa se hover num gráfico OU se está a editar definições
        if (hoveredChart.current) return prev; // ⏸ pausa quando hover num gráfico
        if (tabRef.current === "settings") return prev; // ⏸ pausa nas Definições (evita perder foco)
        const upd = assRef.current.map(a => {
          // FONTE DE VERDADE: se este ativo tem preço real do feed (market.js),
          // nunca geramos ruído por cima — manteríamos dois motores em conflito
          // (foi o que causava o P&L fantasma do ouro: entrada ao preço real
          // ~$4293 vs preço simulado preso no base ~$2341).
          const realPrice = mktDataRef.current?.[a.id]?.price;
          if (typeof realPrice === "number" && realPrice > 0) {
            const h0 = highs.current[a.id];
            if (!h0 || realPrice > h0.p || t - h0.t > 120) highs.current[a.id] = { p: realPrice, t };
            return { ...a, price: realPrice, hist: [...a.hist.slice(-79), { i: t, v: realPrice }] };
          }
          // Se o bot 24/7 está a operar (SIM), também não geramos ruído —
          // os preços reais chegam via fetchMarkets. Mantemos o preço atual.
          if (simModeRef.current && botActiveRef.current) {
            const h0 = highs.current[a.id];
            if (!h0 || a.price > h0.p || t - h0.t > 120) highs.current[a.id] = { p: a.price, t };
            return { ...a, hist: [...a.hist.slice(-79), { i: t, v: a.price }] };
          }
          // Fallback: ativo sem feed real e sem bot — simulação por random walk.
          const noise = (Math.random() - 0.492) * a.price * a.vol * 4.5;
          const p     = +(Math.max(a.price + noise, a.price * 0.45)).toFixed(a.id === "eurusd" ? 4 : 2);
          const chg   = a.id === "btc" || a.id === "eth" ? a.change : ((p - a.base) / a.base) * 100;

          // Track rolling high (janela ~4 min — tempo suficiente para acumular quedas)
          const h = highs.current[a.id];
          if (!h || p > h.p || t - h.t > 120) highs.current[a.id] = { p, t };

          return { ...a, price: p, change: chg, hist: [...a.hist.slice(-79), { i: t, v: p }] };
        });
        setAssets(upd);

        // ── Determina o modo ativo (SIM ou LIVE) e respetivos setters/refs ──
        const isSim = simModeRef.current;

        // ⛔ REGRA ABSOLUTA: o motor do browser SÓ pode negociar em SIMULAÇÃO.
        //    Em paper/real (live), a autoridade de trading é EXCLUSIVAMENTE o bot
        //    24/7 no servidor. A app é só um visor — lê o que o bot escreve no
        //    Firestore e nunca abre/fecha posições. Isto evita que a app crie
        //    trades fantasma (preços simulados, $NaN) etiquetados como "live",
        //    que foi o que encheu o histórico de paper com SOL/XRP a €500.
        if (!isSim) {
          return t; // live/paper → browser não toca em posições, só o bot manda
        }

        // ⛔ Em SIMULAÇÃO: se o bot 24/7 também está vivo, ele é a autoridade e o
        //    browser cede (evita dois motores a escrever ao mesmo tempo).
        if (botActiveRef.current) {
          return t;
        }

        const posPool   = isSim ? simPosRef.current : posRef.current;
        const curBal    = isSim ? simBalRef.current : balRef.current;
        const setPos    = isSim ? setSimPositions : setPositions;
        const setBal    = isSim ? setSimBalance   : setBalance;
        const setClsd   = isSim ? setSimClosed    : setClosed;
        const balRefCur = isSim ? simBalRef        : balRef;

        // 2. Gestão de posições abertas (modo ativo): trailing stop, flip da IA, SL/TP
        const cfg = settingsRef.current || {};
        const sigs = marketSignalsRef.current || {};
        const trailingOn = !!cfg.trailingStop;
        const trailPct   = cfg.trailingStopPct || 4;
        const exitOnFlip = cfg.aiExitOnFlip !== false;
        const flipConf   = cfg.aiBrainConfianca || 78;
        const toClose = [], toKeep = [];
        const normId = s => String(s || "").toLowerCase().trim();
        posPool.forEach(pos => {
          const a = upd.find(x => x.id === pos.assetId)
                 || upd.find(x => normId(x.sym) === normId(pos.assetId))
                 || upd.find(x => normId(x.sym) === normId(pos.assetSym))
                 || upd.find(x => normId(x.name) === normId(pos.assetName));
          if (!a) { toKeep.push(pos); return; }
          let p2 = { ...pos };

          // ── Trailing stop: acompanha o pico, sobe o SL para proteger lucro ──
          if (trailingOn) {
            const peak = Math.max(p2.peak || p2.entryPrice, a.price);
            p2.peak = peak;
            // só sobe o SL quando já há lucro acima da entrada
            if (peak > p2.entryPrice) {
              const trailSl = +(peak * (1 - trailPct / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
              if (trailSl > p2.sl) p2.sl = trailSl; // nunca desce o SL
            }
          }

          // ── Saída antecipada se a IA virar para VENDER com confiança ──
          const sg = sigs[pos.assetId];
          if (exitOnFlip && sg && sg.sinal === "VENDER" && (sg.confianca || 0) >= flipConf && a.price > p2.sl) {
            const pnl = (a.price - p2.entryPrice) * p2.units;
            toClose.push({ ...p2, status: "AI-EXIT", closePrice: a.price, closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now(), pnl });
            setBal(b => { const n = +(b + p2.amount + pnl).toFixed(2); balRefCur.current = n; return n; });
            toast(`🤖 IA fechou ${a.sym} (sinal mudou) ${sign(pnl)}${eur(pnl)}`, pnl >= 0 ? "success" : "warn");
            return;
          }

          if (a.price <= p2.sl) {
            const pnl = (p2.sl - p2.entryPrice) * p2.units;
            // Se o SL está acima da entrada, este fecho protegeu lucro → TRAIL.
            // (não depende do toggle estar ligado neste instante)
            const wasTrail = p2.sl > pos.entryPrice;
            toClose.push({ ...p2, status: wasTrail ? "TRAIL" : "SL", closePrice: p2.sl, closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now(), pnl });
            setBal(b => { const n = +(b + p2.amount + pnl).toFixed(2); balRefCur.current = n; return n; });
            toast(`${wasTrail ? "📈 Trailing" : "🛑 SL"} ${a.sym} — ${sign(pnl)}${eur(pnl)}`, pnl >= 0 ? "success" : "warn");
          } else if (a.price >= p2.tp) {
            const pnl = (p2.tp - p2.entryPrice) * p2.units;
            toClose.push({ ...p2, status: "TP", closePrice: p2.tp, closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now(), pnl });
            setBal(b => { const n = +(b + p2.amount + pnl).toFixed(2); balRefCur.current = n; return n; });
            toast(`✅ TP ${a.sym} +${eur(pnl)}`, "success");
          } else {
            toKeep.push(p2);
          }
        });
        if (toClose.length) {
          setClsd(p => [...toClose, ...p]);
          setPos(toKeep);
          if (isSim) simPosRef.current = toKeep;
          // Trades de day trading fechados → refletir na lista do dia + P&L do dia
          const dtClosed = toClose.filter(t => t.stratId === "daytrading");
          if (dtClosed.length) {
            setDtTrades(prev => prev.map(t => {
              const m = dtClosed.find(c => c.id === t.id);
              return m ? { ...t, status: m.status, closePrice: m.closePrice, pnl: m.pnl } : t;
            }));
            setDtDailyPnl(prev => +(prev + dtClosed.reduce((s, c) => s + (c.pnl || 0), 0)).toFixed(2));
          }
          // Persistir no Firestore — só em paper/live (a simulação local é
          // visual-only; o bot é a fonte de verdade e evita escritas constantes).
          if (user && !isSim) {
            import("./firebase.js").then(({ updateTrade, saveSetting }) => {
              toClose.forEach(t => updateTrade(user.uid, t.id, {
                status: t.status, closePrice: t.closePrice, pnl: t.pnl, closedAt: t.closedAt,
              }).catch(() => {}));
              saveSetting(user.uid, "liveBalance", balRefCur.current).catch(() => {});
            }).catch(() => {});
          }
        } else if (trailingOn) {
          // Sem fechos, mas o trailing stop pode ter movido SLs → persistir alterações
          setPos(toKeep);
          if (isSim) simPosRef.current = toKeep;
        }

        // 3. Strategy signals — corre no modo ativo (SIM ou LIVE).
        //    Em LIVE corre sempre. Em SIM corre se a simulação foi iniciada (Começar)
        //    OU se o Auto-Investir está ativo (a IA investe sem precisares de carregar).
        const autoOn = settingsRef.current?.autoInvestir;
        const simRunning = isSim ? (!!simStartedRef.current || !!autoOn) : true;
        if (simRunning) {
          const maxStrat = settingsRef.current?.maxEstrategias ?? 5;
          const stratOpen = (isSim ? simPosRef.current : posRef.current)
            .filter(p => p.stratId && p.stratId !== "manual" && p.stratId !== "daytrading" && p.stratId !== "ai-brain").length;
          let openedThisTick = 0;
          stratRef.current.filter(s => s.ativo).forEach(s => {
            s.ativos.forEach(aid => {
              const key = `${s.id}_${aid}`;
              if ((cds.current[key] || 0) > 0) { cds.current[key]--; return; }
              const a = upd.find(x => x.id === aid);
              if (!a) return;
              if (stratOpen + openedThisTick >= maxStrat) return; // limite global atingido
              // Limite por ativo: no máximo 3 posições de estratégia no mesmo ativo,
              // para evitar que um só ativo (ex.: ADA) ocupe todos os slots — sete
              // entradas iguais no mesmo ativo são, na prática, uma aposta grande só.
              const sameAssetOpen = (isSim ? simPosRef.current : posRef.current)
                .filter(p => p.assetId === aid && p.stratId && p.stratId !== "manual" && p.stratId !== "daytrading").length;
              if (sameAssetOpen >= 3) return;
              // Máximo de referência: o maior entre o rolling-high e o pico do histórico visível.
              const histHigh = a.hist.length ? Math.max(...a.hist.map(pt => pt.v)) : a.price;
              const high     = Math.max(highs.current[aid]?.p || a.price, histHigh);
              const dropPct  = ((high - a.price) / high) * 100;
              const balNow   = balRefCur.current;
              const _cfg = (simModeRef.current ? settingsRef.current : liveSettingsRef.current) || {};
              const _cf  = (_cfg.catAjuste && typeof _cfg.catAjuste[a.cat] === "number" && _cfg.catAjuste[a.cat] > 0) ? _cfg.catAjuste[a.cat] : 1;
              const _compra = Math.min(15, Math.max(0.1, s.compra * _cf));
              if (dropPct >= _compra && balNow >= s.perTrade) {
                const units = +(s.perTrade / a.price).toFixed(7);
                const _sl = Math.min(60, Math.max(0.3, s.sl * _cf));
                const _tp = Math.min(60, Math.max(0.3, s.tp * _cf));
                const sl    = +(a.price * (1 - _sl / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
                const tp    = +(a.price * (1 + _tp / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
                const pos   = {
                  id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
                  entryPrice: a.price, units, amount: s.perTrade, peak: a.price,
                  strategy: s.nome, stratId: s.id, sl, tp,
                  openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
                  mode: isSim ? "sim" : "live",
                };
                setPos(p => { const next = [...p, pos]; if (isSim) simPosRef.current = next; return next; });
                setBal(b => { const n = +(Math.max(0, b - s.perTrade)).toFixed(2); balRefCur.current = n; return n; });
                setStrategies(p => p.map(x => x.id === s.id ? { ...x, trades: x.trades + 1 } : x));
                cds.current[key] = 22;
                openedThisTick++;
                // Simulação LOCAL é visual-only: não persiste no Firestore (o bot
                // é a fonte de verdade). Evita escritas constantes a cada tick.
                // if (user) import("./firebase.js").then(({ saveTrade }) => saveTrade(user.uid, pos).catch(()=>{})).catch(()=>{});
                toast(`📈 ${isSim ? "[SIM] " : ""}BUY ${a.sym} @$${a.price.toFixed(2)} · "${s.nome}"`, "buy");
              }
            });
          });
        }

        // 4. Cérebro AI autónomo — entra sozinho quando a IA dá COMPRAR com confiança ≥ slider.
        //    Respeita o mesmo gate de "simRunning" e o limite de posições de estratégia.
        if (simRunning && cfg.aiBrain) {
          const minConf  = cfg.aiBrainConfianca || 78;
          const maxBrain = cfg.maxAiBrain ?? 3;
          const poolNow  = isSim ? simPosRef.current : posRef.current;
          const brainOpen = poolNow.filter(p => p.stratId === "ai-brain").length;
          const perTrade  = calcTradeAmount();
          let openedBrain = 0;
          Object.values(sigs).forEach(sg => {
            if (!sg || sg.sinal !== "COMPRAR" || (sg.confianca || 0) < minConf) return;
            const a = upd.find(x => x.id === sg.id);
            if (!a || !isTradeable(a.id)) return; // só ativos negociáveis (lista do bot)
            const key = `aibrain_${sg.id}`;
            if ((cds.current[key] || 0) > 0) { cds.current[key]--; return; }
            // não duplicar posição no mesmo ativo
            if (poolNow.some(p => p.assetId === sg.id && p.stratId === "ai-brain")) return;
            if (brainOpen + openedBrain >= maxBrain) return;
            if (balRefCur.current < perTrade) return;
            const slPct = cfg.stopLossPadrao || 6;
            const tpPct = cfg.takeProfitPadrao || 12;
            const _cfB = (cfg.catAjuste && typeof cfg.catAjuste[a.cat] === "number" && cfg.catAjuste[a.cat] > 0) ? cfg.catAjuste[a.cat] : 1;
            const units = +(perTrade / a.price).toFixed(7);
            const _slB = Math.min(60, Math.max(0.3, slPct * _cfB));
            const _tpB = Math.min(60, Math.max(0.3, tpPct * _cfB));
            const sl    = +(a.price * (1 - _slB / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
            const tp    = +(a.price * (1 + _tpB / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
            const pos   = {
              id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
              entryPrice: a.price, units, amount: perTrade, peak: a.price,
              strategy: `🤖 AI Brain (${sg.confianca}%)`, stratId: "ai-brain", aiSource: "groq", sl, tp,
              openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
              mode: isSim ? "sim" : "live",
            };
            setPos(p => { const next = [...p, pos]; if (isSim) simPosRef.current = next; return next; });
            setBal(b => { const n = +(Math.max(0, b - perTrade)).toFixed(2); balRefCur.current = n; return n; });
            cds.current[key] = 30; // cooldown ~60s por ativo
            openedBrain++;
            // Simulação local visual-only: não persiste (bot é a fonte de verdade).
            // if (user) import("./firebase.js").then(({ saveTrade }) => saveTrade(user.uid, pos).catch(()=>{})).catch(()=>{});
            toast(`🤖 ${isSim ? "[SIM] " : ""}AI comprou ${a.sym} @$${a.price.toFixed(2)} · confiança ${sg.confianca}%`, "buy");
          });
        }

        return t;
      });
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  // ── Derived — respeita o modo atual (SIM ou LIVE) ──
  const activePositions = simMode ? simPositions : positions;
  const activeClosed    = simMode ? simClosed    : closed;
  const activeBalance   = simMode ? simBalance   : balance;
  const invested    = activePositions.reduce((s, p) => s + p.amount, 0);
  const unrealized  = activePositions.reduce((s, p) => {
    const a = resolveAsset(p);
    if (!a) return s;
    const bruto = (a.price - p.entryPrice) * p.units;
    // Desconta a comissão round-trip estimada → P&L líquido, coerente com os
    // trades fechados (que já mostram líquido). Evita "greens" otimistas.
    const fee = roundTripFeeApp(p, p.amount);
    return s + (bruto - fee);
  }, 0);
  const realized    = activeClosed.reduce((s, p) => s + (p.pnl || 0), 0);
  const totalPnl    = unrealized + realized;
  const portfolioV  = activeBalance + invested + unrealized;
  const winRate     = activeClosed.length ? (activeClosed.filter(p => p.pnl > 0).length / activeClosed.length) * 100 : null;

  // ── Estatísticas avançadas de trading (a partir dos trades fechados + capital base) ──
  const tradeStats = (() => {
    const trades = [...activeClosed].filter(t => typeof t.pnl === "number");
    const capBase = simMode ? (simCapital || 1000) : (liveSettings.capitalTotal || 1000);
    if (trades.length === 0) {
      return { count: 0, capBase, equity: [{ i: 0, v: capBase }] };
    }
    // Ordenar por hora de fecho (mais antigo primeiro) para construir a curva de equity
    const ordered = [...trades].reverse(); // activeClosed guarda o mais recente primeiro
    const wins   = ordered.filter(t => t.pnl > 0);
    const losses = ordered.filter(t => t.pnl <= 0);
    const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const net       = grossWin - grossLoss;
    const avgWin    = wins.length   ? grossWin  / wins.length   : 0;
    const avgLoss   = losses.length ? grossLoss / losses.length : 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
    const expectancy   = net / ordered.length;
    const bestTrade  = Math.max(...ordered.map(t => t.pnl));
    const worstTrade = Math.min(...ordered.map(t => t.pnl));
    // Curva de equity + max drawdown
    let eq = capBase, peak = capBase, maxDD = 0;
    const equity = [{ i: 0, v: capBase }];
    ordered.forEach((t, i) => {
      eq += t.pnl;
      equity.push({ i: i + 1, v: +eq.toFixed(2) });
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    });
    // Sequências (streaks)
    let curStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
    ordered.forEach(t => {
      if (t.pnl > 0) { curStreak = curStreak >= 0 ? curStreak + 1 : 1; maxWinStreak = Math.max(maxWinStreak, curStreak); }
      else           { curStreak = curStreak <= 0 ? curStreak - 1 : -1; maxLossStreak = Math.max(maxLossStreak, -curStreak); }
    });
    // Sharpe simplificado: média/desvio-padrão dos retornos por trade
    const rets = ordered.map(t => t.pnl / capBase);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(rets.length) : 0;
    return {
      count: ordered.length, capBase, wins: wins.length, losses: losses.length,
      grossWin, grossLoss, net, avgWin, avgLoss, profitFactor, expectancy,
      bestTrade, worstTrade, maxDD, equity, maxWinStreak, maxLossStreak, sharpe,
      winRate: (wins.length / ordered.length) * 100,
    };
  })();

  // ── Perfil recomendado: deriva dos TEUS números reais, não de opinião ─────────
  // A ideia: cada perfil precisa de um win rate mínimo para empatar (breakeven).
  // O teu win rate REAL observado em paper diz quais perfis são sequer viáveis.
  // Recomendamos o perfil viável com melhor expectativa esperada, dado o teu WR.
  // Atualiza-se sozinho à medida que acumulas trades — é honesto e adaptativo.
  const perfilRecomendado = (() => {
    const CUSTO = 0.2; // % round-trip (comissão + slippage estimado)
    const PERFIS = {
      conservador: { sl: 4, tp: 8,  compra: 2.5, label: "Conservador", emoji: "🛡️" },
      moderado:    { sl: 6, tp: 12, compra: 1.5, label: "Moderado",     emoji: "⚖️" },
      agressivo:   { sl: 9, tp: 18, compra: 0.8, label: "Agressivo",    emoji: "🚀" },
      scalper:     { sl: 3, tp: 4,  compra: 1.0, label: "Scalper",      emoji: "🎯" },
      equilibrado: { sl: 5, tp: 6,  compra: 1.5, label: "Equilibrado",  emoji: "⚡" },
      volatil:     { sl: 8, tp: 10, compra: 2.0, label: "Cripto Volátil",emoji: "🌊" },
    };
    const breakeven = (sl, tp) => ((sl + CUSTO) / (sl + tp)) * 100; // % WR p/ empatar
    const wrReal = tradeStats.count > 0 ? tradeStats.winRate : null; // % observado
    const n = tradeStats.count;

    // Para cada perfil, expectativa ESPERADA usando o TEU win rate real:
    //   exp = WR·avgWin − (1−WR)·avgLoss − custo
    // Sem avgWin/avgLoss reais (poucos trades), usamos os TP/SL do perfil como proxy.
    const avgW = tradeStats.avgWin  || null;
    const avgL = tradeStats.avgLoss || null;
    const scored = Object.entries(PERFIS).map(([id, p]) => {
      const be = breakeven(p.sl, p.tp);
      // Expectativa esperada por trade (em % do valor investido), dado o WR real.
      // Se temos avgWin/avgLoss reais (€), usamo-los; senão, proxy pelos TP/SL.
      let expPct;
      if (wrReal != null) {
        const wr = wrReal / 100;
        if (avgW != null && avgL != null && tradeStats.count >= 10) {
          // Em €: normaliza por valor médio (proxy: avgWin+avgLoss serve de escala)
          expPct = wr * p.tp - (1 - wr) * p.sl - CUSTO; // usa TP/SL do perfil c/ WR real
        } else {
          expPct = wr * p.tp - (1 - wr) * p.sl - CUSTO;
        }
      } else {
        expPct = null;
      }
      const viavel = wrReal != null ? wrReal >= be : null;
      return { id, ...p, breakeven: be, expPct, viavel };
    });

    // Escolha: entre os viáveis, o de maior expectativa. Se nenhum viável, o de
    // menor breakeven (o menos exigente — o "menos mau" dado o WR atual).
    let escolha;
    if (wrReal == null || n < 5) {
      escolha = null; // dados insuficientes
    } else {
      const viaveis = scored.filter(s => s.viavel);
      escolha = viaveis.length
        ? viaveis.reduce((a, b) => (b.expPct > a.expPct ? b : a))
        : scored.reduce((a, b) => (b.breakeven < a.breakeven ? b : a));
    }
    return { escolha, scored, wrReal, n, atual: (liveSettings.riscoPerfil || "moderado").toLowerCase() };
  })();


  const heldAssetIds = new Set(activePositions.map(p => p.assetId));
  // VENDER só faz sentido se tiveres o ativo; caso contrário mostra AGUARDAR
  const normSignal = (assetId, sinal) =>
    sinal === "VENDER" && !heldAssetIds.has(assetId) ? "AGUARDAR" : sinal;

  // ── AI: Create strategy ──
  const createStrategy = async () => {
    if (!objective.trim() || aiLoading) return;
    setAiLoading(true);
    try {
      const { result: obj2, cost: c2 } = await callAI({
        max_tokens: 900,
        system: "És um gestor de investimentos quantitativo. Responde SEMPRE com JSON puro válido, sem markdown nem texto exterior.",
        messages: [{ role: "user", content:
`Cria uma estratégia automática de trading para este objetivo:
"${objective}"

Ativos disponíveis (usa os IDs exatos):
btc (Bitcoin), eth (Ethereum), wti (Petróleo WTI), gold (Ouro), silver (Prata), spy (S&P500 ETF), qqq (Nasdaq ETF), eurusd (EUR/USD)

Regras de negócio:
• compra: disparada quando o preço cai X% do máximo recente dos últimos 2 min
• perTrade: valor EUR por ordem individual (100–500)
• sl e tp em percentagem sobre o preço de entrada

Formato de resposta (JSON puro):
{
  "nome": "nome curto máx 22 chars",
  "descricao": "descrição 2 frases pt",
  "logica": "explicação da lógica de entrada/saída em 1 frase pt",
  "ativos": ["btc","eth"],
  "compra": 1.8,
  "perTrade": 200,
  "sl": 8,
  "tp": 15,
  "prazo": "7 dias",
  "risco": "ALTO"
}` }],
      });
      setAiCost(p => +(p + c2).toFixed(4));
      // ── Saneamento da estratégia gerada pela IA ──
      const validIds = ASSETS.map(a => a.id);
      let ativosOk = Array.isArray(obj2.ativos) ? obj2.ativos.filter(id => validIds.includes(id)) : [];
      // Se a IA devolveu ativos genéricos (btc/eth) mas o NOME da estratégia indica
      // outro ativo, infere o ativo certo a partir do nome/descrição. Evita que a
      // "Prata" ou "Gás Natural" fiquem com BTC/ETH.
      const txt = `${obj2.nome || ""} ${obj2.descricao || ""}`.toLowerCase();
      const nameMatch = ASSETS.find(a =>
        txt.includes(a.name.toLowerCase()) || txt.includes(a.sym.toLowerCase())
      );
      if (nameMatch && !ativosOk.includes(nameMatch.id)) {
        // O ativo do nome manda: substitui os genéricos.
        ativosOk = [nameMatch.id];
      }
      if (ativosOk.length === 0) ativosOk = nameMatch ? [nameMatch.id] : ["btc", "eth"];
      // Queda de compra: limitar a 0.5–3% para garantir que dispara em tempo útil
      let compraOk = Number(obj2.compra);
      if (!compraOk || isNaN(compraOk)) compraOk = 1.5;
      compraOk = Math.min(3, Math.max(0.5, compraOk));
      // perTrade: dentro do capital atual (não maior que ~30% do saldo da simulação)
      const capRef = simModeRef.current ? simBalRef.current : balRef.current;
      let perTradeOk = Number(obj2.perTrade) || 100;
      perTradeOk = Math.min(perTradeOk, Math.max(10, +(capRef * 0.3).toFixed(0)));
      const s = {
        ...obj2,
        ativos: ativosOk,
        compra: compraOk,
        perTrade: perTradeOk,
        sl: Number(obj2.sl) || 6,
        tp: Number(obj2.tp) || 12,
        id: uid(), objetivo: objective, trades: 0, ativo: true,
        criado: new Date().toLocaleString("pt-PT"),
      };
      if (user) import("./firebase.js").then(({ saveStrategy }) => saveStrategy(user.uid, s).catch(()=>{}));
      setStrategies(p => [s, ...p]);
      setObjective("");
      toast(`✦ Estratégia "${s.nome}" criada!`, "success");
    } catch (e) { toast(`Erro: ${e.message}`, "error"); }
    setAiLoading(false);
  };

  // ── AI: Analyse market ──
  const analyseMarket = async () => {
    if (aiLoading) return;
    setAiLoading(true);
    try {
      // Group assets by category — filtra pelas categorias selecionadas
      const catsToUse = analyseCats.length > 0 ? analyseCats : ["Crypto","Commodity","ETF","Forex"];
      const byCategory = {};
      assets.filter(a => catsToUse.includes(a.cat)).forEach(a => {
        if (!byCategory[a.cat]) byCategory[a.cat] = [];
        byCategory[a.cat].push(`${a.name}(${a.sym}):$${fmt(a.price,a.id)}(${pctFmt(a.change)})`);
      });
      const lines = Object.entries(byCategory)
        .map(([cat, items]) => `=== ${cat} ===\n${items.join(", ")}`)
        .join("\n");
      const { result, cost: c3 } = await callAI({
        max_tokens: 2000,
        system: "És um analista de mercados financeiros. Responde SEMPRE com JSON puro válido, sem markdown nem texto exterior.",
        messages: [{ role: "user", content:
`Analisa estes mercados por categoria e dá as TOP recomendações para um investidor português.
Saldo: €${activeBalance.toFixed(0)} | Posições: ${activePositions.length} | P&L não realizado: €${unrealized.toFixed(2)}

Preços agrupados por categoria${liveData ? " (crypto em tempo real)" : " (simulados)"}:
${lines}

Para CADA categoria seleciona os 6 ativos com maior potencial AGORA (exatamente até 6 por categoria, prioriza os de maior movimento).
Para cada um dá "previsao" = frase simples sobre próximos 1-5 dias em português.

JSON puro — inclui TODOS os ativos relevantes de TODAS as categorias:
{
  "resumo": "análise geral do mercado hoje em 2 frases simples pt",
  "oportunidade": "melhor oportunidade global agora em 1 frase pt",
  "risco": "BAIXO|MÉDIO|ALTO",
  "melhor": "id do melhor ativo global",
  "recs": [
    {
      "id": "btc",
      "sinal": "COMPRAR|VENDER|AGUARDAR",
      "confianca": 78,
      "entrada": 67000,
      "sl": 60300,
      "tp": 77050,
      "razao": "explicação simples 1-2 frases pt sem jargão técnico",
      "previsao": "o que esperas nos próximos dias em 1 frase pt",
      "horizonte": "2-4 dias"
    }
  ]
}` }],
      });
      setAiCost(p => +(p + c3).toFixed(4));
      setAiRec(result);
      toast("✦ Análise concluída!", "success");
    } catch (e) { toast(`Erro: ${e.message}`, "error"); }
    setAiLoading(false);
  };

  // ─────────────────────────────────────────────
  // RENDER: DASHBOARD
  // ─────────────────────────────────────────────
  const Dashboard = () => {
    const myPositions = activePositions;
    const hasPositions = myPositions.length > 0;
    const capitalInicialDisplay = simMode ? (settings.capitalTotal || simCapital) : (liveSettings.capitalTotal || 1000);
    const activeStrats = strategies.filter(s => s.ativo);

    // ── Posições agrupadas por origem ────────────────────────────────────────
    // Vista de "onde está o meu dinheiro": cada posição aberta é classificada
    // pela sua origem. As órfãs (estratégia apagada) são destacadas porque são
    // o caso que pode passar despercebido — mas o bot gere todas na mesma.
    const stratIds = new Set(strategies.map(s => s.id));
    const stratNomes = new Map(strategies.map(s => [s.id, s.nome]));
    const origemDe = (p) => {
      if (p.stratId === "dca")        return { key: "dca", label: p.planNome ? `DCA · ${p.planNome}` : "DCA", icon: "🎯", cor: T.accent };
      if (p.stratId === "daytrading") return { key: "daytrade", label: "Day Trading", icon: "⚡", cor: T.gold };
      if (p.stratId === "manual")     return { key: "manual",   label: "Compras manuais", icon: "✋", cor: T.accent };
      if (p.stratId === "ai-brain")   return p.aiSource === "tecnico"
        ? { key: "aitecnico", label: "Cérebro AI (técnico)", icon: "🧮", cor: T.blue }
        : { key: "aibrain",  label: "Cérebro AI", icon: "🤖", cor: T.aLight };
      if (p.stratId && stratIds.has(p.stratId)) return { key: "estrategia", label: "Estratégias", icon: "📊", cor: T.green };
      return { key: "orfa", label: "Órfãs (estratégia apagada)", icon: "🔗", cor: T.gold }; // sem stratId ou estratégia inexistente
    };
    const pnlDe = (p) => {
      const a = assets.find(x => x.id === p.assetId);
      const price = a?.price || p.entryPrice;
      return (price - p.entryPrice) * p.units - roundTripFeeApp(p, p.amount);
    };
    const grupos = {};
    activePositions.forEach(p => {
      const o = origemDe(p);
      if (!grupos[o.key]) grupos[o.key] = { ...o, n: 0, investido: 0, pnl: 0, posicoes: [] };
      grupos[o.key].n += 1;
      grupos[o.key].investido += (p.amount || 0);
      grupos[o.key].pnl += pnlDe(p);
      grupos[o.key].posicoes.push(p);
    });
    // Ordem de apresentação: órfãs primeiro (atenção), depois o resto por valor.
    const ordemGrupos = Object.values(grupos).sort((a, b) => {
      if (a.key === "orfa") return -1;
      if (b.key === "orfa") return 1;
      return b.investido - a.investido;
    });
    const orfas = grupos.orfa?.posicoes || [];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* ── Hero DCA: destaque do núcleo (valor total investido em planos + P&L) ── */}
        {(() => {
          const posDca = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca");
          if (!posDca.length) return null;
          const inv = posDca.reduce((a, x) => a + (x.amount || 0), 0);
          const val = posDca.reduce((a, x) => { const px = assets.find(z => z.id === x.assetId); return a + (px ? x.units * px.price : (x.amount || 0)); }, 0);
          const pl = val - inv;
          const pct = inv > 0 ? (pl / inv) * 100 : 0;
          const cor = pl >= 0 ? T.green : T.red;
          const nPlanos = Array.isArray(liveSettings.dcaPlanos) ? liveSettings.dcaPlanos.filter(p => p.dataInicio).length : 0;
          return (
            <Glass glow style={{ padding: "24px 28px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>🎯 A tua carteira DCA</div>
                  <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.1, background: T.gradGreen, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>€{val.toFixed(2)}</div>
                  <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{nPlanos} plano(s) · investido €{inv.toFixed(0)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10.5, color: T.muted, textTransform: "uppercase" }}>Lucro / Prejuízo</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: cor }}>{pl >= 0 ? "+" : ""}€{pl.toFixed(2)}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: cor, background: `${cor}15`, padding: "2px 10px", borderRadius: 6, display: "inline-block", marginTop: 4 }}>{pl >= 0 ? "+" : ""}{pct.toFixed(2)}%</div>
                </div>
              </div>
            </Glass>
          );
        })()}

        {/* ── Modo de operação: DCA (sempre) + toggle AI Trade ── */}
        {(() => {
          const s = liveSettings;
          const nPlanos = Array.isArray(s.dcaPlanos) ? s.dcaPlanos.length : 0;
          const temPlano = nPlanos > 0 || (Array.isArray(s.dcaCarteira) && s.dcaCarteira.length > 0);
          // Estado efetivo: uma fonte só está "a correr" se o mestre estiver ON
          // E a sua flag estiver ON (opção C). aiTradeAtivo (legado) força tudo.
          const mestreOn = s.aiTradeAtivo || !!s.aiBrainMestre;
          const ef = (k) => mestreOn && (s.aiTradeAtivo || !!s[k]);
          const fontes = [
            { key: "aiEstrategias",    icon: "📊", nome: "Estratégias" },
            { key: "aiManualAutonomo", icon: "🤖", nome: "Compras autónomas" },
            { key: "aiDayTrading",     icon: "⚡", nome: "Day Trading" },
          ];
          const algumOn = fontes.some(f => ef(f.key));
          const Estado = ({ ativo }) => (
            <span style={{ fontSize: 10, fontWeight: 700, color: ativo ? T.green : T.muted }}>{ativo ? "● Ativo" : "○ Desativado"}</span>
          );
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* DCA — núcleo */}
              <Glass style={{ padding: "16px 20px", background: `${T.green}0a`, border: `1px solid ${T.green}33` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>🎯 DCA (núcleo) — sempre a funcionar</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: s.dcaAtivo && temPlano ? T.green : T.gold }}>
                    {s.dcaAtivo && temPlano ? "● ATIVO" : temPlano ? "desligado" : "sem plano"}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
                  {temPlano
                    ? `${nPlanos > 0 ? nPlanos + " plano(s)" : "Plano"} ativo(s), €${s.dcaValorMensal || 0}/período repartido por objetivos. O núcleo passivo nunca para.`
                    : "Ainda sem planos. Vai a 'Plano DCA' para criar com ajuda da IA."}
                </div>
                {manualOrders.length > 0 && (
                  <div onClick={() => setTab("dca")} style={{ fontSize: 10.5, color: T.gold, marginTop: 8, cursor: "pointer", fontWeight: 700, background: `${T.gold}15`, padding: "6px 10px", borderRadius: 6 }}>
                    🔔 {manualOrders.length} compra(s) DCA à tua espera — clica para confirmar
                  </div>
                )}
                <div onClick={() => setTab("dca")} style={{ fontSize: 10, color: T.accent, marginTop: 8, cursor: "pointer", fontWeight: 600 }}>Abrir Plano DCA →</div>
              </Glass>

              {/* Trading ativo — INDICADOR de estado (read-only). Controlos nas Definições. */}
              <Glass style={{ padding: "16px 20px", background: algumOn ? `${T.gold}08` : "transparent", border: `1px solid ${algumOn ? T.gold + "33" : T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>⚡ Trading ativo</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: mestreOn ? T.gold : T.muted }}>AI Brain: {mestreOn ? "● Ativado" : "○ Desativado"}</span>
                </div>
                {mestreOn ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {fontes.map(f => (
                      <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
                        <span style={{ fontSize: 14 }}>{f.icon}</span>
                        <span style={{ flex: 1, fontWeight: 600 }}>{f.nome}</span>
                        <Estado ativo={ef(f.key)} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
                    Desligado. O AI Brain é a chave-mestra do trading ativo — liga-o nas Definições para desbloquear Estratégias, Compras Autónomas e Day Trading. Com ele desligado, só o DCA passivo corre.
                  </div>
                )}
                <div onClick={() => setTab("settings")} style={{ fontSize: 10, color: T.accent, marginTop: 10, cursor: "pointer", fontWeight: 600 }}>Gerir nas Definições →</div>
              </Glass>
            </div>
          );
        })()}

        {/* Estado do bot 24/7 */}
        {botAtivo ? (
          <div style={{
            display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderRadius:12,
            background: botPaused ? `${T.gold}10` : `${T.green}10`, border:`1px solid ${botPaused ? T.gold : T.green}33`,
          }}>
            <div style={{ width:9, height:9, borderRadius:"50%", background: botPaused ? T.gold : T.green, animation: botPaused ? "none" : "pulse 1.2s infinite", flexShrink:0 }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:700, color: botPaused ? T.gold : T.green }}>
                {botPaused ? "⏸ Bot pausado — sem novas entradas" : "🤖 Bot 24/7 ativo — a operar no servidor"}
              </div>
              <div style={{ fontSize:10, color:T.muted, marginTop:2 }}>
                {botPaused
                  ? "As posições abertas continuam protegidas (SL/TP e vendas). Não abre novas. Ideal antes de um deploy."
                  : "As tuas posições são geridas no servidor, mesmo com a app fechada."}
                {!botPaused && botStatus?.features?.aiBrain && (botStatus?.features?.aiBrainFallback ? " · Cérebro AI (modo técnico)" : " · Cérebro AI ON")}
                {!botPaused && botStatus?.features?.trailingStop && " · Trailing Stop ON"}
              </div>
            </div>
            <button
              onClick={() => {
                if (!user) { toast("Inicia sessão para controlar o bot", "error"); return; }
                const next = !botPaused;
                setBotPaused(next);
                import("./firebase.js").then(({ saveSetting }) =>
                  saveSetting(user.uid, "botControl", { paused: next, updatedAt: Date.now() }).catch(()=>{}));
                toast(next ? "⏸ Bot pausado — sem novas entradas" : "▶ Bot retomado", next ? "warn" : "success");
              }}
              style={{
                flexShrink:0, background: botPaused ? `${T.green}18` : `${T.gold}18`,
                border:`1px solid ${botPaused ? T.green : T.gold}55`, color: botPaused ? T.green : T.gold,
                borderRadius:8, padding:"7px 14px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap",
              }}>
              {botPaused ? "▶ Retomar" : "⏸ Pausar"}
            </button>
            <span style={{ fontSize:9, color:T.muted }}>visto {Math.round((Date.now()-botStatus.lastSeen)/1000)}s atrás</span>
          </div>
        ) : (() => {
          // Diagnóstico do motivo de estar offline (a app infere a partir do Firestore)
          const seenMs   = botStatus?.lastSeen ? Date.now() - botStatus.lastSeen : null;
          const agoTxt   = seenMs == null ? null
            : seenMs < 90000      ? `${Math.round(seenMs/1000)}s`
            : seenMs < 3600000    ? `${Math.round(seenMs/60000)} min`
            : `${Math.round(seenMs/3600000)}h`;
          const modeTxt  = simMode ? "Simulação" : (botModoReal ? "DINHEIRO REAL" : "Paper");

          let titulo, detalhe;
          if (!botStatus) {
            // Nunca recebeu nenhum heartbeat
            titulo  = "Bot 24/7 offline — nunca recebeu sinal";
            detalhe = "A app ainda não viu nenhum heartbeat do bot. Causas comuns: o USER_UID no Railway não é igual ao teu (Definições → Copiar UID), o deploy falhou, ou falta o FIREBASE_ADMIN_JSON. Confirma os Deploy Logs no Railway.";
          } else if (botHeartbeatRecente && !botModoBate) {
            // Bot vivo mas noutro modo
            titulo  = `Bot ativo em ${modoLabelBot(botStatus.mode)}, mas estás em ${modeTxt}`;
            detalhe = `O bot está a operar em modo ${modoLabelBot(botStatus.mode)}. Muda o toggle no topo para ${botStatus.mode === "sim" ? "Simulação" : "Live"} para o veres a gerir as posições aqui.`;
          } else {
            // Recebeu antes, mas o heartbeat está velho → parou/crashou
            titulo  = `Bot 24/7 offline — sem sinal há ${agoTxt}`;
            detalhe = "O bot já esteve ligado mas parou de responder (passou dos 3 min). Provavelmente crashou ou foi reiniciado. Vê os Deploy Logs no Railway e confirma que o serviço está 'Active'.";
          }

          return (
            <div style={{
              display:"flex", alignItems:"flex-start", gap:12, padding:"12px 18px", borderRadius:12,
              background:`${T.gold}0c`, border:`1px solid ${T.gold}28`,
            }}>
              <div style={{ width:9, height:9, borderRadius:"50%", background:T.gold, flexShrink:0, marginTop:4 }}/>
              <div style={{ fontSize:11, color:T.muted, lineHeight:1.55 }}>
                <b style={{ color:T.gold }}>{titulo}</b>
                <div style={{ marginTop:3 }}>{detalhe}</div>
                <div style={{ marginTop:3, fontSize:10, opacity:0.8 }}>
                  Enquanto offline, o trading só corre com esta app aberta.
                </div>
              </div>
            </div>
          );
        })()}
        {/* Saúde das APIs (vem do heartbeat do bot) */}
        {botStatus?.apiHealth && (() => {
          const h = botStatus.apiHealth;
          const agora = Date.now();
          const pill = (nome, estado, detalhe) => {
            const cor = estado === "ok" ? T.green
              : estado === "fail" ? T.red
              : estado === "limite" ? T.gold
              : estado === "off" ? T.muted
              : T.muted;
            const txt = estado === "ok" ? "OK"
              : estado === "fail" ? "Falha"
              : estado === "limite" ? "Limite"
              : estado === "off" ? "Desativado"
              : "—";
            return (
              <div key={nome} style={{
                display:"flex", alignItems:"center", gap:6, padding:"5px 10px",
                borderRadius:8, background:`${cor}10`, border:`1px solid ${cor}30`,
              }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:cor, flexShrink:0 }}/>
                <span style={{ fontSize:10, fontWeight:600 }}>{nome}</span>
                <span style={{ fontSize:9, color:cor, fontWeight:700 }}>{txt}</span>
                {detalhe && <span style={{ fontSize:9, color:T.muted }}>{detalhe}</span>}
              </div>
            );
          };
          const groqDet = h.groq?.rateLimited
            ? `pausado ${Math.max(0, Math.round((h.groq.untilMs - agora)/60000))}min`
            : null;
          const fonteEstado = (s) => s?.exhausted ? "limite" : s?.disabled ? "off" : s?.ok === true ? "ok" : s?.ok === false ? "fail" : "unknown";
          return (
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", padding:"0 4px" }}>
              <span style={{ fontSize:10, color:T.muted, marginRight:2 }}>APIs:</span>
              {pill("Cérebro AI (Groq)", h.groq?.ok ? "ok" : "fail", groqDet)}
              {pill("Binance", fonteEstado(h.binance), h.binance?.err && !h.binance?.disabled ? "rede" : null)}
              {pill("CoinGecko", fonteEstado(h.coingecko), h.coingecko?.err ? "rede" : null)}
              {h.twelvedata && (h.twelvedata.ok !== null || h.twelvedata.exhausted) && pill("TwelveData", fonteEstado(h.twelvedata), h.twelvedata?.exhausted ? "repõe amanhã" : h.twelvedata?.err ? "rede" : null)}
              {h.finnhub && (h.finnhub.ok !== null || h.finnhub.disabled) && pill("Finnhub", fonteEstado(h.finnhub), h.finnhub?.disabled ? "sem API key" : h.finnhub?.err ? "rede" : null)}
              {h.stooq && (h.stooq.ok !== null || h.stooq.disabled) && pill("Stooq", fonteEstado(h.stooq), h.stooq?.disabled ? "sem API key" : h.stooq?.err ? "rede" : null)}
            </div>
          );
        })()}
        {/* Posições por origem — onde está o teu dinheiro */}
        {activePositions.length > 0 && (
          <Glass style={{ padding: "16px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <SectionLabel>Posições por origem</SectionLabel>
              <span style={{ fontSize: 10, color: T.muted }}>{activePositions.length} aberta(s) · geridas pelo bot</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
              {ordemGrupos.map(g => {
                const ehOrfa = g.key === "orfa";
                return (
                  <div key={g.key} onClick={() => setTab("portfolio")} style={{
                    cursor: "pointer", borderRadius: 12, padding: "13px 15px",
                    background: ehOrfa ? `${T.gold}0e` : "rgba(255,255,255,0.03)",
                    border: `1px solid ${ehOrfa ? T.gold + "44" : T.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                      <span style={{ fontSize: 15 }}>{g.icon}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: ehOrfa ? T.gold : T.text }}>{g.label}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 18, fontWeight: 800 }}>€{g.investido.toFixed(2)}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: g.pnl >= 0 ? T.green : T.red }}>
                        {sign(g.pnl)}{eur(g.pnl)}
                      </span>
                    </div>
                    <div style={{ fontSize: 9, color: T.muted, marginTop: 3 }}>{g.n} posição(ões)</div>
                  </div>
                );
              })}
            </div>
            {orfas.length > 0 && (
              <div style={{ fontSize: 10, color: T.muted, marginTop: 11, lineHeight: 1.5, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                🔗 As <b style={{ color: T.gold }}>órfãs</b> são posições cuja estratégia foi apagada. O bot continua a geri-las normalmente (Stop-Loss, Take-Profit e saída por lucro) — só já não estão ligadas a nenhuma estratégia.
              </div>
            )}
          </Glass>
        )}
        {/* Hero */}
        <Glass style={{
          padding: "28px 32px",
          background: "linear-gradient(135deg,rgba(99,102,241,0.18) 0%,rgba(16,185,129,0.07) 100%)",
          border: "1px solid rgba(99,102,241,0.28)",
        }}>
          <div className="resp-hero" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 28 }}>
            <div>
              <div style={{ fontSize: 10, color: T.aLight, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8 }}>Portfólio Total</div>
              <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em" }}>
                {valoresEmUSD ? "$" : "€"}{portfolioV.toFixed(2)}
              </div>
              {valoresEmUSD && (
                <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
                  {fxEurUsd
                    ? <>≈ €{toEur(portfolioV).toFixed(2)} · valores na moeda do broker (USD) · 1€={fxEurUsd.toFixed(4)}$</>
                    : <>valores em USD (moeda do broker) · taxa EUR/USD indisponível</>}
                </div>
              )}
              {brokerBalances && Object.keys(brokerBalances).length > 0 && (
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:8 }}>
                  {Object.entries(brokerBalances).map(([bid, bal]) => (
                    <div key={bid} style={{
                      display:"flex", alignItems:"center", gap:6, padding:"4px 10px", borderRadius:8,
                      background:"rgba(255,255,255,0.05)", border:`1px solid ${T.border}`,
                    }}>
                      <span style={{ fontSize:10, color:T.muted, textTransform:"capitalize" }}>{bid}</span>
                      <span style={{ fontSize:12, fontWeight:700, color:T.text }}>€{(+bal).toFixed(2)}</span>
                    </div>
                  ))}
                  <div style={{
                    display:"flex", alignItems:"center", gap:6, padding:"4px 10px", borderRadius:8,
                    background:`${T.accent}12`, border:`1px solid ${T.accent}33`,
                  }}>
                    <span style={{ fontSize:10, color:T.aLight }}>Total brokers</span>
                    <span style={{ fontSize:12, fontWeight:800, color:T.text }}>
                      €{Object.values(brokerBalances).reduce((s,v)=>s+(+v||0),0).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
              <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ color: totalPnl >= 0 ? T.green : T.red, fontWeight: 700, fontSize: 15 }}>{sign(totalPnl)}{eur(totalPnl)}</span>
                <span style={{ color: T.muted, fontSize: 12 }}>capital configurado €{capitalInicialDisplay.toLocaleString()}</span>
              </div>
            </div>
            <KPI label="Disponível"      value={`€${activeBalance.toFixed(0)}`}      sub={`${capitalInicialDisplay>0?((activeBalance / capitalInicialDisplay) * 100).toFixed(0):0}% livre`} />
            <KPI label="P&L Não Realiz." value={`${sign(unrealized)}${eur(unrealized)}`} sub={`${activePositions.length} posições abertas`} color={unrealized >= 0 ? T.green : T.red} />
            <KPI label="P&L Realizado"   value={`${sign(realized)}${eur(realized)}`}     sub={`${activeClosed.length} trades fechados`}     color={realized >= 0 ? T.green : T.red} />
          </div>
        </Glass>

        {/* KPIs row */}
        <div className="resp-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
          {[
            { l: "Planos DCA", v: (Array.isArray(liveSettings.dcaPlanos) ? liveSettings.dcaPlanos.filter(p => p.dataInicio).length : 0), c: T.green },
            { l: "Estratégias Ativas", v: strategies.filter(s => s.ativo).length, c: T.accent },
            { l: "Total Trades",       v: activePositions.length + activeClosed.length, c: T.blue   },
            { l: "Win Rate",           v: winRate !== null ? `${winRate.toFixed(0)}%` : "—",   c: T.gold  },
            { l: "Capital Investido",  v: `€${invested.toFixed(0)}`,               c: T.aLight },
          ].map(m => (
            <Glass key={m.l} style={{ padding: "18px 20px" }}>
              <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 8 }}>{m.l}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: m.c }}>{m.v}</div>
            </Glass>
          ))}
          <Glass style={{ padding: "18px 20px", background: `${T.accent}08`, border: `1px solid ${T.accent}22` }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 4 }}>Custo AI Sessão</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.accent }}>€{aiCost.toFixed(4)}</div>
            <div style={{ fontSize: 9, color: T.muted, marginTop: 4 }}>~€0.007/chamada</div>
          </Glass>
        </div>

        {/* ── Perfil Recomendado (com base nos teus números reais) ── */}
        {(() => {
          const pr = perfilRecomendado;
          const corPerfil = p => ({ conservador: T.green, scalper: T.green, moderado: T.blue,
            equilibrado: T.blue, volatil: T.gold, agressivo: T.red }[p] || T.blue);

          // Sem dados suficientes: card informativo, sem cravar perfil.
          if (!pr.escolha) {
            return (
              <Glass style={{ padding: "18px 22px", background: `${T.blue}08`, border: `1px solid ${T.blue}22` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>🎯 Perfil Recomendado</div>
                <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
                  Ainda sem trades fechados suficientes ({pr.n}/5 mínimo) para recomendar com base nos teus números.
                  À medida que acumulas trades em paper, este card calcula automaticamente qual perfil é viável para o teu win rate real.
                  Para já, podes correr o backtester sobre histórico para escolher com dados.
                </div>
              </Glass>
            );
          }

          const e = pr.escolha;
          const ehAtual = e.id === pr.atual;
          const nenhumViavel = !pr.scored.some(s => s.viavel);
          return (
            <Glass style={{ padding: "20px 24px", background: `${corPerfil(e.id)}0c`, border: `1px solid ${corPerfil(e.id)}33` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>🎯 Perfil Recomendado</div>
                  <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
                    Calculado a partir do teu win rate real ({pr.wrReal.toFixed(0)}%) sobre {pr.n} trades fechados.
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 28 }}>{e.emoji}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: corPerfil(e.id) }}>{e.label}</div>
                </div>
              </div>

              {nenhumViavel && (
                <div style={{ fontSize: 10.5, color: T.red, marginBottom: 12, lineHeight: 1.55, background: `${T.red}10`, padding: "10px 12px", borderRadius: 8 }}>
                  ⚠️ Com o teu win rate atual ({pr.wrReal.toFixed(0)}%), <b>nenhum perfil</b> tem expectativa positiva matematicamente —
                  todos precisam de mais acertos do que tens. O <b>{e.label}</b> é o <b>menos exigente</b> (precisa de {e.breakeven.toFixed(0)}% para empatar),
                  mas o verdadeiro problema é o win rate baixo, não o perfil. Reduzir trades marginais e melhorar a seleção de entradas é o que mexe a agulha.
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 14 }}>
                {[
                  { l: "SL / TP", v: `${e.sl}% / ${e.tp}%`, c: T.aLight },
                  { l: "WR p/ empatar", v: `${e.breakeven.toFixed(0)}%`, c: e.breakeven >= 40 ? T.red : e.breakeven >= 33 ? T.gold : T.green },
                  { l: "Teu WR real", v: `${pr.wrReal.toFixed(0)}%`, c: pr.wrReal >= e.breakeven ? T.green : T.red },
                ].map(item => (
                  <div key={item.l}>
                    <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>{item.l}</div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: item.c }}>{item.v}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 10, color: T.muted }}>
                  {ehAtual
                    ? `Já estás neste perfil. ${nenhumViavel ? "Mas vê o aviso acima." : "É a escolha matematicamente mais sólida para os teus números."}`
                    : `Estás em ${pr.atual}. Mudar para ${e.label} alinha o perfil com o teu win rate real.`}
                </div>
                {!ehAtual && (
                  <button onClick={() => {
                    const docKey = botModoReal ? "realSettings" : "paperSettings";
                    const novo = { ...liveSettings, riscoPerfil: e.id, stopLossPadrao: e.sl, takeProfitPadrao: e.tp };
                    if (user) import("./firebase.js").then(({ saveSetting }) => {
                      saveSetting(user.uid, docKey, novo).catch(() => {});
                    });
                    toast(`🎯 Perfil alterado para ${e.label} (SL ${e.sl}% / TP ${e.tp}%)`, "success");
                  }} style={{
                    padding: "9px 18px", borderRadius: 9, border: `1px solid ${corPerfil(e.id)}`,
                    background: `${corPerfil(e.id)}1a`, color: corPerfil(e.id), fontWeight: 700,
                    fontSize: 12, cursor: "pointer",
                  }}>Aplicar {e.label}</button>
                )}
              </div>
            </Glass>
          );
        })()}

        {/* ── Estatísticas avançadas + curva de equity ── */}
        {tradeStats.count > 0 && (
          <Glass style={{ padding: "20px 24px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>📊 Estatísticas de Performance</div>
              <span style={{ fontSize: 10, color: T.muted }}>{tradeStats.count} trades fechados</span>
            </div>

            {/* Curva de equity */}
            {(() => {
              const eq = tradeStats.equity;
              const vals = eq.map(p => p.v);
              const min = Math.min(...vals), max = Math.max(...vals);
              const range = max - min || 1;
              const W = 100, H = 32;
              const pts = eq.map((p, i) => {
                const x = (i / (eq.length - 1 || 1)) * W;
                const y = H - ((p.v - min) / range) * H;
                return `${x.toFixed(2)},${y.toFixed(2)}`;
              }).join(" ");
              const up = vals[vals.length - 1] >= tradeStats.capBase;
              const col = up ? T.green : T.red;
              return (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>Curva de Capital</div>
                  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 90, display: "block" }}>
                    <defs>
                      <linearGradient id="eqgrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={col} stopOpacity="0.28" />
                        <stop offset="100%" stopColor={col} stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#eqgrad)" />
                    <polyline points={pts} fill="none" stroke={col} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
                  </svg>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:T.muted, marginTop:4 }}>
                    <span>Início €{tradeStats.capBase.toFixed(0)}</span>
                    <span style={{ color: col, fontWeight:700 }}>Atual €{vals[vals.length-1].toFixed(2)}</span>
                  </div>
                </div>
              );
            })()}

            {/* Grelha de métricas */}
            <div className="resp-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
              {[
                { l:"Profit Factor", v: tradeStats.profitFactor === Infinity ? "∞" : tradeStats.profitFactor.toFixed(2),
                  c: tradeStats.profitFactor >= 1.5 ? T.green : tradeStats.profitFactor >= 1 ? T.gold : T.red,
                  sub: tradeStats.profitFactor >= 1.5 ? "saudável" : tradeStats.profitFactor >= 1 ? "marginal" : "a perder" },
                { l:"Max Drawdown", v:`-${tradeStats.maxDD.toFixed(1)}%`,
                  c: tradeStats.maxDD <= 10 ? T.green : tradeStats.maxDD <= 25 ? T.gold : T.red, sub:"maior queda" },
                { l:"Expectativa", v:`${sign(tradeStats.expectancy)}€${Math.abs(tradeStats.expectancy).toFixed(2)}`,
                  c: tradeStats.expectancy >= 0 ? T.green : T.red, sub:"por trade" },
                { l:"Sharpe", v: tradeStats.sharpe.toFixed(2),
                  c: tradeStats.sharpe >= 1 ? T.green : tradeStats.sharpe >= 0 ? T.gold : T.red, sub:"retorno/risco" },
                { l:"Ganho Médio", v:`+€${tradeStats.avgWin.toFixed(2)}`, c:T.green, sub:`${tradeStats.wins} ganhos` },
                { l:"Perda Média", v:`-€${tradeStats.avgLoss.toFixed(2)}`, c:T.red, sub:`${tradeStats.losses} perdas` },
                { l:"Melhor Trade", v:`+€${tradeStats.bestTrade.toFixed(2)}`, c:T.green, sub:"maior ganho" },
                { l:"Pior Trade", v:`${sign(tradeStats.worstTrade)}€${Math.abs(tradeStats.worstTrade).toFixed(2)}`, c:T.red, sub:"maior perda" },
              ].map(m => (
                <div key={m.l} style={{ background:"rgba(0,0,0,0.18)", borderRadius:9, padding:"11px 13px" }}>
                  <div style={{ fontSize:8.5, color:T.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:5 }}>{m.l}</div>
                  <div style={{ fontSize:18, fontWeight:800, color:m.c }}>{m.v}</div>
                  <div style={{ fontSize:8.5, color:T.muted, marginTop:2 }}>{m.sub}</div>
                </div>
              ))}
            </div>

            {/* Sequências */}
            <div style={{ display:"flex", gap:14, marginTop:14, fontSize:11, color:T.muted }}>
              <span>🔥 Melhor sequência: <b style={{ color:T.green }}>{tradeStats.maxWinStreak} ganhos seguidos</b></span>
              <span>❄ Pior sequência: <b style={{ color:T.red }}>{tradeStats.maxLossStreak} perdas seguidas</b></span>
            </div>
          </Glass>
        )}

        {/* Estratégias ativas no dashboard */}
        {activeStrats.length > 0 && (
          <Glass style={{ padding: "18px 22px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              🎯 Estratégias Ativas ({activeStrats.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activeStrats.map(s => {
                const stratTrades = activeClosed.filter(t => t.stratId === s.id);
                const stratPnl    = stratTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
                const openForStrat = activePositions.filter(p => p.stratId === s.id);
                const openPnl = openForStrat.reduce((sum, p) => {
                  const a = resolveAsset(p);
                  return sum + (a ? (a.price - p.entryPrice) * p.units - roundTripFeeApp(p, p.amount) : 0);
                }, 0);
                const total = stratPnl + openPnl;
                return (
                  <div key={s.id} style={{
                    display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12,
                    padding: "10px 14px", borderRadius: 10,
                    background: total >= 0 ? `${T.green}08` : `${T.red}08`,
                    border: `1px solid ${total >= 0 ? T.green : T.red}20`, alignItems: "center", fontSize: 12,
                  }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{s.nome}</div>
                      <div style={{ fontSize: 10, color: T.muted, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                        <span>{(s.ativos||[]).join(", ").toUpperCase()} · {s.risco}</span>
                        {(() => {
                          const ativos = s.ativos || [];
                          if (!ativos.length) return null;
                          const abertos = ativos.filter(id => isMarketOpen(id)).length;
                          const m = abertos === 0          ? { t:"🔴 Mercado fechado", c:T.red }
                                  : abertos === ativos.length ? { t:"🟢 Mercado aberto",  c:T.green }
                                  :                             { t:`🟡 ${abertos}/${ativos.length} abertos`, c:T.gold };
                          return <span style={{ color:m.c, fontWeight:600 }}>· {m.t}</span>;
                        })()}
                      </div>
                    </div>
                    <div><div style={{ fontSize: 8, color: T.muted }}>POSIÇÕES</div><div style={{ fontWeight: 700, color: T.accent }}>{openForStrat.length}</div></div>
                    <div><div style={{ fontSize: 8, color: T.muted }}>TRADES</div><div style={{ fontWeight: 700 }}>{stratTrades.length + openForStrat.length}</div></div>
                    <div><div style={{ fontSize: 8, color: T.muted }}>P&L</div><div style={{ fontWeight: 700, color: total >= 0 ? T.green : T.red }}>{sign(total)}€{Math.abs(total).toFixed(2)}</div></div>
                  </div>
                );
              })}
            </div>
          </Glass>
        )}

        {/* Gráficos dos meus investimentos (ou top movers se não houver) */}
        {hasPositions ? (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.aLight }}>
              📂 Os meus Investimentos — {myPositions.length} {myPositions.length === 1 ? "posição aberta" : "posições abertas"}
            </div>
            <div className="resp-grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
              {myPositions.map(pos => {
                const norm   = s => String(s || "").toLowerCase().trim();
                const a      = assets.find(x => x.id === pos.assetId)
                            || assets.find(x => norm(x.sym) === norm(pos.assetId))
                            || assets.find(x => norm(x.sym) === norm(pos.assetSym))
                            || assets.find(x => norm(x.name) === norm(pos.assetName));
                const live   = mktData[a?.id] || {};
                const price  = live.price ?? a?.price ?? pos.entryPrice;
                const pnl    = (price - pos.entryPrice) * pos.units - roundTripFeeApp(pos, pos.amount);
                const pnlPct = pos.amount > 0 ? (pnl / pos.amount) * 100 : 0;
                const col    = pnl >= 0 ? T.green : T.red;
                const spark  = (live.sparkline?.length ? live.sparkline : a?.hist?.slice(-50)) || [];
                const isSim  = pos.mode === "sim";
                return (
                  <Glass key={pos.id} style={{ padding: "18px 20px 10px" }}
                    onMouseEnter={() => hoveredChart.current = `dash_${pos.id}`}
                    onMouseLeave={() => hoveredChart.current = null}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 20 }}>{a?.icon || "◆"}</span>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>{a?.name || pos.assetName}</div>
                            <div style={{ display: "flex", gap: 6, marginTop: 2, alignItems: "center", flexWrap: "wrap" }}>
                              <Badge label={isSim ? "SIM" : "LIVE"} color={isSim ? T.gold : T.red} />
                              <MarketBadge assetId={a?.id || pos.assetId} />
                              <span style={{ fontSize: 9, color: T.muted }}>entrada ${pos.entryPrice.toFixed(2)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 20, fontWeight: 700 }}>${fmt(price, a?.id || pos.assetId)}</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: col }}>{sign(pnl)}€{Math.abs(pnl).toFixed(2)}</div>
                        <div style={{ fontSize: 11, color: col }}>{sign(pnlPct)}{Math.abs(pnlPct).toFixed(2)}%</div>
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={100}>
                      <AreaChart data={spark} margin={{ top: 4, bottom: 4 }}>
                        <defs>
                          <linearGradient id={`dg${pos.id.slice(-4)}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={col} stopOpacity={0.28} />
                            <stop offset="95%" stopColor={col} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="i" hide /><YAxis domain={["auto","auto"]} hide />
                        <Tooltip
                          contentStyle={{ background: T.base, border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 10, color: T.text }}
                          formatter={v => [`$${(+v).toFixed(2)}`]} labelFormatter={() => ""}
                        />
                        <Area type="monotone" dataKey="v" stroke={col} strokeWidth={2} fill={`url(#dg${pos.id.slice(-4)})`} dot={false} />
                        <ReferenceLine y={pos.entryPrice} stroke={T.gold} strokeDasharray="5 3" strokeWidth={1.5}
                          label={{ value: `${pos.stratId === "dca" ? "🎯 DCA" : pos.stratId === "ai-brain" ? "🤖 AI Brain" : pos.stratId === "daytrading" ? "⚡ Day" : pos.stratId === "manual" ? "✋ Manual" : "🎯 Estratégia"} · entrada $${pos.entryPrice.toFixed(0)}`, position: "insideTopLeft", fill: T.gold, fontSize: 9, fontWeight: 700 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginTop: 8 }}>
                      {[
                        { l: "Investido",    v: `€${pos.amount}` },
                        { l: "Unidades",     v: pos.units.toFixed(5) },
                        { l: "Stop Loss",    v: `$${pos.sl}`,     c: T.red   },
                        { l: "Take Profit",  v: `$${pos.tp}`,     c: T.green },
                      ].map(s => (
                        <div key={s.l} style={{ background: "rgba(0,0,0,0.2)", borderRadius: 6, padding: "6px 8px" }}>
                          <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 2 }}>{s.l}</div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: s.c || T.text }}>{s.v}</div>
                        </div>
                      ))}
                    </div>
                    {/* Botão vender — só posições manuais */}
                    {pos.stratId === "manual" && (() => {
                      const open = isMarketOpen(a?.id || pos.assetId);
                      return (
                        <button
                          onClick={() => open && closePositionById(pos.id)}
                          disabled={!open}
                          style={{
                            width: "100%", marginTop: 10, padding: "9px 0", borderRadius: 8,
                            border: `1px solid ${open ? T.red : T.border}`,
                            background: open ? `${T.red}14` : "rgba(255,255,255,0.03)",
                            color: open ? T.red : T.muted,
                            fontSize: 12, fontWeight: 700, fontFamily: "inherit",
                            cursor: open ? "pointer" : "not-allowed",
                          }}>
                          {open ? `▼ Vender ${a?.sym || ""} @ $${fmt(price, a?.id || pos.assetId)}` : "⏸ Mercado fechado — não dá para vender agora"}
                        </button>
                      );
                    })()}
                  </Glass>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 12 }}>
            {/* Top movers quando não há posições */}
            <Glass style={{ padding: "20px 20px 10px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>📊 Mercado Hoje — Top Movers</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 14 }}>Ainda não tens investimentos. Vai a Mercados ou Estratégias para começar.</div>
              {[...assets].sort((a,b) => Math.abs(b.change) - Math.abs(a.change)).slice(0,5).map(a => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}33` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>{a.icon}</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12 }}>{a.name}</div>
                      <div style={{ fontSize: 9, color: T.muted }}>{a.cat}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 700 }}>${fmt(a.price, a.id)}</div>
                    <div style={{ color: a.change >= 0 ? T.green : T.red, fontWeight: 700, fontSize: 12 }}>{pctFmt(a.change)}</div>
                  </div>
                </div>
              ))}
            </Glass>
            <Glass style={{ padding: "20px" }}>
              <SectionLabel>Todos os Ativos (tradeable)</SectionLabel>
              {assets.filter(a => isTradeable(a.id)).map(a => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${T.border}44` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 17 }}>{a.icon}</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{a.sym}</div>
                      <div style={{ fontSize: 9, color: T.muted }}>{a.cat}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>${fmt(a.price, a.id)}</div>
                    <div style={{ fontSize: 11, color: a.change >= 0 ? T.green : T.red, fontWeight: 700 }}>{pctFmt(a.change)}</div>
                  </div>
                </div>
              ))}
            </Glass>
          </div>
        )}
      </div>
    );
  };

  // ── Investir numa sugestão AI directamente ─────────────────────────────────
  const investirSugestao = (op, explicitAmount) => {
    // Validar o ativo: o id tem de existir mesmo na lista. Se a IA devolver um id
    // inválido (ex. "xag" em vez de "silver"), tenta mapear por símbolo/nome.
    let asset = ASSETS.find(a => a.id === op.id);
    if (!asset) {
      const alvo = (op.id || op.nome || "").toLowerCase();
      asset = ASSETS.find(a =>
        a.sym.toLowerCase() === alvo ||
        a.name.toLowerCase() === alvo ||
        a.id.toLowerCase() === alvo
      );
    }
    if (!asset) {
      toast(`Não reconheço o ativo "${op.nome || op.id}". Não foi possível criar a estratégia.`, "error");
      return;
    }
    if (!isTradeable(asset.id)) {
      toast(`${asset.name} ainda não está disponível para negociação pelo bot.`, "error");
      return;
    }
    const amount = +explicitAmount > 0
      ? +explicitAmount
      : (suggestInvestAmount(asset.id, op.confianca) || calcTradeAmount());
    const slPct  = settingsRef.current?.stopLossPadrao    || 6;
    const tpPct  = settingsRef.current?.takeProfitPadrao  || 12;
    const s = {
      id:        uid(),
      nome:      `${asset.icon} ${asset.name}`,
      descricao: op.porque,
      logica:    `Entrada $${op.entrada} · SL $${op.sl} · TP $${op.tp}`,
      ativos:    [asset.id],
      compra:    0.5,
      perTrade:  amount,
      sl:        slPct,
      tp:        tpPct,
      prazo:     op.prazo,
      risco:     op.risco,
      objetivo:  `Sugestão AI: ${(op.porque||"").slice(0, 60)}…`,
      trades:    0,
      ativo:     true,
      criado:    new Date().toLocaleString("pt-PT"),
    };
    setStrategies(p => [s, ...p]);
    if (user) import("./firebase.js").then(({ saveStrategy }) => saveStrategy(user.uid, s).catch(()=>{}));
    toast(`✅ Estratégia "${s.nome}" criada e ativa!`, "buy");
  };

  // ── AI: Sugerir oportunidades ──────────────────────────────────────────────
  const getSuggestions = async () => {
    setSuggestLoading(true);
    try {
      // Categorias selecionadas ([] = todas)
      const allowedCats = suggestCats.length > 0 ? suggestCats : ["Crypto","Commodity","ETF","Forex"];
      const filteredAssets = assets.filter(a => allowedCats.includes(a.cat));
      const lines = filteredAssets.map(a => `${a.name}(${a.sym})[id:${a.id}]:$${fmt(a.price,a.id)}(${pctFmt(a.change)})`).join(", ");
      const validIds = filteredAssets.map(a => a.id).join(", ");
      const s     = settingsRef.current;
      const amount = calcTradeAmount();
      const nCats = allowedCats.length;
      const { result, cost: c1 } = await callAI({
        max_tokens: 2200,
        system: "És um trader profissional. Analisa mercados e dá oportunidades concretas. Responde SEMPRE com JSON puro, sem markdown.",
        messages: [{ role: "user", content:
`Analisa estes mercados AGORA e diz as melhores oportunidades para hoje.
Perfil: ${s.riscoPerfil} | €${amount}/trade | SL ${s.stopLossPadrao}% | TP ${s.takeProfitPadrao}%
Categorias a analisar: ${allowedCats.join(", ")}
Preços: ${lines}

Dá ${nCats === 1 ? "6 oportunidades" : "as melhores oportunidades (até 6 por categoria)"} dos ativos listados acima. Inclui só ativos das categorias pedidas.
IMPORTANTE: o campo "id" tem de ser EXATAMENTE um destes ids válidos: ${validIds}. Não inventes ids nem uses o símbolo.
JSON puro:
{"resumo":"análise 1 frase pt","momento":"BOM|NEUTRO|MAU","oportunidades":[{"id":"<um dos ids válidos>","nome":"Prata","icone":"🥈","sinal":"COMPRAR|AGUARDAR","porque":"razão simples 1-2 frases pt","confianca":82,"risco":"BAIXO|MÉDIO|ALTO","entrada":30.5,"sl":28.6,"tp":34.2,"retornoEsperado":12.1,"prazo":"3-7 dias"}]}` }],
      });
      setAiSuggestions({ ...result, geradoEm: new Date().toLocaleTimeString("pt-PT"), amount });
      // Semear o valor sugerido por linha: por perfil + confiança da IA.
      const seeded = {};
      (result?.oportunidades || []).forEach(op => {
        const asset = ASSETS.find(a => a.id === op.id);
        const aid = asset?.id || op.id;
        seeded[op.id] = suggestInvestAmount(aid, op.confianca) || amount;
      });
      setEditAmounts(seeded);
      setAiCost(p => +(p + (c1||0)).toFixed(5));
      toast("✦ Oportunidades atualizadas!", "success");
    } catch (e) { toast(`Erro: ${e.message}`, "error"); }
    setSuggestLoading(false);
  };

  // RENDER: ESTRATÉGIAS
  // ─────────────────────────────────────────────
  const Strategies = () => {
    const momentoC = aiSuggestions?.momento === "BOM" ? T.green : aiSuggestions?.momento === "MAU" ? T.red : T.gold;
    return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Secção 1: Oportunidades AI agora ── */}
      <Glass style={{ padding: "24px 26px" }} glow>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>🎯 O que devo investir agora?</div>
            <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
              A IA analisa todos os mercados em tempo real e sugere as melhores oportunidades para o teu perfil.
              Carrega <b style={{ color: T.aLight }}>Investir</b> para o bot entrar automaticamente.
            </div>
          </div>
          <Btn onClick={getSuggestions} disabled={suggestLoading} color={T.green}
            style={{ padding: "11px 22px", fontSize: 13, flexShrink: 0, marginLeft: 16 }}>
            {suggestLoading ? "◌ A analisar…" : "◆ Analisar Agora"}
          </Btn>
        </div>
        {aiSuggestions && (
          <div style={{ marginTop: 4, fontSize: 10, color: T.muted }}>
            Atualizado às {aiSuggestions.geradoEm} ·{" "}
            <span style={{ color: momentoC, fontWeight: 700 }}>Momento {aiSuggestions.momento}</span>
          </div>
        )}
        {aiSuggestions && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 10, color: T.muted, marginBottom: 8 }}>Categorias a analisar (nenhuma = todas):</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {[
                ["Crypto", "💰 Cripto"],
                ["Commodity", "🥇 Metais/Petróleo"],
                ["ETF", "📈 ETFs"],
                ["Forex", "💱 Forex"],
              ].map(([cat, label]) => {
                const sel = suggestCats.includes(cat);
                return (
                  <button key={cat} onClick={() => setSuggestCats(prev => sel ? prev.filter(c => c !== cat) : [...prev, cat])} style={{
                    background: sel ? `${T.accent}28` : `${T.accent}10`,
                    border: `1px solid ${sel ? T.accent+"88" : T.accent+"25"}`,
                    borderRadius: 99, padding: "6px 14px", fontSize: 11,
                    color: sel ? T.aLight : T.muted, fontWeight: sel ? 700 : 500,
                    cursor: "pointer", fontFamily: "inherit",
                  }}>{sel ? "✓ " : ""}{label}</button>
                );
              })}
              <Btn onClick={getSuggestions} disabled={suggestLoading} color={T.green} sm
                style={{ marginLeft: "auto", fontSize: 11, padding: "7px 16px" }}>
                {suggestLoading ? "◌ A analisar…" : `◆ Reanalisar ${suggestCats.length > 0 ? suggestCats.length + " cat." : "tudo"}`}
              </Btn>
            </div>
          </div>
        )}
      </Glass>

      {/* ── Tabela de oportunidades ── */}
      {aiSuggestions ? (
        <Glass className="resp-scroll" style={{ padding: "0" }}>
          {/* Resumo topo */}
          <div style={{ padding: "16px 22px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: momentoC, boxShadow: `0 0 8px ${momentoC}` }} />
            <div style={{ fontSize: 13, color: T.text }}>{aiSuggestions.resumo}</div>
          </div>
          {/* Header tabela */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr 140px", minWidth: isMobile ? 720 : "auto", gap: 0, padding: "10px 22px", borderBottom: `1px solid ${T.border}` }}>
            {["Ativo","Sinal","Porquê","Confiança","Risco","Retorno Esp.","Prazo",""].map(h => (
              <div key={h} style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>{h}</div>
            ))}
          </div>
          {/* Linhas */}
          {(aiSuggestions.oportunidades || []).map((op, i) => {
            const sc = op.sinal === "COMPRAR" ? T.green : T.gold;
            const isLast = i === (aiSuggestions.oportunidades.length - 1);
            return (
              <div key={op.id} style={{
                display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr 140px", minWidth: isMobile ? 720 : "auto",
                gap: 0, padding: "16px 22px", alignItems: "center",
                borderBottom: isLast ? "none" : `1px solid ${T.border}33`,
                background: i % 2 === 0 ? "rgba(255,255,255,0.01)" : "transparent",
                transition: "background 0.12s",
              }}>
                {/* Ativo */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10,
                    background: `${sc}18`, border: `1px solid ${sc}30`,
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
                  }}>{op.icone}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{op.nome}</div>
                    <div style={{ fontSize: 10, color: T.muted }}>${(+op.entrada).toLocaleString()}</div>
                  </div>
                </div>
                {/* Sinal */}
                <div><Badge label={op.sinal} color={sc} /></div>
                {/* Porquê */}
                <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, paddingRight: 12 }}>{op.porque}</div>
                {/* Confiança */}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.aLight }}>{op.confianca}%</div>
                  <div style={{ marginTop: 4, height: 3, background: T.border, borderRadius: 2 }}>
                    <div style={{ width: `${op.confianca}%`, height: 3, background: T.accent, borderRadius: 2 }} />
                  </div>
                </div>
                {/* Risco */}
                <div><Badge label={op.risco} color={riskC(op.risco)} /></div>
                {/* Retorno */}
                <div style={{ fontWeight: 700, color: T.green, fontSize: 14 }}>+{op.retornoEsperado}%</div>
                {/* Prazo */}
                <div style={{ fontSize: 11, color: T.muted }}>{op.prazo}</div>
                {/* Botão */}
                <div>
                  {op.sinal === "COMPRAR" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4,
                        background: "rgba(255,255,255,0.04)", border: `1px solid ${T.border}`,
                        borderRadius: 8, padding: "4px 8px" }}>
                        <span style={{ fontSize: 12, color: T.muted }}>€</span>
                        <input
                          type="number" min="1" step="1"
                          value={editAmounts[op.id] ?? ""}
                          onChange={e => setEditAmounts(prev => ({ ...prev, [op.id]: e.target.value }))}
                          style={{ width: "100%", background: "none", border: "none", outline: "none",
                            color: T.text, fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}
                        />
                      </div>
                      <Btn color={T.green} solid
                        onClick={() => {
                          const val = +editAmounts[op.id];
                          if (!val || val <= 0) { toast("Indica um valor válido a investir.", "error"); return; }
                          investirSugestao(op, val);
                        }}
                        style={{ width: "100%", fontSize: 12, padding: "8px 0" }}>
                        ▶ Investir
                      </Btn>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: T.muted, textAlign: "center", padding: "9px 0" }}>A aguardar…</div>
                  )}
                </div>
              </div>
            );
          })}
          {/* SL / TP resumo por ativo */}
          <div style={{ padding: "14px 22px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 20, flexWrap: "wrap" }}>
            {(aiSuggestions.oportunidades || []).filter(o => o.sinal === "COMPRAR").map(op => (
              <div key={op.id} style={{ fontSize: 10, color: T.muted }}>
                <b style={{ color: T.text }}>{op.icone} {op.nome}</b> · SL{" "}
                <span style={{ color: T.red }}>${(+op.sl).toLocaleString()}</span> · TP{" "}
                <span style={{ color: T.green }}>${(+op.tp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Glass>
      ) : (
        <Glass style={{ padding: "44px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎯</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Sem análise ainda</div>
          <div style={{ color: T.muted, fontSize: 13, marginBottom: 20 }}>
            Clica em <b style={{ color: T.aLight }}>Analisar Agora</b> para a IA te dizer o que investir hoje.
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>Seleciona uma ou mais categorias (nenhuma = todas):</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
            {[
              ["Crypto", "💰 Cripto"],
              ["Commodity", "🥇 Metais/Petróleo"],
              ["ETF", "📈 ETFs"],
              ["Forex", "💱 Forex"],
            ].map(([cat, label]) => {
              const sel = suggestCats.includes(cat);
              return (
                <button key={cat} onClick={() => setSuggestCats(prev => sel ? prev.filter(c => c !== cat) : [...prev, cat])} style={{
                  background: sel ? `${T.accent}28` : `${T.accent}10`,
                  border: `1px solid ${sel ? T.accent+"88" : T.accent+"25"}`,
                  borderRadius: 99, padding: "7px 18px", fontSize: 11,
                  color: sel ? T.aLight : T.muted, fontWeight: sel ? 700 : 500,
                  cursor: "pointer", fontFamily: "inherit",
                }}>{sel ? "✓ " : ""}{label}</button>
              );
            })}
          </div>
          <button onClick={getSuggestions} disabled={suggestLoading} style={{
            background: T.green, border: "none", borderRadius: 10,
            padding: "12px 32px", fontSize: 13, color: "#04140d", fontWeight: 800,
            cursor: suggestLoading ? "default" : "pointer", fontFamily: "inherit",
            opacity: suggestLoading ? 0.6 : 1,
          }}>{suggestLoading ? "◌ A analisar…" : `◆ Analisar ${suggestCats.length > 0 ? suggestCats.length + " categoria(s)" : "tudo"}`}</button>
        </Glass>
      )}

      {/* ── Secção 2: Estratégias ativas ── */}
      <div style={{ padding: "8px 0 4px", borderBottom: `1px solid ${T.border}`, marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.aLight }}>
          Estratégias Ativas ({strategies.filter(s => s.ativo).length})
        </div>
        <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>
          Cada estratégia monitoriza o mercado e investe automaticamente quando as condições são cumpridas.
        </div>
      </div>

      {/* ── Criar por linguagem natural ── */}
      <Glass style={{ padding: "20px 22px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>✦ Criar estratégia personalizada</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            value={objective}
            onChange={e => setObjective(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createStrategy()}
            placeholder='Ex: "quero investir em petróleo quando cair de madrugada"'
            style={{
              flex: 1, background: "rgba(255,255,255,0.04)",
              border: `1px solid ${T.accent}33`, borderRadius: 10,
              padding: "11px 16px", color: T.text, fontSize: 12, fontFamily: "inherit", outline: "none",
            }}
          />
          <Btn onClick={createStrategy} disabled={aiLoading || !objective.trim()} color={T.accent}
            style={{ padding: "11px 20px", fontSize: 12 }}>
            {aiLoading ? "◌ A criar…" : "✦ Criar"}
          </Btn>
        </div>
      </Glass>

      {/* ── Lista de estratégias ── */}
      {strategies.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px", color: T.muted, fontSize: 12 }}>
          Nenhuma estratégia activa — clica em <b style={{ color: T.aLight }}>Investir</b> acima para começar.
        </div>
      ) : strategies.map(s => (
        <Glass key={s.id} style={{ padding: "18px 22px" }} glow={s.ativo}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{s.nome}</div>
                <Badge label={s.risco || "MÉDIO"} color={riskC(s.risco || "MÉDIO")} />
                <Badge label={s.ativo ? "ATIVA" : "PAUSADA"} color={s.ativo ? T.green : T.muted} />
                <Badge label={`${s.trades} trades`} color={T.accent} />
              </div>
              <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.55, maxWidth: 600 }}>{s.descricao || s.logica}</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 16 }}>
              <Btn sm color={s.ativo ? T.gold : T.green}
                onClick={() => {
                  const updated = { ...s, ativo: !s.ativo };
                  setStrategies(p => p.map(x => x.id === s.id ? updated : x));
                  if (user) import("./firebase.js").then(({ saveStrategy }) => saveStrategy(user.uid, updated).catch(()=>{}));
                }}>
                {s.ativo ? "⏸ Pausar" : "▶ Ativar"}
              </Btn>
              <Btn sm color={T.red} onClick={() => {
                const doDelete = () => {
                  setStrategies(p => p.filter(x => x.id !== s.id));
                  if (user) import("./firebase.js").then(({ deleteStrategy }) => deleteStrategy(user.uid, s.id).catch(()=>{}));
                };
                const abertas = activePositions.filter(p => p.stratId === s.id);
                if (abertas.length > 0) {
                  setConfirmModal({
                    danger: true,
                    icon: "🗑️",
                    title: "Apagar estratégia com posições abertas?",
                    message: `Esta estratégia tem ${abertas.length} posição(ões) aberta(s).`,
                    lines: [
                      "As posições NÃO são fechadas — continuam abertas na tua carteira.",
                      "O bot continua a geri-las normalmente (Stop-Loss, Take-Profit e saída por lucro).",
                      "Só deixam de aparecer associadas a esta estratégia no painel.",
                      "Podes sempre fechá-las à mão em Carteira.",
                    ],
                    confirmLabel: "Apagar estratégia",
                    cancelLabel: "Cancelar",
                    onConfirm: doDelete,
                  });
                } else {
                  doDelete();
                }
              }}>✕</Btn>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "11px 14px", marginTop: 12 }}>
            {[
              { l: "Ativos",        v: (s.ativos||[]).map(id => ASSETS.find(a => a.id === id)?.sym || id).join(", ") },
              { l: "€ por trade",   v: `€${s.perTrade}` },
              { l: "Stop Loss",     v: `${s.sl}%`, c: T.red   },
              { l: "Take Profit",   v: `${s.tp}%`, c: T.green },
              { l: "Prazo",         v: s.prazo || "—"          },
            ].map(item => (
              <div key={item.l}>
                <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 3 }}>{item.l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: item.c || T.text }}>{item.v}</div>
              </div>
            ))}
          </div>
        </Glass>
      ))}
    </div>
  );};
  // ─────────────────────────────────────────────
  // REAL MARKET DATA
  // ─────────────────────────────────────────────

  const [mktData,    setMktData]    = useState({});   // { id: { price, change, high24h, low24h, volume, sparkline } }
  useEffect(() => { mktDataRef.current = mktData; }, [mktData]); // sync ref (declarado depois de mktData para evitar TDZ)
  const [mktLoading, setMktLoading] = useState(true);
  const [mktError,   setMktError]   = useState(null);
  const [mktLastAt,  setMktLastAt]  = useState(null);
  const [orderModal,    setOrderModal]    = useState(null);
  const [orderAmount,   setOrderAmount]   = useState(100);
  // Ao abrir o modal de COMPRA, sugere a quantia com base no perfil + confiança IA
  // + saldo do broker. O utilizador pode sempre alterar.
  useEffect(() => {
    if (orderModal && orderModal.side === "BUY") {
      const sig  = marketSignalsRef.current?.[orderModal.assetId];
      const conf = sig?.confianca ?? sig?.confidence ?? 0;
      const sug  = suggestInvestAmount(orderModal.assetId, conf);
      setOrderAmount(sug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderModal]);
  const [aiCost,        setAiCost]        = useState(0);
  const [groqTokens,    setGroqTokens]    = useState(0); // tokens Groq usados nesta sessão (app)
  const [aiProvider,    setAiProvider]    = useState("auto"); // "auto"|"claude"|"groq"
  const [defTab,        setDefTab]        = useState("sim");  // settings sub-tab (top-level p/ sobreviver re-render)
  const [brokerTab,     setBrokerTab]     = useState("alpaca"); // guia: corretora
  const [settingsLocal, setSettingsLocal] = useState(null);   // edição settings (top-level)
  const [marketSignals, setMarketSignals] = useState({});
  // Lista de ativos negociáveis publicada pelo bot (sync app↔bot). Fonte de verdade:
  // o bot só publica ativos que consegue mesmo negociar (têm preço). Conjunto de ids.
  const [botTradeable, setBotTradeable] = useState(null); // null = ainda não recebido
  // É negociável? Prefere a lista publicada pelo bot (fonte de verdade); se ainda
  // não chegou, usa o flag 'trade' hardcoded como fallback.
  const isTradeable = useCallback((assetId) => {
    if (botTradeable) return botTradeable.has(assetId);
    const a = ASSETS.find(x => x.id === assetId);
    return a?.trade === true;
  }, [botTradeable]);
  const marketSignalsRef = useRef({});
  useEffect(() => { marketSignalsRef.current = marketSignals; }, [marketSignals]);
  // Histórico do sinal anterior por ativo (para detetar "flip" COMPRAR→VENDER)
  const prevSignalsRef = useRef({});
  const [mktCatTab,     setMktCatTab]     = useState("Todos");
  const [simMinimized,  setSimMinimized]  = useState(true);  // começa minimizado
  const [dailyVolume,   setDailyVolume]   = useState({});
  const hoveredChart = useRef(null);

  // ── Market quick signals (AI cada 5 min) ──────────────────────────────────
  const fetchMarketSignals = useCallback(async () => {
    // Se o bot 24/7 está ativo, ele já gera os sinais — a app lê-os do Firestore
    // (poupa tokens e evita análises duplicadas).
    if (botActiveRef.current) return;
    if (tabRef.current === "settings") return; // ⏸ não refrescar enquanto se editam Definições
    // Poupar tokens: só analisa ativos com mercado aberto. Crypto está sempre aberto.
    const abertos = ASSETS.filter(a => isMarketOpen(a.id));
    if (abertos.length === 0) return; // tudo fechado → não gasta tokens
    try {
      const lines = abertos.map(a => {
        const live = assRef.current.find(x => x.id === a.id);
        return `${a.id}:${a.sym}=$${live ? fmt(live.price,a.id):"?"}(${live?pctFmt(live.change):"?"})`;
      }).join(", ");
      const { result, cost } = await callAI({
        max_tokens: 500,
        system: "Trader. JSON puro apenas.",
        messages: [{ role:"user", content:
`Sinal rápido por ativo: ${lines}
JSON: {"signals":[{"id":"btc","sinal":"COMPRAR|VENDER|AGUARDAR","razao":"1 frase pt","confianca":75,"previsao":"tendência esperada 1-3 dias"}]}`
        }],
      });
      setAiCost(p => +(p + cost).toFixed(4));
      const map = {};
      (result.signals||[]).forEach(s => { map[s.id] = s; });
      setMarketSignals(map);
    } catch { /* silencioso */ }
  }, []);

  useEffect(() => {
    // Só gera sinais AI na app quando o bot está INATIVO. Com o bot ativo, é ele
    // que gera os sinais — duplicar aqui gastaria a MESMA quota Groq (limite por
    // organização), competindo com o bot. Poupa tokens e evita rate-limit.
    // Só corre se o AI Trade estiver ligado — com ele desligado (modo DCA), não
    // faz sentido gastar tokens a gerar sinais que ninguém usa.
    const run = () => {
      const ls = liveSettingsRef.current || {};
      const mestre = ls.aiTradeAtivo || ls.aiBrainMestre;
      // Só gera sinais se o AI Brain (mestre) estiver ligado E alguma fonte que os
      // use (estratégias ou compras autónomas). Senão, não gasta tokens.
      const usaSinais = mestre && (ls.aiTradeAtivo || ls.aiEstrategias || ls.aiManualAutonomo);
      if (!botActiveRef.current && usaSinais) fetchMarketSignals();
    };
    const timer = setTimeout(run, 3000);
    const iv = setInterval(run, 5 * 60 * 1000);
    return () => { clearTimeout(timer); clearInterval(iv); };
  }, [fetchMarketSignals]);

    const fetchMarkets = useCallback(async () => {
    if (hoveredChart.current) return; // não refresh quando rato está num gráfico
    if (tabRef.current === "settings") return; // ⏸ pausa nas Definições (não refrescar enquanto se edita)
    try {
      const r = await fetch("/.netlify/functions/market");
      const d = await r.json();
      if (d.ok && d.data) {
        setMktData(d.data);
        setMktError(null);
        setMktLastAt(new Date().toLocaleTimeString("pt-PT"));
        // Sync ALL asset prices (tradeable + analysis-only)
        setAssets(prev => prev.map(a => {
          const live = d.data[a.id];
          if (!live) return a;
          return {
            ...a,
            price:  live.price,
            change: live.change,
            hist:   live.sparkline?.length ? live.sparkline : a.hist,
          };
        }));
        setLiveData(true);
      }
    } catch (e) {
      setMktError("Sem dados de mercado — a usar simulação");
    }
    setMktLoading(false);
  }, []);

  useEffect(() => {
    // Só faz fetch à Netlify Function quando o bot está INATIVO. Com o bot ativo,
    // os preços chegam pelo Firestore (marketPrices) — evita chamadas duplicadas
    // e poupa invocações da função (plano de custos). Verifica a cada 30s, mas só
    // dispara o fetch se o bot não estiver a publicar.
    const run = () => { if (!botActiveRef.current) fetchMarkets(); };
    run();
    const iv = setInterval(run, 30000);
    return () => clearInterval(iv);
  }, [fetchMarkets]);

  // Envia um comando ao bot E segue o resultado, dando feedback ao utilizador.
  // Resolve o problema de "enviei e não aconteceu nada" — agora há toast de
  // confirmação ou de recusa com a razão (ex.: sem preço de mercado atual).
  const cmdToBot = (payload, sentMsg) => {
    if (!user) { toast("Inicia sessão para enviar ordens ao bot", "error"); return; }
    if (sentMsg) toast(sentMsg, payload.type === "SELL" ? "sell" : "info");
    import("./firebase.js").then(({ sendCommand, watchCommand }) => {
      sendCommand(user.uid, payload).then(id => {
        watchCommand(user.uid, id, ({ status, reason }) => {
          if (status === "FEITO") {
            toast(`✅ Bot executou: ${payload.type === "BUY" ? "compra" : "venda"} de ${payload.assetId?.toUpperCase?.() || ""}`.trim(), "success");
          } else if (status === "TIMEOUT") {
            toast("⏳ O bot não confirmou a tempo — verifica se está online", "warn");
          } else {
            toast(`🚫 Ordem recusada pelo bot${reason ? `: ${reason}` : ""}`, "error");
          }
        });
      }).catch(() => toast("Falha ao enviar a ordem ao bot", "error"));
    });
  };

  // Fechar qualquer posição aberta pelo seu id (usado pelos botões "Vender" no Dashboard)
  const closePositionById = (posId) => {
    const isSim = simModeRef.current;
    const pool  = isSim ? simPosRef.current : positions;
    const pos   = pool.find(p => p.id === posId);
    if (!pos) { toast("Posição já não está aberta", "warn"); return; }
    const a     = resolveAsset(pos);
    // Bloquear venda se o mercado desse ativo estiver fechado
    if (!isMarketOpen(a?.id || pos.assetId)) {
      toast(`⏸ Mercado de ${a?.sym || pos.assetId} fechado — não é possível vender agora`, "warn");
      return;
    }
    // ── PAPER/REAL: a app NÃO fecha localmente — pede ao BOT (canal de comandos).
    // O bot é a única autoridade de execução: vende na Alpaca e publica o estado.
    // Fechar aqui marcava a posição como fechada na app enquanto continuava
    // aberta na corretora (divergência app↔broker). Só sim fecha localmente.
    if (!isSim) {
      cmdToBot({ type: "SELL", posId: pos.id, assetId: pos.assetId },
        `📤 Pedido de venda de ${a?.sym || pos.assetId} enviado ao bot`);
      return;
    }
    const price = a?.price || pos.entryPrice;
    const feeRt = roundTripFeeFor(a?.cat, pos.amount);
    const pnl   = +(((price - pos.entryPrice) * pos.units) - feeRt).toFixed(4);
    const closedTrade = { ...pos, status: "MANUAL", closePrice: price, closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now(), fee: feeRt, pnl };
    // (paper/real já saiu acima via comando ao bot — aqui é sempre sim)
    setSimClosed(p => [closedTrade, ...p]);
    setSimPositions(p => { const next = p.filter(x => x.id !== posId); simPosRef.current = next; return next; });
    setSimBalance(b => {
      const n = +(b + pos.amount + pnl).toFixed(2); simBalRef.current = n;
      if (user) import("./firebase.js").then(({ updateTrade, saveSetting }) => {
        updateTrade(user.uid, posId, { status: "MANUAL", closePrice: price, pnl, closedAt: closedTrade.closedAt }).catch(()=>{});
        saveSetting(user.uid, "simBalance", n).catch(()=>{});
      }).catch(()=>{});
      return n;
    });
    toast(`${pnl >= 0 ? "✅" : "🛑"} Vendido ${a?.sym} · P&L ${sign(pnl)}€${Math.abs(pnl).toFixed(2)}`, pnl >= 0 ? "success" : "warn");
  };

  // Quick order from Markets tab
  const executeQuickOrder = (assetId, side, explicitAmount) => {
    const a      = assets.find(x => x.id === assetId);
    const live   = mktData[assetId];
    const price  = live?.price || a?.price || 0;
    const amount = explicitAmount || calcTradeAmount();
    const s      = settingsRef.current;
    const units  = +(amount / price).toFixed(7);
    const sl     = +(price * (1 - s.stopLossPadrao    / 100)).toFixed(a?.id === "eurusd" ? 4 : 2);
    const tp     = +(price * (1 + s.takeProfitPadrao  / 100)).toFixed(a?.id === "eurusd" ? 4 : 2);
    const isSim  = simMode;

    // ── PAPER/REAL: a app não executa — pede ao BOT (canal de comandos) ──
    // O bot executa na Alpaca e passa a gerir a posição (SL/TP/venda). Evita as
    // posições-fantasma que a app criava localmente em paper.
    if (!isSim) {
      if (!user) { toast("Precisas de sessão iniciada para enviar ordens ao bot", "error"); setOrderModal(null); return; }
      if (side === "BUY") {
        // O bot publica a lista de ativos que sabe negociar (botTradeable). Se o
        // ativo não está lá, a compra seria recusada — avisa já em vez de enviar.
        if (botTradeable && !botTradeable.has(assetId)) {
          toast(`${a?.sym || assetId} não está disponível para negociação pelo bot`, "warn");
          setOrderModal(null);
          return;
        }
        cmdToBot({ type: "BUY", assetId, amount }, `📤 Ordem de COMPRA de ${a?.sym} (€${amount}) enviada ao bot`);
      } else {
        const openPos = positions.find(p => p.assetId === assetId);
        if (!openPos) { toast(`Sem posição aberta em ${a?.sym} para vender`, "warn"); setOrderModal(null); return; }
        cmdToBot({ type: "SELL", posId: openPos.id, assetId }, `📤 Ordem de VENDA de ${a?.sym} enviada ao bot`);
      }
      setOrderModal(null);
      return;
    }

    if (side === "BUY") {
      // Verificar saldo suficiente
      const currentBal = isSim ? simBalRef.current : balRef.current;
      if (currentBal < amount) {
        toast(`Saldo insuficiente — tens €${currentBal.toFixed(2)} e precisas €${amount}`, "error");
        setOrderModal(null);
        return;
      }
      // Verificar limite de posições manuais
      const poolPositions = isSim ? simPosRef.current : positions;
      const manualCount = poolPositions.filter(p => p.stratId === "manual").length;
      const maxManuais = settingsRef.current?.maxManuais ?? 5;
      if (manualCount >= maxManuais) {
        toast(`Limite de ${maxManuais} posições manuais atingido`, "warn");
        setOrderModal(null);
        return;
      }
      const pos = {
        id: uid(), assetId, assetName: a?.name || assetId, assetSym: a?.sym || assetId,
        entryPrice: price, units, amount, sl, tp, peak: price,
        strategy: "Manual (Mercados)", stratId: "manual",
        openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
        mode: isSim ? "sim" : "live",
      };
      if (isSim) {
        setSimPositions(p => [...p, pos]);
        setSimBalance(b => {
          const n = +(Math.max(0, b - amount)).toFixed(2);
          simBalRef.current = n;
          // Persiste no Firestore
          if (user) {
            import("./firebase.js").then(({ saveTrade, saveSetting }) => {
              saveTrade(user.uid, pos).catch(() => {});
              saveSetting(user.uid, "simBalance", n).catch(() => {});
            }).catch(() => {});
          }
          return n;
        });
      } else {
        setPositions(p => [...p, pos]);
        setBalance(b => {
          const n = +(Math.max(0, b - amount)).toFixed(2); balRef.current = n;
          if (user) import("./firebase.js").then(({ saveTrade, saveSetting }) => {
            saveTrade(user.uid, pos).catch(()=>{});
            saveSetting(user.uid, "liveBalance", n).catch(()=>{});
          }).catch(()=>{});
          return n;
        });
      }
      setDailyVolume(p => ({ ...p, [assetId]: { buys: ((p[assetId]?.buys)||0)+1, sells: (p[assetId]?.sells)||0 }}));
      toast(`${isSim?"◎ [SIM]":"● [LIVE]"} Comprado ${a?.sym} @$${price.toFixed(2)} · €${amount}`, "buy");
    } else {
      const openPos = isSim
        ? simPosRef.current.find(p => p.assetId === assetId)
        : positions.find(p => p.assetId === assetId);
      if (openPos) {
        const pnl = (price - openPos.entryPrice) * openPos.units;
        const closedTrade = { ...openPos, status: "MANUAL", closePrice: price, closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now(), pnl };
        if (isSim) {
          setSimClosed(p => [closedTrade, ...p]);
          setSimPositions(p => p.filter(x => x.id !== openPos.id));
          setSimBalance(b => {
            const n = +(b + openPos.amount + pnl).toFixed(2); simBalRef.current = n;
            if (user) import("./firebase.js").then(({ updateTrade, saveSetting }) => {
              updateTrade(user.uid, openPos.id, { status: "MANUAL", closePrice: price, pnl, closedAt: closedTrade.closedAt }).catch(()=>{});
              saveSetting(user.uid, "simBalance", n).catch(()=>{});
            }).catch(()=>{});
            return n;
          });
        } else {
          setClosed(p => [closedTrade, ...p]);
          setPositions(p => p.filter(x => x.id !== openPos.id));
          setBalance(b => {
            const n = +(b + openPos.amount + pnl).toFixed(2); balRef.current = n;
            if (user) import("./firebase.js").then(({ updateTrade, saveSetting }) => {
              updateTrade(user.uid, openPos.id, { status: "MANUAL", closePrice: price, pnl, closedAt: closedTrade.closedAt }).catch(()=>{});
              saveSetting(user.uid, "liveBalance", n).catch(()=>{});
            }).catch(()=>{});
            return n;
          });
        }
        setDailyVolume(p => ({ ...p, [assetId]: { buys: (p[assetId]?.buys)||0, sells: ((p[assetId]?.sells)||0)+1 }}));
        toast(`${pnl >= 0 ? "✅" : "🛑"} Vendido ${a?.sym} · P&L ${sign(pnl)}€${Math.abs(pnl).toFixed(2)}`, pnl >= 0 ? "success" : "warn");
      } else {
        toast(`Sem posição aberta em ${a?.sym} para vender`, "warn");
      }
    }
    setOrderModal(null);
  };

  // ── Terminar simulação → mostra resumo ──────────────────────────────────
  const finishSim = () => {
    const allSimTrades = [...simClosed];
    const wins        = allSimTrades.filter(t => t.pnl > 0);
    const losses      = allSimTrades.filter(t => t.pnl <= 0);
    const totalPnlSim = allSimTrades.reduce((s, t) => s + (t.pnl||0), 0);
    const duration    = simStartedAt ? Math.round((Date.now() - simStartedAt.getTime()) / 60000) : 0;
    const summary = {
      id:             `sim_${Date.now()}`,
      capitalInicial: simCapital,
      saldoFinal:     simBalance,
      totalPnl:       totalPnlSim,
      roi:            simCapital > 0 ? (totalPnlSim / simCapital) * 100 : 0,
      totalTrades:    allSimTrades.length,
      wins:           wins.length,
      losses:         losses.length,
      winRate:        allSimTrades.length ? (wins.length / allSimTrades.length) * 100 : 0,
      trades:         allSimTrades,
      duration,
      iniciadaEm:     simStartedAt ? simStartedAt.toLocaleString("pt-PT") : "—",
      terminadaEm:    new Date().toLocaleString("pt-PT"),
    };
    setSimSummary(summary);
    // Arquiva + LIMPA posições e trades (termina mesmo a simulação)
    setArchivedSims(p => {
      const next = [summary, ...p];
      if (user) import("./firebase.js").then(({ saveSetting }) =>
        saveSetting(user.uid, "archivedSims", next).catch(()=>{}));
      return next;
    });
    // Apagar trades sim do Firestore (senão o bot recarrega-os)
    const posToDelete = [...simPositions, ...simClosed];
    setSimPositions([]); simPosRef.current = [];
    setSimClosed([]);
    setSimBalance(simCapital); simBalRef.current = simCapital;
    setSimStartedAt(null);
    if (user) import("./firebase.js").then(({ deleteTrade, saveSetting }) => {
      posToDelete.forEach(t => deleteTrade?.(user.uid, t.id).catch(()=>{}));
      saveSetting(user.uid, "simBalance", simCapital).catch(()=>{});
    });
  };

  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // RENDER: CARTEIRA (PORTFOLIO)
  // ─────────────────────────────────────────────
  const Portfolio = () => {
    const allPositions = activePositions;
    const allClosed    = activeClosed;

    if (allPositions.length === 0 && allClosed.length === 0) {
      return (
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <Glass style={{ padding:"56px 24px", textAlign:"center" }}>
            <div style={{ fontSize:48, marginBottom:16 }}>💼</div>
            <div style={{ fontSize:16, fontWeight:700, marginBottom:8 }}>Carteira vazia</div>
            <div style={{ fontSize:13, color:T.muted, marginBottom:24 }}>
              Ainda não tens investimentos activos.<br/>Vai a <b style={{color:T.aLight}}>Mercados</b> para comprar o primeiro ativo.
            </div>
            <Btn color={T.accent} onClick={() => setTab("markets")} style={{ padding:"11px 28px", fontSize:13 }}>
              ◎ Ir para Mercados
            </Btn>
          </Glass>
        </div>
      );
    }

    return (
      <div style={{ display:"flex", flexDirection:"column", gap:16, paddingBottom:80 }}>

        {/* Resumo portfólio */}
        {allPositions.length > 0 && (() => {
          const totalInv   = allPositions.reduce((s,p) => s+p.amount, 0);
          const totalUnreal= allPositions.reduce((s,p) => {
            const a = resolveAsset(p);
            return s + (a ? (a.price-p.entryPrice)*p.units : 0);
          }, 0);
          const totalWin   = allClosed.filter(t=>t.pnl>0).length;
          const wr         = allClosed.length ? (totalWin/allClosed.length*100) : null;
          return (
            <Glass style={{ padding:"24px 28px", background:"linear-gradient(135deg,rgba(99,102,241,0.14),rgba(16,185,129,0.07))", border:`1px solid ${T.accent}30` }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:24 }}>
                <div>
                  <div style={{ fontSize:9, color:T.aLight, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:6 }}>Posições Abertas</div>
                  <div style={{ fontSize:32, fontWeight:800 }}>{allPositions.length}</div>
                  <div style={{ fontSize:11, color:T.muted, marginTop:4 }}>€{totalInv.toFixed(0)} investido</div>
                </div>
                <KPI label="P&L Não Realizado" value={`${sign(totalUnreal)}€${Math.abs(totalUnreal).toFixed(2)}`} color={totalUnreal>=0?T.green:T.red} sub="em posições abertas"/>
                <KPI label="P&L Realizado" value={`${sign(allClosed.reduce((s,t)=>s+(t.pnl||0),0))}€${Math.abs(allClosed.reduce((s,t)=>s+(t.pnl||0),0)).toFixed(2)}`} color={allClosed.reduce((s,t)=>s+(t.pnl||0),0)>=0?T.green:T.red} sub={`${allClosed.length} trades fechados`}/>
                <KPI label="Win Rate" value={wr!==null?`${wr.toFixed(0)}%`:"—"} color={wr>=50?T.green:T.red} sub={`${totalWin}/${allClosed.length} ganhos`}/>
              </div>
            </Glass>
          );
        })()}

        {/* Posições abertas com gráfico completo */}
        {allPositions.length > 0 && (
          <div>
            <div style={{ fontSize:10, color:T.muted, letterSpacing:"0.13em", textTransform:"uppercase", marginBottom:12 }}>
              Investimentos Ativos ({allPositions.length})
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {allPositions.map(pos => {
                const norm    = s => String(s || "").toLowerCase().trim();
                const a       = assets.find(x=>x.id===pos.assetId)
                             || assets.find(x=>norm(x.sym)===norm(pos.assetId))
                             || assets.find(x=>norm(x.sym)===norm(pos.assetSym))
                             || assets.find(x=>norm(x.name)===norm(pos.assetName));
                if (!a) return null;
                const live    = mktData[a.id] || {};
                const price   = live.price ?? a.price;
                const pnl     = (price - pos.entryPrice) * pos.units - roundTripFeeApp(pos, pos.amount);
                const pnlPct  = (pnl / pos.amount) * 100;
                const col     = pnl>=0 ? T.green : T.red;
                const spark   = live.sparkline?.length ? live.sparkline : a.hist.slice(-60);
                const open    = isMarketOpen(a.id);
                const mhours  = MARKET_HOURS[pos.assetId];

                return (
                  <Glass key={pos.id} style={{ padding:"0", overflow:"hidden" }}
                    onMouseEnter={() => hoveredChart.current = pos.assetId}
                    onMouseLeave={() => hoveredChart.current = null}>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 340px", gap:0 }}>
                      {/* Left: chart */}
                      <div style={{ padding:"18px 20px 12px" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                            <div style={{ width:44, height:44, borderRadius:12, background:`${col}14`, border:`1px solid ${col}25`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>{a.icon}</div>
                            <div>
                              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                                <span style={{ fontWeight:700, fontSize:15 }}>{a.name}</span>
                                {pos.mode==="sim" && <Badge label="SIM" color={T.gold}/>}
                                <Badge label={open?"ABERTO":"FECHADO"} color={open?T.green:T.red}/>
                                {(() => {
                                  const o = pos.stratId === "dca"        ? { l: pos.planNome ? `🎯 DCA · ${pos.planNome}` : "🎯 DCA", c:T.accent }
                                          : pos.stratId === "ai-brain"   ? (pos.aiSource === "tecnico" ? { l:"🧮 AI Técnico", c:T.blue } : { l:"🤖 AI Brain", c:T.accent })
                                          : pos.stratId === "daytrading" ? { l:"⚡ Day Trade",  c:T.gold }
                                          : pos.stratId === "manual"     ? { l:"✋ Manual",     c:T.muted }
                                          :                                { l:"🎯 Estratégia", c:T.blue };
                                  return <Badge label={o.l} color={o.c}/>;
                                })()}
                              </div>
                              <div style={{ fontSize:10, color:T.muted, marginTop:3 }}>
                                {a.cat} · {a.sym}
                                {mhours && <span style={{ marginLeft:8, color:open?T.green:T.gold }}>🕐 {mhours.label}</span>}
                              </div>
                            </div>
                          </div>
                          <div style={{ textAlign:"right" }}>
                            <div style={{ fontSize:26, fontWeight:800 }}>${fmt(price,a.id)}</div>
                            <div style={{ color:a.change>=0?T.green:T.red, fontSize:12, fontWeight:700 }}>{pctFmt(a.change)} 24h</div>
                          </div>
                        </div>

                        {/* Full chart with entry line */}
                        <div style={{ position:"relative" }}>
                          <ResponsiveContainer width="100%" height={120}>
                            <AreaChart data={spark} margin={{ top:4, bottom:4 }}>
                              <defs>
                                <linearGradient id={`pf${pos.id}`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%"  stopColor={col} stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor={col} stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <XAxis dataKey="i" hide/>
                              <YAxis domain={["auto","auto"]} hide/>
                              <Tooltip
                                contentStyle={{ background:T.base, border:`1px solid ${T.border}`, borderRadius:8, fontSize:10, color:T.text }}
                                formatter={v => [`$${(+v).toFixed(a.id==="eurusd"?4:2)}`]}
                                labelFormatter={() => ""}/>
                              <Area type="monotone" dataKey="v" stroke={col} strokeWidth={2.5} fill={`url(#pf${pos.id})`} dot={false}/>
                              <ReferenceLine y={pos.entryPrice} stroke={T.gold} strokeDasharray="6 3" strokeWidth={2}
                                label={{ value:`${pos.stratId === "dca" ? "🎯 DCA" : pos.stratId === "ai-brain" ? "🤖 AI Brain" : pos.stratId === "daytrading" ? "⚡ Day" : pos.stratId === "manual" ? "✋ Manual" : "🎯 Estratégia"} · entrada $${pos.entryPrice.toFixed(a.id==="eurusd"?4:2)}`, position:"insideTopLeft", fill:T.gold, fontSize:10, fontWeight:700 }}/>
                            </AreaChart>
                          </ResponsiveContainer>
                          {hoveredChart.current===pos.assetId && (
                            <div style={{ position:"absolute", top:6, right:6, fontSize:9, color:T.gold, background:"rgba(0,0,0,0.5)", borderRadius:4, padding:"2px 6px" }}>⏸ Pausado</div>
                          )}
                        </div>

                        {/* Stats bar */}
                        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginTop:10 }}>
                          {[
                            { l:"Entrada",    v:`$${pos.entryPrice.toFixed(2)}`,   c:T.muted  },
                            { l:"Máximo 24h", v:live.high24h?`$${live.high24h.toFixed(2)}`:"—", c:T.green },
                            { l:"Mínimo 24h", v:live.low24h ?`$${live.low24h.toFixed(2)}` :"—", c:T.red   },
                            { l:"Volume",     v:live.volume?(live.volume>=1e9?`$${(live.volume/1e9).toFixed(1)}B`:`$${(live.volume/1e6).toFixed(0)}M`):"—" },
                          ].map(s => (
                            <div key={s.l} style={{ background:"rgba(0,0,0,0.2)", borderRadius:7, padding:"7px 9px" }}>
                              <div style={{ fontSize:8, color:T.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:3 }}>{s.l}</div>
                              <div style={{ fontSize:12, fontWeight:700, color:s.c||T.text }}>{s.v}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Right: P&L panel */}
                      <div style={{ borderLeft:`1px solid ${T.border}33`, padding:"18px 20px", display:"flex", flexDirection:"column", justifyContent:"space-between", background:`${col}06` }}>
                        <div>
                          <div style={{ fontSize:9, color:T.muted, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:8 }}>P&L em Tempo Real</div>
                          <div style={{ fontSize:38, fontWeight:800, color:col, letterSpacing:"-0.02em" }}>
                            {sign(pnl)}€{Math.abs(pnl).toFixed(2)}
                          </div>
                          <div style={{ fontSize:16, color:col, fontWeight:700, marginTop:4 }}>
                            {sign(pnlPct)}{Math.abs(pnlPct).toFixed(2)}%
                          </div>
                        </div>

                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:16 }}>
                          {[
                            { l:"Investido",  v:`€${pos.amount}`,             c:T.text  },
                            { l:"Unidades",   v:pos.units.toFixed(5),          c:T.muted },
                            { l:"Stop Loss",  v:`$${pos.sl}`,                  c:T.red   },
                            { l:"Take Profit",v:`$${pos.tp}`,                  c:T.green },
                          ].map(s => (
                            <div key={s.l} style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"9px 10px" }}>
                              <div style={{ fontSize:8, color:T.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>{s.l}</div>
                              <div style={{ fontSize:13, fontWeight:700, color:s.c }}>{s.v}</div>
                            </div>
                          ))}
                        </div>

                        <div style={{ marginTop:14, display:"flex", gap:8 }}>
                          <Btn color={T.red} full onClick={() => { setOrderModal({ assetId:pos.assetId, side:"SELL" }); setTab("markets"); }}
                            style={{ flex:1, padding:"10px 0", fontSize:12 }}>
                            ▼ Fechar Posição
                          </Btn>
                        </div>

                        <div style={{ marginTop:10, fontSize:10, color:T.muted }}>
                          Aberta: {pos.openedAt} · {pos.strategy}
                        </div>
                      </div>
                    </div>
                  </Glass>
                );
              })}
            </div>
          </div>
        )}

        {/* Histórico recente */}
        {allClosed.length > 0 && (
          <div>
            <div style={{ fontSize:10, color:T.muted, letterSpacing:"0.13em", textTransform:"uppercase", marginBottom:12 }}>
              Trades Fechados Recentes ({allClosed.length})
            </div>
            <Glass style={{ padding:"0", overflow:"hidden" }}>
              {allClosed.slice(0,10).map((t,i) => {
                const a   = resolveAsset(t);
                const col = (t.pnl||0)>=0 ? T.green : T.red;
                return (
                  <div key={t.id} style={{
                    display:"grid", gridTemplateColumns:"40px 2fr 1fr 1fr 1fr 1fr 1fr",
                    gap:0, padding:"13px 18px", alignItems:"center",
                    borderBottom: i<allClosed.length-1 ? `1px solid ${T.border}22` : "none",
                    background: i%2===0 ? "rgba(255,255,255,0.01)" : "transparent",
                  }}>
                    <span style={{ fontSize:20 }}>{a?.icon||"?"}</span>
                    <div>
                      <div style={{ fontWeight:700, fontSize:13 }}>{a?.name||t.assetId}</div>
                      <div style={{ fontSize:10, color:T.muted }}>{t.strategy}</div>
                    </div>
                    <div><div style={{ fontSize:9, color:T.muted }}>ENTRADA</div><div style={{ fontWeight:600, fontSize:12 }}>${t.entryPrice?.toFixed(2)}</div></div>
                    <div><div style={{ fontSize:9, color:T.muted }}>SAÍDA</div><div style={{ fontWeight:600, fontSize:12 }}>{Number.isFinite(+t.closePrice) ? `$${(+t.closePrice).toFixed(2)}` : "—"}</div></div>
                    <div><div style={{ fontSize:9, color:T.muted }}>INVESTIDO</div><div style={{ fontWeight:600 }}>€{t.amount}</div></div>
                    <div><Badge label={(() => { const win=(t.pnl||0)>=0; if(t.status==="TP")return "✓ TP"; if(t.status==="MANUAL")return "✓ Manual"; if(t.status==="AI-EXIT")return "🤖 AI"; if(t.status==="TRAIL"||(t.status==="SL"&&win))return "📈 Trailing"; if(t.status==="SL")return "🛑 SL"; return t.status||"MANUAL"; })()} color={t.status==="SL"&&(t.pnl||0)<0?T.red:(t.pnl||0)>=0?T.green:T.red}/></div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:16, fontWeight:800, color:col }}>{sign(t.pnl||0)}€{Math.abs(t.pnl||0).toFixed(2)}</div>
                      <div style={{ fontSize:10, color:col }}>{sign((t.pnl||0)/t.amount*100)}{Math.abs((t.pnl||0)/t.amount*100).toFixed(1)}%</div>
                    </div>
                  </div>
                );
              })}
            </Glass>
          </div>
        )}
      </div>
    );
  };

  // RENDER: MERCADOS
  // ─────────────────────────────────────────────
  const Markets = () => {
    const up    = Object.values(mktData).filter(d => d.change >= 0).length;
    const down  = Object.values(mktData).filter(d => d.change < 0).length;
    const fmtVol = v => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : v ? `$${v.toFixed(0)}` : "—";

    return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Status bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {mktLoading ? (
            <div style={{ fontSize: 12, color: T.muted }}>◌ A carregar dados reais…</div>
          ) : mktError ? (
            <div style={{ fontSize: 12, color: T.gold }}>⚠ {mktError}</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: `${T.green}12`, border: `1px solid ${T.green}25`, borderRadius: 99, padding: "4px 12px" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: T.green, animation: "pulse 2s infinite" }} />
                <span style={{ fontSize: 10, color: T.green, fontWeight: 700 }}>DADOS REAIS · Yahoo Finance + CoinGecko</span>
              </div>
              <span style={{ fontSize: 10, color: T.muted }}>Atualizado {mktLastAt} · refresh 30s</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: T.green, fontWeight: 700 }}>▲ {up} em alta</span>
          <span style={{ fontSize: 11, color: T.red,   fontWeight: 700 }}>▼ {down} em baixa</span>
          <button onClick={fetchMarkets} style={{ background: `${T.accent}15`, border: `1px solid ${T.accent}33`, borderRadius: 6, padding: "4px 12px", fontSize: 10, color: T.aLight, cursor: "pointer", fontFamily: "inherit" }}>
            ↺ Atualizar
          </button>
        </div>
      </div>


      {/* Category tabs */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {["Todos","Crypto","Commodity","ETF","Forex"].map(cat => (
          <button key={cat} onClick={() => setMktCatTab(cat)} style={{
            background: mktCatTab===cat ? `${T.accent}22`:"rgba(255,255,255,0.04)",
            border:`1px solid ${mktCatTab===cat ? T.accent+"55":T.border}`,
            borderRadius:99, padding:"5px 14px", fontSize:11, fontWeight:700,
            color: mktCatTab===cat ? T.aLight:T.muted, cursor:"pointer", fontFamily:"inherit",
          }}>{cat==="Commodity"?"Metais/Petróleo":cat}</button>
        ))}
        {Object.keys(dailyVolume).length > 0 && (
          <span style={{ marginLeft:"auto", fontSize:10, color:T.muted }}>
            🔥 Mais activo:{" "}
            {Object.entries(dailyVolume).sort((a,b)=>(b[1].buys+b[1].sells)-(a[1].buys+a[1].sells)).slice(0,2).map(([id,v]) => {
              const as = assets.find(x => x.id === id);
              return <b key={id} style={{ color:T.aLight }}>{as?.sym}({v.buys+v.sells}) </b>;
            })}
          </span>
        )}
      </div>

      {/* Cards grid — top 15 per category, sorted by movement */}
      <div className="resp-grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }}>
        {(mktCatTab === "Todos"
          ? assets.filter(a => isTradeable(a.id))
          : [...assets].filter(a => a.cat === mktCatTab)
              .map(a => ({ ...a, _live: mktData[a.id] || {} }))
              .sort((a,b) => Math.abs((b._live?.change ?? b.change)) - Math.abs((a._live?.change ?? a.change)))
              .slice(0, 15)
        ).map(a => {
          const live      = mktData[a.id] || {};
          const price     = live.price  ?? a.price;
          const change    = live.change ?? a.change;
          const high24h   = live.high24h;
          const low24h    = live.low24h;
          const volume    = live.volume;
          const spark     = live.sparkline?.length ? live.sparkline : a.hist.slice(-48);
          const isLive    = !!live.source;
          const isUp      = change >= 0;
          const col       = isUp ? T.green : T.red;
          const openPos   = positions.find(p => p.assetId === a.id);
          const posPnl    = openPos ? ((price - openPos.entryPrice) * openPos.units - roundTripFeeApp(openPos, openPos.amount)) : null;

          return (
            <Glass key={a.id} style={{ padding: "0", overflow: "hidden" }}
              onMouseEnter={() => hoveredChart.current = a.id}
              onMouseLeave={() => hoveredChart.current = null}>
              {/* Top section */}
              <div style={{ padding: "16px 18px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  {/* Left: icon + name + AI signal */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: 11,
                      background: `${col}14`, border: `1px solid ${col}25`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 20, flexShrink: 0,
                    }}>{a.icon}</div>
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{a.name}</span>
                        {hoveredChart.current===a.id && <span style={{ fontSize:9, color:T.gold }}>⏸ pausado</span>}
                      </div>
                      <div style={{ display: "flex", gap: 5, marginTop: 3, flexWrap:"wrap", alignItems:"center" }}>
                        <span style={{ fontSize: 9, color: T.muted }}>{a.cat} · {a.sym}</span>
                        {simMode
                          ? <span style={{ fontSize: 9, color: T.gold }}>◎ SIM</span>
                          : botModoReal
                            ? <span style={{ fontSize: 9, color: T.red, fontWeight: 700 }}>● REAL</span>
                            : <span style={{ fontSize: 9, color: T.blue, fontWeight: 700 }}>📝 PAPER</span>}
                        {marketSignals[a.id] && (() => {
                          const sig = marketSignals[a.id];
                          const sinalShow = normSignal(a.id, sig.sinal);
                          const sc2 = sinalShow==="COMPRAR"?T.green:sinalShow==="VENDER"?T.red:T.gold;
                          return <span title={sig.razao||""} style={{ background:`${sc2}18`, color:sc2, border:`1px solid ${sc2}33`, borderRadius:99, padding:"1px 8px", fontSize:9, fontWeight:700, cursor:"help" }}>◆ {sinalShow}</span>;
                        })()}
                      </div>
                      {marketSignals[a.id]?.previsao && (
                        <div style={{ fontSize:9, color:T.muted, marginTop:2, fontStyle:"italic", lineHeight:1.4 }}>
                          {marketSignals[a.id].previsao}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Right: price + change */}
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
                      ${fmt(price, a.id)}
                    </div>
                    <div style={{
                      display: "inline-flex", alignItems: "center", gap: 4, marginTop: 3,
                      background: `${col}15`, border: `1px solid ${col}30`,
                      borderRadius: 99, padding: "2px 9px",
                    }}>
                      <span style={{ color: col, fontWeight: 700, fontSize: 12 }}>
                        {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Sparkline com linha de entrada se tiver posição */}
                <div style={{ position: "relative" }}>
                  <ResponsiveContainer width="100%" height={openPos ? 80 : 64}>
                    <AreaChart data={spark} margin={{ top: 6, bottom: openPos ? 18 : 2, right: 2 }}>
                      <defs>
                        <linearGradient id={`gr${a.id}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={col} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={col} stopOpacity={0}    />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="i" hide />
                      <YAxis domain={["auto","auto"]} hide />
                      <Tooltip
                        contentStyle={{ background: T.base, border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 10, color: T.text }}
                        formatter={v => [`$${(+v).toFixed(a.id === "eurusd" ? 4 : 2)}`]}
                        labelFormatter={() => ""}
                      />
                      <Area type="monotone" dataKey="v" stroke={col} strokeWidth={1.8} fill={`url(#gr${a.id})`} dot={false} />
                      {openPos && (
                        <ReferenceLine
                          y={openPos.entryPrice}
                          stroke={posPnl >= 0 ? T.gold : T.red}
                          strokeWidth={1.5}
                          strokeDasharray="4 3"
                          label={{
                            value: `Entrada $${openPos.entryPrice.toFixed(a.id==="eurusd"?4:2)}`,
                            position: "insideBottomLeft",
                            fill: posPnl >= 0 ? T.gold : T.red,
                            fontSize: 9,
                            fontWeight: 700,
                          }}
                        />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                  {/* Seta de P&L flutuante */}
                  {openPos && (
                    <div style={{
                      position: "absolute", top: 6, right: 6,
                      background: `${posPnl >= 0 ? T.green : T.red}22`,
                      border: `1px solid ${posPnl >= 0 ? T.green : T.red}44`,
                      borderRadius: 6, padding: "3px 8px",
                      fontSize: 11, fontWeight: 800,
                      color: posPnl >= 0 ? T.green : T.red,
                    }}>
                      {sign(posPnl)}€{Math.abs(posPnl).toFixed(2)}
                    </div>
                  )}
                </div>

                {/* Market hours badge */}
                {(() => {
                  const open = isMarketOpen(a.id);
                  const mh   = MARKET_HOURS[a.id];
                  return (
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:8, marginBottom:2 }}>
                      <div style={{ width:6, height:6, borderRadius:"50%", background:open?T.green:T.red, flexShrink:0 }}/>
                      <span style={{ fontSize:9, color:open?T.green:T.muted, fontWeight:700 }}>{open?"MERCADO ABERTO":"MERCADO FECHADO"}</span>
                      {mh && <span style={{ fontSize:9, color:T.muted }}>· {mh.label}</span>}
                    </div>
                  );
                })()}

                {/* Stats row */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
                  {[
                    { l: "Máximo 24h", v: high24h ? `$${high24h.toFixed(a.id==="eurusd"?4:2)}` : "—", c: T.green },
                    { l: "Mínimo 24h", v: low24h  ? `$${low24h.toFixed(a.id==="eurusd"?4:2)}`  : "—", c: T.red   },
                    { l: "Volume",     v: fmtVol(volume),                                                           },
                    { l: "Variação",   v: `${isUp?"+":""}${change.toFixed(2)}%`,                     c: col         },
                  ].map(s => (
                    <div key={s.l} style={{ background: "rgba(0,0,0,0.2)", borderRadius: 7, padding: "7px 9px" }}>
                      <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>{s.l}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: s.c || T.text }}>{s.v}</div>
                    </div>
                  ))}
                </div>

                {/* Stats históricas (90 dias) — publicadas pelo bot. Ajudam a ver
                    se o preço atual está caro/barato face ao histórico recente. */}
                {(() => {
                  const ps = priceStats[a.id];
                  if (!ps) return null;
                  const dp = a.id === "eurusd" ? 4 : (price < 1 ? 4 : 2);
                  const f = (v) => (v != null ? `$${Number(v).toFixed(dp)}` : "—");
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
                      {[
                        { l: "Máx 90d",   v: f(ps.max90),    c: T.green },
                        { l: "Mín 90d",   v: f(ps.min90),    c: T.red   },
                        { l: "Méd semana", v: f(ps.avgWeek)             },
                        { l: "Méd mês",    v: f(ps.avgMonth)            },
                      ].map(s => (
                        <div key={s.l} style={{ background: "rgba(0,0,0,0.12)", borderRadius: 7, padding: "7px 9px" }}>
                          <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>{s.l}</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: s.c || T.text }}>{s.v}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>

              {/* Posição aberta neste ativo */}
              {openPos && (
                <div style={{
                  padding: "8px 18px",
                  background: `${posPnl >= 0 ? T.green : T.red}0d`,
                  borderTop: `1px solid ${posPnl >= 0 ? T.green : T.red}22`,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span style={{ fontSize: 11, color: T.muted }}>
                    📂 Posição aberta · {openPos.units.toFixed(5)} · entrada ${ openPos.entryPrice.toFixed(2)}
                  </span>
                  <span style={{ fontWeight: 700, color: posPnl >= 0 ? T.green : T.red, fontSize: 13 }}>
                    {sign(posPnl)}€{Math.abs(posPnl).toFixed(2)}
                  </span>
                </div>
              )}

              {/* BUY / SELL buttons — VENDER só aparece se tiveres posição aberta neste ativo */}
              <div style={{ display: "grid", gridTemplateColumns: openPos ? "1fr 1fr" : "1fr", borderTop: `1px solid ${T.border}33` }}>
                <button onClick={() => setOrderModal({ assetId: a.id, side: "BUY" })} style={{
                  background: `${T.green}12`, color: T.green, border: "none",
                  borderRight: openPos ? `1px solid ${T.border}33` : "none",
                  padding: "12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                  fontFamily: "inherit", transition: "background 0.12s",
                }}>▲ COMPRAR</button>
                {openPos && (
                  <button onClick={() => setOrderModal({ assetId: a.id, side: "SELL" })} style={{
                    background: `${T.red}12`, color: T.red, border: "none",
                    padding: "12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                    fontFamily: "inherit", transition: "background 0.12s",
                  }}>▼ VENDER</button>
                )}
              </div>
            </Glass>
          );
        })}
      </div>

      {/* Order confirmation modal */}
      {orderModal && (() => {
        const a     = assets.find(x => x.id === orderModal.assetId);
        const live  = mktData[orderModal.assetId] || {};
        const price = live.price ?? a?.price ?? 0;
        const amt   = orderAmount || calcTradeAmount();
        const s     = settingsRef.current;
        const sl    = +(price * (1 - s.stopLossPadrao   / 100)).toFixed(a?.id==="eurusd"?4:2);
        const tp    = +(price * (1 + s.takeProfitPadrao / 100)).toFixed(a?.id==="eurusd"?4:2);
        const isBuy = orderModal.side === "BUY";
        const col   = isBuy ? T.green : T.red;
        const units = +(amt / price).toFixed(7);
        const sig   = marketSignals[orderModal.assetId];
        return (
          <div style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 5000, backdropFilter: "blur(10px)",
          }} onClick={e => e.target===e.currentTarget && setOrderModal(null)}>
            <div style={{
              background: T.base, border: `1px solid ${col}44`,
              borderRadius: 20, padding: isMobile ? "20px 18px" : "28px 32px", width: isMobile ? "calc(100vw - 24px)" : 460, maxWidth: "calc(100vw - 24px)", maxHeight: "90vh", overflowY: "auto",
              boxShadow: `0 0 80px ${col}14`,
            }}>
              {/* Header */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800 }}>
                    {a?.icon} {isBuy ? "▲ Comprar" : "▼ Vender"} {a?.name}
                  </div>
                  <div style={{ fontSize: 11, color: T.muted, marginTop:3 }}>
                    {simMode ? "◎ Simulação — sem dinheiro real" : botModoReal ? "⚠ LIVE — dinheiro real na Alpaca" : "📝 PAPER — dinheiro fictício na Alpaca"}
                  </div>
                </div>
                <button onClick={() => setOrderModal(null)} style={{ background:"none", border:"none", color:T.muted, fontSize:20, cursor:"pointer" }}>✕</button>
              </div>

              {/* AI signal se disponível */}
              {sig && (() => {
                const sinalShow = normSignal(orderModal.assetId, sig.sinal);
                const sigCol = sinalShow==="COMPRAR"?T.green:sinalShow==="VENDER"?T.red:T.gold;
                return (
                <div style={{ margin:"12px 0", padding:"10px 14px", borderRadius:9,
                  background: `${sigCol}10`,
                  border: `1px solid ${sigCol}30`,
                  fontSize:11, color:T.muted, lineHeight:1.6 }}>
                  <b style={{ color: sigCol }}>◆ AI: {sinalShow}</b>
                  {" · "}{sig.razao}
                  {sig.previsao && <div style={{marginTop:3, fontStyle:"italic"}}>{sig.previsao}</div>}
                </div>
                );
              })()}

              {/* Valor editável */}
              <div style={{ background:`${col}08`, border:`1px solid ${col}22`, borderRadius:12, padding:"16px", marginBottom:16 }}>
                <div style={{ fontSize:9, color:T.muted, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:8 }}>
                  Valor a {isBuy?"Investir":"Fechar"} (€)
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:24, fontWeight:300, color:T.muted }}>€</span>
                  <input
                    type="number" value={amt}
                    onChange={e => setOrderAmount(Math.max(1, +e.target.value))}
                    style={{ flex:1, background:"transparent", border:"none", borderBottom:`2px solid ${col}55`,
                      color:col, fontSize:32, fontWeight:800, fontFamily:"inherit", outline:"none", padding:"4px 0" }}
                    min={1} max={99999}
                  />
                </div>
                <div style={{ marginTop:8, fontSize:11, color:T.muted }}>
                  ≈ {units} {a?.sym} · Saldo disponível: €{simMode ? simBalance.toFixed(2) : balance.toFixed(2)}
                </div>
                {isBuy && (() => {
                  const conf = sig?.confianca ?? sig?.confidence ?? 0;
                  const perfil = (settingsRef.current?.riscoPerfil || "moderado");
                  const sug = suggestInvestAmount(orderModal.assetId, conf);
                  return (
                    <div style={{ marginTop:6, fontSize:10, color:T.aLight, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <span>💡 Sugerido: <b style={{color:T.text}}>€{sug}</b> (perfil {perfil}{conf?`, confiança ${conf}%`:""})</span>
                      {amt !== sug && (
                        <button onClick={() => setOrderAmount(sug)} style={{
                          background:`${col}18`, border:`1px solid ${col}44`, borderRadius:5,
                          padding:"2px 8px", fontSize:9, color:col, cursor:"pointer", fontFamily:"inherit", fontWeight:700,
                        }}>usar</button>
                      )}
                    </div>
                  );
                })()}
                {/* Quick amount buttons */}
                <div style={{ display:"flex", gap:6, marginTop:10, flexWrap:"wrap" }}>
                  {[50,100,200,500,1000].map(v => (
                    <button key={v} onClick={() => setOrderAmount(v)} style={{
                      background: amt===v ? `${col}22`:"rgba(255,255,255,0.05)",
                      border:`1px solid ${amt===v ? col+"44":T.border}`,
                      borderRadius:6, padding:"4px 12px", fontSize:11,
                      color: amt===v ? col : T.muted, cursor:"pointer", fontFamily:"inherit", fontWeight:700,
                    }}>€{v}</button>
                  ))}
                </div>
              </div>

              {/* SL / TP info */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:16 }}>
                {[
                  { l:"Preço Atual",  v:`$${price.toFixed(a?.id==="eurusd"?4:2)}`, c:T.text  },
                  { l:"Stop Loss",    v:`$${sl} (${s.stopLossPadrao}%)`,            c:T.red   },
                  { l:"Take Profit",  v:`$${tp} (${s.takeProfitPadrao}%)`,          c:T.green },
                ].map(row => (
                  <div key={row.l} style={{ background:"rgba(255,255,255,0.04)", borderRadius:9, padding:"10px 12px" }}>
                    <div style={{ fontSize:8, color:T.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>{row.l}</div>
                    <div style={{ fontWeight:700, fontSize:13, color:row.c }}>{row.v}</div>
                  </div>
                ))}
              </div>

              {/* Confirm */}
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setOrderModal(null)} style={{
                  flex:1, background:"rgba(255,255,255,0.04)", border:`1px solid ${T.border}`,
                  borderRadius:10, padding:"13px", fontSize:13, color:T.muted,
                  cursor:"pointer", fontFamily:"inherit",
                }}>Cancelar</button>
                <button onClick={() => { executeQuickOrder(orderModal.assetId, orderModal.side, amt); setOrderAmount(null); }} style={{
                  flex:2, background:`${col}20`, border:`1px solid ${col}55`,
                  borderRadius:10, padding:"13px", fontSize:15, color:col,
                  cursor:"pointer", fontFamily:"inherit", fontWeight:800,
                }}>
                  {isBuy
                    ? `${simMode?"◎":"●"} ${simMode?"Simular":"EXECUTAR"} · €${amt}`
                    : `${simMode?"◎":"●"} Fechar posição`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );};

  // ─────────────────────────────────────────────
  // RENDER: AI INTEL
  // ─────────────────────────────────────────────
  const AI_CATS = ["Todos","Crypto","Commodity","ETF","Forex"];
  const [aiCat, setAiCat] = useState("Todos");
  const [analyseCats, setAnalyseCats] = useState([]); // categorias selecionadas para analisar ([] = todas)

  const AIIntel = () => {
    const sc = s => s === "COMPRAR" ? T.green : s === "VENDER" ? T.red : T.gold;

    // Top movers — todos os 20 mais movimentados
    const topMovers = [...assets]
      .map(a => ({ ...a, absChange: Math.abs(a.change) }))
      .sort((a,b) => b.absChange - a.absChange)
      .slice(0, 20);

    // Filtrar recs por categoria — inclui ativos não-tradeable
    const filteredRecs = (aiRec?.recs || []).filter(rec => {
      if (aiCat === "Todos") return true;
      const asset = assets.find(x => x.id === rec.id);
      return asset?.cat === aiCat;
    });
    // Per-category stats
    const catStats = {};
    (aiRec?.recs || []).forEach(rec => {
      const a = assets.find(x => x.id === rec.id);
      if (a?.cat) { catStats[a.cat] = (catStats[a.cat] || 0) + 1; }
    });

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 200 }}>

        {/* ── TOP MOVERS HOJE ── */}
        <Glass style={{ padding: "18px 22px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={{ fontSize:13, fontWeight:700 }}>🔥 Mais Movimentados Hoje — Top 20</div>
            <span style={{ fontSize:10, color:T.muted }}>variação % nas últimas 24h · atualiza automaticamente</span>
          </div>
          <div className="resp-grid-2" style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
            {topMovers.map((a, i) => {
              const col2 = a.change>=0 ? T.green : T.red;
              const sig  = marketSignals[a.id];
              const sinalShow = sig ? normSignal(a.id, sig.sinal) : null;
              const sigC = sinalShow==="COMPRAR"?T.green:sinalShow==="VENDER"?T.red:T.gold;
              return (
              <div key={a.id} style={{
                background: `${col2}0a`, border: `1px solid ${col2}22`,
                borderRadius:10, padding:"12px 14px",
              }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <span style={{ fontSize:16 }}>{a.icon}</span>
                    <div>
                      <div style={{ fontWeight:700, fontSize:12 }}>{a.sym}</div>
                      <div style={{ fontSize:9, color:T.muted }}>{a.cat}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3 }}>
                    {i<3 && <span style={{ fontSize:9, color:T.gold }}>{["👑","🥈","🥉"][i]}</span>}
                    {sig && <span style={{ background:`${sigC}18`, color:sigC, border:`1px solid ${sigC}33`, borderRadius:99, padding:"1px 6px", fontSize:8, fontWeight:700 }}>{sinalShow}</span>}
                  </div>
                </div>
                <div style={{ fontWeight:800, fontSize:18, color: col2, marginBottom:2 }}>
                  {a.change>=0?"▲":"▼"}{Math.abs(a.change).toFixed(2)}%
                </div>
                <div style={{ fontSize:11, color:T.muted, marginBottom:8 }}>${fmt(a.price, a.id)}</div>
                {sig?.razao && <div style={{ fontSize:9, color:T.muted, marginBottom:8, lineHeight:1.4, fontStyle:"italic" }}>{sig.razao.slice(0,60)}…</div>}
                {isTradeable(a.id) ? (
                  <button onClick={() => { setOrderModal({ assetId:a.id, side:"BUY" }); setOrderAmount(calcTradeAmount()); setTab("markets"); }} style={{
                    width:"100%", background:`${T.green}18`, border:`1px solid ${T.green}33`,
                    borderRadius:6, padding:"5px 0", fontSize:10, color:T.green,
                    cursor:"pointer", fontFamily:"inherit", fontWeight:700,
                  }}>▲ Investir</button>
                ) : (
                  <div style={{ fontSize:9, color:T.muted, textAlign:"center", padding:"5px 0" }}>Apenas análise</div>
                )}
              </div>
            );})}
          </div>
        </Glass>

        {/* ── ANÁLISE BOTÃO ── */}
        <Glass style={{ padding: "20px 24px" }} glow>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, flexWrap:"wrap", gap:12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>◆ Análise Profunda com IA</div>
              <div style={{ fontSize: 11, color: T.muted }}>
                Seleciona as categorias a analisar (nenhuma = todas). A IA dá até 6 oportunidades por categoria.
              </div>
            </div>
            <Btn onClick={analyseMarket} disabled={aiLoading} color={T.accent} style={{ padding: "11px 24px", fontSize: 13, flexShrink:0 }}>
              {aiLoading ? "◌ A analisar…" : "◆ Analisar Agora"}
            </Btn>
          </div>
          {/* Seletor de categorias */}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {[
              ["Crypto","💰 Cripto"],
              ["Commodity","🥇 Metais/Petróleo"],
              ["ETF","📈 ETFs"],
              ["Forex","💱 Forex"],
            ].map(([cat, label]) => {
              const sel = analyseCats.includes(cat);
              return (
                <button key={cat} onClick={() => {
                  setAnalyseCats(prev => sel ? prev.filter(c => c !== cat) : [...prev, cat]);
                }} style={{
                  background: sel ? `${T.accent}22` : "rgba(255,255,255,0.04)",
                  border: `1px solid ${sel ? T.accent+"66" : T.border}`,
                  borderRadius: 99, padding: "6px 16px", fontSize: 12, fontWeight: 700,
                  color: sel ? T.aLight : T.muted, cursor: "pointer", fontFamily: "inherit",
                }}>{sel ? "✓ " : ""}{label}</button>
              );
            })}
            {analyseCats.length > 0 && (
              <button onClick={() => setAnalyseCats([])} style={{
                background: "transparent", border: `1px solid ${T.border}`,
                borderRadius: 99, padding: "6px 14px", fontSize: 11, color: T.muted, cursor: "pointer", fontFamily: "inherit",
              }}>Limpar (todas)</button>
            )}
          </div>
        </Glass>

        {aiRec && (
          <>
            {/* Resumo + risco */}
            <Glass style={{
              padding: "20px 24px",
              background: "linear-gradient(135deg,rgba(99,102,241,0.12),rgba(16,185,129,0.06))",
              border: `1px solid ${T.accent}30`,
            }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:9, color:T.aLight, letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:8 }}>◆ ANÁLISE GERAL</div>
                  <div style={{ fontSize:14, lineHeight:1.7, marginBottom:8 }}>{aiRec.resumo}</div>
                  <div style={{ fontSize:12, color:T.aLight }}>{aiRec.oportunidade}</div>
                </div>
                <Badge label={`RISCO ${aiRec.risco}`} color={riskC(aiRec.risco)} />
              </div>
            </Glass>

            {/* Category tabs */}
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {AI_CATS.map(cat => {
                const count = cat==="Todos"
                  ? (aiRec.recs||[]).length
                  : (aiRec.recs||[]).filter(r => assets.find(x=>x.id===r.id)?.cat===cat).length;
                if (count===0 && cat!=="Todos") return null;
                return (
                  <button key={cat} onClick={() => setAiCat(cat)} style={{
                    background: aiCat===cat ? `${T.accent}22` : "rgba(255,255,255,0.04)",
                    border: `1px solid ${aiCat===cat ? T.accent+"55" : T.border}`,
                    borderRadius:99, padding:"5px 14px", fontSize:11, fontWeight:700,
                    color: aiCat===cat ? T.aLight : T.muted, cursor:"pointer", fontFamily:"inherit",
                  }}>
                    {cat==="Commodity"?"Metais/Petróleo":cat}
                    <span style={{ marginLeft:6, opacity:0.6 }}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Recs grid */}
            {filteredRecs.length === 0 ? (
              <div style={{ textAlign:"center", padding:32, color:T.muted, fontSize:12 }}>
                Sem recomendações para "{aiCat}" nesta análise.
              </div>
            ) : (
              <div className="resp-grid-2" style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:12 }}>
                {filteredRecs.map(rec => {
                  const a      = assets.find(x => x.id === rec.id);
                  const isBest = rec.id === aiRec.melhor;
                  const sinalRec = normSignal(rec.id, rec.sinal);
                  const colRec = sc(sinalRec);
                  return (
                    <Glass key={rec.id} style={{ padding:"18px 20px", position:"relative" }} glow={isBest}>
                      {isBest && (
                        <div style={{ position:"absolute", top:0, right:14, background:T.gold,
                          color:"#000", fontSize:9, fontWeight:700, padding:"2px 10px",
                          borderRadius:"0 0 8px 8px" }}>★ MELHOR</div>
                      )}
                      {/* Header */}
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10, marginTop:isBest?10:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ fontSize:22 }}>{a?.icon}</span>
                          <div>
                            <div style={{ fontWeight:700, fontSize:13 }}>{a?.name || rec.id}</div>
                            <div style={{ fontSize:10, color:T.muted }}>${a ? fmt(a.price, a.id) : "—"}</div>
                          </div>
                        </div>
                        <Badge label={sinalRec} color={colRec} />
                      </div>
                      {/* Razão */}
                      <div style={{ fontSize:12, color:T.text, lineHeight:1.65, marginBottom:10 }}>{rec.razao}</div>
                      {/* Previsão */}
                      {rec.previsao && (
                        <div style={{ fontSize:11, color:T.gold, fontStyle:"italic", padding:"6px 10px",
                          background:`${T.gold}0a`, borderLeft:`2px solid ${T.gold}55`, borderRadius:"0 6px 6px 0",
                          marginBottom:10, lineHeight:1.55 }}>
                          📅 {rec.previsao}
                        </div>
                      )}
                      {/* SL / TP / Entrada */}
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8,
                        background:"rgba(0,0,0,0.22)", borderRadius:8, padding:"10px 12px", fontSize:11 }}>
                        <div><div style={{ fontSize:8, color:T.muted }}>ENTRADA</div><div style={{ fontWeight:700 }}>${rec.entrada}</div></div>
                        <div><div style={{ fontSize:8, color:T.red   }}>STOP LOSS</div><div style={{ fontWeight:700, color:T.red   }}>${rec.sl}</div></div>
                        <div><div style={{ fontSize:8, color:T.green }}>TAKE PROFIT</div><div style={{ fontWeight:700, color:T.green }}>${rec.tp}</div></div>
                      </div>
                      <div style={{ marginTop:8, display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:10, color:T.muted }}>
                        <div>
                          <span>Confiança: <b style={{ color:T.aLight }}>{rec.confianca}%</b></span>
                          {rec.horizonte && <span style={{ marginLeft:10 }}>Prazo: {rec.horizonte}</span>}
                        </div>
                        {rec.sinal === "COMPRAR" && (
                          <button onClick={() => {
                            if (a?.trade) {
                              setOrderModal({ assetId: rec.id, side: "BUY" });
                              setOrderAmount(calcTradeAmount());
                              setTab("markets");
                            } else {
                              toast(`${a?.name || rec.id} não disponível para trading direto`, "warn");
                            }
                          }} style={{
                            background:`${T.green}20`, border:`1px solid ${T.green}44`,
                            borderRadius:7, padding:"5px 12px", fontSize:11, color:T.green,
                            cursor:"pointer", fontFamily:"inherit", fontWeight:700,
                          }}>▲ Investir</button>
                        )}
                      </div>
                    </Glass>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // ── Página de Sugestões: análise dos teus dados → recomendações transparentes ──
  // Regras FIXAS e explicáveis (não um LLM a adivinhar). Cada sugestão diz o
  // PORQUÊ, o número que a disparou, e (quando aplicável) tem botão de aplicar.
  const Sugestoes = () => {
    const docKey = botModoReal ? "realSettings" : "paperSettings";
    const aplicar = (patch, msg) => {
      const novo = { ...liveSettings, ...patch };
      if (user) import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
      toast(msg, "success");
    };

    const n = tradeStats.count;
    const wr = n > 0 ? tradeStats.winRate : null;
    const exp = n > 0 ? tradeStats.expectancy : null;
    const pf = n > 0 ? tradeStats.profitFactor : null;
    const dd = n > 0 ? tradeStats.maxDD : null;
    const arq = (dailyArchives || []).filter(a => Array.isArray(a.trades));
    const ultimoDia = arq[0];
    const tradesUltimoDia = ultimoDia ? ultimoDia.trades.length : null;
    const s = liveSettings;

    const sugestoes = [];

    if (n >= 10 && exp != null && exp < 0) {
      sugestoes.push({
        sev: "alta", icon: "🚫", titulo: "Não passar a live ainda",
        facto: `Expectativa de ${sign(exp)}€${Math.abs(exp).toFixed(2)}/trade sobre ${n} trades fechados.`,
        texto: "Com expectativa negativa, passar a live perde dinheiro real de forma consistente. O backtester confirmou que nenhum perfil tem edge com a lógica atual. A prioridade é mudar a lógica de entrada (testar momentum), não os parâmetros.",
        acao: null,
      });
    }

    if ((s.maxDayTrading || 0) >= 6 || s.rotacaoAtiva) {
      sugestoes.push({
        sev: "alta", icon: "⚡", titulo: "Reduzir geração de trades",
        facto: `Day Trading: ${s.maxDayTrading || 0} posições${s.rotacaoAtiva ? " · Rotação ATIVADA" : ""}${tradesUltimoDia != null ? ` · ${tradesUltimoDia} trades no último dia` : ""}.`,
        texto: "Day Trading alto + Rotação geram muitos trades. Cada trade tem custo de comissão/slippage; com expectativa negativa, mais trades = perder mais rápido. Reduzir o Day Trading para 3-4 e desligar a Rotação corta o sangramento.",
        acao: { label: "Aplicar (DT=4, Rotação off)", patch: { maxDayTrading: 4, rotacaoAtiva: false } },
      });
    }

    if (s.aiBrain && (s.aiBrainConfianca || 0) < 80) {
      sugestoes.push({
        sev: "media", icon: "🤖", titulo: "Subir a confiança do Cérebro AI",
        facto: `Confiança mínima atual: ${s.aiBrainConfianca || 0}%.`,
        texto: "O Groq infla confiança (diz 90%+ em ativos parados). A 70%, entram demasiados sinais marginais — os que mais perdem. Subir para 82% filtra as entradas fracas e melhora a qualidade média.",
        acao: { label: "Aplicar (82%)", patch: { aiBrainConfianca: 82 } },
      });
    }

    if (!s.regimeDinamico && (exp == null || exp < 0 || (dd != null && dd > 12))) {
      sugestoes.push({
        sev: "media", icon: "📊", titulo: "Ligar o Modo Dinâmico",
        facto: dd != null ? `Drawdown máximo: ${dd.toFixed(0)}%. Modo Dinâmico: desligado.` : "Modo Dinâmico: desligado.",
        texto: "A tua lógica perde mais em mercados de baixa (comprar quedas). O Modo Dinâmico reduz exposição automaticamente quando BTC e SPY estão a descer — corta perdas sem precisar de prever nada. É das poucas coisas que ajudam matematicamente já.",
        acao: { label: "Ligar Modo Dinâmico", patch: { regimeDinamico: true } },
      });
    }

    if (perfilRecomendado.escolha && perfilRecomendado.escolha.id !== perfilRecomendado.atual) {
      const e = perfilRecomendado.escolha;
      sugestoes.push({
        sev: "media", icon: "🎯", titulo: `Mudar perfil para ${e.label}`,
        facto: `Win rate real ${wr != null ? wr.toFixed(0) : "?"}% · perfil atual ${perfilRecomendado.atual} (precisa de ${e.breakeven.toFixed(0)}% para empatar no recomendado).`,
        texto: `Para o teu win rate atual, o ${e.label} é o perfil matematicamente mais sólido (ou o menos mau). Alinha os SL/TP com a taxa de acerto que tens realmente.`,
        acao: { label: `Aplicar ${e.label}`, patch: { riscoPerfil: e.id, stopLossPadrao: e.sl, takeProfitPadrao: e.tp } },
      });
    }

    if (n < 10) {
      sugestoes.push({
        sev: "info", icon: "📈", titulo: "Acumular mais dados",
        facto: `${n} trades fechados (mínimo ~30 para conclusões fiáveis).`,
        texto: "As sugestões ganham força com mais trades. Deixa o bot correr em paper e volta aqui — quanto mais trades, mais precisas ficam as recomendações sobre perfil, expectativa e drawdown.",
        acao: null,
      });
    }

    const corSev = { alta: T.red, media: T.gold, info: T.blue };
    const agora = new Date();
    const periodo = agora.getHours() < 12 ? "manhã" : agora.getHours() < 18 ? "meio do dia" : "fim do dia";

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }}>
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>💡 Configurações Sugeridas</div>
          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
            Análise dos teus dados reais ({n} trades fechados) — snapshot de {periodo}, {agora.toLocaleDateString("pt-PT")} {agora.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}.
            Cada sugestão usa regras transparentes sobre os teus números, não palpites de IA. Vê o porquê de cada uma e aplica se concordares.
          </div>
        </Glass>

        {n > 0 && (
          <div className="resp-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
            {[
              { l: "Win Rate", v: `${wr.toFixed(0)}%`, c: wr >= 35 ? T.green : T.red },
              { l: "Expectativa", v: `${sign(exp)}€${Math.abs(exp).toFixed(2)}`, c: exp >= 0 ? T.green : T.red },
              { l: "Profit Factor", v: pf === Infinity ? "∞" : pf.toFixed(2), c: pf >= 1 ? T.green : T.red },
              { l: "Max Drawdown", v: `${dd.toFixed(0)}%`, c: dd <= 15 ? T.green : T.red },
            ].map(m => (
              <Glass key={m.l} style={{ padding: "14px 16px" }}>
                <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 6 }}>{m.l}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: m.c }}>{m.v}</div>
              </Glass>
            ))}
          </div>
        )}

        {sugestoes.length === 0 ? (
          <Glass style={{ padding: "24px", textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Sem sugestões críticas neste momento</div>
            <div style={{ fontSize: 11, color: T.muted }}>A tua configuração está alinhada com os teus dados. Continua a monitorizar.</div>
          </Glass>
        ) : (
          sugestoes.map((sg, i) => (
            <Glass key={i} style={{ padding: "18px 22px", borderLeft: `3px solid ${corSev[sg.sev]}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 18 }}>{sg.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{sg.titulo}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: corSev[sg.sev], textTransform: "uppercase", letterSpacing: "0.08em", padding: "2px 6px", borderRadius: 4, background: `${corSev[sg.sev]}1a` }}>{sg.sev}</span>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.aLight, marginBottom: 6 }}>{sg.facto}</div>
                  <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>{sg.texto}</div>
                </div>
                {sg.acao && (
                  <button onClick={() => aplicar(sg.acao.patch, `✅ ${sg.titulo} aplicado`)} style={{
                    padding: "9px 16px", borderRadius: 9, border: `1px solid ${corSev[sg.sev]}`,
                    background: `${corSev[sg.sev]}1a`, color: corSev[sg.sev], fontWeight: 700,
                    fontSize: 11, cursor: "pointer", whiteSpace: "nowrap",
                  }}>{sg.acao.label}</button>
                )}
              </div>
            </Glass>
          ))
        )}

        <Glass style={{ padding: "16px 20px", background: `${T.blue}08` }}>
          <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>
            <b style={{ color: T.aLight }}>Nota honesta:</b> estas sugestões reduzem o dano e alinham a config com os teus dados, mas
            enquanto a lógica de entrada não tiver edge (confirmado pelo backtester), o sistema continua com expectativa negativa.
            A mudança que mais mexe a agulha é testar a lógica momentum — corre <code style={{ color: T.accent }}>node scripts/backtest.js --compara --fetch=btc,eth,sol,xrp,ada --dias=365</code> na consola do Railway.
          </div>
        </Glass>
      </div>
    );
  };

  // ── PÁGINA: Plano DCA (o núcleo passivo) ──────────────────────────────────
  // Onde o utilizador define o plano com ajuda da IA. O bot é que executa.
  // ── PÁGINA: Relatório Financeiro ──────────────────────────────────────────
  // Posição consolidada (saldo real dos brokers) + valor por plano DCA + por
  // fonte de trading, com P&L líquido de comissões.
  const Relatorio = () => {
    const brokers = Array.isArray(botStatus?.brokers) ? botStatus.brokers : [];
    const precoDe = (id) => { const a = assets.find(x => x.id === id); return a ? a.price : null; };
    const fmt = (v) => `${v < 0 ? "-" : ""}€${Math.abs(v).toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // Posições abertas agrupadas por fonte (DCA por plano; trading por origem).
    const abertas = positions.filter(p => p.status === "ABERTA" || !p.status);
    const valorPos = (p) => { const px = precoDe(p.assetId); return px != null ? p.units * px : (p.amount || 0); };
    const plPos = (p) => { const px = precoDe(p.assetId); if (px == null) return 0; return (px - p.entryPrice) * p.units - roundTripFeeApp(p, p.amount); };

    // DCA por plano
    const planos = Array.isArray(liveSettings.dcaPlanos) ? liveSettings.dcaPlanos : [];
    const dcaPorPlano = planos.map(pl => {
      const ps = abertas.filter(p => p.stratId === "dca" && (p.planId || "principal") === pl.id);
      const investido = ps.reduce((a, p) => a + (p.amount || 0), 0);
      const valor = ps.reduce((a, p) => a + valorPos(p), 0);
      const pl_ = ps.reduce((a, p) => a + plPos(p), 0);
      return { nome: pl.nome, n: ps.length, investido, valor, pl: pl_, dataInicio: pl.dataInicio };
    }).filter(x => x.n > 0);

    // DCA sem plano (legado) ou plano "principal"
    const dcaOutras = abertas.filter(p => p.stratId === "dca" && !planos.find(pl => pl.id === (p.planId || "principal")));
    if (dcaOutras.length) {
      dcaPorPlano.push({ nome: "DCA (principal)", n: dcaOutras.length,
        investido: dcaOutras.reduce((a, p) => a + (p.amount || 0), 0),
        valor: dcaOutras.reduce((a, p) => a + valorPos(p), 0),
        pl: dcaOutras.reduce((a, p) => a + plPos(p), 0), dataInicio: null });
    }

    // Trading ativo por fonte
    const fonteDe = (p) => p.stratId === "daytrading" ? "Day Trading"
      : p.stratId === "manual" ? "Compras manuais"
      : p.stratId === "ai-brain" ? "Cérebro AI" : "Estratégias";
    const ativo = abertas.filter(p => p.stratId !== "dca");
    const porFonte = {};
    for (const p of ativo) {
      const f = fonteDe(p);
      if (!porFonte[f]) porFonte[f] = { nome: f, n: 0, investido: 0, valor: 0, pl: 0 };
      porFonte[f].n++; porFonte[f].investido += p.amount || 0; porFonte[f].valor += valorPos(p); porFonte[f].pl += plPos(p);
    }
    const fontes = Object.values(porFonte);

    // Totais
    const totalDcaValor = dcaPorPlano.reduce((a, x) => a + x.valor, 0);
    const totalDcaPL = dcaPorPlano.reduce((a, x) => a + x.pl, 0);
    const totalAtivoValor = fontes.reduce((a, x) => a + x.valor, 0);
    const totalAtivoPL = fontes.reduce((a, x) => a + x.pl, 0);

    // P&L realizado (trades fechados), líquido de comissões
    const fechados = closed.filter(t => t.status && t.status !== "ABERTA");
    const plRealizado = fechados.reduce((a, t) => {
      const px = t.exitPrice ?? t.precoSaida;
      if (px == null) return a + (t.pl || t.lucro || 0);
      return a + ((px - t.entryPrice) * t.units - roundTripFeeApp(t, t.amount));
    }, 0);

    const Linha = ({ nome, sub, n, investido, valor, pl, cor }) => (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: `1px solid ${T.border}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{nome}</div>
          {sub && <div style={{ fontSize: 9.5, color: T.muted }}>{sub}</div>}
        </div>
        <div style={{ textAlign: "right", minWidth: 90 }}>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Investido</div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{fmt(investido)}</div>
        </div>
        <div style={{ textAlign: "right", minWidth: 90 }}>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Valor atual</div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{fmt(valor)}</div>
        </div>
        <div style={{ textAlign: "right", minWidth: 90 }}>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>P&L líq.</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: pl >= 0 ? T.green : T.red }}>{pl >= 0 ? "+" : ""}{fmt(pl)}</div>
        </div>
      </div>
    );

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 940 }}>
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>📊 Relatório Financeiro</div>
          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>A tua posição consolidada: saldo real nos brokers, valor por plano DCA e por fonte de trading. Todos os P&L são líquidos de comissões.</div>
        </Glass>

        {/* Gráfico de evolução da carteira (dados reais guardados pelo bot) */}
        {portfolioHist.length >= 2 ? (
          <Glass style={{ padding: "20px 24px" }}>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>📈 Evolução da carteira</div>
            <div style={{ fontSize: 10, color: T.muted, marginBottom: 14 }}>Valor total ao longo do tempo (um ponto por dia). A linha tracejada é o que investiste.</div>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={portfolioHist.map(p => ({ ...p, dLabel: new Date(p.ts).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" }) }))} margin={{ top: 6, right: 6, bottom: 4, left: 0 }}>
                <defs>
                  <linearGradient id="gPort" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.green} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={T.green} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="dLabel" tick={{ fontSize: 9, fill: T.muted }} tickLine={false} axisLine={false} minTickGap={30} />
                <YAxis tick={{ fontSize: 9, fill: T.muted }} tickLine={false} axisLine={false} width={44} domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ background: T.base, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 11 }} labelStyle={{ color: T.muted }} formatter={(v, n) => [`€${Number(v).toFixed(2)}`, n === "v" ? "Valor" : "Investido"]} />
                <Area type="monotone" dataKey="v" stroke={T.green} strokeWidth={2} fill="url(#gPort)" />
                <Area type="monotone" dataKey="inv" stroke={T.muted} strokeWidth={1} strokeDasharray="4 4" fill="none" />
              </AreaChart>
            </ResponsiveContainer>
          </Glass>
        ) : (
          <Glass style={{ padding: "18px 24px" }}>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>📈 Evolução da carteira</div>
            <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>O gráfico aparece aqui a partir de amanhã. O bot guarda um ponto do valor da tua carteira por dia — precisa de pelo menos 2 dias para desenhar a linha. Vai ficando mais rico com o tempo.</div>
          </Glass>
        )}

        {/* Saldo real por broker */}
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>🏦 Contas nos brokers</div>
          {brokers.length === 0 ? (
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
              Sem dados de brokers ainda. Em modo simulação não há saldo real. Quando ligares um broker (paper ou real), o saldo aparece aqui automaticamente.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {brokers.map(b => {
                const classes = (b.assetClasses || []).join(", ");
                const fazDca = (b.assetClasses || []).some(c => ["etf", "stock", "crypto", "commodity"].includes(c));
                return (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: `1px solid ${T.border}` }}>
                    <div style={{ width: 9, height: 9, borderRadius: "50%", background: b.conectado ? T.green : T.muted, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{b.nome}</div>
                      <div style={{ fontSize: 9.5, color: T.muted }}>Negoceia: {classes || "—"} {fazDca ? "· pode fazer DCA" : ""}</div>
                      {b.erro && <div style={{ fontSize: 9, color: T.red }}>⚠ {b.erro}</div>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {b.id === "xtb" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 10, color: T.muted }}>€</span>
                          <input type="number" step="0.01" placeholder="saldo"
                            defaultValue={liveSettings.xtbSaldo != null ? liveSettings.xtbSaldo : ""}
                            onBlur={(e) => {
                              if (!user) return;
                              const v = e.target.value === "" ? null : Math.max(0, parseFloat(e.target.value) || 0);
                              const docKey = botModoReal ? "realSettings" : "paperSettings";
                              const novo = { ...liveSettings, xtbSaldo: v };
                              import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
                              toast("💾 Saldo XTB atualizado", "success");
                            }}
                            style={{ width: 100, padding: "6px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 13, fontWeight: 700, textAlign: "right" }} />
                        </div>
                      ) : b.saldo != null ? (
                        <div style={{ fontSize: 14, fontWeight: 800 }}>{b.saldo.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style={{ fontSize: 10, color: T.muted }}>{b.moeda}</span></div>
                      ) : (
                        <div style={{ fontSize: 10, color: T.muted }}>{b.conectado ? (botModoReal ? "—" : "saldo só em live") : "não ligado"}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 9.5, color: T.muted, marginTop: 12, lineHeight: 1.5, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
            💡 Cada plano DCA só pode usar o broker que negoceia os seus ativos. Ex.: um plano de ETFs sai do XTB/IBKR; um de cripto sai do Binance. A app escolhe o broker certo conforme a carteira de cada plano.
            <br />🏦 <b>XTB:</b> 0% de comissão em ETFs/ações até 100k€/mês. Conta com ~0,5% de conversão de moeda se comprares ETFs em USD — escolhe versões UCITS em EUR para evitar. Os P&L abaixo já descontam estes custos.
          </div>
        </Glass>

        {/* Planos DCA */}
        <Glass style={{ padding: "20px 24px", background: `${T.green}06` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>🎯 Planos DCA</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: totalDcaPL >= 0 ? T.green : T.red }}>{totalDcaPL >= 0 ? "+" : ""}{fmt(totalDcaPL)}</span>
          </div>
          {dcaPorPlano.length === 0 ? (
            <div style={{ fontSize: 11, color: T.muted, marginTop: 8 }}>Ainda sem posições DCA. Quando o bot fizer as primeiras compras, aparecem aqui por plano.</div>
          ) : dcaPorPlano.map((x, i) => (
            <Linha key={i} nome={x.nome} sub={`${x.n} posição(ões)${x.dataInicio ? " · desde " + new Date(x.dataInicio).toLocaleDateString("pt-PT") : ""}`} investido={x.investido} valor={x.valor} pl={x.pl} />
          ))}
        </Glass>

        {/* Trading ativo */}
        <Glass style={{ padding: "20px 24px", background: `${T.gold}06` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>⚡ Trading ativo</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: totalAtivoPL >= 0 ? T.green : T.red }}>{totalAtivoPL >= 0 ? "+" : ""}{fmt(totalAtivoPL)}</span>
          </div>
          {fontes.length === 0 ? (
            <div style={{ fontSize: 11, color: T.muted, marginTop: 8 }}>Sem posições de trading ativo abertas.</div>
          ) : fontes.map((x, i) => (
            <Linha key={i} nome={x.nome} sub={`${x.n} posição(ões)`} investido={x.investido} valor={x.valor} pl={x.pl} />
          ))}
        </Glass>

        {/* Totais */}
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>Σ Resumo</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div><div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>Valor DCA</div><div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(totalDcaValor)}</div></div>
            <div><div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>Valor trading ativo</div><div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(totalAtivoValor)}</div></div>
            <div><div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>P&L não realizado</div><div style={{ fontSize: 16, fontWeight: 800, color: (totalDcaPL + totalAtivoPL) >= 0 ? T.green : T.red }}>{(totalDcaPL + totalAtivoPL) >= 0 ? "+" : ""}{fmt(totalDcaPL + totalAtivoPL)}</div></div>
            <div><div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>P&L realizado (fechados)</div><div style={{ fontSize: 16, fontWeight: 800, color: plRealizado >= 0 ? T.green : T.red }}>{plRealizado >= 0 ? "+" : ""}{fmt(plRealizado)}</div></div>
          </div>
          <div style={{ fontSize: 9.5, color: T.muted, marginTop: 14, lineHeight: 1.5 }}>Todos os valores de P&L já descontam as comissões estimadas de entrada e saída (round-trip), para refletirem o ganho/perda real.</div>
        </Glass>

        {/* Exportação para IRS — CSV das vendas do ano (mais-valias) */}
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>📄 Exportar para IRS</div>
          <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6, marginBottom: 14 }}>
            Gera um ficheiro CSV com as tuas vendas do ano (data, ativo, valor de compra, valor de venda, mais/menos-valia). Útil para o Anexo G/J do IRS quando venderes. Abre no Excel.
          </div>
          <Btn solid color={T.accent} onClick={() => {
            const ano = new Date().getFullYear();
            const vendas = closed.filter(t => {
              if (!t.status || t.status === "ABERTA") return false;
              const d = t.closedAt || t.savedAt;
              return d && new Date(d).getFullYear() === ano;
            });
            if (!vendas.length) { toast("Sem vendas registadas este ano para exportar.", "warn"); return; }
            const linhas = [["Data venda", "Ativo", "Unidades", "Valor compra (EUR)", "Valor venda (EUR)", "Mais-valia (EUR)"]];
            vendas.forEach(t => {
              const px = t.exitPrice ?? t.precoSaida ?? 0;
              const valorVenda = px * t.units;
              const valorCompra = t.entryPrice * t.units;
              const mv = valorVenda - valorCompra - roundTripFeeApp(t, t.amount);
              linhas.push([
                new Date(t.closedAt || t.savedAt).toLocaleDateString("pt-PT"),
                (t.assetSym || t.assetId || "").toUpperCase(),
                t.units.toFixed(6),
                valorCompra.toFixed(2),
                valorVenda.toFixed(2),
                mv.toFixed(2),
              ]);
            });
            const csv = linhas.map(l => l.join(";")).join("\n");
            const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `tradeai-irs-${ano}.csv`; a.click();
            URL.revokeObjectURL(url);
            toast(`✅ Exportadas ${vendas.length} vendas de ${ano}`, "success");
          }}>📥 Exportar vendas de {new Date().getFullYear()}</Btn>
          <div style={{ fontSize: 9, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>⚠️ Documento de apoio, não substitui aconselhamento fiscal. Confirma as regras de mais-valias com um contabilista ou na app das Finanças.</div>
        </Glass>

        {/* Comparação: trading ativo vs comprar-e-segurar (honestidade sobre a estratégia) */}
        {fontes.length > 0 && (() => {
          // Quanto renderia se, em vez de fazer trading ativo, simplesmente
          // tivesses comprado os mesmos ativos e segurado (sem comissões de saída).
          const investidoAtivo = fontes.reduce((a, x) => a + x.investido, 0);
          // P&L de buy-and-hold = variação de preço desde a entrada, SEM custos de
          // rotação (só uma entrada). Aproximação: o valor atual menos o investido.
          const valorBH = ativo.reduce((a, p) => { const px = precoDe(p.assetId); return a + (px != null ? p.units * px : (p.amount || 0)); }, 0);
          const plBH = valorBH - investidoAtivo; // sem taxas de saída repetidas
          const plReal = totalAtivoPL; // já líquido de taxas
          const diff = plReal - plBH;
          return (
            <Glass style={{ padding: "20px 24px" }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>⚖️ Trading ativo vs Comprar e segurar</div>
              <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6, marginBottom: 14 }}>
                Compara o que ganhaste a fazer trading ativo com o que terias ganho se simplesmente comprasses os mesmos ativos e segurasses. Ajuda a saber se a estratégia ativa está mesmo a valer a pena.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div><div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>Trading ativo (real)</div><div style={{ fontSize: 17, fontWeight: 800, color: plReal >= 0 ? T.green : T.red }}>{plReal >= 0 ? "+" : ""}{fmt(plReal)}</div></div>
                <div><div style={{ fontSize: 10, color: T.muted, textTransform: "uppercase" }}>Se tivesses só segurado</div><div style={{ fontSize: 17, fontWeight: 800, color: plBH >= 0 ? T.green : T.red }}>{plBH >= 0 ? "+" : ""}{fmt(plBH)}</div></div>
              </div>
              <div style={{ marginTop: 14, padding: "12px 16px", borderRadius: 10, background: diff >= 0 ? `${T.green}12` : `${T.red}12`, border: `1px solid ${diff >= 0 ? T.green : T.red}33` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: diff >= 0 ? T.green : T.red }}>
                  {diff >= 0
                    ? `✓ O trading ativo está a render +${fmt(diff)} acima de comprar e segurar.`
                    : `⚠ Comprar e segurar teria rendido +${fmt(Math.abs(diff))} a mais que o trading ativo.`}
                </div>
                {diff < 0 && <div style={{ fontSize: 9.5, color: T.muted, marginTop: 4 }}>Não é um problema imediato — é só informação. Se isto se mantiver ao longo do tempo, talvez o DCA passivo seja melhor para ti do que o trading ativo.</div>}
              </div>
            </Glass>
          );
        })()}
      </div>
    );
  };

  // ── Card de uma ordem DCA manual pendente: mostra o que comprar, deixa editar
  //    o preço real, e confirma (regista a posição). ──

  const PlanoDCA = () => {
    const s = liveSettings;
    const docKey = botModoReal ? "realSettings" : "paperSettings";
    // (planoAberto vem do estado do componente principal — não pode ser useState
    //  aqui porque PlanoDCA é chamado como função condicional, o que violaria as
    //  regras dos hooks e causava o React error #310.)
    const salvar = (patch, msg) => {
      const novo = { ...liveSettings, ...patch };
      if (user) import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
      if (msg) toast(msg, "success");
    };

    // Migração suave: se houver plano antigo (dcaCarteira) e ainda não houver
    // dcaPlanos, converte-o num plano "Principal" da primeira vez.
    const planos = Array.isArray(s.dcaPlanos) ? s.dcaPlanos : [];
    const nomeAtivo = (id) => { const a = ASSETS.find(x => x.id === id); return a ? `${a.icon || ""} ${a.name}` : id; };
    // Dado a carteira de um plano, descobre que broker(s) conseguem negociá-la.
    // Mapeia a categoria de cada ativo às assetClasses dos brokers disponíveis.
    const brokersDisp = Array.isArray(botStatus?.brokers) ? botStatus.brokers : [];
    const catParaClasse = { Crypto: "crypto", ETF: "etf", "Ação": "stock", Commodity: "commodity", Forex: "forex" };
    const brokerDoPlano = (carteira) => {
      if (!carteira?.length || !brokersDisp.length) return null;
      const classesNec = [...new Set(carteira.map(c => { const a = ASSETS.find(x => x.id === c.id); return a ? catParaClasse[a.cat] : null; }).filter(Boolean))];
      // Brokers que cobrem TODAS as classes necessárias.
      const compat = brokersDisp.filter(b => classesNec.every(cl => (b.assetClasses || []).includes(cl)));
      return { classesNec, compat };
    };
    const bolo = Number(s.dcaValorMensal) || 0;

    // Repartição: calcula quanto € vai cada plano + a fatia AI Trade.
    const reservaAi = Number(s.dcaAiTradeValor) > 0 ? Number(s.dcaAiTradeValor)
      : (Number(s.dcaAiTradePct) || 0) / 100 * bolo;
    const planosEur = (() => {
      const fixos = planos.filter(p => p.alocacao?.tipo === "valor");
      const pcts = planos.filter(p => p.alocacao?.tipo === "pct");
      const totalFixo = fixos.reduce((a, p) => a + (Number(p.alocacao.valor) || 0), 0);
      const restante = Math.max(0, bolo - totalFixo - reservaAi);
      const somaPct = pcts.reduce((a, p) => a + (Number(p.alocacao.valor) || 0), 0);
      const out = {};
      for (const p of fixos) out[p.id] = Math.min(Number(p.alocacao.valor) || 0, bolo);
      for (const p of pcts) {
        const ideal = bolo * (Number(p.alocacao.valor) || 0) / 100;
        out[p.id] = somaPct > 0 ? Math.min(ideal, restante * (Number(p.alocacao.valor) / somaPct)) : 0;
      }
      return out;
    })();
    const totalAlocado = Object.values(planosEur).reduce((a, v) => a + v, 0) + reservaAi;
    const sobra = +(bolo - totalAlocado).toFixed(2);

    const novoPlano = (carteira, alocacao, frequencia, nome, modoExecucao) => {
      const id = "p_" + Date.now().toString(36);
      const p = { id, nome: nome || "Novo plano", carteira, alocacao: alocacao || { tipo: "pct", valor: 0 },
        frequencia: frequencia || "mensal", dataInicio: null, proximaCompra: null, reequilibrar: true,
        ...(modoExecucao ? { modoExecucao } : {}) };
      salvar({ dcaPlanos: [...planos, p] }, `✅ Plano "${p.nome}" criado`);
    };
    const updPlano = (id, patch) => salvar({ dcaPlanos: planos.map(p => p.id === id ? { ...p, ...patch } : p) });
    const delPlano = (id) => {
      const plano = planos.find(p => p.id === id);
      const posAbertas = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca" && (x.planId || "principal") === id);
      if (posAbertas.length > 0) {
        // O plano tem posições abertas — perguntar o que fazer, para não deixar órfãs.
        setConfirmModal({
          title: `Apagar plano "${plano?.nome || ""}"?`,
          message: `Este plano tem ${posAbertas.length} posição(ões) aberta(s). O que queres fazer?`,
          lines: posAbertas.map(x => `${(x.assetSym || x.assetId).toUpperCase()} — €${(x.amount || 0).toFixed(0)}`),
          icon: "🎯",
          confirmLabel: "Vender tudo e apagar",
          extraLabel: "Apagar e manter posições",
          extra2Label: mestreOn ? "🤖 Passar para o AI gerir" : null,
          onConfirm: () => {
            // Vende todas as posições do plano, depois apaga o plano.
            posAbertas.forEach(pos => cmdToBot({ type: "SELL", posId: pos.id, assetId: pos.assetId }));
            salvar({ dcaPlanos: planos.filter(p => p.id !== id) }, "Plano apagado — posições vendidas");
            setConfirmModal(null);
          },
          onExtra: () => {
            // Apaga o plano mas mantém as posições (ficam órfãs, geridas na mesma).
            salvar({ dcaPlanos: planos.filter(p => p.id !== id) }, "Plano apagado — posições mantidas");
            setConfirmModal(null);
          },
          onExtra2: () => {
            // Passa para o AI gerir: pede o lucro-alvo e envia o comando.
            setConfirmModal(null);
            const alvoStr = window.prompt("A que percentagem de lucro (líquida de taxas) queres que o AI venda cada posição?\n\nEx.: 5 = vende quando estiver +5% em lucro real.\nO AI nunca vende a perder — só realiza lucro.", "5");
            const alvo = parseFloat(alvoStr);
            if (!alvo || alvo <= 0) { toast("Lucro-alvo inválido. Nada alterado.", "warn"); return; }
            if (user) import("./firebase.js").then(({ sendCommand }) => {
              sendCommand(user.uid, { type: "DCA_TO_AI", planId: id, lucroAlvo: alvo })
                .then(() => { salvar({ dcaPlanos: planos.filter(p => p.id !== id) }, `🤖 Posições passadas ao AI (vende a +${alvo}%)`); })
                .catch(() => toast("Erro ao passar para o AI.", "error"));
            });
          },
        });
      } else {
        salvar({ dcaPlanos: planos.filter(p => p.id !== id) }, "Plano removido");
      }
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 940 }}>
        {/* Cabeçalho */}
        <Glass style={{ padding: "20px 24px", background: `${T.green}0a`, border: `1px solid ${T.green}22` }}>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>🎯 Planos DCA — investir em piloto automático</div>
          <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.7 }}>
            Defines um <b>valor mensal</b> e repartes por objetivos (ex.: Férias, Reforma). Cada plano tem a sua carteira e a sua data de início, para medires o desempenho de cada um. O <b>bot executa tudo sozinho</b>, 24/7, mesmo com a app fechada.
          </div>
          <div style={{ fontSize: 10, color: T.gold, marginTop: 10, lineHeight: 1.6, background: `${T.gold}12`, padding: "8px 12px", borderRadius: 8 }}>
            ⚠️ Não é aconselhamento financeiro. A IA ajuda-te a montar, mas a decisão é tua. Os mercados podem cair no curto prazo — o DCA funciona melhor em horizontes de vários anos.
          </div>
        </Glass>


        {/* Ordens DCA manuais pendentes — "compra isto e confirma" */}
        {manualOrders.length > 0 && manualOrders.map(ordem => (
          <OrdemManualCard key={ordem.id} ordem={ordem} ASSETS={ASSETS} T={T} Glass={Glass}
            precoAtual={(id) => { const a = assets.find(x => x.id === id); return a ? a.price : null; }}
            onConfirmar={(itens) => {
              if (!user) return;
              const docKey = botModoReal ? "realSettings" : "paperSettings";
              // Desconto automático do saldo manual (XTB) se a compra foi nesse broker.
              const gasto = itens.reduce((a, it) => a + (Number(it.eur) || 0), 0);
              if ((ordem.broker === "xtb" || !ordem.broker) && liveSettings.xtbSaldo != null) {
                const novoSaldo = Math.max(0, +(Number(liveSettings.xtbSaldo) - gasto).toFixed(2));
                const novo = { ...liveSettings, xtbSaldo: novoSaldo };
                import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
              }
              import("./firebase.js").then(({ sendCommand }) => {
                sendCommand(user.uid, {
                  type: "DCA_MANUAL_CONFIRM", ordemId: ordem.id, planId: ordem.planId,
                  planNome: ordem.planNome, broker: ordem.broker, itens,
                }).then(() => toast("✅ Compra registada — posição adicionada ao teu plano", "success"))
                  .catch(() => toast("Não consegui registar. Tenta de novo.", "error"));
              });
            }} />
        ))}

        {/* Calendário de próximos aportes — quando é a próxima compra de cada plano */}
        {planos.length > 0 && (() => {
          const FREQ_MS = { semanal: 7*864e5, quinzenal: 15*864e5, mensal: 30*864e5 };
          const agora = Date.now();
          const proximos = planos.map(p => {
            let prox = p.proximaCompra;
            if (!prox) {
              const intervalo = FREQ_MS[p.frequencia] || FREQ_MS.mensal;
              prox = (p.dataInicio || agora) + intervalo;
            }
            const eur = planosEur[p.id] || 0;
            return { nome: p.nome, prox, eur, modo: p.modoExecucao, freq: p.frequencia };
          }).filter(x => x.eur > 0).sort((a, b) => a.prox - b.prox);
          if (!proximos.length) return null;
          return (
            <Glass style={{ padding: "20px 24px" }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>📅 Próximos aportes</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {proximos.map((x, i) => {
                  const dias = Math.ceil((x.prox - agora) / 864e5);
                  const quando = dias <= 0 ? "hoje" : dias === 1 ? "amanhã" : `em ${dias} dias`;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: i ? `1px solid ${T.border}` : "none" }}>
                      <div style={{ width: 42, height: 42, borderRadius: 10, background: T.gradCard, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1 }}>{new Date(x.prox).getDate()}</div>
                        <div style={{ fontSize: 7.5, color: T.muted, textTransform: "uppercase" }}>{new Date(x.prox).toLocaleString("pt-PT", { month: "short" })}</div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{x.nome}</div>
                        <div style={{ fontSize: 9.5, color: T.muted }}>€{x.eur.toFixed(0)} · {x.freq} · {x.modo === "manual" ? "🔔 confirmas tu" : "🤖 automático"}</div>
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: dias <= 1 ? T.gold : T.muted }}>{quando}</div>
                    </div>
                  );
                })}
              </div>
            </Glass>
          );
        })()}

        {/* Bolo mensal + repartição */}
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>💰 Valor mensal e repartição</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Valor por período (o "bolo")</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18, color: T.muted }}>€</span>
                <input type="number" min={1} value={s.dcaValorMensal}
                  onChange={(e) => salvar({ dcaValorMensal: Math.max(1, parseInt(e.target.value) || 1) })}
                  style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 16, fontWeight: 700 }} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Reserva p/ AI Trade</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="number" min={0} value={s.dcaAiTradeValor > 0 ? s.dcaAiTradeValor : s.dcaAiTradePct}
                  onChange={(e) => {
                    const v = Math.max(0, parseInt(e.target.value) || 0);
                    if (s.dcaAiTradeValor > 0) salvar({ dcaAiTradeValor: v });
                    else salvar({ dcaAiTradePct: v });
                  }}
                  style={{ width: 80, padding: "9px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 15, fontWeight: 700 }} />
                <button onClick={() => salvar(s.dcaAiTradeValor > 0 ? { dcaAiTradeValor: 0, dcaAiTradePct: 20 } : { dcaAiTradeValor: Math.round(reservaAi) || 20, dcaAiTradePct: 0 })}
                  style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: "transparent", color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  {s.dcaAiTradeValor > 0 ? "€ fixo" : "% bolo"}
                </button>
              </div>
            </div>
          </div>

          {/* Barra de repartição visual */}
          <div style={{ fontSize: 10, color: T.muted, marginBottom: 8 }}>Como o bolo de €{bolo} é repartido:</div>
          <div style={{ display: "flex", height: 28, borderRadius: 8, overflow: "hidden", marginBottom: 10, background: "rgba(0,0,0,0.3)" }}>
            {planos.map((p, i) => {
              const w = bolo > 0 ? (planosEur[p.id] || 0) / bolo * 100 : 0;
              const cores = [T.green, T.blue, T.accent, "#a78bfa", "#f472b6"];
              return w > 0 ? <div key={p.id} title={`${p.nome}: €${(planosEur[p.id]||0).toFixed(0)}`} style={{ width: `${w}%`, background: cores[i % cores.length], display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#000" }}>{w > 12 ? p.nome : ""}</div> : null;
            })}
            {reservaAi > 0 && <div title={`AI Trade: €${reservaAi.toFixed(0)}`} style={{ width: `${bolo > 0 ? reservaAi / bolo * 100 : 0}%`, background: T.gold, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#000" }}>AI</div>}
            {sobra > 0.5 && <div title={`Não alocado: €${sobra.toFixed(0)}`} style={{ width: `${sobra / bolo * 100}%`, background: "rgba(255,255,255,0.1)" }} />}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 10, color: T.muted }}>
            {planos.map(p => <span key={p.id}>{p.nome}: <b style={{ color: T.aLight }}>€{(planosEur[p.id]||0).toFixed(0)}</b></span>)}
            <span>⚡ AI Trade: <b style={{ color: T.gold }}>€{reservaAi.toFixed(0)}</b></span>
            {sobra > 0.5 && <span style={{ color: T.gold }}>Não alocado: €{sobra.toFixed(0)}</span>}
          </div>
        </Glass>

        {/* Lista de planos */}
        {planos.map((p, idx) => {
          const somaPesos = (p.carteira || []).reduce((a, c) => a + (c.peso || 0), 0);
          const diasAtivo = p.dataInicio ? Math.floor((Date.now() - p.dataInicio) / 86400000) : null;
          // Valor já investido neste plano (soma das posições DCA deste plano).
          const investidoPlano = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca" && (x.planId || "principal") === p.id).reduce((a, x) => a + (x.amount || 0), 0);
          // P&L atual do plano (para mostrar no cabeçalho compacto).
          const valorPlanoAtual = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca" && (x.planId || "principal") === p.id).reduce((a, x) => { const px = assets.find(z => z.id === x.assetId); return a + (px ? x.units * px.price : (x.amount || 0)); }, 0);
          const plPlano = valorPlanoAtual - investidoPlano;
          const aberto = planoAberto === p.id;
          return (
            <Glass key={p.id} style={{ padding: aberto ? "18px 22px" : "14px 18px" }}>
              {/* Cabeçalho clicável (acordeão) */}
              <div onClick={() => setPlanoAberto(aberto ? null : p.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, color: T.muted, transform: aberto ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.nome}</span>
                  <span style={{ fontSize: 9.5, color: T.muted, background: "rgba(255,255,255,0.05)", padding: "2px 7px", borderRadius: 5, whiteSpace: "nowrap" }}>{(p.carteira || []).length} ativos · {p.frequencia}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {investidoPlano > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 800, color: plPlano >= 0 ? T.green : T.red }}>{plPlano >= 0 ? "+" : ""}€{plPlano.toFixed(2)}</span>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 700, color: T.green, whiteSpace: "nowrap" }}>€{(planosEur[p.id]||0).toFixed(0)}/per</span>
                </div>
              </div>

              {/* Conteúdo detalhado — só quando expandido */}
              {aberto && (<div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10 }}>
                <input value={p.nome} onChange={(e) => updPlano(p.id, { nome: e.target.value })}
                  style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.2)", color: T.aLight, fontSize: 13, fontWeight: 700 }} />
                <button onClick={() => delPlano(p.id)} style={{ border: "none", background: "none", color: T.red, cursor: "pointer", fontSize: 18 }}>×</button>
              </div>

              {/* Contabilidade de aportes (planos manuais com lembretes) */}
              {p.modoExecucao === "manual" && liveSettings.dcaLembretes && (() => {
                const valorPlano = planosEur[p.id] || 0;
                if (valorPlano < 1) return null;
                const FREQ_MS = { semanal: 7*864e5, quinzenal: 15*864e5, mensal: 30*864e5 };
                const inicio = p.dataInicio || Date.now();
                const intervalo = FREQ_MS[p.frequencia] || FREQ_MS.mensal;
                const periodosDecorridos = Math.max(1, Math.floor((Date.now() - inicio) / intervalo) + 1);
                const devido = periodosDecorridos * valorPlano;
                const reg = dcaAportes[p.id] || { total: 0, periodos: 0 };
                const investido = reg.total || 0;
                const emFalta = +(devido - investido).toFixed(2);
                const periodosFalta = valorPlano > 0 ? Math.max(0, Math.round(emFalta / valorPlano)) : 0;
                const emDia = emFalta <= 0.5;
                return (
                  <div style={{ marginBottom: 14, padding: "14px 16px", borderRadius: 12, background: emDia ? `${T.green}0c` : `${T.gold}0c`, border: `1px solid ${emDia ? T.green : T.gold}33` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 800 }}>{emDia ? "✅ Em dia" : `⚠️ ${periodosFalta} aporte(s) em atraso`}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: emDia ? T.green : T.gold }}>{emDia ? "Tudo certo!" : `€${emFalta.toFixed(0)} em falta`}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 10 }}>
                      <div><span style={{ color: T.muted }}>Devias ter investido</span><div style={{ fontSize: 13, fontWeight: 700 }}>€{devido.toFixed(0)}</div></div>
                      <div><span style={{ color: T.muted }}>Já investiste</span><div style={{ fontSize: 13, fontWeight: 700 }}>€{investido.toFixed(0)}</div></div>
                    </div>
                    {!emDia && (
                      <button onClick={() => {
                        if (!user) return;
                        // Cria uma ordem manual para o valor em falta (até 1 período de cada vez, ou tudo).
                        const itens = (p.carteira || []).filter(c => c.peso > 0).map(c => {
                          const somaP = (p.carteira || []).reduce((a, x) => a + x.peso, 0) || 100;
                          const eur = +(emFalta * (c.peso / somaP)).toFixed(2);
                          const a = assets.find(x => x.id === c.id);
                          return { assetId: c.id, eur, preco: a?.price || 0 };
                        }).filter(i => i.eur >= 1 && i.preco > 0);
                        if (!itens.length) { toast("Sem preços para registar agora.", "warn"); return; }
                        import("./firebase.js").then(({ sendCommand }) => {
                          sendCommand(user.uid, { type: "DCA_MANUAL_CONFIRM", planId: p.id, planNome: p.nome, broker: p.brokerId, itens })
                            .then(() => toast(`✅ Registado €${emFalta.toFixed(0)} — compensaste o atraso`, "success"))
                            .catch(() => toast("Erro ao registar.", "error"));
                        });
                      }} style={{ width: "100%", marginTop: 12, padding: "10px", borderRadius: 9, border: "none", background: T.gradGold, color: "#000", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
                        💰 Já investi €{emFalta.toFixed(0)} — compensar atraso
                      </button>
                    )}
                    <div style={{ fontSize: 8.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                      Se puseres mais num período, abate ao atraso automaticamente. Compensas quando quiseres — neste mês, no próximo, ou de uma vez.
                    </div>
                  </div>
                );
              })()}

              {diasAtivo != null && (
                <div style={{ fontSize: 9.5, color: T.muted, marginBottom: 10 }}>📅 Início: {new Date(p.dataInicio).toLocaleDateString("pt-PT")} ({diasAtivo} dias) — desempenho mede-se a partir daqui</div>
              )}

              {/* Meta do plano — objetivo e progresso */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 9.5, color: T.muted }}>🎯 Meta:</span>
                <span style={{ fontSize: 11, color: T.muted }}>€</span>
                <input type="number" min={0} placeholder="objetivo" value={p.meta || ""}
                  onChange={(e) => updPlano(p.id, { meta: e.target.value === "" ? null : Math.max(0, parseInt(e.target.value) || 0) })}
                  style={{ width: 90, padding: "5px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 12, fontWeight: 700 }} />
                {p.meta > 0 && (
                  <div style={{ flex: 1, minWidth: 140, display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(100, (investidoPlano / p.meta) * 100)}%`, height: "100%", background: T.green }} />
                    </div>
                    <span style={{ fontSize: 9.5, color: T.muted, whiteSpace: "nowrap" }}>€{Math.round(investidoPlano)} / €{p.meta} ({Math.round((investidoPlano / p.meta) * 100)}%)</span>
                  </div>
                )}
              </div>
              {p.meta > 0 && investidoPlano > 0 && diasAtivo > 7 && (() => {
                // Estimativa de quando atinge a meta, ao ritmo atual.
                const porDia = investidoPlano / diasAtivo;
                const faltam = p.meta - investidoPlano;
                if (porDia <= 0 || faltam <= 0) return null;
                const diasFalta = Math.ceil(faltam / porDia);
                const data = new Date(Date.now() + diasFalta * 86400000);
                return <div style={{ fontSize: 9, color: T.muted, marginBottom: 10 }}>Ao ritmo atual, atinges a meta por volta de {data.toLocaleDateString("pt-PT", { month: "long", year: "numeric" })}.</div>;
              })()}

              {/* Indicação do broker que executa este plano (conforme a carteira) */}
              {(() => {
                const bp = brokerDoPlano(p.carteira);
                if (!bp || !p.carteira?.length) return null;
                if (bp.compat.length === 0) return (
                  <div style={{ fontSize: 9.5, color: T.gold, marginBottom: 10, background: `${T.gold}10`, padding: "6px 10px", borderRadius: 6 }}>
                    ⚠ Nenhum broker ligado negoceia todos estes ativos ({bp.classesNec.join(", ")}). Liga o broker certo ou ajusta a carteira.
                  </div>
                );
                if (bp.compat.length === 1) return (
                  <div style={{ fontSize: 9.5, color: T.muted, marginBottom: 10 }}>🏦 Executado via <b style={{ color: T.aLight }}>{bp.compat[0].nome}</b> (único compatível com esta carteira)</div>
                );
                // Vários compatíveis → deixa escolher
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 9.5, color: T.muted }}>🏦 Broker:</span>
                    <select value={p.brokerId || bp.compat[0].id} onChange={(e) => updPlano(p.id, { brokerId: e.target.value })}
                      style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 10 }}>
                      {bp.compat.map(b => <option key={b.id} value={b.id}>{b.nome}</option>)}
                    </select>
                  </div>
                );
              })()}

              {/* Otimizador de taxas: avisa se há ETFs em USD num plano no XTB
                  (custam 0,5% de câmbio) e sugere versões UCITS em EUR. */}
              {(() => {
                const bp = brokerDoPlano(p.carteira);
                const usaXtb = bp?.compat?.some(b => b.id === "xtb") || (p.brokerId === "xtb");
                if (!usaXtb || !p.carteira?.length) return null;
                // Ativos que cotam em USD (ETFs US + commodities) → têm custo de câmbio.
                const emUSD = p.carteira.filter(c => { const a = ASSETS.find(x => x.id === c.id); return a && (a.cat === "ETF" || a.cat === "Commodity"); });
                if (!emUSD.length) return null;
                return (
                  <div style={{ fontSize: 9.5, color: T.gold, marginBottom: 12, background: `${T.gold}10`, padding: "8px 12px", borderRadius: 8, lineHeight: 1.5 }}>
                    💱 <b>Dica de poupança:</b> {emUSD.length} ativo(s) deste plano cotam em USD — no XTB pagas ~0,5% de câmbio por compra. Se escolheres versões UCITS em EUR (ex.: VWCE, VUAA), poupas esse custo. Em anos de DCA, faz diferença.
                  </div>
                );
              })()}

              {/* Modo de execução: automático (bot compra) ou manual (avisa-te) */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 9.5, color: T.muted }}>Execução:</span>
                <button onClick={() => updPlano(p.id, { modoExecucao: "auto" })}
                  style={{ padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", border: `1px solid ${(p.modoExecucao || "auto") === "auto" ? T.green : T.border}`, background: (p.modoExecucao || "auto") === "auto" ? `${T.green}1a` : "transparent", color: (p.modoExecucao || "auto") === "auto" ? T.green : T.muted }}>
                  🤖 Automático
                </button>
                <button onClick={() => updPlano(p.id, { modoExecucao: "manual" })}
                  style={{ padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", border: `1px solid ${p.modoExecucao === "manual" ? T.gold : T.border}`, background: p.modoExecucao === "manual" ? `${T.gold}1a` : "transparent", color: p.modoExecucao === "manual" ? T.gold : T.muted }}>
                  🔔 Manual (avisa-me)
                </button>
                <span style={{ fontSize: 9, color: T.muted, flex: 1, minWidth: 200 }}>
                  {p.modoExecucao === "manual"
                    ? "O bot avisa-te quando for hora; compras no teu broker e confirmas."
                    : "O bot compra sozinho (precisa de broker com API: Binance p/ cripto)."}
                </span>
              </div>

              {/* Reequilíbrio automático: manter as % da carteira (vende excesso, recompra em falta) */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(0,0,0,0.15)" }}>
                <span style={{ fontSize: 16 }}>⚖️</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700 }}>Reequilíbrio automático</div>
                  <div style={{ fontSize: 9, color: T.muted, lineHeight: 1.4 }}>Mantém as percentagens da carteira: se um ativo cresce demais, vende o excesso e reforça os outros. Desliga para nunca vender (só acumular).</div>
                </div>
                <div onClick={() => updPlano(p.id, { reequilibrar: p.reequilibrar === false ? true : false })} style={{ cursor: "pointer" }}>
                  <div style={{ width: 42, height: 23, borderRadius: 12, background: p.reequilibrar !== false ? T.green : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                    <div style={{ position: "absolute", top: 3, left: p.reequilibrar !== false ? 21 : 3, width: 17, height: 17, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </div>
                </div>
              </div>

              {/* Alocação */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 10, color: T.muted }}>Alocar:</span>
                <input type="number" min={0} value={p.alocacao?.valor || 0}
                  onChange={(e) => updPlano(p.id, { alocacao: { ...p.alocacao, valor: Math.max(0, parseInt(e.target.value) || 0) } })}
                  style={{ width: 70, padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 13, fontWeight: 700 }} />
                <button onClick={() => updPlano(p.id, { alocacao: { ...p.alocacao, tipo: p.alocacao?.tipo === "pct" ? "valor" : "pct" } })}
                  style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.accent, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  {p.alocacao?.tipo === "pct" ? "% do bolo" : "€ fixo"}
                </button>
                <select value={p.frequencia} onChange={(e) => updPlano(p.id, { frequencia: e.target.value })}
                  style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 12 }}>
                  <option value="semanal">Semanal</option>
                  <option value="quinzenal">Quinzenal</option>
                  <option value="mensal">Mensal</option>
                </select>
              </div>

              {/* Carteira do plano */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                {(p.carteira || []).map((c, i) => {
                  // Capital investido, preço médio e preço atual deste ativo no plano (só consulta).
                  const posAtivo = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca" && (x.planId || "principal") === p.id && x.assetId === c.id);
                  const invAtivo = posAtivo.reduce((a, x) => a + (x.amount || 0), 0);
                  const unitsAtivo = posAtivo.reduce((a, x) => a + (x.units || 0), 0);
                  const precoMedio = unitsAtivo > 0 ? invAtivo / unitsAtivo : 0;
                  const precoAtual = (assets.find(z => z.id === c.id) || {}).price || 0;
                  const plAtivo = unitsAtivo > 0 && precoAtual ? (precoAtual - precoMedio) * unitsAtivo : 0;
                  const pctAtivo = invAtivo > 0 ? (plAtivo / invAtivo) * 100 : 0;
                  const corA = plAtivo >= 0 ? T.green : T.red;
                  return (
                  <div key={c.id} style={{ background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ flex: 1, fontSize: 11.5 }}>{nomeAtivo(c.id)}</span>
                    {invAtivo > 0 && <span style={{ fontSize: 10, color: corA, fontWeight: 700, background: `${corA}12`, padding: "2px 8px", borderRadius: 6 }}>{plAtivo >= 0 ? "+" : ""}{pctAtivo.toFixed(1)}%</span>}
                    <input type="number" min={0} max={100} value={c.peso}
                      onChange={(e) => { const nc = [...p.carteira]; nc[i] = { ...nc[i], peso: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) }; updPlano(p.id, { carteira: nc }); }}
                      style={{ width: 52, padding: "4px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 12, textAlign: "right" }} />
                    <span style={{ fontSize: 10, color: T.muted }}>%</span>
                    <button onClick={() => updPlano(p.id, { carteira: p.carteira.filter((_, j) => j !== i) })} style={{ border: "none", background: "none", color: T.red, cursor: "pointer", fontSize: 14 }}>×</button>
                    </div>
                    {invAtivo > 0 && (
                      <div style={{ fontSize: 9, color: T.muted, marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <span>€{invAtivo.toFixed(0)} investido</span>
                        <span>médio: ${precoMedio < 1 ? precoMedio.toFixed(4) : precoMedio.toFixed(2)}</span>
                        <span>atual: ${precoAtual < 1 ? precoAtual.toFixed(4) : precoAtual.toFixed(2)}</span>
                        <span style={{ color: corA, fontWeight: 700 }}>{plAtivo >= 0 ? "+" : ""}€{plAtivo.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                  );
                })}
                {somaPesos !== 100 && (p.carteira || []).length > 0 && <div style={{ fontSize: 9.5, color: T.gold }}>Pesos somam {somaPesos}% (deviam somar 100%)</div>}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <select id={`add-${p.id}`} style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 11 }}>
                  {ASSETS.filter(a => !(p.carteira || []).find(c => c.id === a.id)).map(a => <option key={a.id} value={a.id}>{a.name} ({a.cat})</option>)}
                </select>
                <button onClick={() => { const sel = document.getElementById(`add-${p.id}`); if (sel?.value) updPlano(p.id, { carteira: [...(p.carteira || []), { id: sel.value, peso: 0 }] }); }}
                  style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${T.accent}`, background: `${T.accent}1a`, color: T.accent, fontWeight: 700, fontSize: 11, cursor: "pointer" }}>+ Ativo</button>
              </div>

              {/* Botão Iniciar plano: faz a 1ª compra agora e arranca o agendamento.
                  Fica desabilitado depois de iniciado. Útil em paper e em live
                  (arranca o plano; o bot continua sozinho nas datas seguintes). */}
              {(() => {
                const valorP = planosEur[p.id] || 0;
                const carteiraOk = (p.carteira || []).filter(c => c.peso > 0).length > 0;
                const somaPesos = (p.carteira || []).reduce((a, c) => a + (c.peso || 0), 0);
                const iniciado = !!p.dataInicio;
                const podeIniciar = !iniciado && valorP >= 1 && carteiraOk && Math.abs(somaPesos - 100) < 0.5;
                let aviso = "";
                if (iniciado) aviso = "Plano já iniciado — o bot compra sozinho nas próximas datas.";
                else if (valorP < 1) aviso = "Define a alocação (% do bolo ou €) — está a €0/período.";
                else if (!carteiraOk) aviso = "Adiciona pelo menos um ativo com peso.";
                else if (Math.abs(somaPesos - 100) >= 0.5) aviso = `Os pesos somam ${somaPesos.toFixed(0)}% — têm de somar 100%.`;
                return (
                  <div style={{ marginBottom: 14 }}>
                    <button
                      disabled={!podeIniciar}
                      onClick={() => {
                        if (!user || !podeIniciar) return;
                        const ehAuto = (p.modoExecucao || "auto") === "auto";
                        // Marca o plano como iniciado (data de início = agora).
                        updPlano(p.id, { dataInicio: Date.now() });
                        if (ehAuto) {
                          // Plano automático: o bot EXECUTA a compra no broker (Binance/Alpaca).
                          import("./firebase.js").then(({ sendCommand }) => {
                            sendCommand(user.uid, { type: "DCA_INICIAR", planId: p.id, planNome: p.nome, valorPlano: valorP })
                              .then(() => toast(`🚀 Plano "${p.nome}" iniciado — o bot vai comprar no broker`, "success"))
                              .catch(() => toast("Erro ao iniciar o plano.", "error"));
                          });
                        } else {
                          // Plano manual: regista as posições (compraste tu no broker).
                          const itens = (p.carteira || []).filter(c => c.peso > 0).map(c => {
                            const a = assets.find(x => x.id === c.id);
                            const eur = +(valorP * (c.peso / (somaPesos || 100))).toFixed(2);
                            return { assetId: c.id, eur, preco: a?.price || 0 };
                          }).filter(i => i.eur >= 1 && i.preco > 0);
                          if (!itens.length) { toast("Sem preços disponíveis para iniciar agora.", "warn"); return; }
                          import("./firebase.js").then(({ sendCommand }) => {
                            sendCommand(user.uid, { type: "DCA_MANUAL_CONFIRM", planId: p.id, planNome: p.nome, broker: p.brokerId, itens })
                              .then(() => toast(`🚀 Plano "${p.nome}" iniciado — primeira compra registada`, "success"))
                              .catch(() => toast("Erro ao iniciar o plano.", "error"));
                          });
                        }
                      }}
                      style={{
                        width: "100%", padding: "12px", borderRadius: 11, border: "none",
                        background: podeIniciar ? T.gradGreen : "rgba(255,255,255,0.06)",
                        color: podeIniciar ? "#04120c" : T.muted,
                        fontWeight: 800, fontSize: 13, cursor: podeIniciar ? "pointer" : "not-allowed",
                        boxShadow: podeIniciar ? `0 4px 16px ${T.green}44` : "none",
                      }}>
                      {iniciado ? "✓ Plano em curso" : "🚀 Iniciar plano (1ª compra agora)"}
                    </button>
                    {aviso && <div style={{ fontSize: 9.5, color: iniciado ? T.green : T.gold, marginTop: 6, textAlign: "center" }}>{aviso}</div>}
                  </div>
                );
              })()}

              {/* Projeção de ganhos — cenários, com avisos claros */}
              {(p.carteira || []).length > 0 && (() => {
                const eurPlano = planosEur[p.id] || 0;
                const porMes = p.frequencia === "semanal" ? eurPlano * 4.33 : p.frequencia === "quinzenal" ? eurPlano * 2.17 : eurPlano;
                if (porMes < 1) return null;
                // Retorno anualizado médio estimado por classe (histórico longo, MUITO
                // aproximado — não é promessa). Ponderado pelos pesos da carteira.
                const retClasse = { ETF: 0.07, Commodity: 0.04, Crypto: 0.15, Forex: 0.0, "Ação": 0.08 };
                const somaP = (p.carteira || []).reduce((a, c) => a + (c.peso || 0), 0) || 100;
                let retAnual = 0;
                (p.carteira || []).forEach(c => { const a = ASSETS.find(x => x.id === c.id); if (a) retAnual += (retClasse[a.cat] ?? 0.05) * (c.peso / somaP); });
                // Projeção de DCA: valor futuro de uma série de depósitos mensais.
                const fv = (anos, taxaAnual) => {
                  const r = taxaAnual / 12, n = anos * 12;
                  if (r === 0) return porMes * n;
                  return porMes * ((Math.pow(1 + r, n) - 1) / r);
                };
                const anos = [1, 5, 10];
                const cenarios = [
                  { nome: "Pessimista", taxa: retAnual * 0.4, cor: T.muted },
                  { nome: "Médio", taxa: retAnual, cor: T.green },
                  { nome: "Otimista", taxa: retAnual * 1.5, cor: T.accent },
                ];
                return (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                    {/* Real vs projetado: como o plano vai face ao esperado */}
                    {investidoPlano > 0 && (() => {
                      // Valor real atual do plano
                      const valorReal = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca" && (x.planId || "principal") === p.id)
                        .reduce((a, x) => { const px = assets.find(z => z.id === x.assetId); return a + (px ? x.units * px.price : (x.amount || 0)); }, 0);
                      // Esperado: ao retorno médio anualizado, sobre o tempo decorrido
                      const dias = p.dataInicio ? Math.max(1, (Date.now() - p.dataInicio) / 864e5) : 30;
                      const anos = dias / 365;
                      const esperado = investidoPlano * Math.pow(1 + retAnual, anos);
                      const diff = valorReal - esperado;
                      const pctDiff = esperado > 0 ? (diff / esperado) * 100 : 0;
                      if (Math.abs(pctDiff) < 0.5) return null;
                      return (
                        <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: diff >= 0 ? `${T.green}10` : `${T.gold}10`, border: `1px solid ${diff >= 0 ? T.green : T.gold}33` }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: diff >= 0 ? T.green : T.gold }}>
                            {diff >= 0
                              ? `📈 Está ${pctDiff.toFixed(1)}% à frente do projetado`
                              : `📉 Está ${Math.abs(pctDiff).toFixed(1)}% atrás do projetado`}
                          </div>
                          <div style={{ fontSize: 9, color: T.muted, marginTop: 3 }}>
                            Real: €{Math.round(valorReal)} · Esperado a esta altura: €{Math.round(esperado)}. {diff < 0 ? "Normal no curto prazo — o DCA recupera com o tempo." : "Boa! Mas não te habitues; os mercados oscilam."}
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8 }}>📈 Projeção (investindo ~€{Math.round(porMes)}/mês)</div>
                    {/* Estado ao dia de hoje: já a ganhar ou a perder (real) */}
                    {(() => {
                      const posP = positions.filter(x => (x.status === "ABERTA" || !x.status) && x.stratId === "dca" && (x.planId || "principal") === p.id);
                      if (!posP.length) return null;
                      const inv = posP.reduce((a, x) => a + (x.amount || 0), 0);
                      const val = posP.reduce((a, x) => { const px = assets.find(z => z.id === x.assetId); return a + (px ? x.units * px.price : (x.amount || 0)); }, 0);
                      const pl = val - inv;
                      const pct = inv > 0 ? (pl / inv) * 100 : 0;
                      const cor = pl >= 0 ? T.green : T.red;
                      return (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 9, background: `${cor}10`, border: `1px solid ${cor}33`, marginBottom: 10 }}>
                          <span style={{ fontSize: 10.5, color: T.muted }}>Ao dia de hoje</span>
                          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <span style={{ fontSize: 13, fontWeight: 800, color: cor }}>{pl >= 0 ? "+" : ""}€{pl.toFixed(2)}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: cor, background: `${cor}18`, padding: "2px 8px", borderRadius: 6 }}>{pl >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>
                          </span>
                        </div>
                      );
                    })()}
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
                        <thead>
                          <tr style={{ color: T.muted }}>
                            <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Cenário</th>
                            {anos.map(y => <th key={y} style={{ textAlign: "right", padding: "4px 8px", fontWeight: 600 }}>{y} ano{y > 1 ? "s" : ""}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {cenarios.map(c => (
                            <tr key={c.nome} style={{ borderTop: `1px solid ${T.border}` }}>
                              <td style={{ padding: "6px 8px", fontWeight: 700, color: c.cor }}>{c.nome}<span style={{ fontSize: 8.5, color: T.muted, fontWeight: 400 }}> ({(c.taxa * 100).toFixed(0)}%/ano)</span></td>
                              {anos.map(y => {
                                const investido = porMes * 12 * y;
                                const valor = fv(y, c.taxa);
                                const ganho = valor - investido;
                                return (
                                  <td key={y} style={{ textAlign: "right", padding: "6px 8px" }}>
                                    <div style={{ fontWeight: 700 }}>€{Math.round(valor).toLocaleString("pt-PT")}</div>
                                    <div style={{ fontSize: 8.5, color: ganho >= 0 ? T.green : T.red }}>{ganho >= 0 ? "+" : ""}€{Math.round(ganho).toLocaleString("pt-PT")}</div>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: 8.5, color: T.gold, marginTop: 8, lineHeight: 1.5 }}>
                      ⚠️ Estimativas MUITO aproximadas baseadas em médias históricas — não são promessas. Os mercados podem cair e perderes dinheiro. Rendimentos passados não garantem futuros. Não é aconselhamento financeiro.
                    </div>
                    {/* Simulador retroativo: "e se tivesse começado há X meses" */}
                    {(() => {
                      const mensal = porMes;
                      if (mensal < 1) return null;
                      const retAnualSim = 0.12; // média histórica conservadora ~12%/ano
                      const cenarios = [6, 12, 24];
                      return (
                        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                          <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8 }}>⏮️ E se tivesses começado há…</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                            {cenarios.map(meses => {
                              const investido = mensal * meses;
                              // Valor futuro de uma série de aportes mensais compostos.
                              const rMensal = Math.pow(1 + retAnualSim, 1/12) - 1;
                              const valor = rMensal > 0 ? mensal * ((Math.pow(1 + rMensal, meses) - 1) / rMensal) : investido;
                              const ganho = valor - investido;
                              return (
                                <div key={meses} style={{ padding: "10px", borderRadius: 8, background: "rgba(0,0,0,0.2)", textAlign: "center" }}>
                                  <div style={{ fontSize: 9, color: T.muted }}>há {meses} meses</div>
                                  <div style={{ fontSize: 13, fontWeight: 800, color: T.green, marginTop: 3 }}>€{Math.round(valor)}</div>
                                  <div style={{ fontSize: 8.5, color: T.muted }}>investido €{Math.round(investido)}</div>
                                  <div style={{ fontSize: 9, color: T.green, fontWeight: 700 }}>+€{Math.round(ganho)}</div>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ fontSize: 8.5, color: T.muted, marginTop: 6, textAlign: "center" }}>Ilustração ao retorno médio histórico (~12%/ano) — mostra o valor da consistência e do tempo.</div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
              </div>)}
            </Glass>
          );
        })}

        {/* Criar novo plano (com ou sem assistente IA) */}
        <Glass style={{ padding: "18px 22px", border: `1px dashed ${T.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>➕ Criar novo plano</div>
          <DCAAssistente carteiraAtual={[]} onAplicar={(plano) => {
            novoPlano(plano.carteira, { tipo: "pct", valor: 0 }, plano.frequencia, plano.nome || "Novo plano", plano.modoExecucao);
          }} callAI={callAI} ASSETS={ASSETS} T={T} Glass={Glass} brokersDisp={brokersDisp} />
          <button onClick={() => novoPlano([], { tipo: "pct", valor: 0 }, "mensal", "Plano manual")}
            style={{ marginTop: 10, padding: "8px 16px", borderRadius: 8, border: `1px solid ${T.border}`, background: "transparent", color: T.muted, fontSize: 11, cursor: "pointer" }}>
            ou criar plano vazio (configuro à mão)
          </button>
        </Glass>

        {/* Como funciona + conselhos */}
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>📚 Como funciona, em simples</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              ["1", "Um bolo, vários objetivos", "Defines quanto investes por período e repartes por planos (Férias, Reforma…). O bot separa e investe cada fatia na carteira certa."],
              ["2", "Compras automáticas e regulares", "Compra mais quando os preços estão baixos e menos quando estão altos. Não tentas adivinhar o melhor momento — invistes sempre."],
              ["3", "Cada objetivo, a sua carteira", "A Reforma (longo prazo) aguenta mais risco; as Férias (curto prazo) pedem mais segurança. Cada plano tem a sua data de início para medir o desempenho."],
              ["4", "Reequilíbrio e segurar", "O bot mantém os pesos-alvo e segura a longo prazo. Sem stop-loss — acumula e deixa crescer."],
            ].map(([n, t, d]) => (
              <div key={n} style={{ display: "flex", gap: 14 }}>
                <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: "50%", background: `${T.green}1a`, border: `1px solid ${T.green}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: T.green }}>{n}</div>
                <div><div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{t}</div><div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>{d}</div></div>
              </div>
            ))}
          </div>
        </Glass>

        <Glass style={{ padding: "20px 24px", background: `${T.blue}08` }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 14 }}>💡 Conselhos</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["Consistência ganha", "O segredo do DCA é nunca parar. Mais vale um valor pequeno que aguentas sempre do que um grande que te obriga a parar."],
              ["Pensa em anos", "O DCA brilha em horizontes de 3+ anos. Para objetivos próximos, tem menos margem para recuperar de uma queda."],
              ["Não invistas o essencial", "O dinheiro de emergências e despesas não deve estar nos mercados, mesmo diversificado."],
              ["Reforma aguenta mais risco", "Quanto mais longe o objetivo, mais a carteira pode arriscar (mais ações). Quanto mais perto, mais segura (mais ouro/obrigações)."],
            ].map(([t, d], i) => (
              <div key={i} style={{ display: "flex", gap: 10 }}>
                <span style={{ color: T.blue, fontSize: 14, flexShrink: 0 }}>✓</span>
                <div><div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 2 }}>{t}</div><div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>{d}</div></div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9.5, color: T.gold, marginTop: 14, lineHeight: 1.6, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
            Lembrete: a app é uma ferramenta, não um consultor financeiro. As decisões de investir dinheiro real são tuas — informa-te com fontes sérias antes de o fazer.
          </div>
        </Glass>
      </div>
    );
  };

  // ── Assistente IA do DCA: perguntas simples → carteira sugerida ───────────

  // ─────────────────────────────────────────────
  // RENDER: HISTÓRICO
  // ─────────────────────────────────────────────
  const History = () => {
    // Resolve o ativo de forma robusta (id, símbolo ou nome) — tolera trades antigos com id errado
    const norm = s => String(s || "").toLowerCase().trim();
    const findAsset = (t) =>
         assets.find(x => x.id === t.assetId)
      || assets.find(x => norm(x.sym) === norm(t.assetId))
      || assets.find(x => norm(x.sym) === norm(t.assetSym))
      || assets.find(x => norm(x.name) === norm(t.assetName));
    // Organiza por modo (sim/live) e categoria
    const simTrades  = [...simPositions.map(p => {
      const a = findAsset(p);
      return { ...p, curPnl: a ? (a.price - p.entryPrice) * p.units : 0, livePrice: a?.price, mode: "sim" };
    }), ...simClosed.map(t => ({...t, mode:"sim"}))];

    const liveTrades = [...positions.map(p => {
      const a = findAsset(p);
      // Alinhado com o bot (sim-engine): base de custo = amount investido (não
      // entryPrice*units, que diverge após consolidações). Sempre líquido de taxas.
      const invBase = p.amount || (p.entryPrice * p.units);
      return { ...p, curPnl: a ? (a.price * p.units - invBase - roundTripFeeApp(p, invBase)) : 0, livePrice: a?.price, mode: "live" };
    }), ...closed.map(t => ({...t, mode:"live"}))];

    const activeTrades = histTab === "sim" ? simTrades : liveTrades;

    // Classificar origem de cada trade
    const origemDe = (t) =>
      t.stratId === "dca"        ? (t.planNome ? `🎯 DCA · ${t.planNome}` : "🎯 DCA")
      : t.stratId === "ai-brain"   ? (t.aiSource === "tecnico" ? "🧮 AI Técnico" : "🤖 AI Brain")
      : t.stratId === "manual"   ? "✋ Manual"
      : t.stratId === "daytrading" ? "⚡ Day Trading"
      : "🎯 Estratégias";
    const origens = ["Todas", ...new Set(activeTrades.map(origemDe))];

    const cats = ["Todos", ...new Set(activeTrades.map(t => {
      const a = findAsset(t); return a?.cat || "Outro";
    }))];
    const filtered = activeTrades.filter(t => {
      const a = findAsset(t);
      const okCat = histCat === "Todos" || a?.cat === histCat;
      const okOrig = histOrigem === "Todas" || origemDe(t) === histOrigem;
      return okCat && okOrig;
    });

    // ── Ordenação por coluna ────────────────────────────────────────────────
    // Cada coluna tem um extrator de valor (número ou texto). Datas usam o
    // timestamp; campos em falta vão para o fim. Clicar no cabeçalho alterna
    // asc/desc; clicar noutra coluna ordena por essa.
    const parseDur = (t) => {
      if (!t.openedTs) return null;
      const fim = t.closedTs || Date.now();
      return fim - t.openedTs; // ms
    };
    const sortVals = {
      ativo:    t => (findAsset(t)?.sym || t.assetSym || t.assetId || "").toLowerCase(),
      cat:      t => (findAsset(t)?.cat || "").toLowerCase(),
      estrategia: t => (t.strategy || "").toLowerCase(),
      origem:   t => origemDe(t),
      abertura: t => t.openedTs || 0,
      saida:    t => t.closedTs || 0,
      duracao:  t => parseDur(t) ?? -1,
      entrada:  t => t.entryPrice ?? 0,
      preco:    t => (t.livePrice ?? t.closePrice ?? t.entryPrice ?? 0),
      investido: t => t.amount ?? 0,
      sl:       t => t.sl ?? 0,
      tp:       t => t.tp ?? 0,
      pnl:      t => (t.pnl !== undefined ? t.pnl : t.curPnl) ?? 0,
      pct:      t => {
        const p = (t.pnl !== undefined ? t.pnl : t.curPnl) ?? 0;
        return t.amount ? (p / t.amount) * 100 : 0;
      },
      status:   t => (t.status || "").toLowerCase(),
    };
    const sortedFiltered = [...filtered].sort((a, b) => {
      const fn = sortVals[histSortKey] || sortVals.abertura;
      const va = fn(a), vb = fn(b);
      let cmp;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), "pt");
      return histSortDir === "asc" ? cmp : -cmp;
    });
    const toggleSort = (key) => {
      if (histSortKey === key) setHistSortDir(d => d === "asc" ? "desc" : "asc");
      else { setHistSortKey(key); setHistSortDir(key === "abertura" || key === "saida" ? "desc" : "desc"); }
    };
    // Mapeia o rótulo do cabeçalho → chave de ordenação (null = não ordenável).
    const colSortKey = {
      "Ativo": "ativo", "Cat.": "cat", "Estratégia": "estrategia", "Origem": "origem",
      "Abertura": "abertura", "Saída": "saida", "Duração": "duracao", "Entrada": "entrada",
      "Preço Atual": "preco", "Investido": "investido", "SL": "sl", "TP": "tp",
      "P&L": "pnl", "%": "pct", "IA": null, "Hold": null, "Status": "status", "Mercado": null,
    };

    // Estados que NÃO são vendas reais (fechos técnicos): reset do testnet ou
    // reconciliação. Não contam para win rate nem P&L — falseariam as métricas.
    const naoVenda = s => s === "RESET-TESTNET" || s === "FECHADA-RECON";
    const eVendaReal = t => t.status !== "ABERTA" && !naoVenda(t.status);

    // Resumo por origem (só trades fechados REAIS) — para comparar o que compensa
    const resumoOrigem = {};
    activeTrades.filter(eVendaReal).forEach(t => {
      const o = origemDe(t);
      if (!resumoOrigem[o]) resumoOrigem[o] = { n: 0, wins: 0, pnl: 0 };
      resumoOrigem[o].n++;
      if ((t.pnl || 0) > 0) resumoOrigem[o].wins++;
      resumoOrigem[o].pnl += t.pnl || 0;
    });

    const filteredClosed  = filtered.filter(eVendaReal);
    const filteredOpen    = filtered.filter(t => t.status === "ABERTA");
    const filteredWins    = filteredClosed.filter(t => (t.pnl||t.curPnl||0) > 0);
    const filteredLosses  = filteredClosed.filter(t => (t.pnl||t.curPnl||0) <= 0);
    const filteredPnl     = filteredClosed.reduce((s,t) => s + (t.pnl||0), 0);
    const filteredWR      = filteredClosed.length ? filteredWins.length / filteredClosed.length * 100 : null;
    // Repartição sobre o TOTAL (fechados + abertos), para veres a foto completa:
    const totalTrades_    = filtered.length;
    const pctPendentes    = totalTrades_ ? (filteredOpen.length / totalTrades_) * 100 : 0;
    const pctPerdas       = totalTrades_ ? (filteredLosses.length / totalTrades_) * 100 : 0;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Mode tabs + refresh */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 0, background: "rgba(0,0,0,0.3)", borderRadius: 10, overflow: "hidden", width: "fit-content" }}>
            {[["sim","◎ Simulação"], ["live", botModoReal ? "● Live Real" : "📝 Paper"]].map(([id, label]) => (
              <button key={id} onClick={() => { setHistTab(id); setHistCat("Todos"); }} style={{
                padding: "10px 22px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                background: histTab===id ? (id==="sim"?`${T.gold}20`:`${T.red}20`) : "transparent",
                color: histTab===id ? (id==="sim"?T.gold:T.red) : T.muted,
                border: "none", fontFamily: "inherit",
              }}>{label}</button>
            ))}
          </div>
          <button onClick={() => window.location.reload()}
            title="Recarregar dados do histórico"
            style={{ background: `${T.accent}15`, border: `1px solid ${T.accent}33`, borderRadius: 8, padding: "8px 16px", fontSize: 11, fontWeight: 700, color: T.aLight, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            ↻ Refresh
          </button>
        </div>

        {/* KPIs */}
        <div className="resp-grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          {[
            { l: "P&L Realizado",     v: `${sign(filteredPnl)}${eur(filteredPnl)}`,                            c: filteredPnl >= 0 ? T.green : T.red },
            { l: "P&L Não Realizado", v: `${sign(unrealized)}${eur(unrealized)}`,                               c: unrealized >= 0 ? T.green : T.red },
            { l: "Win Rate",          v: filteredWR !== null ? `${filteredWR.toFixed(1)}%` : "—",               c: T.gold, sub: `${pctPendentes.toFixed(0)}% pendentes · ${pctPerdas.toFixed(0)}% perdas` },
            { l: "Total Trades",      v: filtered.length,                                                        c: T.accent },
          ].map(m => (
            <Glass key={m.l} style={{ padding: "18px 20px" }}>
              <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 8 }}>{m.l}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: m.c }}>{m.v}</div>
              {m.sub && <div style={{ fontSize: 9, color: T.muted, marginTop: 4 }}>{m.sub}</div>}
            </Glass>
          ))}
        </div>

        {/* Category filter */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {cats.map(cat => (
            <button key={cat} onClick={() => setHistCat(cat)} style={{
              background: histCat===cat ? `${T.accent}22` : "rgba(255,255,255,0.04)",
              border: `1px solid ${histCat===cat ? T.accent+"55" : T.border}`,
              borderRadius: 99, padding: "4px 13px", fontSize: 11, fontWeight: 700,
              color: histCat===cat ? T.aLight : T.muted, cursor: "pointer", fontFamily: "inherit",
            }}>{cat}</button>
          ))}
        </div>

        {/* Filtro por origem */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {origens.map(o => (
            <button key={o} onClick={() => setHistOrigem(o)} style={{
              background: histOrigem===o ? `${T.blue}22` : "rgba(255,255,255,0.04)",
              border: `1px solid ${histOrigem===o ? T.blue+"55" : T.border}`,
              borderRadius: 99, padding: "4px 13px", fontSize: 11, fontWeight: 700,
              color: histOrigem===o ? T.blue : T.muted, cursor: "pointer", fontFamily: "inherit",
            }}>{o}</button>
          ))}
        </div>

        {/* Performance por origem — qual compensa? */}
        {Object.keys(resumoOrigem).length > 0 && (
          <Glass style={{ padding: "16px 20px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 12 }}>⚖ Performance por origem — qual compensa?</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(resumoOrigem).sort((a,b) => b[1].pnl - a[1].pnl).map(([o, r]) => {
                const wr = r.n ? (r.wins / r.n) * 100 : 0;
                const pos = r.pnl >= 0;
                return (
                  <div key={o} style={{
                    display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr", gap: 10,
                    padding: "10px 14px", borderRadius: 10, alignItems: "center", fontSize: 12,
                    background: pos ? `${T.green}08` : `${T.red}08`,
                    border: `1px solid ${pos ? T.green : T.red}20`,
                  }}>
                    <div style={{ fontWeight: 700 }}>{o}</div>
                    <div><div style={{ fontSize: 8, color: T.muted }}>TRADES</div><div style={{ fontWeight: 700 }}>{r.n}</div></div>
                    <div><div style={{ fontSize: 8, color: T.muted }}>WIN RATE</div><div style={{ fontWeight: 700, color: wr >= 50 ? T.green : T.gold }}>{wr.toFixed(0)}%</div></div>
                    <div><div style={{ fontSize: 8, color: T.muted }}>P&L</div><div style={{ fontWeight: 700, color: pos ? T.green : T.red }}>{sign(r.pnl)}€{Math.abs(r.pnl).toFixed(2)}</div></div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>
              💡 Compara o P&L e o win rate de cada origem. Se o 🤖 AI Brain tiver P&L positivo e win rate consistente ao longo de vários dias, está a compensar.
            </div>
          </Glass>
        )}

        {/* Archived simulations (only in sim tab) */}
        {histTab === "sim" && archivedSims.length > 0 && (
          <Glass style={{ padding: "18px 22px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 12 }}>📁 Simulações Arquivadas ({archivedSims.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {archivedSims.map((s, i) => (
                <div key={s.id} style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                  gap: 12, padding: "10px 14px", borderRadius: 10,
                  background: s.roi >= 0 ? `${T.green}08` : `${T.red}08`,
                  border: `1px solid ${s.roi >= 0 ? T.green : T.red}20`,
                  alignItems: "center", fontSize: 12,
                }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>Simulação #{archivedSims.length - i}</div>
                    <div style={{ fontSize: 10, color: T.muted }}>{s.terminadaEm}</div>
                  </div>
                  <div><div style={{ fontSize: 9, color: T.muted }}>Capital</div><div style={{ fontWeight: 700 }}>€{s.capitalInicial}</div></div>
                  <div><div style={{ fontSize: 9, color: T.muted }}>Saldo Final</div><div style={{ fontWeight: 700, color: s.roi >= 0 ? T.green : T.red }}>€{s.saldoFinal?.toFixed(2)}</div></div>
                  <div><div style={{ fontSize: 9, color: T.muted }}>ROI</div><div style={{ fontWeight: 700, color: s.roi >= 0 ? T.green : T.red }}>{sign(s.roi)}{Math.abs(s.roi).toFixed(1)}%</div></div>
                  <div><div style={{ fontSize: 9, color: T.muted }}>Win Rate</div><div style={{ fontWeight: 700, color: T.gold }}>{s.winRate.toFixed(0)}%</div></div>
                </div>
              ))}
            </div>
          </Glass>
        )}

        {/* Arquivos diários (automáticos, criados pelo bot à meia-noite) */}
        {dailyArchives.length > 0 && (() => {
          // O arquivo diário do bot mistura trades sim e live no mesmo dia. Aqui
          // filtramos cada dia pelo modo do separador ativo (histTab) e
          // recalculamos os totais (P&L, win rate, wins, count) só com esses
          // trades. Antes, o arquivo só aparecia em "sim" → o histórico de paper
          // desaparecia depois do arquivo da meia-noite. Agora aparece nos dois.
          const wantMode = histTab === "sim" ? "sim" : "live";
          // Fechos técnicos (reset testnet / reconciliação) não são vendas reais —
          // não contam para P&L nem win rate (falseariam as métricas do dia).
          const naoVendaArq = s => s === "RESET-TESTNET" || s === "FECHADA-RECON";
          const archForTab = dailyArchives
            .map((a) => {
              const trades = (Array.isArray(a.trades) ? a.trades : [])
                .filter(t => (t.mode || "sim") === wantMode && !naoVendaArq(t.status));
              if (!trades.length) return null;
              const pnl     = +trades.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2);
              const wins    = trades.filter(t => (t.pnl || 0) > 0).length;
              const winRate = +(wins / trades.length * 100).toFixed(1);
              return { ...a, trades, count: trades.length, pnl, wins, winRate };
            })
            .filter(Boolean);
          if (!archForTab.length) return null;
          // ── Expectativa acumulada (vários dias) ─────────────────────────────
          // Junta TODOS os trades de TODOS os dias arquivados (já filtrados pelo
          // modo do separador) e calcula a expectativa por trade ao longo do
          // período. Fórmula idêntica à dos cartões: net / nº de trades, que é
          // algebricamente igual a (ganhoMédio × taxaAcerto − perdaMédia × taxaErro).
          // O objetivo é distinguir uma VANTAGEM ESTÁVEL de SORTE: mostramos
          // também a concentração (quanto do lucro vem do melhor dia isolado).
          const acc = (() => {
            const all = archForTab.flatMap(a =>
              (a.trades || []).filter(t => typeof t.pnl === "number"));
            if (all.length === 0) return null;
            const wins   = all.filter(t => t.pnl > 0);
            const losses = all.filter(t => t.pnl <= 0);
            const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
            const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
            const net       = grossWin - grossLoss;
            const winRate   = wins.length / all.length;          // 0..1
            const lossRate  = 1 - winRate;
            const avgWin    = wins.length   ? grossWin  / wins.length   : 0;
            const avgLoss   = losses.length ? grossLoss / losses.length : 0;
            const expectancy = net / all.length;                 // €/trade no período
            // Concentração: P&L por dia, contributo do melhor dia para o total.
            const dayPnls = archForTab.map(a => +(a.pnl || 0));
            const totalPnl = dayPnls.reduce((s, p) => s + p, 0);
            const bestDayPnl = dayPnls.length ? Math.max(...dayPnls) : 0;
            const netSemMelhor = +(totalPnl - bestDayPnl).toFixed(2);
            const concentracao = totalPnl > 0 ? (bestDayPnl / totalPnl) * 100 : null;
            const diasPos = dayPnls.filter(p => p > 0).length;
            // Veredicto simples sobre estabilidade da vantagem.
            let veredito, vColor;
            if (expectancy <= 0) {
              veredito = "Sem vantagem — expectativa por trade negativa ou nula no período.";
              vColor = T.red;
            } else if (netSemMelhor <= 0) {
              veredito = "Vantagem frágil — todo o lucro depende do melhor dia. Sem ele, o período é negativo.";
              vColor = T.red;
            } else if (concentracao !== null && concentracao >= 60) {
              veredito = `Vantagem concentrada — ${concentracao.toFixed(0)}% do lucro vem de um só dia. Precisa de mais dias para confirmar.`;
              vColor = T.gold;
            } else {
              veredito = "Vantagem aparentemente estável — o lucro não depende de um único dia.";
              vColor = T.green;
            }
            return { all, wins, losses, grossWin, grossLoss, net, winRate, lossRate,
                     avgWin, avgLoss, expectancy, totalPnl, bestDayPnl, netSemMelhor,
                     concentracao, diasPos, veredito, vColor, dias: archForTab.length };
          })();
          // ── Soma de todo o histórico (só arquivos diários) ──────────────────
          // Totais agregados de TODOS os dias arquivados, no modo do separador.
          // Ganho bruto, perda bruta, P&L líquido, nº de trades e dias.
          const tot = (() => {
            const all = archForTab.flatMap(a =>
              (a.trades || []).filter(t => typeof t.pnl === "number"));
            const wins   = all.filter(t => t.pnl > 0);
            const losses = all.filter(t => t.pnl <= 0);
            const grossWin  = +wins.reduce((s, t) => s + t.pnl, 0).toFixed(2);
            const grossLoss = +Math.abs(losses.reduce((s, t) => s + t.pnl, 0)).toFixed(2);
            const net       = +(grossWin - grossLoss).toFixed(2);
            const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
            const bestTrade  = all.length ? Math.max(...all.map(t => t.pnl)) : 0;
            const worstTrade = all.length ? Math.min(...all.map(t => t.pnl)) : 0;
            return { nTrades: all.length, dias: archForTab.length, wins: wins.length,
                     losses: losses.length, grossWin, grossLoss, net, profitFactor,
                     bestTrade, worstTrade };
          })();
          return (
          <Glass style={{ padding: "16px 18px" }}>
            {tot.nTrades > 0 && (
              <div style={{
                marginBottom: 16, padding: "14px 16px", borderRadius: 12,
                background: `${T.aLight}0E`, border: `1px solid ${T.border}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  Σ Total do histórico · {tot.dias} dia{tot.dias === 1 ? "" : "s"} · {tot.nTrades} trades
                </div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 12 }}>
                  Soma agregada de todos os arquivos diários ({histTab === "sim" ? "simulação" : "live/paper"}).
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
                  {[
                    { l: "P&L líquido", v: `${sign(tot.net)}€${Math.abs(tot.net).toFixed(2)}`,
                      c: tot.net >= 0 ? T.green : T.red, sub: `${tot.nTrades} trades` },
                    { l: "Ganho bruto", v: `+€${tot.grossWin.toFixed(2)}`, c: T.green, sub: `${tot.wins} wins` },
                    { l: "Perda bruta", v: `−€${tot.grossLoss.toFixed(2)}`, c: T.red, sub: `${tot.losses} perdas` },
                    { l: "Profit factor", v: tot.profitFactor === Infinity ? "∞" : tot.profitFactor.toFixed(2),
                      c: tot.profitFactor >= 1 ? T.green : T.red, sub: "bruto÷perda" },
                    { l: "Melhor trade", v: `+€${Math.abs(tot.bestTrade).toFixed(2)}`, c: T.green, sub: "isolado" },
                    { l: "Pior trade", v: `−€${Math.abs(tot.worstTrade).toFixed(2)}`, c: T.red, sub: "isolado" },
                  ].map((m, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{m.l}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: m.c }}>{m.v}</div>
                      {m.sub && <div style={{ fontSize: 9, color: T.muted }}>{m.sub}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {acc && (
              <div style={{
                marginBottom: 16, padding: "14px 16px", borderRadius: 12,
                background: `${acc.vColor}0E`, border: `1px solid ${acc.vColor}33`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  📈 Expectativa acumulada · {acc.dias} dia{acc.dias === 1 ? "" : "s"} · {acc.all.length} trades
                </div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 12 }}>
                  Mede se a vantagem é estável ou se o lucro depende de poucos dias excecionais.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginBottom: 12 }}>
                  {[
                    { l: "Expectativa / trade", v: `${sign(acc.expectancy)}€${Math.abs(acc.expectancy).toFixed(2)}`,
                      c: acc.expectancy >= 0 ? T.green : T.red, sub: "no período" },
                    { l: "Taxa de acerto", v: `${(acc.winRate * 100).toFixed(0)}%`, c: T.gold,
                      sub: `${acc.wins.length}/${acc.all.length} trades` },
                    { l: "Ganho médio", v: `+€${acc.avgWin.toFixed(2)}`, c: T.green, sub: `${acc.wins.length} wins` },
                    { l: "Perda média", v: `−€${acc.avgLoss.toFixed(2)}`, c: T.red, sub: `${acc.losses.length} perdas` },
                    { l: "P&L total", v: `${sign(acc.totalPnl)}€${Math.abs(acc.totalPnl).toFixed(2)}`,
                      c: acc.totalPnl >= 0 ? T.green : T.red, sub: `${acc.diasPos}/${acc.dias} dias positivos` },
                    { l: "Sem o melhor dia", v: `${sign(acc.netSemMelhor)}€${Math.abs(acc.netSemMelhor).toFixed(2)}`,
                      c: acc.netSemMelhor >= 0 ? T.green : T.red,
                      sub: acc.concentracao !== null ? `melhor dia = ${acc.concentracao.toFixed(0)}% do lucro` : "—" },
                  ].map((m, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{m.l}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: m.c }}>{m.v}</div>
                      {m.sub && <div style={{ fontSize: 9, color: T.muted }}>{m.sub}</div>}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: acc.vColor, fontWeight: 600 }}>{acc.veredito}</div>
              </div>
            )}
            {(() => {
              // ── Comparação ANTES vs DEPOIS de uma data de corte ───────────────
              // Para medir o efeito de uma mudança (ex.: ligar o Modo Dinâmico, ou
              // o deploy das correções), define-se uma data; a app calcula a
              // expectativa por trade de cada lado. É a forma honesta de ver se uma
              // alteração ajudou: comparar como-com-como, sem marcar cada trade.
              const expDe = (dias) => {
                const all = dias.flatMap(a => (a.trades || []).filter(t => typeof t.pnl === "number"));
                if (!all.length) return null;
                const net = all.reduce((s, t) => s + t.pnl, 0);
                const wins = all.filter(t => t.pnl > 0).length;
                return {
                  n: all.length, dias: dias.length, net: +net.toFixed(2),
                  exp: +(net / all.length).toFixed(3),
                  wr: +(wins / all.length * 100).toFixed(0),
                };
              };
              // archForTab vem ordenado desc (mais recente primeiro). 'day' é "YYYY-MM-DD".
              const antes  = histCorte ? archForTab.filter(a => (a.day || "") <  histCorte) : [];
              const depois = histCorte ? archForTab.filter(a => (a.day || "") >= histCorte) : [];
              const eA = expDe(antes), eD = expDe(depois);
              const Lado = (titulo, e, cor) => (
                <div style={{ flex: 1, padding: "10px 12px", borderRadius: 10, background: `${cor}0E`, border: `1px solid ${cor}33` }}>
                  <div style={{ fontSize: 10, color: T.muted, marginBottom: 6 }}>{titulo}</div>
                  {e ? <>
                    <div style={{ fontSize: 18, fontWeight: 800, color: e.exp >= 0 ? T.green : T.red }}>
                      {sign(e.exp)}€{Math.abs(e.exp).toFixed(2)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 600 }}> /trade</span>
                    </div>
                    <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>
                      {e.dias} dias · {e.n} trades · {e.wr}% win · P&L {sign(e.net)}€{Math.abs(e.net).toFixed(2)}
                    </div>
                  </> : <div style={{ fontSize: 11, color: T.muted }}>sem dados neste lado</div>}
                </div>
              );
              const delta = (eA && eD) ? +(eD.exp - eA.exp).toFixed(3) : null;
              // ── Comparação DIRETA pelo carimbo do trade ───────────────────────
              // O bot marca cada trade com regimeDinamico (true/false) no momento
              // da abertura. Aqui agrupamos por esse carimbo — é o método mais
              // direto: não depende de datas, lê o estado real de cada trade.
              const allTrades = archForTab.flatMap(a => (a.trades || []).filter(t => typeof t.pnl === "number"));
              const comCarimbo = allTrades.filter(t => typeof t.regimeDinamico === "boolean");
              const expTrades = (arr) => {
                if (!arr.length) return null;
                const net = arr.reduce((s, t) => s + t.pnl, 0);
                const wins = arr.filter(t => t.pnl > 0).length;
                return { n: arr.length, net: +net.toFixed(2), exp: +(net / arr.length).toFixed(3), wr: +(wins / arr.length * 100).toFixed(0) };
              };
              const eOn  = expTrades(comCarimbo.filter(t => t.regimeDinamico === true));
              const eOff = expTrades(comCarimbo.filter(t => t.regimeDinamico === false));
              const deltaTag = (eOn && eOff) ? +(eOn.exp - eOff.exp).toFixed(3) : null;
              const LadoT = (titulo, e, cor) => (
                <div style={{ flex: 1, padding: "10px 12px", borderRadius: 10, background: `${cor}0E`, border: `1px solid ${cor}33` }}>
                  <div style={{ fontSize: 10, color: T.muted, marginBottom: 6 }}>{titulo}</div>
                  {e ? <>
                    <div style={{ fontSize: 18, fontWeight: 800, color: e.exp >= 0 ? T.green : T.red }}>
                      {sign(e.exp)}€{Math.abs(e.exp).toFixed(2)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 600 }}> /trade</span>
                    </div>
                    <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>
                      {e.n} trades · {e.wr}% win · P&L {sign(e.net)}€{Math.abs(e.net).toFixed(2)}
                    </div>
                  </> : <div style={{ fontSize: 11, color: T.muted }}>ainda sem trades</div>}
                </div>
              );
              return (
              <div style={{ marginBottom: 16, padding: "14px 16px", borderRadius: 12, background: `${T.accent}08`, border: `1px solid ${T.accent}22` }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>⚖️ Modo Dinâmico — com vs sem</div>
                {comCarimbo.length > 0 ? (
                  <>
                    <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>
                      Comparação direta pelo estado gravado em cada trade no momento da abertura. {comCarimbo.length} de {allTrades.length} trades têm o carimbo.
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      {LadoT("COM modo dinâmico", eOn, T.accent)}
                      {LadoT("SEM modo dinâmico", eOff, T.muted)}
                    </div>
                    {deltaTag !== null && (
                      <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: deltaTag >= 0 ? T.green : T.red, textAlign: "center" }}>
                        {deltaTag >= 0 ? "▲" : "▼"} {sign(deltaTag)}€{Math.abs(deltaTag).toFixed(2)}/trade {deltaTag >= 0 ? "melhor" : "pior"} COM o modo dinâmico
                        <div style={{ fontSize: 9, color: T.muted, fontWeight: 400, marginTop: 2 }}>
                          {(eOn.n < 20 || eOff.n < 20) ? "⚠ amostra pequena — precisa de mais trades para ser fiável" : "amostra razoável"}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: T.muted, fontStyle: "italic" }}>
                    Ainda não há trades com o carimbo do regime. Os trades novos (abertos depois deste deploy do bot) vão ser marcados automaticamente — volta aqui depois de o sistema operar mais um pouco.
                  </div>
                )}
              </div>
              );
            })()}
            {(() => {
              // ── Comparação alternativa por DATA de corte (método secundário) ──
              const expDe = (dias) => {
                const all = dias.flatMap(a => (a.trades || []).filter(t => typeof t.pnl === "number"));
                if (!all.length) return null;
                const net = all.reduce((s, t) => s + t.pnl, 0);
                const wins = all.filter(t => t.pnl > 0).length;
                return {
                  n: all.length, dias: dias.length, net: +net.toFixed(2),
                  exp: +(net / all.length).toFixed(3),
                  wr: +(wins / all.length * 100).toFixed(0),
                };
              };
              // archForTab vem ordenado desc (mais recente primeiro). 'day' é "YYYY-MM-DD".
              const antes  = histCorte ? archForTab.filter(a => (a.day || "") <  histCorte) : [];
              const depois = histCorte ? archForTab.filter(a => (a.day || "") >= histCorte) : [];
              const eA = expDe(antes), eD = expDe(depois);
              const Lado = (titulo, e, cor) => (
                <div style={{ flex: 1, padding: "10px 12px", borderRadius: 10, background: `${cor}0E`, border: `1px solid ${cor}33` }}>
                  <div style={{ fontSize: 10, color: T.muted, marginBottom: 6 }}>{titulo}</div>
                  {e ? <>
                    <div style={{ fontSize: 18, fontWeight: 800, color: e.exp >= 0 ? T.green : T.red }}>
                      {sign(e.exp)}€{Math.abs(e.exp).toFixed(2)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 600 }}> /trade</span>
                    </div>
                    <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>
                      {e.dias} dias · {e.n} trades · {e.wr}% win · P&L {sign(e.net)}€{Math.abs(e.net).toFixed(2)}
                    </div>
                  </> : <div style={{ fontSize: 11, color: T.muted }}>sem dados neste lado</div>}
                </div>
              );
              const delta = (eA && eD) ? +(eD.exp - eA.exp).toFixed(3) : null;
              return (
              <div style={{ marginBottom: 16, padding: "14px 16px", borderRadius: 12, background: `${T.accent}08`, border: `1px solid ${T.accent}22` }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>⚖️ Comparar por data (alternativa)</div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>
                  Define a data em que mudaste algo (ex.: ligaste o Modo Dinâmico) para ver se a expectativa por trade melhorou. Compara os dias antes da data com os dias a partir dela.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: T.muted }}>Data de corte:</span>
                  <input type="date" value={histCorte} onChange={e => setHistCorte(e.target.value)}
                    style={{ background: T.base, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 12, padding: "4px 8px", colorScheme: "dark" }} />
                  {histCorte && <button onClick={() => setHistCorte("")} style={{ background: "transparent", border: "none", color: T.muted, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>limpar</button>}
                  {/* Atalho: usar a data do último liga/desliga registado do Modo Dinâmico. */}
                  {regimeLog.length > 0 && (
                    <button onClick={() => setHistCorte(regimeLog[0].data)} style={{
                      background: `${T.accent}18`, border: `1px solid ${T.accent}44`, borderRadius: 8,
                      color: T.aLight, fontSize: 10, fontWeight: 600, padding: "4px 10px", cursor: "pointer",
                    }}>
                      usar último evento ({regimeLog[0].data})
                    </button>
                  )}
                </div>
                {/* Histórico de liga/desliga do Modo Dinâmico — ancora a comparação em factos. */}
                {regimeLog.length > 0 && (
                  <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: `${T.base}`, border: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>📊 Registo do Modo Dinâmico</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {regimeLog.slice(0, 5).map((ev) => (
                        <div key={ev.id} style={{ fontSize: 10, color: T.muted, display: "flex", justifyContent: "space-between" }}>
                          <span>
                            <span style={{ color: ev.estado ? T.green : T.red, fontWeight: 700 }}>
                              {ev.estado ? "● LIGADO" : "○ DESLIGADO"}
                            </span>
                            <span style={{ color: T.muted }}> · {ev.modo}</span>
                          </span>
                          <span>{(() => { try { return new Date(ev.ts).toLocaleString("pt-PT"); } catch { return ev.data; } })()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!histCorte ? (
                  <div style={{ fontSize: 11, color: T.muted, fontStyle: "italic" }}>Escolhe uma data acima para ver a comparação.</div>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 10 }}>
                      {Lado(`Antes de ${histCorte}`, eA, T.muted)}
                      {Lado(`A partir de ${histCorte}`, eD, T.accent)}
                    </div>
                    {delta !== null && (
                      <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: delta >= 0 ? T.green : T.red, textAlign: "center" }}>
                        {delta >= 0 ? "▲" : "▼"} {sign(delta)}€{Math.abs(delta).toFixed(2)}/trade {delta >= 0 ? "melhor" : "pior"} depois da mudança
                        <div style={{ fontSize: 9, color: T.muted, fontWeight: 400, marginTop: 2 }}>
                          {(eA.n < 20 || eD.n < 20) ? "⚠ amostra pequena — precisa de mais trades para ser fiável" : "amostra razoável"}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              );
            })()}
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 12 }}>🗓 Arquivo Diário ({archForTab.length} dias)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {archForTab.map((a) => {
                const isOpen = histOpenDay === a.day;
                const pnlPos = (a.pnl || 0) >= 0;
                return (
                  <div key={a.id || a.day} style={{
                    borderRadius: 10,
                    background: pnlPos ? `${T.green}08` : `${T.red}08`,
                    border: `1px solid ${pnlPos ? T.green : T.red}20`,
                    overflow: "hidden",
                  }}>
                    <div
                      onClick={() => setHistOpenDay(isOpen ? null : a.day)}
                      style={{
                        display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr 0.4fr",
                        gap: 12, padding: "10px 14px", alignItems: "center",
                        fontSize: 12, cursor: "pointer",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700 }}>{a.day}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{a.count} trades</div>
                      </div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>P&L</div><div style={{ fontWeight: 700, color: pnlPos ? T.green : T.red }}>{sign(a.pnl || 0)}€{Math.abs(a.pnl || 0).toFixed(2)}</div></div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>€/trade</div><div style={{ fontWeight: 700, color: pnlPos ? T.green : T.red }}>{a.count ? `${sign((a.pnl||0)/a.count)}€${Math.abs((a.pnl||0)/a.count).toFixed(2)}` : "—"}</div></div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>Win Rate</div><div style={{ fontWeight: 700, color: T.gold }}>{(a.winRate || 0).toFixed(0)}%</div></div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>Wins</div><div style={{ fontWeight: 700 }}>{a.wins ?? 0}/{a.count}</div></div>
                      <div style={{ textAlign: "right", color: T.muted, fontSize: 13 }}>{isOpen ? "▲" : "▼"}</div>
                    </div>
                    {isOpen && Array.isArray(a.trades) && (
                      <div style={{ padding: "0 14px 12px", overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, minWidth: 760 }}>
                          <thead>
                            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                              {[["Ativo","ativo"],["Estratégia","estrategia"],["Abertura","abertura"],["Saída","saidaData"],["Entrada $","entrada"],["Saída $","saida"],["P&L","pnl"],["Status","status"]].map(([h,key]) => {
                                const active = arqSortKey === key;
                                return (
                                  <th key={h}
                                    onClick={() => { if (active) setArqSortDir(d=>d==="asc"?"desc":"asc"); else { setArqSortKey(key); setArqSortDir("desc"); } }}
                                    style={{ padding: "6px 8px", textAlign: "left", color: active ? T.aLight : T.muted, fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
                                    {h}{active ? (arqSortDir==="asc"?" ▲":" ▼") : " ⇅"}
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {[...a.trades].sort((x,y) => {
                              const val = (t) => ({
                                ativo: (t.assetSym||t.assetId||"").toLowerCase(),
                                estrategia: (t.strategy||t.stratId||"").toLowerCase(),
                                abertura: t.openedTs || 0,
                                saidaData: t.closedTs || 0,
                                entrada: t.entryPrice ?? 0,
                                saida: t.closePrice ?? 0,
                                pnl: t.pnl ?? 0,
                                status: (t.status||"").toLowerCase(),
                              })[arqSortKey];
                              const vx = val(x), vy = val(y);
                              let c = (typeof vx === "number" && typeof vy === "number") ? vx - vy : String(vx).localeCompare(String(vy),"pt");
                              return arqSortDir === "asc" ? c : -c;
                            }).map((t, ti) => {
                              const tp = (t.pnl || 0) >= 0;
                              return (
                                <tr key={t.id || ti} style={{ borderBottom: `1px solid ${T.border}55` }}>
                                  <td style={{ padding: "6px 8px", fontWeight: 700 }}>{t.assetSym || t.assetId}</td>
                                  <td style={{ padding: "6px 8px", color: T.muted }}>{t.strategy || t.stratId || "—"}</td>
                                  <td style={{ padding: "6px 8px", color: T.muted, whiteSpace: "nowrap", fontSize: 9 }}>{t.openedAt || "—"}</td>
                                  <td style={{ padding: "6px 8px", color: T.muted, whiteSpace: "nowrap", fontSize: 9 }}>{t.closedAt || "—"}</td>
                                  <td style={{ padding: "6px 8px" }}>${t.entryPrice}</td>
                                  <td style={{ padding: "6px 8px" }}>${t.closePrice ?? "—"}</td>
                                  <td style={{ padding: "6px 8px", fontWeight: 700, color: tp ? T.green : T.red }}>{sign(t.pnl || 0)}€{Math.abs(t.pnl || 0).toFixed(2)}</td>
                                  <td style={{ padding: "6px 8px", color: T.muted }}>{t.status}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Glass>
          );
        })()}

        {/* Trades table */}
        {filtered.length === 0 ? (
          <Glass style={{ padding: "56px 24px", textAlign: "center" }}>
            <div style={{ color: T.muted, fontSize: 13 }}>
              {histTab === "sim" ? "Sem trades de simulação ainda." : botModoReal ? "Sem trades live ainda." : "Sem trades em paper ainda."}
            </div>
          </Glass>
        ) : (
          <Glass style={{ padding: "20px", overflowX: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
              <SectionLabel>Trades — {histTab === "sim" ? "Simulação" : "Live"} · {histCat} ({filtered.length})</SectionLabel>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Colunas:</span>
                {[
                  { k: "abertura", l: "Abertura" },
                  { k: "duracao", l: "Duração" },
                  { k: "investido", l: "Investido" },
                  { k: "sltp", l: "SL/TP" },
                  { k: "mercado", l: "Mercado" },
                ].map(c => (
                  <button key={c.k} onClick={() => setColsVisiveis(v => ({ ...v, [c.k]: !v[c.k] }))}
                    style={{ padding: "3px 9px", borderRadius: 6, fontSize: 9, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                      background: colsVisiveis[c.k] ? `${T.accent}1a` : "transparent",
                      border: `1px solid ${colsVisiveis[c.k] ? T.accent : T.border}`,
                      color: colsVisiveis[c.k] ? T.accent : T.muted }}>
                    {colsVisiveis[c.k] ? "✓ " : ""}{c.l}
                  </button>
                ))}
              </div>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 780 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {(() => {
                    // Colunas: essenciais sempre; opcionais conforme colsVisiveis.
                    const cols = [
                      { h: "Ativo", key: colSortKey["Ativo"], on: true },
                      { h: "Origem", key: null, on: true },
                      { h: "Abertura", key: colSortKey["Abertura"], on: colsVisiveis.abertura },
                      { h: "Duração", key: colSortKey["Duração"], on: colsVisiveis.duracao },
                      { h: "Entrada", key: colSortKey["Entrada"], on: true },
                      { h: "Atual", key: colSortKey["Preço Atual"], on: true },
                      { h: "Investido", key: colSortKey["Investido"], on: colsVisiveis.investido },
                      { h: "SL/TP", key: null, on: colsVisiveis.sltp },
                      { h: "P&L", key: colSortKey["P&L"], on: true },
                      { h: "IA", key: null, on: true },
                      { h: "Ação", key: null, on: true },
                      { h: "Status", key: colSortKey["Status"], on: true },
                      { h: "Mercado", key: null, on: colsVisiveis.mercado },
                    ];
                    return cols.filter(c => c.on).map(({ h, key }) => {
                      const active = key && histSortKey === key;
                      return (
                        <th key={h}
                          onClick={key ? () => toggleSort(key) : undefined}
                          style={{
                            padding: "8px 10px", textAlign: "left", fontSize: 8, letterSpacing: "0.1em",
                            textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap",
                            color: active ? T.aLight : T.muted,
                            cursor: key ? "pointer" : "default", userSelect: "none",
                          }}>
                          {h}{active ? (histSortDir === "asc" ? " ▲" : " ▼") : (key ? " ⇅" : "")}
                        </th>
                      );
                    });
                  })()}
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map(t => {
                  const pnl    = t.pnl !== undefined ? t.pnl : t.curPnl;
                  const isOpen = t.status === "ABERTA";
                  const a      = findAsset(t);
                  return (
                    <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}20` }}>
                      {/* Ativo */}
                      <td style={{ padding: "9px 10px", fontWeight: 700 }}>{a?.icon || "◆"} {a?.sym || t.assetSym || t.assetId}</td>
                      {/* Origem (junta origem + nome da estratégia) */}
                      <td style={{ padding: "9px 10px", maxWidth: 150 }}>
                        <div style={{ fontSize: 10, color: T.aLight, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {t.stratId === "dca"        ? (t.planNome ? `🎯 DCA · ${t.planNome}` : "🎯 DCA")
                            : t.stratId === "manual"     ? "✋ Manual"
                            : t.stratId === "ai-brain"   ? "🤖 AI Brain"
                            : t.stratId === "daytrading" ? "⚡ Day Trading"
                            : "🎯 Estratégia"}
                        </div>
                        {t.strategy && t.stratId !== "dca" && <div style={{ fontSize: 8.5, color: T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.strategy}</div>}
                      </td>
                      {/* Abertura (opcional) */}
                      {colsVisiveis.abertura && <td style={{ padding: "9px 10px", color: T.muted, fontSize: 9.5 }}>{t.openedAt}{!isOpen && t.closedAt ? <div style={{ fontSize: 8, color: T.muted }}>→ {t.closedAt}</div> : null}</td>}
                      {/* Duração (opcional) */}
                      {colsVisiveis.duracao && <td style={{ padding: "9px 10px", color: T.muted, whiteSpace: "nowrap" }}>
                        {isOpen || !t.openedTs || !t.closedTs ? "—" : (() => {
                          const m = Math.round((t.closedTs - t.openedTs) / 60000);
                          if (m < 1)  return "<1min";
                          if (m < 60) return `${m}min`;
                          return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
                        })()}
                      </td>}
                      {/* Entrada */}
                      <td style={{ padding: "9px 10px" }}>${t.entryPrice?.toFixed(2)}</td>
                      {/* Preço atual */}
                      <td style={{ padding: "9px 10px" }}>{isOpen ? `$${t.livePrice ? fmt(t.livePrice, a?.id || t.assetId) : "—"}` : (Number.isFinite(+t.closePrice) ? `$${(+t.closePrice).toFixed(2)}` : "—")}</td>
                      {/* Investido (opcional) */}
                      {colsVisiveis.investido && <td style={{ padding: "9px 10px" }}>€{t.amount}</td>}
                      {/* SL/TP (opcional, junto) */}
                      {colsVisiveis.sltp && <td style={{ padding: "9px 10px", fontSize: 9.5, whiteSpace: "nowrap" }}>
                        {t.stratId === "dca" ? <span style={{ color: T.muted }}>—</span> : <><span style={{ color: T.red }}>${t.sl}</span> <span style={{ color: T.muted }}>/</span> <span style={{ color: T.green }}>${t.tp}</span></>}
                      </td>}
                      {/* P&L + % juntos */}
                      <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                        {pnl !== undefined && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                            <span style={{ color: pnl >= 0 ? T.green : T.red, fontWeight: 700 }}>{sign(pnl)}{eur(pnl)}</span>
                            {t.amount ? (() => { const pct = (pnl / t.amount) * 100; return <span style={{ color: pct >= 0 ? T.green : T.red, fontWeight: 600, fontSize: 9 }}>{sign(pct)}{Math.abs(pct).toFixed(2)}% <span style={{ color: T.muted, fontWeight: 400 }}>líq.</span></span>; })() : null}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        {(() => {
                          // Sinal atual da IA para este ativo (só faz sentido em posições abertas)
                          if (!isOpen) return <span style={{ color: T.muted }}>—</span>;
                          const sig = (marketSignals || {})[t.assetId];
                          if (!sig) return <span style={{ color: T.muted, fontSize: 10 }}>—</span>;
                          const cor = sig.sinal === "COMPRAR" ? T.green : sig.sinal === "VENDER" ? T.red : T.gold;
                          const txt = sig.sinal === "COMPRAR" ? "▲ Subir" : sig.sinal === "VENDER" ? "▼ Descer" : "● Manter";
                          return <span style={{ color: cor, fontSize: 10, fontWeight: 600 }} title={sig.razao || ""}>{txt} {sig.confianca ? `${sig.confianca}%` : ""}</span>;
                        })()}
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        {isOpen ? (
                          <button
                            onClick={() => {
                              const novoHold = !t.hold;
                              // grava no Firestore — o bot lê e respeita (trava AI-EXIT e TP, mantém SL)
                              if (user) import("./firebase.js").then(({ updateTrade }) =>
                                updateTrade(user.uid, t.id, { hold: novoHold }).catch(()=>{}));
                              toast(novoHold ? `🔒 Hold ligado em ${a?.sym || t.assetId} — deixa correr (SL mantém-se)` : `🔓 Hold desligado em ${a?.sym || t.assetId}`, novoHold ? "buy" : "info");
                            }}
                            style={{
                              padding: "3px 9px", borderRadius: 6, fontSize: 9, fontWeight: 700, cursor: "pointer",
                              fontFamily: "inherit",
                              background: t.hold ? `${T.gold}22` : "transparent",
                              border: `1px solid ${t.hold ? T.gold : T.border}`,
                              color: t.hold ? T.gold : T.muted,
                            }}
                          >{t.hold ? "🔒 HOLD" : "○ Hold"}</button>
                        ) : <span style={{ color: T.muted }}>—</span>}
                        {/* Toggle "só vender lucro" com % editável (posições abertas, não sim) */}
                        {(t.status === "ABERTA" || !t.status) && !simMode && (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
                            <button
                              onClick={() => {
                                if (!user) return;
                                const ativar = !t.aiGerido;
                                const alvo = Number(t.lucroAlvo) || 2;
                                cmdToBot({ type: "POS_VENDER_LUCRO", posId: t.id, ativar, lucroAlvo: alvo },
                                  ativar ? `🎯 ${t.assetSym || t.assetId}: só vende a +${alvo}%` : `Modo lucro desligado em ${t.assetSym || t.assetId}`);
                              }}
                              title="Só vende quando a posição estiver em lucro (líquido de taxas)"
                              style={{ padding: "3px 8px", borderRadius: 6, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                                background: t.aiGerido ? `${T.green}22` : "transparent", border: `1px solid ${t.aiGerido ? T.green : T.border}`, color: t.aiGerido ? T.green : T.muted }}
                            >{t.aiGerido ? "🎯 só lucro" : "○ só lucro"}</button>
                            {t.aiGerido && user && (
                              <LucroAlvoControl t={t} vol={a?.vol} cmdToBot={cmdToBot} />
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        {(() => {
                          const pnlVal = t.pnl !== undefined ? t.pnl : t.curPnl;
                          const win = (pnlVal || 0) >= 0;
                          // Um stop que fechou COM lucro foi, na prática, um trailing a proteger
                          // ganhos → mostra como TRAIL (verde). Só um stop COM perda é SL (vermelho).
                          const isTrailWin = (t.status === "TRAIL") || (t.status === "SL" && win);
                          const isRealSL   = t.status === "SL" && !win;
                          const lbl = isOpen ? "ABERTA"
                            : t.status === "TP"      ? "✓ TP"
                            : t.status === "MANUAL"  ? "✓ Manual"
                            : t.status === "AI-EXIT" ? "🤖 AI"
                            : t.status === "ROTACAO" ? "🔄 Rotação"
                            : t.status === "CANCELADA" ? "✗ Cancelada"
                            : t.status === "FECHADA-RECON" ? "🔧 Reconciliada"
                            : t.status === "RESET-TESTNET" ? "🧪 Reset testnet"
                            : isTrailWin             ? "📈 Trailing"
                            : isRealSL               ? "🛑 SL"
                            : t.status && t.status !== "ABERTA" ? `· ${t.status}`
                            : win ? "✓ Fechado" : "✗ Fechado";
                          const c = isOpen ? T.blue
                            : (t.status === "RESET-TESTNET" || t.status === "FECHADA-RECON") ? T.muted
                            : isRealSL ? T.red
                            : win ? T.green : T.red;
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Badge label={lbl} color={c} />
                              {isOpen && !simMode && t.stratId !== "dca" && (
                                <button
                                  onClick={() => {
                                    cmdToBot({ type: "SELL", posId: t.id, assetId: t.assetId },
                                      `📤 Pedido de venda de ${t.assetSym} enviado ao bot`);
                                  }}
                                  title="Pedir ao bot para vender esta posição"
                                  style={{ background: `${T.red}18`, border: `1px solid ${T.red}44`, color: T.red, borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                                >▼ Vender</button>
                              )}
                              {isOpen && !simMode && t.stratId === "dca" && (
                                <span style={{ fontSize: 8.5, color: T.muted, fontStyle: "italic" }}>DCA · segurar</span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      {colsVisiveis.mercado && <td style={{ padding: "9px 10px" }}>
                        {isOpen ? <MarketBadge assetId={t.assetId} /> : <span style={{ color: T.muted, fontSize: 10 }}>—</span>}
                      </td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Glass>
        )}
      </div>
    );
  };

  // RENDER: MENSAGENS (eventos do bot — erros + trading)
  // ─────────────────────────────────────────────
  const Messages = () => {
    const filtro = msgFiltro, setFiltro = setMsgFiltro;
    const corNivel = (lvl) => lvl === "buy" ? T.blue : lvl === "sell" ? T.green
      : lvl === "error" ? T.red : lvl === "warn" ? T.gold : T.muted;
    const iconNivel = (lvl) => lvl === "buy" ? "🛒" : lvl === "sell" ? "💰"
      : lvl === "error" ? "🚫" : lvl === "warn" ? "⚠️" : "•";
    const filtrados = botLogs.filter(l => {
      if (filtro === "todos") return true;
      if (filtro === "trading") return l.level === "buy" || l.level === "sell";
      if (filtro === "erros") return l.level === "error" || l.level === "warn";
      return true;
    });
    const limpar = () => {
      if (!user) return;
      if (!window.confirm("Apagar todas as mensagens? Esta ação não pode ser desfeita.")) return;
      import("./firebase.js").then(({ clearLogs }) => clearLogs(user.uid).then(() => {
        setBotLogs([]); toast("Mensagens apagadas", "success");
      }).catch(() => toast("Falha ao apagar", "error")));
    };
    const hora = (ts) => { try { return new Date(ts).toLocaleString("pt-PT"); } catch { return ""; } };
    // Exportar as mensagens filtradas como texto, para copiar/colar (ex.: para
    // análise). Inclui data, nível e mensagem, uma por linha, em ordem cronológica.
    const exportar = async () => {
      if (!filtrados.length) { toast("Nada para exportar neste filtro", "warn"); return; }
      const linhas = [...filtrados]
        .sort((a, b) => (a.ts || 0) - (b.ts || 0)) // cronológico (mais antigo primeiro)
        .map(l => `[${hora(l.ts)}] ${(l.level || "info").toUpperCase()}: ${l.msg}`);
      const cabecalho = `TradeAI — Mensagens do Bot (${filtro})\nExportado: ${new Date().toLocaleString("pt-PT")}\nTotal: ${linhas.length} eventos\n${"─".repeat(40)}\n`;
      const texto = cabecalho + linhas.join("\n");
      try {
        await navigator.clipboard.writeText(texto);
        toast(`${linhas.length} mensagens copiadas — cola onde precisares`, "success");
      } catch {
        // Fallback: se a clipboard falhar (permissões), descarrega um .txt.
        try {
          const blob = new Blob([texto], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `tradeai-mensagens-${Date.now()}.txt`;
          a.click(); URL.revokeObjectURL(url);
          toast("Mensagens descarregadas (.txt)", "success");
        } catch { toast("Falha ao exportar", "error"); }
      }
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Glass style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>🔔 Mensagens do Bot</div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>Eventos de trading e erros. Guardadas 3 dias (apagam-se sozinhas).</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={exportar} style={{
                padding: "8px 16px", borderRadius: 8, border: `1px solid ${T.aLight}40`,
                background: `${T.aLight}15`, color: T.aLight, fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>📋 Exportar</button>
              <button onClick={limpar} style={{
                padding: "8px 16px", borderRadius: 8, border: `1px solid ${T.red}40`,
                background: `${T.red}15`, color: T.red, fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>🗑 Limpar tudo</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {[["todos", "Todos"], ["trading", "🛒 Trading"], ["erros", "⚠️ Erros"]].map(([id, lbl]) => (
              <button key={id} onClick={() => setFiltro(id)} style={{
                padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                border: `1px solid ${filtro === id ? T.aLight : T.border}`,
                background: filtro === id ? `${T.aLight}18` : "transparent",
                color: filtro === id ? T.aLight : T.muted,
              }}>{lbl}</button>
            ))}
          </div>
        </Glass>

        <Glass style={{ padding: filtrados.length ? "8px 0" : "40px 24px" }}>
          {!filtrados.length ? (
            <div style={{ textAlign: "center", color: T.muted, fontSize: 13 }}>
              Sem mensagens {filtro !== "todos" ? "neste filtro" : "ainda"}. Os eventos do bot aparecem aqui.
            </div>
          ) : filtrados.map((l, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 24px",
              borderBottom: i < filtrados.length - 1 ? `1px solid ${T.border}` : "none",
            }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>{iconNivel(l.level)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: corNivel(l.level), fontWeight: 600, wordBreak: "break-word" }}>{l.msg}</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{hora(l.ts)}</div>
              </div>
            </div>
          ))}
        </Glass>
      </div>
    );
  };

  // RENDER: GUIA
  // ─────────────────────────────────────────────
  const Guide = () => {
    const Row = ({ k, v, c }) => (
      <div style={{ display:"flex", gap:14, padding:"7px 0", borderBottom:`1px solid ${T.border}44`, fontSize:12 }}>
        <span style={{ color: c || T.accent, fontWeight:700, minWidth:130, flexShrink:0 }}>{k}</span>
        <span style={{ color:T.muted }}>{v}</span>
      </div>
    );

    const CodeBlock = ({ children }) => (
      <div style={{ background:"rgba(0,0,0,0.4)", borderRadius:10, padding:"14px 16px",
        fontFamily:"monospace", fontSize:11, color:T.aLight, lineHeight:1.9, overflowX:"auto",
        whiteSpace:"pre", border:`1px solid ${T.border}` }}>{children}</div>
    );

    return (
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

        {/* Header */}
        <Glass style={{ padding:"24px 28px",
          background:"linear-gradient(135deg,rgba(99,102,241,0.12),rgba(16,185,129,0.07))",
          border:`1px solid ${T.accent}30` }}>
          <div style={{ fontSize:17, fontWeight:700, marginBottom:6 }}>◉ Guia Completo — Do Zero ao Bot a Investir</div>
          <div style={{ color:T.muted, fontSize:12, lineHeight:1.7 }}>
            Tudo o que precisas: corretora, API keys, deploy e levantamento para IBAN PT.
          </div>
        </Glass>

        {/* ── PASSO 01: Escolher Corretora ── */}
        <Glass style={{ padding:"22px 24px", display:"flex", gap:20 }}>
          <div style={{ fontSize:44, fontWeight:800, color:T.aLight, opacity:0.22, flexShrink:0, lineHeight:1 }}>01</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.aLight, marginBottom:14 }}>Escolher a Corretora</div>

            {/* Comparação */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
              {[
                { id:"alpaca", emoji:"🦙", name:"Alpaca", badge:"RECOMENDADO DAY TRADING", badgeC:T.green,
                  pros:["API REST simples, gratuita","Paper trading built-in sem instalar nada","$0 comissão em ações US","Conta em 10 minutos","Perfeito para bot e day trading"],
                  cons:["Só ações US, ETFs e cripto","Sem futuros de petróleo/ouro reais","Sem SEPA direto — usa Wise"],
                  for:"SPY, QQQ, ETFs, BTC, ETH, day trading" },
                { id:"ibkr", emoji:"🏦", name:"Interactive Brokers", badge:"RECOMENDADO COMPLETO", badgeC:T.accent,
                  pros:["Futuros reais: petróleo WTI, ouro, prata","Forex, ações globais, ETFs","SEPA gratuito para IBAN PT","API oficial robusta","Regulado CMVM/FCA/SEC"],
                  cons:["Precisas do TWS aberto no servidor","Setup mais complexo","1-3 dias aprovação"],
                  for:"Petróleo, ouro, forex, mercados globais" },
              ].map(b => (
                <div key={b.id} onClick={() => setBrokerTab(b.id)} style={{
                  borderRadius:12, padding:"16px", cursor:"pointer",
                  background: brokerTab===b.id ? `${b.badgeC}12` : "rgba(255,255,255,0.03)",
                  border:`2px solid ${brokerTab===b.id ? b.badgeC : T.border}`,
                  transition:"all 0.15s",
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                    <span style={{ fontSize:24 }}>{b.emoji}</span>
                    <div>
                      <div style={{ fontWeight:700, fontSize:13 }}>{b.name}</div>
                      <span style={{ background:`${b.badgeC}20`, color:b.badgeC, border:`1px solid ${b.badgeC}33`,
                        borderRadius:99, padding:"1px 8px", fontSize:8, fontWeight:700 }}>{b.badge}</span>
                    </div>
                  </div>
                  {b.pros.map(p => <div key={p} style={{ fontSize:10, color:T.green, padding:"1px 0" }}>✓ {p}</div>)}
                  {b.cons.map(c => <div key={c} style={{ fontSize:10, color:T.red,   padding:"1px 0" }}>✗ {c}</div>)}
                  <div style={{ marginTop:8, fontSize:10, color:T.muted }}>Melhor para: <b style={{ color:T.text }}>{b.for}</b></div>
                </div>
              ))}
            </div>

            {/* Instruções da corretora selecionada */}
            {brokerTab === "alpaca" ? (
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:T.green, marginBottom:12 }}>🦙 Setup Alpaca — 10 minutos</div>
                <Row k="1. Criar conta"      v="alpaca.markets → Get Started → Individual" />
                <Row k="2. Verificação"      v="Email + número de telemóvel (sem documentos para paper)" />
                <Row k="3. Paper Trading"    v="Ativa automaticamente — $100.000 fictícios para simular" />
                <Row k="4. API Keys"         v="Dashboard → Paper Trading → API Keys → Generate" c={T.green} />
                <Row k="5. Variáveis"        v="Copia ALPACA_API_KEY e ALPACA_SECRET_KEY para o .env" c={T.green} />
                <Row k="6. Live Trading"     v="Paper → Live: deposita via ACH (banco US) ou Wise" />
                <div style={{ marginTop:14 }}>
                  <div style={{ fontSize:11, color:T.muted, marginBottom:8 }}>Variáveis de ambiente a adicionar:</div>
                  <CodeBlock>{`# Paper Trading (simulação real com dados reais)
ALPACA_API_KEY=PKxxxxxxxxxxxxxxxxxx
ALPACA_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# Live Trading (dinheiro real) — muda só o URL
# ALPACA_BASE_URL=https://api.alpaca.markets`}</CodeBlock>
                </div>
                <div style={{ marginTop:12, background:`${T.green}0d`, border:`1px solid ${T.green}25`,
                  borderRadius:8, padding:"10px 14px", fontSize:11, color:T.muted }}>
                  💡 O Alpaca Paper Trading usa preços <b style={{ color:T.text }}>reais de mercado</b> mas dinheiro fictício.
                  É diferente da simulação desta app — as ordens vão mesmo para o mercado (sem execução real).
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:T.accent, marginBottom:12 }}>🏦 Setup IBKR — 1-3 dias</div>
                <Row k="1. Criar conta"      v="ibkr.com → Open Account → Individual" />
                <Row k="2. Documentos"       v="Cartão de Cidadão (frente+verso) + comprovativo morada recente" />
                <Row k="3. NIF"              v="Obrigatório no registo como residente português" />
                <Row k="4. Aprovação"        v="1–3 dias úteis, 100% online" />
                <Row k="5. Ativar API"       v="TWS → File → Global Config → API → Enable Socket Clients" c={T.accent} />
                <Row k="6. Portas"           v="Paper: 7497  |  Live: 7496" c={T.accent} />
                <Row k="7. Paper Account"    v="TWS menu topo → Switch to Paper Trading Account" />
                <div style={{ marginTop:14 }}>
                  <div style={{ fontSize:11, color:T.muted, marginBottom:8 }}>Variáveis de ambiente a adicionar:</div>
                  <CodeBlock>{`# IBKR (o bot liga via TWS no servidor)
IBKR_HOST=127.0.0.1
IBKR_PORT_DEMO=7497    # Paper Trading
IBKR_PORT_REAL=7496    # Live
IBKR_CLIENT_ID=1`}</CodeBlock>
                </div>
              </div>
            )}
          </div>
        </Glass>

        {/* ── PASSO 02: API Keys da App ── */}
        <Glass style={{ padding:"22px 24px", display:"flex", gap:20 }}>
          <div style={{ fontSize:44, fontWeight:800, color:T.green, opacity:0.22, flexShrink:0, lineHeight:1 }}>02</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.green, marginBottom:14 }}>Configurar API Keys da App</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
              {[
                { name:"Anthropic (Claude)", badge:"Análise profunda", badgeC:T.accent,
                  url:"console.anthropic.com/settings/keys", cost:"~€5-15/mês", var:"ANTHROPIC_API_KEY",
                  desc:"Estratégias, AI Intel, análise de mercado detalhada" },
                { name:"Groq (LLaMA)", badge:"Day Trading", badgeC:T.green,
                  url:"console.groq.com → API Keys", cost:"~€1-2/mês (gratuito até 14.400 req/dia)", var:"GROQ_API_KEY",
                  desc:"Scans rápidos de day trading — 30x mais barato que Claude" },
              ].map(api => (
                <div key={api.name} style={{ background:"rgba(0,0,0,0.2)", borderRadius:10, padding:"14px 16px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                    <div style={{ fontWeight:700, fontSize:12 }}>{api.name}</div>
                    <span style={{ background:`${api.badgeC}18`, color:api.badgeC, border:`1px solid ${api.badgeC}33`,
                      borderRadius:99, padding:"1px 8px", fontSize:8, fontWeight:700 }}>{api.badge}</span>
                  </div>
                  <div style={{ fontSize:10, color:T.muted, marginBottom:8, lineHeight:1.55 }}>{api.desc}</div>
                  <div style={{ fontSize:10, color:T.gold, marginBottom:6 }}>Custo: {api.cost}</div>
                  <div style={{ fontSize:10, color:T.muted, marginBottom:6 }}>Site: <span style={{ color:T.aLight }}>{api.url}</span></div>
                  <div style={{ background:"rgba(0,0,0,0.3)", borderRadius:6, padding:"6px 10px",
                    fontFamily:"monospace", fontSize:10, color:T.green }}>{api.var}=...</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize:11, fontWeight:700, color:T.muted, marginBottom:8 }}>Onde colocar as keys:</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <div style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"12px 14px" }}>
                <div style={{ fontSize:11, fontWeight:700, marginBottom:6 }}>Em Desenvolvimento (local)</div>
                <CodeBlock>{`# ficheiro tradeai/.env
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...`}</CodeBlock>
              </div>
              <div style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"12px 14px" }}>
                <div style={{ fontSize:11, fontWeight:700, marginBottom:6 }}>Em Produção (Netlify)</div>
                <div style={{ fontSize:10, color:T.muted, lineHeight:1.65 }}>
                  Site → <b style={{ color:T.text }}>Environment variables</b> → Add a variable<br/>
                  Adiciona <b style={{ color:T.aLight }}>ANTHROPIC_API_KEY</b> e <b style={{ color:T.aLight }}>GROQ_API_KEY</b><br/>
                  Faz redeploy após guardar
                </div>
              </div>
            </div>
          </div>
        </Glass>

        {/* ── PASSO 03: Depositar e Levantar ── */}
        <Glass style={{ padding:"22px 24px", display:"flex", gap:20 }}>
          <div style={{ fontSize:44, fontWeight:800, color:T.gold, opacity:0.22, flexShrink:0, lineHeight:1 }}>03</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.gold, marginBottom:14 }}>Depositar e Levantar Dinheiro</div>
            {brokerTab === "alpaca" ? (
              <>
                <div style={{ fontSize:12, color:T.muted, lineHeight:1.75, marginBottom:14 }}>
                  O Alpaca não aceita SEPA diretamente. A solução para Portugal:
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
                  <div style={{ background:`${T.green}0a`, border:`1px solid ${T.green}22`, borderRadius:10, padding:"14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:T.green, marginBottom:8 }}>Depositar</div>
                    <ol style={{ fontSize:11, color:T.muted, paddingLeft:16, lineHeight:2.1 }}>
                      <li>Abre conta <b style={{ color:T.text }}>Wise</b> (wise.com)</li>
                      <li>Transfere EUR do teu banco PT para o Wise (SEPA gratuito)</li>
                      <li>Converte EUR → USD no Wise (~0.4% taxa)</li>
                      <li>Envia USD do Wise para o Alpaca via ACH</li>
                    </ol>
                  </div>
                  <div style={{ background:`${T.blue}0a`, border:`1px solid ${T.blue}22`, borderRadius:10, padding:"14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:T.blue, marginBottom:8 }}>Levantar Lucros</div>
                    <ol style={{ fontSize:11, color:T.muted, paddingLeft:16, lineHeight:2.1 }}>
                      <li>Alpaca → Withdraw → USD para conta Wise</li>
                      <li>Wise converte USD → EUR (~0.4%)</li>
                      <li>SEPA do Wise para o teu banco PT</li>
                      <li>Chega em 1-2 dias úteis</li>
                    </ol>
                  </div>
                </div>
                <div style={{ background:`${T.gold}0d`, border:`1px solid ${T.gold}25`, borderRadius:8,
                  padding:"10px 14px", fontSize:11, color:T.muted }}>
                  💡 <b style={{ color:T.text }}>Wise</b> é a forma mais barata de mover dinheiro entre PT e Alpaca.
                  Taxa total tipicamente 0.4-0.8% vs 2-3% nos bancos tradicionais.
                </div>
              </>
            ) : (
              <>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <div style={{ background:`${T.green}0a`, border:`1px solid ${T.green}22`, borderRadius:10, padding:"14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:T.green, marginBottom:8 }}>Depositar via SEPA</div>
                    <ol style={{ fontSize:11, color:T.muted, paddingLeft:16, lineHeight:2.1 }}>
                      <li>IBKR → Transfer & Pay → Deposit → SEPA</li>
                      <li>IBKR dá-te um IBAN luxemburguês</li>
                      <li>Transfere EUR do teu banco PT</li>
                      <li>Chega em 1-2 dias úteis — sem custo</li>
                    </ol>
                  </div>
                  <div style={{ background:`${T.blue}0a`, border:`1px solid ${T.blue}22`, borderRadius:10, padding:"14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:T.blue, marginBottom:8 }}>Levantar para IBAN PT</div>
                    <ol style={{ fontSize:11, color:T.muted, paddingLeft:16, lineHeight:2.1 }}>
                      <li>IBKR → Transfer & Pay → Withdraw → SEPA</li>
                      <li>Insere o teu IBAN PT (PT50…)</li>
                      <li>Mínimo €200 · sem taxa SEPA</li>
                      <li>Chega em 1-3 dias úteis</li>
                    </ol>
                  </div>
                </div>
                <div style={{ marginTop:12, background:`${T.green}0d`, border:`1px solid ${T.green}25`,
                  borderRadius:8, padding:"10px 14px", fontSize:11, color:T.muted }}>
                  ✓ EUR→EUR sem custo de câmbio. Começa com €200-500 para validar antes de escalar.
                </div>
              </>
            )}
          </div>
        </Glass>

        {/* ── PASSO 04: IRS ── */}
        <Glass style={{ padding:"22px 24px", display:"flex", gap:20 }}>
          <div style={{ fontSize:44, fontWeight:800, color:T.red, opacity:0.22, flexShrink:0, lineHeight:1 }}>04</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.red, marginBottom:14 }}>Impostos em Portugal — IRS</div>
            {[
              ["Mais-valias (ações, ETFs, futuros)", "Categoria G — taxa autónoma 28% sobre o lucro líquido", T.red],
              ["Dividendos",                         "Categoria E — 28% (ou englobamento se taxa marginal < 28%)", T.gold],
              ["Day Trading",                        "Cada operação é tributada individualmente — guarda registo de todos os trades", T.gold],
              ["Quando declarar",                    "Ganhos de 2025 → IRS de Abril/Junho 2026", T.green],
              ["Documentação",                       "IBKR e Alpaca fornecem relatório anual CSV com todos os trades", T.blue],
            ].map(([k, v, c]) => (
              <div key={k} style={{ padding:"8px 0", borderBottom:`1px solid ${T.border}44` }}>
                <div style={{ fontSize:12, fontWeight:600, color:c, marginBottom:2 }}>{k}</div>
                <div style={{ fontSize:11, color:T.muted }}>{v}</div>
              </div>
            ))}
            <div style={{ marginTop:12, background:`${T.red}0d`, border:`1px solid ${T.red}22`,
              borderRadius:8, padding:"10px 14px", fontSize:11, color:T.muted }}>
              ⚠ Consulta um TOC/contabilista para a tua situação — regras fiscais podem mudar.
            </div>
          </div>
        </Glass>

        {/* ── PASSO 05: Deploy 24/7 ── */}
        <Glass style={{ padding:"22px 24px", display:"flex", gap:20 }}>
          <div style={{ fontSize:44, fontWeight:800, color:T.accent, opacity:0.22, flexShrink:0, lineHeight:1 }}>05</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.accent, marginBottom:14 }}>Deploy 24/7 — App + Bot</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:T.aLight, marginBottom:8 }}>App React (Netlify)</div>
                <CodeBlock>{`# Na pasta tradeai/
git init
git add .
git commit -m "TradeAI v1"
git push origin main
# Liga o repo ao Netlify → deploy automático`}</CodeBlock>
                <div style={{ marginTop:8, fontSize:11, color:T.muted, lineHeight:1.65 }}>
                  A app fica online 24/7 automaticamente no Netlify.<br/>
                  As Netlify Functions correm sem servidor adicional.
                </div>
              </div>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:T.aLight, marginBottom:8 }}>Bot Node.js (Hetzner €4/mês)</div>
                <CodeBlock>{`# Hetzner CX22 (€4/mês, Frankfurt)
npm install -g pm2
cd tradeai-bot
cp .env.example .env
# preenche .env com as keys
npm install
pm2 start ecosystem.config.js \
  --env demo  # ou production para real
pm2 save && pm2 startup`}</CodeBlock>
              </div>
            </div>
            <div style={{ marginTop:12, background:`${T.accent}0a`, border:`1px solid ${T.accent}25`,
              borderRadius:8, padding:"10px 14px", fontSize:11, color:T.muted }}>
              📦 Custo total: Netlify gratuito + Hetzner €4/mês + Anthropic ~€10/mês + Groq ~€2/mês = <b style={{ color:T.text }}>~€16/mês</b>
            </div>
          </div>
        </Glass>

        {/* ── PASSO 06: Fluxo Simulação → Real ── */}
        <Glass style={{ padding:"22px 24px", display:"flex", gap:20 }}>
          <div style={{ fontSize:44, fontWeight:800, color:T.green, opacity:0.22, flexShrink:0, lineHeight:1 }}>06</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:T.green, marginBottom:14 }}>Fluxo Recomendado — Simulação → Real</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {[
                { n:"1", c:T.gold,   t:"Simular 15 dias",              d:"Usa esta app em modo Simulação com €500-1000 fictícios. Deixa o bot e o day trading trabalhar. Analisa os resultados no Histórico." },
                { n:"2", c:T.gold,   t:"Validar métricas",             d:"Win Rate > 52% · Profit Factor > 1.3 · Max Drawdown < 20% · ROI positivo consistente." },
                { n:"3", c:T.blue,   t:"Abrir conta (Alpaca ou IBKR)", d:"Alpaca para day trading de ETFs/cripto. IBKR para commodities e mercados globais. Ou ambas." },
                { n:"4", c:T.blue,   t:"Depositar capital inicial",    d:"Começa com €200-500. Nunca invistas mais do que podes perder a 100%." },
                { n:"5", c:T.green,  t:"Mudar para LIVE",              d:"Toggle no topo da app: SIMULAÇÃO → LIVE. O bot começa a executar ordens reais." },
                { n:"6", c:T.accent, t:"Escalar gradualmente",         d:"Se os primeiros 30 dias forem positivos, aumenta o capital. Mantém sempre stop loss ativo." },
              ].map(s => (
                <div key={s.n} style={{ display:"flex", gap:14, padding:"10px 14px",
                  background:"rgba(0,0,0,0.18)", borderRadius:10, alignItems:"flex-start" }}>
                  <div style={{ width:24, height:24, borderRadius:"50%", background:`${s.c}25`,
                    border:`1px solid ${s.c}44`, display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:11, fontWeight:800, color:s.c, flexShrink:0 }}>{s.n}</div>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:s.c, marginBottom:2 }}>{s.t}</div>
                    <div style={{ fontSize:11, color:T.muted, lineHeight:1.55 }}>{s.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Glass>

        <div style={{ textAlign:"center", padding:18, color:T.muted, fontSize:11, borderTop:`1px solid ${T.border}` }}>
          ⚠ Trading envolve risco real de perda de capital. Esta app é educacional — não é aconselhamento financeiro.
        </div>
      </div>
    );
  };


  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // RENDER: DEFINIÇÕES
  // ─────────────────────────────────────────────
  const Settings = () => {
    // defTab: "sim" | "paper" | "real"
    const isSimTab  = defTab === "sim";
    const isRealTab = defTab === "real";
    const currentSettings    = isSimTab ? settings : isRealTab ? realSettings : paperSettings;
    const setCurrentSettings = isSimTab ? setSettings : isRealTab ? setRealSettings : setPaperSettings;
    const docKey             = isSimTab ? "settings" : isRealTab ? "realSettings" : "paperSettings";
    // local edit state vive no top-level (settingsLocal) para sobreviver ao re-render de 2s
    const brainDefaults = { aiBrain: false, aiBrainConfianca: 78, trailingStop: false, trailingStopPct: 4, aiExitOnFlip: true, aiSignalsMin: 15 };
    const local = { ...brainDefaults, ...(settingsLocal || currentSettings) };
    const setLocal = (updater) => {
      setSettingsLocal(prev => {
        const base = prev || { ...currentSettings };
        return typeof updater === "function" ? updater(base) : updater;
      });
    };

    const settingsForTab = (tab) => tab === "sim" ? settings : tab === "real" ? realSettings : paperSettings;
    const switchTab = (tab) => {
      setDefTab(tab);
      setSettingsLocal({ ...settingsForTab(tab) });
    };

    const upd  = (k, v) => setLocal(p => ({ ...p, [k]: v }));
    const perfilInfo = {
      conservador: { desc: "Quedas maiores para acionar compra, SL/TP apertados. Menos trades, mais seguros.",                       sl: 4, tp: 8,  compra: 2.5 },
      moderado:    { desc: "Equilíbrio entre oportunidades e risco. Bom ponto de partida.",                                          sl: 6, tp: 12, compra: 1.5 },
      agressivo:   { desc: "Mais trades, entradas mais frequentes. TP distante — só compensa em mercados claramente em alta.",       sl: 9, tp: 18, compra: 0.8 },
      scalper:     { desc: "Alvos curtos: fecha em lucro muitas vezes (win rate alto). Combina muito bem com o TP parcial ligado.",  sl: 3, tp: 4,  compra: 1.0 },
      equilibrado: { desc: "Rácio quase 1:1 entre risco e ganho. Win rate alto, ganhos e perdas de tamanho parecido.",              sl: 5, tp: 6,  compra: 1.5 },
      volatil:     { desc: "Pensado para cripto: dá espaço à volatilidade (SL largo) mas com TP alcançável. Menos SLs prematuros.",  sl: 8, tp: 10, compra: 2.0 },
    };

    const save = () => {
      const finalSettings = { ...local };
      // Deteta mudança do Modo Dinâmico face ao que estava guardado, para registar
      // o evento (liga/desliga) na base de dados — assim a comparação "antes vs
      // depois" fica ancorada em factos e não depende de te lembrares da data.
      const antesRegime = !!currentSettings?.regimeDinamico;
      const depoisRegime = !!finalSettings.regimeDinamico;
      const regimeMudou = antesRegime !== depoisRegime;
      setCurrentSettings(finalSettings);
      setSettingsLocal(null);
      if (user) import("./firebase.js").then(({ saveSetting, logRegimeToggle }) => {
        saveSetting(user.uid, docKey, finalSettings).catch(()=>{});
        if (regimeMudou) {
          const modo = isSimTab ? "sim" : isRealTab ? "real" : "paper";
          logRegimeToggle(user.uid, { estado: depoisRegime, modo }).catch(()=>{});
        }
      });
      const nomeTab = isSimTab ? "simulação" : isRealTab ? "REAL" : "paper";
      toast(`✅ Definições ${nomeTab} guardadas! (Perfil ${finalSettings.riscoPerfil}: SL ${finalSettings.stopLossPadrao}% / TP ${finalSettings.takeProfitPadrao}%)`, "success");
      if (regimeMudou) {
        toast(`📊 Modo Dinâmico ${depoisRegime ? "LIGADO" : "DESLIGADO"} — registado para comparação`, "info");
      }
    };
    const info = perfilInfo[local.riscoPerfil];
    const amountPreview = local.modoValor === "fixo"
      ? local.valorFixo
      : Math.max(10, +(local.capitalTotal * local.percentagem / 100).toFixed(2));

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 820, paddingBottom: 80 }}>

        {/* Mode tabs */}
        <div style={{ display: "flex", gap: 0, background: "rgba(0,0,0,0.3)", borderRadius: 10, overflow: "hidden", width: "fit-content" }}>
          {[["sim","◎ Simulação", T.gold], ["paper","📝 Paper", T.blue], ["real","● Real", T.red]].map(([id, label, col]) => (
            <button key={id} onClick={() => switchTab(id)} style={{
              padding: "10px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer",
              background: defTab===id ? `${col}20` : "transparent",
              color: defTab===id ? col : T.muted,
              border: "none", fontFamily: "inherit",
            }}>{label}</button>
          ))}
        </div>

        {isSimTab && (
          <div style={{ background: `${T.gold}0a`, border: `1px solid ${T.gold}25`, borderRadius: 10, padding: "10px 16px", fontSize: 11, color: T.muted }}>
            ◎ Estas definições aplicam-se apenas à simulação — para praticar sem risco.
          </div>
        )}
        {defTab === "paper" && (
          <div style={{ background: `${T.blue}0a`, border: `1px solid ${T.blue}25`, borderRadius: 10, padding: "10px 16px", fontSize: 11, color: T.muted }}>
            📝 Estas definições aplicam-se ao modo PAPER — trades fictícios na Alpaca. O bot usa-as quando arranca com MODE=paper.
          </div>
        )}
        {isRealTab && (
          <div style={{ background: `${T.red}12`, border: `1px solid ${T.red}40`, borderRadius: 10, padding: "10px 16px", fontSize: 11, color: T.text }}>
            ⚠ <b>DINHEIRO REAL.</b> Estas definições aplicam-se ao modo REAL na Alpaca. O bot só as usa quando arranca com MODE=real. Por defeito são mais conservadoras (teto e nº de posições baixos) — revê antes de ativar real.
          </div>
        )}

        {/* ═══ GRUPO: GERAL ═══ */}
        <div onClick={() => setDefGrupo(g => ({ ...g, geral: !g.geral }))} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", background: defGrupo.geral ? `${T.accent}0c` : T.card, border: `1px solid ${defGrupo.geral ? T.accent + "44" : T.border}`, borderRadius: 14 }}>
          <span style={{ fontSize: 20 }}>⚙️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>Geral</div>
            <div style={{ fontSize: 10.5, color: T.muted, marginTop: 2 }}>O capital total e quanto o bot investe por cada trade. A base de tudo.</div>
          </div>
          <span style={{ fontSize: 13, color: T.muted, transform: defGrupo.geral ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
        </div>

        {/* Capital */}
        {defGrupo.geral && (
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 16 }}>💰 Capital e Valor por Trade</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Capital total disponível (€)</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 8, lineHeight: 1.55 }}>O total que tens para investir. O bot nunca gasta mais do que isto.</div>
              <input key="cap-total" type="number" defaultValue={local.capitalTotal} onChange={e => upd("capitalTotal", +e.target.value)}
                style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: `1px solid ${T.accent}33`, borderRadius: 8, padding: "10px 14px", color: T.text, fontSize: 15, fontWeight: 700, fontFamily: "inherit", outline: "none" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Modo de investimento</div>
              <div style={{ display: "flex", gap: 0, background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                {[["fixo","Valor Fixo (€)"],["percentagem","% da Banca"]].map(([v, l]) => (
                  <button key={v} onClick={() => upd("modoValor", v)} style={{
                    flex: 1, padding: "10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
                    background: local.modoValor === v ? `${T.accent}22` : "transparent",
                    color: local.modoValor === v ? T.aLight : T.muted,
                    border: "none", fontWeight: local.modoValor === v ? 700 : 400,
                  }}>{l}</button>
                ))}
              </div>
              {local.modoValor === "fixo" ? (
                <div>
                  <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>Valor fixo por cada trade (€)</div>
                  <input key="val-fixo" type="number" defaultValue={local.valorFixo} onChange={e => upd("valorFixo", +e.target.value)}
                    style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: `1px solid ${T.accent}33`, borderRadius: 8, padding: "10px 14px", color: T.text, fontSize: 15, fontWeight: 700, fontFamily: "inherit", outline: "none" }} />
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>Percentagem da banca: <b style={{ color: T.aLight }}>{local.percentagem}%</b></div>
                  <input type="range" min={1} max={25} value={local.percentagem} onChange={e => upd("percentagem", +e.target.value)} style={{ width: "100%", accentColor: T.accent }} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.muted, marginTop: 4 }}>
                    <span>1% Conservador</span><span>25% Agressivo</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div style={{ background: `${T.green}0d`, border: `1px solid ${T.green}22`, borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: T.muted }}>💡 Trade típico (confiança média):</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: T.green }}>€{amountPreview}</span>
          </div>
          {/* Regras de dimensionamento — para saberes sempre como o valor é calculado */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.aLight, marginBottom: 8 }}>📐 Como o valor de cada trade é decidido</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.7 }}>
              {local.modoValor === "percentagem" ? (
                <>
                  • Base: <b style={{ color: T.text }}>{local.percentagem}%</b> do saldo disponível.<br/>
                  • Ajustado pela <b style={{ color: T.text }}>confiança da IA</b>: ≥90% → ×2 · ≥80% → ×1,5 · ≥70% → ×1,1 · senão menos.<br/>
                </>
              ) : (
                <>• Valor fixo de <b style={{ color: T.text }}>€{local.valorFixo}</b> por trade.<br/></>
              )}
              • Nunca acima do teto: <b style={{ color: (local.maxValorTrade ?? 100) > 0 ? T.gold : T.text }}>{(local.maxValorTrade ?? 100) > 0 ? `€${local.maxValorTrade ?? 100}` : "sem teto"}</b> por trade <span style={{ opacity: 0.7 }}>(em Limites de Segurança)</span>.<br/>
              • Mínimo de <b style={{ color: T.text }}>€10</b> por trade.<br/>
              • <b style={{ color: T.green }}>Só fecha em lucro</b> se este cobrir as comissões (cripto ~0,5% ida-volta) + margem — evita "ganhos" que na verdade dão prejuízo.
            </div>
          </div>
        </Glass>
        )}
        {defGrupo.geral && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderRadius: 12, background: T.card, border: `1px solid ${T.border}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700 }}>🔗 Ligação ao bot</div>
              <div style={{ fontSize: 9.5, color: T.muted, marginTop: 2 }}>Copia o teu UID para configurares o bot no servidor (Railway).</div>
            </div>
            <button onClick={() => {
              navigator.clipboard?.writeText(user.uid);
              toast(`UID copiado: ${user.uid}`, "success");
            }} style={{
              background: `${T.blue}12`, border: `1px solid ${T.blue}33`, borderRadius: 8,
              padding: "10px 18px", fontSize: 11, color: T.blue, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, whiteSpace: "nowrap",
            }}>📋 Copiar UID</button>
          </div>
        )}
        {!isSimTab && (
        <div onClick={() => setDefGrupo(g => ({ ...g, ai: !g.ai }))} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", background: defGrupo.ai ? `${T.gold}0c` : T.card, border: `1px solid ${defGrupo.ai ? T.gold + "44" : T.border}`, borderRadius: 14 }}>
          <span style={{ fontSize: 20 }}>⚡</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>Trading Ativo (AI Brain)</div>
            <div style={{ fontSize: 10.5, color: T.muted, marginTop: 2 }}>Tudo o que controla o trading ativo com IA: perfil de risco, ajustes, limites e automação. Só afeta o sistema se ligares o AI Brain lá dentro. Se só usas DCA, podes ignorar este grupo.</div>
          </div>
          <span style={{ fontSize: 13, color: T.muted, transform: defGrupo.ai ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
        </div>
        )}

        {/* Perfil de risco */}
        {!isSimTab && defGrupo.ai && (<>
        {/* Botão: aplicar configuração recomendada do AI Brain (começar seguro) */}
        {!isSimTab && (
          <div style={{ background: `${T.green}0c`, border: `1px solid ${T.green}33`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: T.green }}>✨ Configuração recomendada</div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 3, lineHeight: 1.5 }}>Aplica valores seguros para começar: perfil Moderado, confiança 82%, trailing e take-profit parcial ligados, posições pequenas. Podes afinar depois.</div>
            </div>
            <button onClick={() => setConfirmModal({
              title: "Aplicar configuração recomendada?",
              message: "Vai definir os parâmetros do AI Brain para valores seguros de arranque:",
              lines: ["Perfil Moderado (SL 6% · TP 12%)", "Confiança mínima 82%", "Trailing Stop 4% ligado", "Take-profit parcial 60% ligado", "Máx. 3 posições AI · €50/trade", "Modo dinâmico ligado", "Análise a cada 15 min"],
              icon: "✨", confirmLabel: "Aplicar",
              onConfirm: () => {
                setLocal(prev => ({ ...(prev || currentSettings),
                  riscoPerfil: "moderado", stopLossPadrao: 6, takeProfitPadrao: 12,
                  aiBrainConfianca: 82, trailingStop: true, trailingStopPct: 4,
                  aiExitOnFlip: true, scaleOutTP: true, scaleOutPct: 60,
                  maxAiBrain: 3, maxValorTrade: 50, maxPosicoesTotal: 40,
                  regimeDinamico: true, rotacaoAtiva: false, aiSignalsMin: 15,
                  aiManualSugestao: true,
                }));
                setConfirmModal(null);
                toast("✨ Configuração recomendada aplicada — revê e carrega em Guardar", "success");
              },
            })} style={{ background: T.gradGreen, border: "none", borderRadius: 10, padding: "11px 20px", fontSize: 12, fontWeight: 800, color: "#04120c", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              ✨ Aplicar recomendada
            </button>
          </div>
        )}
        {/* ── AI Brain (mestre) + fontes — no topo do grupo, é a chave de tudo ── */}
        {!isSimTab && (() => {
          const setFlag = (key, v) => {
            const novo = { ...currentSettings, [key]: v };
            setCurrentSettings(novo);
            if (user) import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
          };
          const mestre = !!currentSettings.aiBrainMestre;
          const Toggle = ({ on, onClick, disabled, cor }) => (
            <div onClick={() => !disabled && onClick()} style={{ cursor: disabled ? "not-allowed" : "pointer", flexShrink: 0, opacity: disabled ? 0.4 : 1 }}>
              <div style={{ width: 44, height: 24, borderRadius: 12, background: on ? (cor || T.gold) : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                <div style={{ position: "absolute", top: 3, left: on ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
              </div>
            </div>
          );
          const fontes = [
            { key: "aiEstrategias",    icon: "📊", nome: "Estratégias",       desc: "As tuas estratégias compram/vendem sozinhas, com os SL/TP do perfil." },
            { key: "aiManualAutonomo", icon: "🤖", nome: "Compras autónomas",  desc: "O Cérebro AI decide e compra sozinho, nos sinais de alta confiança." },
            { key: "aiDayTrading",     icon: "⚡", nome: "Day Trading",        desc: "Scalping rápido com IA, usando os SL/TP que definires abaixo." },
          ];
          return (
            <div style={{ padding: "18px 20px", borderRadius: 12, border: `1px solid ${mestre ? T.gold + "44" : T.border}`, background: mestre ? `${T.gold}08` : T.card }}>
              <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6, marginBottom: 16 }}>
                O <b>AI Brain</b> é a chave-mestra: liga-o para desbloquear as fontes de trading ativo. Cada fonte corre em paralelo com o DCA, numa fatia separada do capital. Com o AI Brain desligado, só o DCA passivo funciona.
              </div>
              {/* Mestre */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 8, background: `${T.gold}0c`, border: `1px solid ${T.gold}33`, marginBottom: 14 }}>
                <span style={{ fontSize: 20 }}>🧠</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>AI Brain (mestre)</div>
                  <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.4 }}>Desbloqueia o trading ativo. Desligado = só DCA.</div>
                </div>
                <Toggle on={mestre} onClick={() => { const v = !mestre; setFlag("aiBrainMestre", v); toast(v ? "🧠 AI Brain ligado — fontes desbloqueadas" : "💤 AI Brain desligado — só DCA", v ? "info" : "success"); }} />
              </div>
              {/* Sub-fontes (só disponíveis com o mestre on) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, opacity: mestre ? 1 : 0.5 }}>
                {fontes.map(f => (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 17 }}>{f.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{f.nome}</div>
                      <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.4 }}>{f.desc}</div>
                    </div>
                    <Toggle on={mestre && !!currentSettings[f.key]} disabled={!mestre} onClick={() => setFlag(f.key, !currentSettings[f.key])} />
                  </div>
                ))}
                {/* Sugestão a pedido — independente, não executa nada */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 17 }}>💡</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>Sugestão da IA a pedido</div>
                    <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.4 }}>A IA dá opinião quando TU pedes, antes de comprares. Não executa nada. Funciona mesmo sem o AI Brain.</div>
                  </div>
                  <Toggle on={!!currentSettings.aiManualSugestao} cor={T.blue} onClick={() => setFlag("aiManualSugestao", !currentSettings.aiManualSugestao)} />
                </div>
              </div>
              {!mestre && (
                <div style={{ fontSize: 9.5, color: T.muted, marginTop: 12, fontStyle: "italic" }}>Liga o AI Brain acima para poderes activar estas fontes.</div>
              )}
            </div>
          );
        })()}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 16 }}>🎯 Perfil de Risco</div>
          <div className="resp-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { id: "conservador", emoji: "🛡️", label: "Conservador",  desc: "Menos trades, mais seguros" },
              { id: "moderado",    emoji: "⚖️", label: "Moderado",     desc: "Equilíbrio geral"           },
              { id: "agressivo",   emoji: "🚀", label: "Agressivo",    desc: "Mais trades, mais risco"    },
              { id: "scalper",     emoji: "🎯", label: "Scalper",      desc: "Alvos curtos, win rate alto"},
              { id: "equilibrado", emoji: "⚡", label: "Equilibrado",  desc: "Rácio risco/ganho 1:1"      },
              { id: "volatil",     emoji: "🌊", label: "Cripto Volátil",desc: "Espaço à volatilidade"     },
            ].map(p => (
              <div key={p.id} onClick={() => {
                const pi = perfilInfo[p.id];
                setLocal(prev => ({ ...prev, riscoPerfil: p.id, stopLossPadrao: pi.sl, takeProfitPadrao: pi.tp }));
              }} style={{
                padding: "14px", borderRadius: 12, cursor: "pointer",
                background: local.riscoPerfil === p.id ? `${perfilC(p.id)}18` : "rgba(255,255,255,0.03)",
                border: `2px solid ${local.riscoPerfil === p.id ? perfilC(p.id) : T.border}`,
                textAlign: "center", transition: "all 0.15s",
              }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>{p.emoji}</div>
                <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 3 }}>{p.label}</div>
                <div style={{ fontSize: 10, color: T.muted }}>{p.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 10, lineHeight: 1.6 }}>{info.desc}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
              {[
                { l: "Stop Loss padrão",  v: `${info.sl}%`,     c: T.red   },
                { l: "Take Profit padrão",v: `${info.tp}%`,     c: T.green },
                { l: "Queda p/ comprar",  v: `${info.compra}%`, c: T.gold  },
              ].map(item => (
                <div key={item.l}>
                  <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>{item.l}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: item.c }}>{item.v}</div>
                </div>
              ))}
            </div>
          </div>
        </Glass>

        {/* Ajuste por categoria de ativo */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 6 }}>🎚 Ajuste por Tipo de Ativo</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 16, lineHeight: 1.6 }}>
            Multiplica o SL/TP/queda do perfil conforme a volatilidade de cada classe. <b>1.0×</b> = igual ao perfil.
            Crypto mexe muito (valores mais largos); forex pouco (mais apertados). Aplica-se ao bot.
          </div>
          {[
            { cat: "Crypto",    emoji: "₿",  hint: "BTC, ETH, SOL, XRP…" },
            { cat: "Commodity", emoji: "🛢", hint: "Petróleo, ouro, prata" },
            { cat: "ETF",       emoji: "📈", hint: "SPY, QQQ, GLD…" },
            { cat: "Forex",     emoji: "💱", hint: "EUR/USD, GBP/USD…" },
            { cat: "Ação",      emoji: "🏢", hint: "ações individuais (futuro)" },
          ].map(({ cat, emoji, hint }) => {
            const ca = local.catAjuste || {};
            const val = typeof ca[cat] === "number" ? ca[cat] : 1.0;
            const slEf = +(local.stopLossPadrao * val).toFixed(1);
            const tpEf = +(local.takeProfitPadrao * val).toFixed(1);
            return (
              <div key={cat} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ width: 130, flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{emoji} {cat}</div>
                  <div style={{ fontSize: 9, color: T.muted }}>{hint}</div>
                </div>
                <input type="range" min={0.2} max={2.5} step={0.1} value={val}
                  onChange={e => { const v = +e.target.value; setLocal(prev => ({ ...prev, catAjuste: { ...(prev.catAjuste||{}), [cat]: v } })); }}
                  style={{ flex: 1, accentColor: T.aLight }} />
                <div style={{ width: 46, textAlign: "right", fontSize: 14, fontWeight: 700, color: T.aLight }}>{val.toFixed(1)}×</div>
                <div style={{ width: 120, textAlign: "right", fontSize: 10, color: T.muted }}>
                  SL <span style={{ color: T.red }}>{slEf}%</span> · TP <span style={{ color: T.green }}>{tpEf}%</span>
                </div>
              </div>
            );
          })}
        </Glass>

        {/* Valor e teto por origem */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 6 }}>💶 Valor e Teto por Origem</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 16, lineHeight: 1.6 }}>
            Define o valor (€) e o teto (€) por trade de cada origem. <b>0 = herda o global</b> (valor fixo €{local.valorFixo ?? 50} · teto €{local.maxValorTrade ?? 100}).
            Permite, por ex., estratégias €50, Cérebro AI €30, day-trade €20.
          </div>
          {[
            { k: "estrategias", l: "🎯 Estratégias", c: T.blue },
            { k: "aibrain",     l: "🤖 Cérebro AI",  c: T.accent },
            { k: "daytrading",  l: "⚡ Day Trading",  c: T.gold },
            { k: "manual",      l: "✋ Manuais",      c: T.muted },
          ].map(({ k, l, c }) => {
            const po = (local.perOrigem || {})[k] || { valorFixo: 0, maxValorTrade: 0 };
            const setPO = (field, v) => setLocal(prev => {
              const base = prev.perOrigem || {};
              const cur  = base[k] || { valorFixo: 0, maxValorTrade: 0 };
              return { ...prev, perOrigem: { ...base, [k]: { ...cur, [field]: v } } };
            });
            return (
              <div key={k} style={{ padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: c, marginBottom: 8 }}>{l}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 9, color: T.muted, marginBottom: 4 }}>VALOR €/TRADE {po.valorFixo > 0 ? "" : "(global)"}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="range" min={0} max={500} step={5} value={po.valorFixo || 0} onChange={e => setPO("valorFixo", +e.target.value)} style={{ flex: 1, accentColor: c }} />
                      <div style={{ fontSize: 13, fontWeight: 700, color: po.valorFixo > 0 ? c : T.muted, minWidth: 52, textAlign: "right" }}>{po.valorFixo > 0 ? `€${po.valorFixo}` : "auto"}</div>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: T.muted, marginBottom: 4 }}>TETO €/TRADE {po.maxValorTrade > 0 ? "" : "(global)"}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="range" min={0} max={1000} step={10} value={po.maxValorTrade || 0} onChange={e => setPO("maxValorTrade", +e.target.value)} style={{ flex: 1, accentColor: c }} />
                      <div style={{ fontSize: 13, fontWeight: 700, color: po.maxValorTrade > 0 ? c : T.muted, minWidth: 52, textAlign: "right" }}>{po.maxValorTrade > 0 ? `€${po.maxValorTrade}` : "global"}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </Glass>

        {/* Limites */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 6 }}>🔒 Limites de Segurança</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 16, lineHeight: 1.6 }}>Proteções automáticas. O bot para se estes limites forem atingidos.</div>
          {/* Limites de posições por tipo */}
          <div style={{ fontSize: 11, color: T.aLight, fontWeight: 700, marginBottom: 10 }}>Máximo de posições abertas por tipo</div>
          <div className="resp-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 16 }}>
            {[
              { k: "maxManuais",     l: "✋ Manuais",     desc: "Compras tuas em Mercados", max: 20, def: 5 },
              { k: "maxEstrategias", l: "🎯 Estratégias", desc: "Trades automáticos das estratégias", max: 20, def: 5 },
              { k: "maxAiBrain",     l: "🤖 Cérebro AI",  desc: "Posições abertas pela IA (separado das estratégias)", max: 15, def: 3 },
              { k: "maxDayTrading",  l: "⚡ Day Trading",  desc: "Scalping rápido", max: 50, def: 5 },
            ].map(f => (
              <div key={f.k} style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>{f.l}</div>
                <div style={{ fontSize: 9, color: T.muted, marginBottom: 10, lineHeight: 1.4 }}>{f.desc}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="range" min={1} max={f.max} value={local[f.k] ?? f.def} onChange={e => upd(f.k, +e.target.value)} style={{ flex: 1, accentColor: T.accent }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.aLight, minWidth: 24, textAlign: "right" }}>{local[f.k] ?? f.def}</div>
                </div>
              </div>
            ))}
          </div>
          {/* SL/TP */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            {[
              { k: "stopLossPadrao",   l: "Stop Loss padrão (%)",   desc: "Vende se preço cair esta percentagem",  min: 1, max: 30 },
              { k: "takeProfitPadrao", l: "Take Profit padrão (%)", desc: "Vende se preço subir esta percentagem", min: 2, max: 50 },
            ].map(f => (
              <div key={f.k} style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{f.l}</div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>{f.desc}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="range" min={f.min} max={f.max} value={local[f.k]} onChange={e => upd(f.k, +e.target.value)} style={{ flex: 1, accentColor: T.accent }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.aLight, minWidth: 38, textAlign: "right" }}>{local[f.k]}%</div>
                </div>
              </div>
            ))}
          </div>
          {/* Controlo de risco: teto € por trade + limite global de posições */}
          <div style={{ fontSize: 11, color: T.aLight, fontWeight: 700, marginBottom: 10 }}>Controlo de risco (aplica-se ao bot)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>💶 Máximo por trade (€)</div>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>Teto absoluto por posição, mesmo com saldo grande (ex.: paper $100k). A % continua a valer abaixo deste teto. <b>0 = sem teto</b> (só a %).</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="range" min={0} max={1000} step={10} value={local.maxValorTrade ?? 100} onChange={e => upd("maxValorTrade", +e.target.value)} style={{ flex: 1, accentColor: T.accent }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: T.aLight, minWidth: 56, textAlign: "right" }}>{(local.maxValorTrade ?? 100) > 0 ? `€${local.maxValorTrade ?? 100}` : "—"}</div>
              </div>
            </div>
            <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>📊 Máximo de posições abertas (total)</div>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>Limite global de posições abertas ao mesmo tempo (todas as origens). Impede centenas de entradas. <b>0 = sem limite</b>.</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="range" min={0} max={100} step={5} value={local.maxPosicoesTotal ?? 40} onChange={e => upd("maxPosicoesTotal", +e.target.value)} style={{ flex: 1, accentColor: T.accent }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: T.aLight, minWidth: 32, textAlign: "right" }}>{(local.maxPosicoesTotal ?? 40) > 0 ? (local.maxPosicoesTotal ?? 40) : "—"}</div>
              </div>
            </div>
          </div>
          {/* Auto-investir + Rotação */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={{ background: `${T.accent}0a`, border: `1px solid ${T.accent}22`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Auto-Investir com AI</div>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>As tuas estratégias ativas operam sozinhas, mesmo sem carregares em "Começar" na simulação.</div>
              <div onClick={() => upd("autoInvestir", !local.autoInvestir)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: local.autoInvestir ? T.green : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: local.autoInvestir ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
                <span style={{ fontSize: 12, color: local.autoInvestir ? T.green : T.muted, fontWeight: 700 }}>{local.autoInvestir ? "ATIVADO" : "Desativado"}</span>
              </div>
            </div>
            <div style={{ background: `${T.gold}0a`, border: `1px solid ${T.gold}22`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>🔄 Rotação de Posições</div>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>Quando o limite está cheio, vende a posição com mais lucro para abrir outra melhor.</div>
              <div onClick={() => {
                if (!local.rotacaoAtiva) {
                  // Ativar → mostrar aviso
                  setConfirmModal({
                    danger: true,
                    icon: "🔄",
                    title: "Ativar Rotação de Posições?",
                    message: "Esta é uma estratégia avançada e arriscada. Lê com atenção:",
                    lines: [
                      "Vais trocar lucro REAL e garantido por lucro HIPOTÉTICO",
                      "A 'vantagem' da nova posição é uma previsão, não um facto",
                      "Cortar vencedores cedo é um erro comum que destrói contas",
                      "Em modo real, cada troca gera custos (spread/comissões)",
                      "Recomendado: testa em simulação e compara com o modo normal",
                    ],
                    confirmLabel: "Percebo o risco, ativar",
                    onConfirm: () => upd("rotacaoAtiva", true),
                  });
                } else {
                  upd("rotacaoAtiva", false);
                }
              }} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: local.rotacaoAtiva ? T.gold : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: local.rotacaoAtiva ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
                <span style={{ fontSize: 12, color: local.rotacaoAtiva ? T.gold : T.muted, fontWeight: 700 }}>{local.rotacaoAtiva ? "ATIVADA" : "Desativada"}</span>
              </div>
            </div>
            {(() => {
              // Toggle do Modo Dinâmico por regime de mercado. Mostra também o
              // regime atual lido do bot (alta/neutro/baixa) e o que está a fazer.
              const reg = botStatus?.regime;
              const estado = reg?.estado || "—";
              const corReg = estado === "baixa" ? T.red : estado === "alta" ? T.green : T.gold;
              const rotulo = { alta: "🔼 ALTA", neutro: "➖ NEUTRO", baixa: "🔻 BAIXA" }[estado] || "—";
              return (
              <div style={{ background: `${T.accent}0a`, border: `1px solid ${T.accent}22`, borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>📊 Modo Dinâmico (regime de mercado)</div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>
                  Reduz automaticamente a exposição (menos posições, menor valor) e exige mais confiança quando o mercado está em queda. Deteta o regime por BTC + SPY vs média de 50 dias. Nunca aumenta além dos teus limites.
                </div>
                <div onClick={() => {
                  if (!local.regimeDinamico) {
                    setConfirmModal({
                      icon: "📊",
                      title: "Ativar Modo Dinâmico?",
                      message: "O bot vai ajustar a exposição automaticamente conforme o regime de mercado:",
                      lines: [
                        "Em mercado de BAIXA: metade das posições, 60% do valor, +8% de confiança exigida",
                        "Em mercado NEUTRO: ligeira cautela (80% das posições)",
                        "Em mercado de ALTA: usa os teus limites normais",
                        "Não mexe nos teus SL/TP — só na exposição",
                        "Podes desligar a qualquer momento e voltar aos limites fixos",
                      ],
                      confirmLabel: "Ativar modo dinâmico",
                      onConfirm: () => upd("regimeDinamico", true),
                    });
                  } else {
                    upd("regimeDinamico", false);
                  }
                }} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div style={{ width: 44, height: 24, borderRadius: 12, background: local.regimeDinamico ? T.accent : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                    <div style={{ position: "absolute", top: 3, left: local.regimeDinamico ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                  </div>
                  <span style={{ fontSize: 12, color: local.regimeDinamico ? T.accent : T.muted, fontWeight: 700 }}>{local.regimeDinamico ? "ATIVADO" : "Desativado"}</span>
                </div>
                {local.regimeDinamico && reg && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, color: T.muted }}>Regime atual:</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: corReg }}>{rotulo}</span>
                  </div>
                )}
                {local.regimeDinamico && reg?.detalhe && (
                  <div style={{ fontSize: 9, color: T.muted, marginTop: 4, lineHeight: 1.4 }}>{reg.detalhe}</div>
                )}
              </div>
              );
            })()}
          </div>
        </Glass>

        {/* ── Automação Avançada com IA ── */}
        <Glass style={{ padding: "22px 24px", background: `${T.accent}06`, border: `1px solid ${T.accent}22` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 4 }}>🤖 Automação Avançada com IA</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 18, lineHeight: 1.55 }}>
            A IA decide compras e vendas com base nos seus próprios sinais de mercado.
            Funciona com a simulação iniciada ou com o Auto-Investir ligado.
          </div>

          {/* ── Monitor de consumo de IA (Groq) ── */}
          {(() => {
            const LIMITE_DIA = 100000; // limite diário tokens (plano gratuito Groq)
            const usado = groqTokens;
            const pct = Math.min(100, (usado / LIMITE_DIA) * 100);
            const cor = pct >= 85 ? T.red : pct >= 60 ? T.gold : T.green;
            // estimativa de tokens/scan e quantos scans restam
            const porScan = 900; // ~tokens por scan com modelo 8b
            const restantes = Math.max(0, Math.floor((LIMITE_DIA - usado) / porScan));
            return (
              <div style={{ background: "rgba(0,0,0,0.22)", borderRadius: 10, padding: "16px 18px", marginBottom: 14, border: `1px solid ${cor}22` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>📊 Consumo de IA (Groq) — esta sessão</div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: cor }}>{pct.toFixed(1)}%</span>
                </div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>
                  Tokens contados desde que abriste a app. O limite gratuito da Groq é {(LIMITE_DIA/1000).toFixed(0)}k tokens/dia (partilhado entre app e bot).
                </div>
                <div style={{ height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 99, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: cor, borderRadius: 99, transition: "width 0.3s" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.muted }}>
                  <span>{usado.toLocaleString("pt-PT")} tokens usados</span>
                  <span>~{restantes} scans restantes hoje</span>
                </div>
                {pct >= 85 && (
                  <div style={{ fontSize: 10, color: T.red, marginTop: 8 }}>
                    ⚠ Estás perto do limite diário. Aumenta o intervalo da análise AI abaixo, ou aguarda a meia-noite UTC para reiniciar.
                  </div>
                )}
                <div style={{ fontSize: 9, color: T.muted, marginTop: 8, fontStyle: "italic" }}>
                  Nota: este contador mede só o que a app consome. O consumo do bot 24/7 vê-se no painel da Groq em console.groq.com.
                </div>
              </div>
            );
          })()}

          {/* Cérebro AI */}
          <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "16px 18px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Cérebro AI — entrada autónoma</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Compra sozinho quando a IA dá sinal de COMPRAR com confiança suficiente.</div>
              </div>
              <div onClick={() => upd("aiBrain", !local.aiBrain)} style={{ cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: local.aiBrain ? T.accent : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: local.aiBrain ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
              </div>
            </div>
            {local.aiBrain && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>
                  Confiança mínima para agir: <b style={{ color: T.aLight }}>{local.aiBrainConfianca}%</b>
                </div>
                <input type="range" min={60} max={95} value={local.aiBrainConfianca}
                  onChange={e => upd("aiBrainConfianca", +e.target.value)} style={{ width: "100%", accentColor: T.accent }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.muted, marginTop: 4 }}>
                  <span>60% · mais trades, mais risco</span><span>95% · só sinais fortes</span>
                </div>
              </div>
            )}
          </div>

          {/* Trailing stop */}
          <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "16px 18px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>🔒 Trailing Stop — proteger lucros</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>O stop-loss sobe atrás do preço quando estás em lucro, travando ganhos sem cortar cedo demais.</div>
              </div>
              <div onClick={() => upd("trailingStop", !local.trailingStop)} style={{ cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: local.trailingStop ? T.green : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: local.trailingStop ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
              </div>
            </div>
            {local.trailingStop && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>
                  Distância do trailing: <b style={{ color: T.aLight }}>{local.trailingStopPct}%</b> abaixo do pico
                </div>
                <input type="range" min={1} max={12} value={local.trailingStopPct}
                  onChange={e => upd("trailingStopPct", +e.target.value)} style={{ width: "100%", accentColor: T.green }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.muted, marginTop: 4 }}>
                  <span>1% · trava cedo</span><span>12% · dá mais espaço</span>
                </div>
              </div>
            )}
          </div>

          {/* Saída por flip da IA */}
          <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>↩ Sair quando a IA muda de opinião</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Fecha a posição em lucro se a IA passar a sinal de VENDER com alta confiança.</div>
              </div>
              <div onClick={() => upd("aiExitOnFlip", !local.aiExitOnFlip)} style={{ cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: local.aiExitOnFlip ? T.blue : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: local.aiExitOnFlip ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
              </div>
            </div>
          </div>

          {/* Take-profit parcial (scale-out) */}
          <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "16px 18px", marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>📊 Take-profit parcial — deixar correr</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Ao atingir o TP, vende uma parte e deixa o resto correr com o stop em break-even. Captura lucro mas mantém o potencial. Só cripto.</div>
              </div>
              <div onClick={() => upd("scaleOutTP", !local.scaleOutTP)} style={{ cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: local.scaleOutTP ? T.green : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: local.scaleOutTP ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
              </div>
            </div>
            {local.scaleOutTP && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>Vender no TP: <b style={{ color: T.green }}>{local.scaleOutPct ?? 50}%</b> · o resto corre</div>
                <input type="range" min={10} max={90} step={10} value={local.scaleOutPct ?? 50}
                  onChange={e => upd("scaleOutPct", +e.target.value)}
                  style={{ width: "100%", accentColor: T.green }} />
              </div>
            )}
          </div>

          {/* Intervalo dos sinais AI — controla o consumo de tokens da Groq */}
          <div style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "16px 18px", marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>⏱ Frequência da análise AI</div>
            <div style={{ fontSize: 10, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>
              De quanto em quanto tempo o bot analisa o mercado com a IA. Intervalos maiores poupam tokens da Groq (evita o limite diário). Aplica-se ao bot 24/7.
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>
              A cada <b style={{ color: T.aLight }}>{local.aiSignalsMin} min</b>
              {local.aiSignalsMin <= 5 && <span style={{ color: T.red }}> · consumo alto</span>}
              {local.aiSignalsMin >= 6 && local.aiSignalsMin <= 14 && <span style={{ color: T.gold }}> · consumo médio</span>}
              {local.aiSignalsMin >= 15 && <span style={{ color: T.green }}> · consumo baixo (recomendado)</span>}
            </div>
            <input type="range" min={3} max={60} step={1} value={local.aiSignalsMin}
              onChange={e => upd("aiSignalsMin", +e.target.value)} style={{ width: "100%", accentColor: T.accent }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.muted, marginTop: 4 }}>
              <span>3 min · reação rápida, gasta muito</span><span>60 min · muito económico</span>
            </div>
          </div>
        </Glass>
        </>)}
        {/* ═══ FIM GRUPO AI ═══ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center" }}>
          {/* Limpar simulações */}
          {simMode && (
          <button onClick={() => setConfirmModal({
            danger: true,
            icon: "🗑",
            title: "Apagar todas as simulações?",
            message: "Vais apagar todo o histórico e posições simuladas e reiniciar com o capital configurado.",
            lines: ["Esta ação é irreversível", "As posições abertas serão fechadas", "As estratégias ativas serão apagadas", "Os trades de Day Trading serão apagados", "O saldo volta ao capital inicial"],
            confirmLabel: "Sim, apagar tudo",
            onConfirm: () => {
              if (!simMode) { toast("Limpar só está disponível em Simulação", "error"); return; }
              const tradesToDelete = [...simPositions, ...simClosed];
              const stratsToDelete = strategies.map(s => s.id);
              setArchivedSims([]);
              setSimClosed([]);
              setSimPositions([]);
              simPosRef.current = [];
              setSimBalance(simCapital);
              simBalRef.current = simCapital;
              setSimStartedAt(null);
              setStrategies([]);
              stratRef.current = [];
              // Limpar Day Trading
              setDtTrades([]);
              setDtDailyPnl(0);
              setDtScanResult(null);
              setDtActive(false);
              // Apagar TUDO do Firestore (senão o bot recarrega)
              if (user) import("./firebase.js").then(({ saveSetting, deleteStrategy, deleteTrade }) => {
                saveSetting(user.uid, "archivedSims", []).catch(()=>{});
                saveSetting(user.uid, "simBalance", simCapital).catch(()=>{});
                saveSetting(user.uid, "dtState", { trades: [], dailyPnl: 0 }).catch(()=>{});
                stratsToDelete.forEach(id => deleteStrategy(user.uid, id).catch(()=>{}));
                tradesToDelete.forEach(t => deleteTrade(user.uid, t.id).catch(()=>{}));
              });
              toast("🗑 Tudo apagado e reiniciado!", "success");
            },
          })} style={{
            background: `${T.red}12`, border: `1px solid ${T.red}33`, borderRadius: 8,
            padding: "10px 18px", fontSize: 12, color: T.red, cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
          }}>🗑 Limpar Simulações</button>
          )}
          </div>

          {/* ═══ GRUPO: DCA ═══ */}
          {!isSimTab && (
          <div onClick={() => setDefGrupo(g => ({ ...g, dca: !g.dca }))} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", background: defGrupo.dca ? `${T.green}0c` : T.card, border: `1px solid ${defGrupo.dca ? T.green + "44" : T.border}`, borderRadius: 14 }}>
            <span style={{ fontSize: 20 }}>🎯</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>DCA — o teu núcleo</div>
              <div style={{ fontSize: 10.5, color: T.muted, marginTop: 2 }}>As compras regulares e automáticas dos teus planos. O travão de emergência, as notificações e o modo férias. É a parte que estás a usar.</div>
            </div>
            <span style={{ fontSize: 13, color: T.muted, transform: defGrupo.dca ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
          </div>
          )}
          {!isSimTab && defGrupo.dca && (<>
          {/* ── DCA: travão de emergência (desligar o núcleo passivo) ── */}
          {!isSimTab && (() => {
            const setDca = (v) => {
              const novo = { ...currentSettings, dcaAtivo: v };
              setCurrentSettings(novo);
              if (user) import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
              toast(v ? "🎯 DCA religado — compras automáticas retomadas" : "⏸ DCA pausado — sem novas compras automáticas", v ? "success" : "warn");
            };
            const on = currentSettings.dcaAtivo !== false;
            return (
              <div style={{ marginTop: 8, padding: "16px 20px", borderRadius: 10, border: `1px solid ${on ? T.green + "33" : T.gold + "44"}`, background: on ? `${T.green}08` : `${T.gold}08` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 20 }}>🎯</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>DCA (núcleo passivo)</div>
                    <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
                      {on ? "Ligado — as compras automáticas dos teus planos correm normalmente." : "⏸ Pausado — nenhuma compra automática vai acontecer até religares. As posições atuais mantêm-se."}
                    </div>
                    <div style={{ fontSize: 9.5, color: T.gold, marginTop: 4 }}>Travão de emergência: usa-o se notares algo errado em live. Pausa só as compras novas, não vende nada.</div>
                  </div>
                  <div onClick={() => setDca(!on)} style={{ cursor: "pointer", flexShrink: 0 }}>
                    <div style={{ width: 44, height: 24, borderRadius: 12, background: on ? T.green : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                      <div style={{ position: "absolute", top: 3, left: on ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── Notificações DCA (opt-in): alerta de queda + resumo mensal ── */}
          {!isSimTab && (() => {
            const setFlag = (key, v) => {
              const novo = { ...currentSettings, [key]: v };
              setCurrentSettings(novo);
              if (user) import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
            };
            const Toggle = ({ on, onClick }) => (
              <div onClick={onClick} style={{ cursor: "pointer", flexShrink: 0 }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: on ? T.green : "rgba(255,255,255,0.1)", position: "relative", transition: "all 0.2s" }}>
                  <div style={{ position: "absolute", top: 3, left: on ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                </div>
              </div>
            );
            const queda = !!currentSettings.dcaAlertaQueda;
            const resumo = !!currentSettings.dcaResumoMensal;
            return (
              <div style={{ marginTop: 8, padding: "16px 20px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.card }}>
                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 12 }}>🔔 Notificações DCA (Telegram)</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <span style={{ fontSize: 18 }}>📉</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>Alerta de compra em queda</div>
                    <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.5 }}>Avisa-te quando um ativo cai bastante abaixo do teu preço médio — oportunidade para reforçares.</div>
                  </div>
                  <Toggle on={queda} onClick={() => setFlag("dcaAlertaQueda", !queda)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 18 }}>📅</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>Resumo mensal</div>
                    <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.5 }}>No início de cada mês, recebes um balanço dos teus planos: investido, valor atual e P&L.</div>
                  </div>
                  <Toggle on={resumo} onClick={() => setFlag("dcaResumoMensal", !resumo)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 18 }}>⏰</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>Lembrete diário de aporte</div>
                    <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.5 }}>Para planos manuais: lembra-te todos os dias de investir, até confirmares na app. A app conta o que está em atraso.</div>
                  </div>
                  <Toggle on={!!currentSettings.dcaLembretes} onClick={() => setFlag("dcaLembretes", !currentSettings.dcaLembretes)} />
                </div>
              </div>
            );
          })()}

          {/* ── Modo férias: pausa o DCA até uma data, retoma sozinho ── */}
          {!isSimTab && (() => {
            const setVal = (v) => {
              const novo = { ...currentSettings, dcaPausadoAte: v };
              setCurrentSettings(novo);
              if (user) import("./firebase.js").then(({ saveSetting }) => saveSetting(user.uid, docKey, novo).catch(() => {}));
            };
            const pausadoAte = currentSettings.dcaPausadoAte;
            const ativo = pausadoAte && Number(pausadoAte) > Date.now();
            return (
              <div style={{ marginTop: 8, padding: "16px 20px", borderRadius: 10, border: `1px solid ${ativo ? T.gold + "44" : T.border}`, background: ativo ? `${T.gold}08` : T.card }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 18 }}>🏖️</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>Modo férias</div>
                    <div style={{ fontSize: 9.5, color: T.muted, lineHeight: 1.5 }}>
                      {ativo
                        ? `DCA pausado até ${new Date(Number(pausadoAte)).toLocaleDateString("pt-PT")}. Retoma sozinho nessa data.`
                        : "Pausa as compras DCA até uma data (ex.: meses sem rendimento). Retoma automaticamente."}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="date" min={new Date(Date.now() + 864e5).toISOString().split("T")[0]}
                    value={ativo ? new Date(Number(pausadoAte)).toISOString().split("T")[0] : ""}
                    onChange={(e) => { if (e.target.value) setVal(new Date(e.target.value).getTime()); }}
                    style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(0,0,0,0.3)", color: T.aLight, fontSize: 12, fontFamily: "inherit" }} />
                  {ativo && (
                    <button onClick={() => setVal(null)} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.green}44`, background: `${T.green}15`, color: T.green, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      Retomar agora
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          </>)}
          {/* ═══ FIM GRUPO DCA ═══ */}

          {/* (bloco AI Brain mestre movido para o topo do grupo Trading Ativo) */}

          {/* ═══ GRUPO: ZONA DE PERIGO ═══ */}
          {!isSimTab && (
          <div onClick={() => setDefGrupo(g => ({ ...g, perigo: !g.perigo }))} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer", background: defGrupo.perigo ? `${T.red}0c` : T.card, border: `1px solid ${defGrupo.perigo ? T.red + "44" : T.border}`, borderRadius: 14 }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>Zona de perigo</div>
              <div style={{ fontSize: 10.5, color: T.muted, marginTop: 2 }}>Recomeçar do zero: apaga trades, posições e histórico. Ações permanentes.</div>
            </div>
            <span style={{ fontSize: 13, color: T.muted, transform: defGrupo.perigo ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
          </div>
          )}
          {!isSimTab && defGrupo.perigo && (<>
          {/* ── Zona de perigo: recomeço de raiz (limpa a BD no servidor) ── */}
          {!isSimTab && (
            <div style={{ marginTop: 8, padding: "16px 18px", borderRadius: 10, border: `1px solid ${T.red}33`, background: `${T.red}08` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.red, marginBottom: 4 }}>⚠️ Zona de perigo</div>
              <div style={{ fontSize: 10.5, color: T.muted, lineHeight: 1.6, marginBottom: 12 }}>
                Limpar tudo apaga <b>todos os trades, posições, histórico e estatísticas</b> e repõe o saldo ao capital inicial.
                As tuas definições e o plano DCA <b>mantêm-se</b>. Útil para recomeçar do zero — como uma conta nova.
                Esta ação é <b>permanente</b> e não pode ser desfeita.
              </div>
              <button onClick={() => setConfirmModal({
                icon: "🧹",
                title: "Limpar toda a base de dados?",
                message: "Vais apagar permanentemente, no servidor:",
                lines: [
                  "Todas as posições abertas e fechadas",
                  "Todo o histórico e arquivos diários",
                  "Todas as estatísticas",
                  "Todas as estratégias de trading",
                  "O saldo volta ao capital inicial",
                  "As definições e o plano DCA mantêm-se",
                ],
                confirmLabel: "Sim, limpar tudo",
                danger: true,
                onConfirm: () => {
                  if (!user) return;
                  import("./firebase.js").then(({ sendCommand }) => {
                    sendCommand(user.uid, { type: "RESET_ALL", capital: currentSettings.capitalTotal || 1000 })
                      .then(() => toast("🧹 Pedido de limpeza enviado ao bot — a base de dados vai ser limpa em segundos", "success"))
                      .catch(() => toast("Não foi possível enviar o pedido. Verifica se o bot está online.", "error"));
                  });
                },
              })} style={{
                background: `${T.red}15`, border: `1px solid ${T.red}55`, borderRadius: 8,
                padding: "11px 20px", fontSize: 12.5, color: T.red, cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
              }}>🧹 Limpar tudo e recomeçar</button>
            </div>
          )}
          </>)}
          {/* ═══ FIM GRUPO PERIGO ═══ */}
          <div style={{ display: "flex", gap: 10 }}>
            <Btn color={T.muted} onClick={() => setSettingsLocal(null)}>Cancelar</Btn>
            <Btn color={T.green} solid onClick={save} style={{ padding: "11px 32px", fontSize: 14 }}>✓ Guardar</Btn>
          </div>
        </div>
      </div>
    );
  };

  // RENDER: DAY TRADING
  // ─────────────────────────────────────────────
  const DayTrading = () => {
    const sc  = s => s === "COMPRAR" ? T.green : s === "VENDER" ? T.red : T.gold;
    const dtPnlColor = dtDailyPnl >= 0 ? T.green : T.red;

    // Scan AI: analisa ativos voláteis e decide comprar/vender agora
    const runScan = async (auto = false) => {
      if (dtLoading) return;
      // Se o bot 24/7 está ativo, é ele que faz o day trading no servidor (em
      // qualquer modo: sim, paper ou real). O scan AUTOMÁTICO da app pára para não
      // duplicar trades nem gastar tokens Groq. O "Scan Agora" manual continua a
      // funcionar como análise informativa (mas em paper/real não auto-compra).
      if (auto && botActiveRef.current) return;
      setDtLoading(true);
      try {
        // Watchlist: ativos escolhidos pelo user, OU (por defeito) os tradeable +
        // os mais voláteis do dia, até 12, para a IA ter material para 6+ oportunidades.
        let watchlist;
        if (dtAssets.length > 0) {
          watchlist = dtAssets;
        } else {
          const tradeables = assets.filter(a => a.trade);
          const volateis = [...assets]
            .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
            .filter(a => !tradeables.some(t => t.id === a.id));
          watchlist = [...tradeables, ...volateis].slice(0, 12);
        }
        // Poupar tokens: só analisa ativos com mercado aberto.
        const abertos = watchlist.filter(a => isMarketOpen(a.id));
        if (abertos.length === 0) {
          setDtLoading(false);
          if (!auto) toast("⏸ Todos os mercados selecionados estão fechados agora", "warn");
          return;
        }
        watchlist = abertos;
        const lines = watchlist.map(a => {
          const live = mktData[a.id] || {};
          const p    = live.price ?? a.price;
          const chg  = live.change ?? a.change;
          return `id=${a.id} · ${a.name}(${a.sym}): $${fmt(p, a.id)} variação24h=${chg.toFixed(2)}%`;
        }).join("\n");

        const dtTradesInfo = dtTrades.slice(0, 8).map(t =>
          `${t.assetSym} ${t.action} @$${t.entryPrice?.toFixed(2)} → ${t.status==="ABERTA"?"aberto":`fechado P&L €${t.pnl?.toFixed(2)}`}`
        ).join("; ");

        // Groq por defeito para day trading (mais rápido e 30x mais barato)
        const useGroq  = aiProvider !== "claude";
        const callFn   = useGroq ? callGroq : callAI;
        const modelLbl = useGroq ? "Groq/LLaMA" : "Claude";
        const { result, cost: c, tokens: tk } = await callFn({
          max_tokens: 1500,
          temperature: 0.25,
          system: "És um day trader profissional especializado em scalping e movimentos intradiários. Analisa ativos e dá sinais PRECISOS para hoje. Responde SEMPRE com JSON puro.",
          messages: [{ role: "user", content:
`ANÁLISE DAY TRADING — ${new Date().toLocaleString("pt-PT")}

Ativos a monitorizar:
${lines}

Trades de hoje: ${dtTradesInfo || "nenhum ainda"}
P&L do dia: €${dtDailyPnl.toFixed(2)}
Meta de lucro: ${dtProfitTarget}% por trade
Stop loss: ${dtMaxLoss}% por trade
Valor por trade: €${dtAmount}

Com base no momento atual (hora do dia, volatilidade, tendência), diz-me:
1. Quais ativos têm maior potencial de movimento HOJE
2. Se devo COMPRAR ou VENDER AGORA (não amanhã, HOJE)
3. Previsão concreta: "prevejo subida de X% nas próximas Y horas"

Devolve entre 4 e 6 oportunidades no array (as melhores dos ativos acima). Sê direto — não dizes "pode subir", dizes "vai subir X% até às HH:MM" ou "não invistas agora".

IMPORTANTE: no campo "id" usa SEMPRE o valor exato de id= indicado acima (ex: "silver", "gold", "eurusd"), nunca o símbolo.

JSON puro:
{
  "resumo": "análise geral do mercado AGORA em 1 frase direta pt",
  "momento": "MUITO_BOM|BOM|NEUTRO|MAU|MUITO_MAU",
  "melhorOportunidade": "nome do melhor ativo para day trading agora",
  "oportunidades": [
    {
      "id": "silver",
      "nome": "Prata",
      "icone": "🥈",
      "acao": "COMPRAR|VENDER|AGUARDAR",
      "entrada": 30.5,
      "alvo": 33.2,
      "sl": 29.6,
      "potencial": 8.9,
      "previsao": "prevejo subida de 8-10% até às 18h com base no breakout técnico de hoje",
      "razao": "explicação simples 1-2 frases pt sem jargão do PORQUÊ AGORA",
      "urgencia": "AGORA|HOJE|AGUARDAR",
      "confianca": 82
    }
  ]
}` }],
        });
        setDtScanResult({ ...result, scanAt: new Date().toLocaleTimeString("pt-PT") });
        setAiCost(p => +(p + (c||0)).toFixed(5));
        if (useGroq && tk) setGroqTokens(p => p + tk);

        // Auto-executar se urgência = AGORA e ação = COMPRAR.
        // REGRA ABSOLUTA: o browser só auto-executa em SIMULAÇÃO. Em paper/real
        // quem negoceia é o bot 24/7 — a app nunca abre day-trades em live.
        // E mesmo em sim, se o bot estiver vivo, cede-lhe a autoridade.
        const appPodeNegociar = simModeRef.current && !botActiveRef.current;
        if (dtActive && appPodeNegociar && result.oportunidades) {
          for (const op of result.oportunidades) {
            if (op.acao === "COMPRAR" && op.urgencia === "AGORA" && op.confianca >= dtMinConf) {
              const norm = s => String(s || "").toLowerCase().trim();
              const a = assets.find(x => x.id === op.id)
                     || assets.find(x => norm(x.sym) === norm(op.id))
                     || assets.find(x => norm(x.name) === norm(op.nome))
                     || assets.find(x => norm(x.sym) === norm(op.nome));
              if (!a) continue;
              // Limite de posições day trading
              const pool = simMode ? simPosRef.current : positions;
              const dtCount = pool.filter(p => p.stratId === "daytrading").length;
              const maxDt = settingsRef.current?.maxDayTrading ?? 5;
              if (dtCount >= maxDt) { continue; }
              // AUTORIDADE DO BOT: em paper/real, a app NÃO executa day-trades.
              // O bot (servidor) é a única autoridade de execução — gera e gere os
              // day-trades, que aparecem na lista paper. A app aqui é só análise.
              // Auto-comprar localmente duplicaria posições e dessincronizaria o
              // saldo. Só em SIMULAÇÃO pura (sem bot) é que a app simula localmente.
              if (!simMode) {
                continue; // paper/real → deixa o bot executar; app não cria trade
              }
              const price = mktData[a.id]?.price || a.price;
              const units = +(dtAmount / price).toFixed(7);
              const sl    = +(price * (1 - dtMaxLoss    / 100)).toFixed(2);
              const tp    = +(price * (1 + dtProfitTarget / 100)).toFixed(2);
              const trade = {
                id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
                action: "COMPRAR", entryPrice: price, units, amount: dtAmount,
                sl, tp, strategy: `DayTrade — ${op.previsao?.slice(0,40)}`,
                openedAt: new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
                mode: "sim",
              };
              setDtTrades(p => [trade, ...p]);
              setSimPositions(p => [...p, { ...trade, stratId: "daytrading" }]);
              setSimBalance(b => { const n = +(Math.max(0, b - dtAmount)).toFixed(2); simBalRef.current = n; return n; });
              toast(`⚡ DayTrade: COMPROU ${a.sym} @$${price.toFixed(2)} · Alvo +${dtProfitTarget}%`, "buy");
            }
          }
        }

        toast("⚡ Scan concluído!", "success");
      } catch (e) {
        const msg = String(e.message || "");
        if (/rate limit|TPD|tokens per day|429/i.test(msg)) {
          const m = /try again in ([\dhms.\s]+?)[.\n]/i.exec(msg);
          toast(`⏳ Limite diário de IA atingido (Groq). ${m ? `Tenta de novo em ${m[1].trim()}.` : "Tenta mais tarde ou aumenta o intervalo nas Definições."}`, "warn");
        } else {
          toast(`Erro no scan: ${msg}`, "error");
        }
      }
      setDtLoading(false);
    };

    // Iniciar/parar monitor automático
    const toggleMonitor = () => {
      if (dtActive) {
        clearInterval(dtTimerRef.current);
        setDtActive(false);
        toast("⏸ Monitor pausado", "warn");
      } else {
        setDtActive(true);
        runScan(true);
        dtTimerRef.current = setInterval(() => runScan(true), 5 * 60 * 1000); // scan cada 5 min
        toast("▶ Monitor ativo — scan cada 5 min", "success");
      }
    };

    // Fechar trade day trading manualmente
    const closeDtTrade = (tradeId) => {
      // PAPER/REAL: pede ao bot para vender — a app não fecha localmente.
      if (!simMode) {
        const t = dtTrades.find(x => x.id === tradeId);
        if (!t) { toast("Posição já não existe", "warn"); return; }
        cmdToBot({ type: "SELL", posId: t.id, assetId: t.assetId },
          `📤 Pedido de venda de ${t.assetSym} enviado ao bot`);
        return;
      }
      setDtTrades(p => p.map(t => {
        if (t.id !== tradeId || t.status !== "ABERTA") return t;
        const a    = resolveAsset(t);
        const price = a?.price || mktData[a?.id]?.price || t.entryPrice;
        const pnl  = (price - t.entryPrice) * t.units;
        setDtDailyPnl(prev => +(prev + pnl).toFixed(2));
        // Fechar nas posições (só sim — live é tratado acima via comando)
        setSimPositions(prev => prev.filter(x => x.id !== tradeId));
        setSimClosed(prev => [{ ...t, status: "MANUAL", closePrice: price, pnl, closedAt: new Date().toLocaleString("pt-PT"), closedTs: Date.now() }, ...prev]);
        setSimBalance(b => { const n = +(b + t.amount + pnl).toFixed(2); simBalRef.current = n; return n; });
        toast(`${pnl>=0?"✅":"🛑"} DayTrade fechado: ${sign(pnl)}€${Math.abs(pnl).toFixed(2)}`, pnl>=0?"success":"warn");
        return { ...t, status: "FECHADO", closePrice: price, pnl };
      }));
    };

    const momentoInfo = {
      MUITO_BOM:  { c: T.green,  label: "🔥 MUITO BOM — excelente para day trading" },
      BOM:        { c: T.green,  label: "✅ BOM — boas oportunidades agora"          },
      NEUTRO:     { c: T.gold,   label: "⚖ NEUTRO — espera por melhor momento"      },
      MAU:        { c: T.red,    label: "⚠ MAU — evita trades agora"                },
      MUITO_MAU:  { c: T.red,    label: "🛑 MUITO MAU — não entres em posições"     },
    };
    const mom = momentoInfo[dtScanResult?.momento] || null;

    return (
      <div style={{ display:"flex", flexDirection:"column", gap:16, paddingBottom:220 }}>

        {/* ── Header e Controlos ── */}
        <Glass style={{ padding:"22px 26px",
          background: dtActive
            ? "linear-gradient(135deg,rgba(16,185,129,0.12),rgba(99,102,241,0.06))"
            : "rgba(255,255,255,0.04)",
          border: `1px solid ${dtActive ? T.green+"44" : T.border}`,
        }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16 }}>
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                <div style={{ fontSize:18, fontWeight:800 }}>⚡ Day Trading</div>
                {dtActive && (
                  <div style={{ display:"flex", alignItems:"center", gap:6,
                    background:`${T.green}18`, border:`1px solid ${T.green}33`,
                    borderRadius:99, padding:"3px 10px" }}>
                    <div style={{ width:6, height:6, borderRadius:"50%", background:T.green, animation:"pulse 1.2s infinite" }}/>
                    <span style={{ fontSize:9, fontWeight:700, color:T.green, letterSpacing:"0.1em" }}>MONITOR ATIVO — scan 5min</span>
                  </div>
                )}
              </div>
              <div style={{ fontSize:12, color:T.muted, lineHeight:1.65 }}>
                A IA analisa ativos voláteis em tempo real com base no histórico e momento do dia.
                Entra e sai automaticamente quando atinge <b style={{ color:T.aLight }}>{dtProfitTarget}%</b> de lucro.
                {dtDailyPnl !== 0 && (
                  <span style={{ marginLeft:10, color:dtPnlColor, fontWeight:700 }}>
                    P&L hoje: {sign(dtDailyPnl)}€{Math.abs(dtDailyPnl).toFixed(2)}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display:"flex", gap:10, flexShrink:0 }}>
              <button onClick={() => runScan(false)} disabled={dtLoading} style={{
                background:`${T.accent}18`, border:`1px solid ${T.accent}44`,
                borderRadius:10, padding:"10px 18px", fontSize:12, color:T.aLight,
                cursor:dtLoading?"not-allowed":"pointer", fontFamily:"inherit", fontWeight:700,
                opacity:dtLoading?0.5:1,
              }}>{dtLoading ? "◌ A analisar…" : "◆ Scan Agora"}</button>
              <button onClick={toggleMonitor} style={{
                background: dtActive ? `${T.red}18` : `${T.green}18`,
                border: `1px solid ${dtActive ? T.red : T.green}44`,
                borderRadius:10, padding:"10px 20px", fontSize:12,
                color: dtActive ? T.red : T.green,
                cursor:"pointer", fontFamily:"inherit", fontWeight:700,
              }}>{dtActive ? "⏸ Parar Monitor" : "▶ Iniciar Monitor"}</button>
            </div>
          </div>

          {/* Config row */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12, marginTop:18 }}>
            {[
              { l:"Meta de Lucro (%)", key:"dtProfitTarget", val:dtProfitTarget, set:setDtProfitTarget, min:1, max:25, c:T.green },
              { l:"Stop Loss (%)",     key:"dtMaxLoss",      val:dtMaxLoss,      set:setDtMaxLoss,      min:1, max:15, c:T.red   },
              { l:"Confiança Mín. (%)",key:"dtMinConf",      val:dtMinConf,      set:setDtMinConf,      min:50, max:95, c:T.gold  },
              { l:"€ por Trade",       key:"dtAmount",       val:dtAmount,       set:setDtAmount,       min:10, max:5000, c:T.aLight, isNum:true },
            ].map(f => (
              <div key={f.key} style={{ background:"rgba(0,0,0,0.2)", borderRadius:10, padding:"12px 14px" }}>
                <div style={{ fontSize:9, color:T.muted, letterSpacing:"0.11em", textTransform:"uppercase", marginBottom:8 }}>{f.l}</div>
                {f.isNum ? (
                  <input type="number" value={f.val} onChange={e => f.set(Math.max(f.min, +e.target.value))} style={{
                    background:"transparent", border:"none", borderBottom:`1px solid ${f.c}44`,
                    color:f.c, fontSize:22, fontWeight:800, fontFamily:"inherit", outline:"none", width:"100%",
                  }}/>
                ) : (
                  <>
                    <input type="range" min={f.min} max={f.max} value={f.val}
                      onChange={e => f.set(+e.target.value)} style={{ width:"100%", accentColor:f.c, marginBottom:4 }}/>
                    <div style={{ fontSize:20, fontWeight:800, color:f.c }}>{f.val}%</div>
                  </>
                )}
              </div>
            ))}
            {/* Modo + Provider AI */}
            <div style={{ background:"rgba(0,0,0,0.2)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:9, color:T.muted, letterSpacing:"0.11em", textTransform:"uppercase", marginBottom:8 }}>Modo / AI</div>
              <div style={{ fontSize:13, fontWeight:700, color:simMode?T.gold:T.red, marginBottom:8 }}>
                {simMode ? "◎ Simulação" : botModoReal ? "● Live Real" : "📝 Paper"}
              </div>
              <div style={{ fontSize:9, color:T.muted, marginBottom:5 }}>Motor de análise:</div>
              <div style={{ display:"flex", gap:4 }}>
                {[["auto","⚡ Auto"],["groq","Groq"],["claude","Claude"]].map(([v,l]) => (
                  <button key={v} onClick={() => setAiProvider(v)} style={{
                    flex:1, padding:"4px 0", fontSize:9, fontFamily:"inherit", cursor:"pointer",
                    background: aiProvider===v ? `${T.accent}25` : "transparent",
                    border: `1px solid ${aiProvider===v ? T.accent+"55" : T.border}`,
                    borderRadius:5, color: aiProvider===v ? T.aLight : T.muted, fontWeight:700,
                  }}>{l}</button>
                ))}
              </div>
              <div style={{ fontSize:9, color:T.muted, marginTop:6, lineHeight:1.5 }}>
                {aiProvider==="auto"?"Groq p/ scans, Claude p/ análise":aiProvider==="groq"?"Groq — 30x mais barato":"Claude — análise mais profunda"}
              </div>
            </div>
          </div>
        </Glass>

        {/* ── Resultado do Scan ── */}
        {dtScanResult && (
          <>
            {/* Momento geral */}
            <div style={{
              padding:"12px 20px", borderRadius:10, display:"flex", alignItems:"center", gap:12,
              background: `${mom?.c || T.muted}0e`, border:`1px solid ${mom?.c || T.muted}25`,
            }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:mom?.c || T.muted }} />
              <div style={{ fontSize:13, fontWeight:700, color:mom?.c || T.text }}>{mom?.label}</div>
              <div style={{ marginLeft:"auto", fontSize:10, color:T.muted }}>Scan às {dtScanResult.scanAt}</div>
            </div>

            {/* Melhor oportunidade destaque */}
            {dtScanResult.melhorOportunidade && (
              <div style={{
                padding:"14px 20px", borderRadius:10,
                background:`${T.gold}0d`, border:`1px solid ${T.gold}30`,
                fontSize:13, color:T.text,
              }}>
                ⭐ <b style={{ color:T.gold }}>Melhor agora:</b> {dtScanResult.melhorOportunidade} · {dtScanResult.resumo}
              </div>
            )}

            {/* Cards de oportunidades */}
            <div className="resp-grid-2" style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:12 }}>
              {(dtScanResult.oportunidades || []).map(op => {
                const a    = (() => {
                  const norm = s => String(s || "").toLowerCase().trim();
                  return assets.find(x => x.id === op.id)
                      || assets.find(x => norm(x.sym) === norm(op.id))
                      || assets.find(x => norm(x.name) === norm(op.nome))
                      || assets.find(x => norm(x.sym) === norm(op.nome));
                })();
                const live = mktData[a?.id] || {};
                const price = live.price ?? a?.price ?? op.entrada;
                const acaoShow = normSignal(a?.id || op.id, op.acao);
                const col   = acaoShow==="COMPRAR" ? T.green : acaoShow==="VENDER" ? T.red : T.gold;
                const urgC  = op.urgencia==="AGORA" ? T.red : op.urgencia==="HOJE" ? T.gold : T.muted;
                const alreadyOpen = dtTrades.some(t => t.assetId===(a?.id||op.id) && t.status==="ABERTA");
                return (
                  <Glass key={op.id} style={{ padding:"18px 20px", position:"relative" }}>
                    {/* Urgência badge */}
                    <div style={{ position:"absolute", top:0, right:14,
                      background:urgC, color:"#000", fontSize:8, fontWeight:800,
                      padding:"2px 10px", borderRadius:"0 0 7px 7px", letterSpacing:"0.1em" }}>
                      {op.urgencia}
                    </div>
                    {/* Header */}
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10, marginTop:10 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <span style={{ fontSize:24 }}>{op.icone}</span>
                        <div>
                          <div style={{ fontWeight:700, fontSize:14 }}>{op.nome}</div>
                          <div style={{ fontSize:11, color:T.muted }}>${fmt(price, op.id)}</div>
                        </div>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <Badge label={acaoShow} color={col} />
                        <div style={{ fontSize:11, color:T.aLight, marginTop:4, fontWeight:700 }}>Confiança {op.confianca}%</div>
                      </div>
                    </div>
                    {/* Razão */}
                    <div style={{ fontSize:12, color:T.text, lineHeight:1.65, marginBottom:8 }}>{op.razao}</div>
                    {/* Previsão */}
                    <div style={{ fontSize:11, color:T.gold, fontStyle:"italic", padding:"6px 10px",
                      background:`${T.gold}0a`, borderLeft:`2px solid ${T.gold}55`,
                      borderRadius:"0 7px 7px 0", marginBottom:12, lineHeight:1.55 }}>
                      📅 {op.previsao}
                    </div>
                    {/* Entrada / Alvo / SL */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8,
                      background:"rgba(0,0,0,0.22)", borderRadius:8, padding:"10px 12px",
                      fontSize:11, marginBottom:12 }}>
                      <div><div style={{ fontSize:8, color:T.muted }}>ENTRADA</div><div style={{ fontWeight:700 }}>${op.entrada}</div></div>
                      <div><div style={{ fontSize:8, color:T.green }}>ALVO (+{op.potencial}%)</div><div style={{ fontWeight:700, color:T.green }}>${op.alvo}</div></div>
                      <div><div style={{ fontSize:8, color:T.red }}>STOP LOSS</div><div style={{ fontWeight:700, color:T.red }}>${op.sl}</div></div>
                      <div><div style={{ fontSize:8, color:T.aLight }}>META €</div><div style={{ fontWeight:700, color:T.aLight }}>+€{(dtAmount * op.potencial/100).toFixed(2)}</div></div>
                    </div>
                    {/* Botão */}
                    {op.acao === "COMPRAR" && !alreadyOpen && (
                      <button onClick={() => {
                        const price2 = mktData[a?.id]?.price || a?.price || op.entrada;
                        // PAPER/REAL: pede ao bot; não cria posição local.
                        if (!simMode) {
                          cmdToBot({ type: "BUY", assetId: a?.id || op.id, amount: dtAmount },
                            `📤 Compra de ${op.nome} (€${dtAmount}) enviada ao bot`);
                          return;
                        }
                        const units2 = +(dtAmount / price2).toFixed(7);
                        const sl2    = +(price2 * (1 - dtMaxLoss    /100)).toFixed(2);
                        const tp2    = +(price2 * (1 + dtProfitTarget/100)).toFixed(2);
                        const trade  = {
                          id: uid(), assetId:a?.id||op.id, assetName:a?.name||op.nome, assetSym:a?.sym||op.id,
                          action:"COMPRAR", entryPrice:price2, units:units2, amount:dtAmount,
                          sl:sl2, tp:tp2, strategy:`DayTrade`,
                          openedAt:new Date().toLocaleString("pt-PT"), openedTs: Date.now(), status:"ABERTA",
                          mode: "sim",
                        };
                        setDtTrades(p => [trade, ...p]);
                        setSimPositions(p => [...p, { ...trade, stratId:"daytrading" }]);
                        setSimBalance(b => { const n = +(Math.max(0,b-dtAmount)).toFixed(2); simBalRef.current=n; return n; });
                        toast(`⚡ Comprado ${op.nome} @$${price2.toFixed(2)}`, "buy");
                      }} style={{
                        width:"100%", background:`${T.green}20`, border:`1px solid ${T.green}55`,
                        borderRadius:9, padding:"11px 0", fontSize:13, color:T.green,
                        cursor:"pointer", fontFamily:"inherit", fontWeight:800,
                      }}>▲ Comprar Agora · €{dtAmount}</button>
                    )}
                    {alreadyOpen && (
                      <div style={{ textAlign:"center", fontSize:11, color:T.gold, padding:"8px 0" }}>
                        📂 Posição aberta — a aguardar alvo +{dtProfitTarget}%
                      </div>
                    )}
                    {op.acao === "AGUARDAR" && (
                      <div style={{ textAlign:"center", fontSize:11, color:T.muted, padding:"8px 0" }}>
                        ⏳ A aguardar melhor entrada…
                      </div>
                    )}
                  </Glass>
                );
              })}
            </div>
          </>
        )}

        {/* ── Trades do Dia ── */}
        {dtTrades.length > 0 && (
          <Glass style={{ padding:"20px 22px" }}>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:12 }}>
              ⚡ Trades de Hoje ({dtTrades.length})
              <span style={{ marginLeft:12, color:dtPnlColor, fontWeight:800 }}>
                P&L: {sign(dtDailyPnl)}€{Math.abs(dtDailyPnl).toFixed(2)}
              </span>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {dtTrades.map(t => {
                const a     = resolveAsset(t);
                const price = a?.price || mktData[a?.id]?.price || t.entryPrice;
                const curPnl = t.status==="ABERTA"
                  ? (price - t.entryPrice) * t.units
                  : (t.pnl || 0);
                const col = curPnl >= 0 ? T.green : T.red;
                return (
                  <div key={t.id} style={{
                    display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr 120px",
                    gap:10, padding:"12px 14px", borderRadius:10,
                    background:`${col}08`, border:`1px solid ${col}20`,
                    alignItems:"center", fontSize:12,
                  }}>
                    <div>
                      <div style={{ fontWeight:700 }}>{a?.icon || "⚡"} {a?.name || t.assetName || t.assetId}</div>
                      <div style={{ fontSize:10, color:T.muted }}>{t.openedAt} · €{t.amount}</div>
                    </div>
                    <div><div style={{ fontSize:8, color:T.muted }}>ENTRADA</div><div style={{ fontWeight:700 }}>${t.entryPrice?.toFixed(2)}</div></div>
                    <div><div style={{ fontSize:8, color:T.muted }}>ATUAL</div><div style={{ fontWeight:700 }}>${fmt(price, a?.id || t.assetId)}</div></div>
                    <div><div style={{ fontSize:8, color:T.green }}>TP +{dtProfitTarget}%</div><div style={{ fontWeight:700, color:T.green }}>${t.tp}</div></div>
                    <div>
                      <div style={{ fontSize:16, fontWeight:800, color:col }}>{sign(curPnl)}€{Math.abs(curPnl).toFixed(2)}</div>
                      <Badge label={t.status} color={t.status==="ABERTA"?T.blue:col} />
                    </div>
                    {t.status === "ABERTA" && (
                      <button onClick={() => closeDtTrade(t.id)} style={{
                        background:`${T.red}18`, border:`1px solid ${T.red}33`,
                        borderRadius:7, padding:"7px 0", width:"100%", fontSize:11,
                        color:T.red, cursor:"pointer", fontFamily:"inherit", fontWeight:700,
                      }}>Fechar</button>
                    )}
                    {t.status !== "ABERTA" && (
                      <div style={{ textAlign:"center", fontSize:10, color:T.muted }}>Fechado</div>
                    )}
                  </div>
                );
              })}
            </div>
          </Glass>
        )}

        {!dtScanResult && (
          <Glass style={{ padding:"56px 24px", textAlign:"center" }}>
            <div style={{ fontSize:44, marginBottom:12 }}>⚡</div>
            <div style={{ fontWeight:700, fontSize:16, marginBottom:10 }}>Day Trading com IA</div>
            <div style={{ color:T.muted, fontSize:13, marginBottom:24, maxWidth:500, margin:"0 auto 24px" }}>
              Clica em <b style={{ color:T.aLight }}>Scan Agora</b> para a IA analisar o mercado e identificar
              oportunidades de lucro rápido para hoje. Com o Monitor ativo, a IA faz scan a cada 5 minutos
              e entra automaticamente nas melhores oportunidades.
            </div>
            <button onClick={() => runScan(false)} disabled={dtLoading} style={{
              background:`${T.accent}20`, border:`1px solid ${T.accent}55`,
              borderRadius:12, padding:"14px 32px", fontSize:14, color:T.aLight,
              cursor:dtLoading?"not-allowed":"pointer", fontFamily:"inherit", fontWeight:700,
            }}>{dtLoading ? "◌ A analisar mercados…" : "◆ Fazer Primeiro Scan"}</button>
          </Glass>
        )}
      </div>
    );
  };

  // ─────────────────────────────────────────────
  // RENDER: RESUMO MÓVEL (entrada por defeito em telemóvel)
  // Vista de consulta rápida em cartões: como vão as coisas, se o bot está
  // vivo, e atalho para uma compra manual rápida.
  // ─────────────────────────────────────────────
  const MobileResumo = () => {
    const capitalInicialDisplay = simMode ? (settings.capitalTotal || simCapital) : (liveSettings.capitalTotal || 1000);
    const ganhoHoje = totalPnl; // não realizado + realizado da sessão ativa
    const aGanhar   = ganhoHoje >= 0;
    const corPnl    = aGanhar ? T.green : T.red;

    // Posições ordenadas pelo maior movimento (|P&L|), até 4.
    const posOrdenadas = [...activePositions]
      .map(p => {
        const live = mktData[p.assetId] || {};
        const price = live.price || p.entryPrice;
        const pnl   = (price - p.entryPrice) * p.units;
        return { ...p, _price: price, _pnl: pnl };
      })
      .sort((a, b) => Math.abs(b._pnl) - Math.abs(a._pnl))
      .slice(0, 4);

    // "Bons negócios": ativos negociáveis com maior subida hoje, até 4.
    const oportunidades = [...assets]
      .filter(a => isTradeable(a.id))
      .sort((a, b) => b.change - a.change)
      .slice(0, 4);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* ── Compras DCA pendentes — NO TOPO, bem visíveis (vêm do Telegram) ── */}
        {manualOrders.length > 0 && (
          <Glass glow style={{ padding: "18px 20px", background: `${T.gold}14`, border: `1.5px solid ${T.gold}` }}>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>🔔 {manualOrders.length} compra(s) à tua espera</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, marginBottom: 12 }}>
              Está na hora de investires nos teus planos DCA. Compra no teu broker e confirma aqui.
            </div>
            {manualOrders.slice(0, 3).map(o => (
              <div key={o.id} style={{ fontSize: 11.5, marginBottom: 4 }}>
                <b>{o.planNome}</b> — €{(o.valorTotal || 0).toFixed(2)}
              </div>
            ))}
            <button onClick={() => setTab("dca")} style={{ width: "100%", marginTop: 10, padding: "12px", borderRadius: 10, border: "none", background: T.gold, color: "#000", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
              Ver e confirmar →
            </button>
          </Glass>
        )}

        {/* ── Cartão de estado principal ── */}
        <Glass glow style={{ padding: "22px 22px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 11, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>
            {aGanhar ? "Estás a ganhar" : "Estás a perder"}
          </div>
          <div style={{
            fontSize: 44, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em",
            background: aGanhar ? T.gradGreen : `linear-gradient(135deg, ${T.red}, #ff8fa3)`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          }}>
            {sign(ganhoHoje)}{eur(ganhoHoje)}
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 6 }}>
            Carteira: <b style={{ color: T.text }}>€{portfolioV.toFixed(2)}</b>
            {capitalInicialDisplay > 0 && (
              <span style={{ color: corPnl, fontWeight: 700 }}>
                {" "}· {sign(ganhoHoje)}{((ganhoHoje / capitalInicialDisplay) * 100).toFixed(1)}%
              </span>
            )}
          </div>

          {/* Estado do bot */}
          <div style={{
            marginTop: 16, display: "inline-flex", alignItems: "center", gap: 8,
            background: botAtivo ? `${T.green}14` : `${T.red}12`,
            border: `1px solid ${botAtivo ? T.green : T.red}40`,
            borderRadius: 99, padding: "7px 16px",
          }}>
            <span style={{
              width: 9, height: 9, borderRadius: "50%",
              background: botAtivo ? T.green : T.red,
              boxShadow: `0 0 8px ${botAtivo ? T.green : T.red}`,
            }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: botAtivo ? T.green : T.red }}>
              {botAtivo
                ? `Bot ativo${botStatus?.mode ? ` · ${modoLabelBot(botStatus.mode)}` : ""}`
                : "Bot offline"}
            </span>
          </div>
          {botAtivo && botStatus?.lastSeen && (
            <div style={{ fontSize: 9, color: T.muted, marginTop: 6 }}>
              visto {Math.round((Date.now() - botStatus.lastSeen) / 1000)}s atrás
            </div>
          )}
          {!botAtivo && (
            <div style={{ fontSize: 10, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
              O bot não está a responder. Toca em <b style={{ color: T.aLight }} onClick={() => setTab("dashboard")}>Dashboard</b> para detalhes.
            </div>
          )}
        </Glass>

        {/* ── DCA + ordens pendentes (foco do mobile) ── */}
        {(() => {
          const nPlanos = Array.isArray(liveSettings.dcaPlanos) ? liveSettings.dcaPlanos.length : 0;
          const dcaOn = liveSettings.dcaAtivo !== false && nPlanos > 0;
          return (
            <Glass style={{ padding: "16px 18px", background: `${T.green}0a`, border: `1px solid ${T.green}33` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 800 }}>🎯 DCA</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: dcaOn ? T.green : T.gold }}>{dcaOn ? "● Ativo" : nPlanos > 0 ? "Pausado" : "Sem planos"}</span>
              </div>
              <div style={{ fontSize: 10.5, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
                {nPlanos > 0 ? `${nPlanos} plano(s) · €${liveSettings.dcaValorMensal || 0}/período` : "Cria o teu primeiro plano no separador DCA."}
              </div>
              {manualOrders.length > 0 && (
                <div onClick={() => setTab("dca")} style={{ marginTop: 10, fontSize: 11, fontWeight: 700, color: T.gold, background: `${T.gold}15`, padding: "8px 12px", borderRadius: 8, textAlign: "center" }}>
                  🔔 {manualOrders.length} compra(s) à tua espera — toca para confirmar
                </div>
              )}
            </Glass>
          );
        })()}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Glass style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Disponível</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>€{activeBalance.toFixed(2)}</div>
          </Glass>
          <Glass style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Investido</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>€{invested.toFixed(2)}</div>
          </Glass>
          <Glass style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>P&L Aberto</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: unrealized >= 0 ? T.green : T.red }}>{sign(unrealized)}{eur(unrealized)}</div>
          </Glass>
          <Glass style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Posições</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{activePositions.length}</div>
          </Glass>
        </div>

        {/* ── As tuas posições ── */}
        {posOrdenadas.length > 0 && (
          <div>
            <SectionLabel>As tuas posições</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {posOrdenadas.map(p => {
                const a = assets.find(x => x.id === p.assetId);
                const pnlPct = p.entryPrice > 0 ? ((p._price - p.entryPrice) / p.entryPrice) * 100 : 0;
                const c = p._pnl >= 0 ? T.green : T.red;
                return (
                  <Glass key={p.id} style={{ padding: "13px 16px" }} onClick={() => setTab("portfolio")}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 20 }}>{a?.icon || "•"}</span>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{a?.name || p.assetSym || p.assetId}</div>
                          <div style={{ fontSize: 10, color: T.muted }}>€{(p.amount || 0).toFixed(2)} · entrada ${fmt(p.entryPrice, p.assetId)}</div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontWeight: 800, fontSize: 14, color: c }}>{sign(p._pnl)}{eur(p._pnl)}</div>
                        <div style={{ fontSize: 11, color: c, fontWeight: 700 }}>{sign(pnlPct)}{Math.abs(pnlPct).toFixed(2)}%</div>
                      </div>
                    </div>
                  </Glass>
                );
              })}
            </div>
            {activePositions.length > posOrdenadas.length && (
              <div onClick={() => setTab("portfolio")} style={{ textAlign: "center", fontSize: 11, color: T.aLight, marginTop: 8, cursor: "pointer" }}>
                Ver todas as {activePositions.length} posições →
              </div>
            )}
          </div>
        )}

        {/* ── Bons negócios agora (compra rápida) ── */}
        <div>
          <SectionLabel>Bons negócios agora</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {oportunidades.map(a => {
              const live = mktData[a.id] || {};
              const price = live.price || a.price;
              const chg = (typeof live.change === "number" ? live.change : a.change) || 0;
              return (
                <Glass key={a.id} style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span style={{ fontSize: 19 }}>{a.icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>
                          ${fmt(price, a.id)} · <span style={{ color: chg >= 0 ? T.green : T.red, fontWeight: 700 }}>{pctFmt(chg)}</span>
                        </div>
                      </div>
                    </div>
                    <Btn color={T.green} solid sm
                      onClick={() => {
                        setOrderModal({ assetId: a.id, side: "BUY" });
                        setOrderAmount(calcTradeAmount());
                        setTab("markets");
                      }}
                      style={{ flexShrink: 0, fontSize: 12, padding: "8px 16px" }}>
                      ▲ Comprar
                    </Btn>
                  </div>
                </Glass>
              );
            })}
          </div>
          <div onClick={() => setTab("markets")} style={{ textAlign: "center", fontSize: 11, color: T.aLight, marginTop: 8, cursor: "pointer" }}>
            Ver todos os mercados →
          </div>
        </div>

      </div>
    );
  };

  // NAV + LAYOUT
  // ─────────────────────────────────────────────
  // aiOnly: separadores que só fazem sentido com o AI Trade ligado. Quando está
  // desligado (só DCA), ficam escondidos para o layout respirar e não confundir.
  const NAV_ALL = [
    { id: "resumo",     icon: "⚡", label: "Resumo", mobileOnly: true },
    { id: "dashboard",  icon: "🏠", label: "Início"        },
    { id: "investir",   icon: "🎯", label: "Investir", group: ["dca", "portfolio", "relatorio"] },
    { id: "markets",    icon: "◎",  label: "Mercados", group: ["markets", "sugestoes"] },
    { id: "lab",        icon: "⚡",  label: "Laboratório", aiGroup: true, group: ["strategies", "daytrading", "ai"] },
    { id: "history",    icon: "≡",  label: "Histórico" },
    { id: "mais",       icon: "⚙",  label: "Mais", group: ["messages", "settings", "guide"] },
  ];
  // Sub-abas dentro de cada zona agrupada (label + id da página)
  const SUBTABS = {
    investir: [
      { id: "dca",       icon: "🎯", label: "Planos" },
      { id: "portfolio", icon: "💼", label: "Carteira" },
      { id: "relatorio", icon: "📊", label: "Relatório" },
    ],
    markets: [
      { id: "markets",   icon: "◎",  label: "Mercados" },
      { id: "sugestoes", icon: "💡", label: "Sugestões" },
    ],
    lab: [
      { id: "strategies",icon: "📊", label: "Estratégias" },
      { id: "daytrading",icon: "⚡",  label: "Day Trading" },
      { id: "ai",        icon: "◆",  label: "AI Intel" },
    ],
    mais: [
      { id: "messages",  icon: "🔔", label: "Mensagens" },
      { id: "settings",  icon: "⚙",  label: "Definições" },
      { id: "guide",     icon: "◉",  label: "Guia" },
    ],
  };
  // Qual zona contém um dado tab (para destacar a zona certa no nav)
  const zonaDoTab = (t) => {
    for (const z of Object.keys(SUBTABS)) {
      if (SUBTABS[z].some(s => s.id === t)) return z;
    }
    return t; // dashboard/resumo são zonas próprias
  };
  const aiTradeOn = !!liveSettings.aiTradeAtivo;
  const mestreOn = aiTradeOn || !!liveSettings.aiBrainMestre;
  // Mostra cada separador de trading se o AI Brain (mestre) estiver ON e a sua
  // fonte estiver ON. DCA/Carteira/etc. continuam sempre visíveis.
  const NAV = NAV_ALL.filter(item => !item.aiGroup || mestreOn);

  // ── Persistência Firestore: carregar estado ao iniciar ──────────────────
  useEffect(() => {
    if (!user) return;
    const uid2 = user.uid;
    // Carregar posições simuladas abertas
    let unsubTrades = null, unsubBal = null, unsubBalLive = null, unsubTradeable = null, unsubMktPrices = null;
    import("./firebase.js").then(({ subscribeTrades, subscribeSetting }) => {
      unsubTrades = subscribeTrades(uid2, (trades) => {
        // Carregar trades do bot/servidor — separa SIM de LIVE (paper/real).
        // O bot escreve mode:"sim" em simulação e mode:"live" em paper/real.
        const simOpen    = trades.filter(t => t.status === "ABERTA" && t.mode === "sim");
        const simClosed_  = trades.filter(t => t.status !== "ABERTA" && t.mode === "sim");
        const liveOpen   = trades.filter(t => t.status === "ABERTA" && t.mode === "live");
        const liveClosed_ = trades.filter(t => t.status !== "ABERTA" && t.mode === "live");
        // Preservar posições locais MUITO recentes (últimos 10s) que ainda não
        // apareceram no snapshot do Firestore — evita que uma compra manual
        // "desapareça" do ecrã por causa da latência de propagação.
        const idsFb = new Set(simOpen.map(t => t.id));
        const recentesLocais = (simPosRef.current || []).filter(p =>
          !idsFb.has(p.id) && p.openedTs && (Date.now() - p.openedTs < 10000)
        );
        const simOpenMerged = [...simOpen, ...recentesLocais];
        setSimPositions(simOpenMerged);
        simPosRef.current = simOpenMerged;
        setSimClosed(simClosed_);
        setPositions(liveOpen);
        setClosed(liveClosed_);
        setDbLoaded(true);
      });
      unsubBal = subscribeSetting(uid2, "simBalance", (val) => {
        if (typeof val === "number" && val > 0) {
          setSimBalance(val);
          simBalRef.current = val;
        }
      });
      unsubBalLive = subscribeSetting(uid2, "liveBalance", (val) => {
        if (typeof val === "number" && val > 0) {
          setBalance(val);
          balRef.current = val;
        }
      });
      unsubTradeable = subscribeSetting(uid2, "tradeableAssets", (val) => {
        if (Array.isArray(val) && val.length) {
          setBotTradeable(new Set(val.map(a => a.id)));
        }
      });
      // Estatísticas históricas (máx/mín 90d, média semana/mês) publicadas pelo bot.
      unsubPriceStats = subscribeSetting(uid2, "priceStats", (val) => {
        if (val?.stats && typeof val.stats === "object") setPriceStats(val.stats);
      });
      // Preços publicados pelo bot (marketPrices). Com o bot ativo, a app aplica
      // estes preços em vez de chamar APIs — fonte única, sem chamadas duplicadas.
      unsubMktPrices = subscribeSetting(uid2, "marketPrices", (val) => {
        const p = val?.prices;
        if (!p || typeof p !== "object") return;
        setAssets(prev => prev.map(a => {
          const d = p[a.id];
          if (!d || typeof d.price !== "number") return a;
          return { ...a, price: d.price, change: typeof d.change === "number" ? d.change : a.change };
        }));
        setLiveData(true);
      });
    }).catch(() => {});
    // Carregar estratégias guardadas
    let unsubStrat = null, unsubSettings = null, unsubLive = null, unsubLiveLegacy = null, unsubReal = null, unsubCtrl = null, unsubArch = null, unsubDt = null, unsubBot = null, unsubSig = null, unsubDaily = null, unsubBrokers = null, unsubLogs = null, unsubPriceStats = null, unsubRegimeLog = null, unsubManual = null;
    import("./firebase.js").then(({ subscribeStrategies, subscribeSetting: subSet, subscribeArchives, subscribeLogs, subscribeRegimeLog, subscribeManualOrders }) => {
      if (subscribeManualOrders) {
        unsubManual = subscribeManualOrders(uid2, (ords) => setManualOrders(Array.isArray(ords) ? ords : []));
      }
      if (subscribeArchives) {
        unsubDaily = subscribeArchives(uid2, (arcs) => {
          if (Array.isArray(arcs)) setDailyArchives(arcs);
        });
      }
      if (subscribeLogs) {
        unsubLogs = subscribeLogs(uid2, (logs) => { if (Array.isArray(logs)) setBotLogs(logs); });
      }
      if (subscribeRegimeLog) {
        unsubRegimeLog = subscribeRegimeLog(uid2, (evs) => { if (Array.isArray(evs)) setRegimeLog(evs); });
      }
      if (subscribeStrategies) {
        unsubStrat = subscribeStrategies(uid2, (strats) => {
          if (strats) {
            const validIds = ASSETS.map(a => a.id);
            const fixed = strats.map(s => {
              let ativos = Array.isArray(s.ativos) ? s.ativos.filter(id => validIds.includes(id)) : [];
              if (ativos.length === 0) ativos = ["btc", "eth"];
              let compra = Number(s.compra);
              if (!compra || isNaN(compra)) compra = 1.5;
              compra = Math.min(3, Math.max(0.5, compra));
              return {
                ...s, ativos, compra,
                perTrade: Number(s.perTrade) || 100,
                sl: Number(s.sl) || 6,
                tp: Number(s.tp) || 12,
              };
            });
            setStrategies(fixed); stratRef.current = fixed;
          }
        });
      }
      // Carregar definições guardadas
      unsubSettings = subSet(uid2, "settings", (val) => {
        if (val && typeof val === "object") {
          setSettings(val); settingsRef.current = val;
          if (typeof val.capitalTotal === "number") { setSimCapital(val.capitalTotal); }
        }
      });
      unsubLive = subSet(uid2, "paperSettings", (val) => {
        if (val && typeof val === "object") { setPaperSettings(val); paperSettingsRef.current = val; paperLoadedRef.current = true; }
      });
      // Migração suave (uma vez): se NUNCA houve paperSettings guardado mas
      // existe o antigo "liveSettings", adota-o como base de paper. Assim não
      // perdes as definições que já tinhas no separador Paper.
      unsubLiveLegacy = subSet(uid2, "liveSettings", (val) => {
        if (val && typeof val === "object" && !paperLoadedRef.current) {
          setPaperSettings(val); paperSettingsRef.current = val;
        }
      });
      unsubReal = subSet(uid2, "realSettings", (val) => {
        if (val && typeof val === "object") { setRealSettings(val); realSettingsRef.current = val; }
      });
      unsubCtrl = subSet(uid2, "botControl", (val) => {
        if (val && typeof val === "object") setBotPaused(!!val.paused);
      });
      unsubArch = subSet(uid2, "archivedSims", (val) => {
        if (Array.isArray(val)) setArchivedSims(val);
      });
      unsubDt = subSet(uid2, "dtState", (val) => {
        if (val && typeof val === "object") {
          if (Array.isArray(val.trades)) setDtTrades(val.trades);
          if (typeof val.dailyPnl === "number") setDtDailyPnl(val.dailyPnl);
          if (typeof val.profitTarget === "number") setDtProfitTarget(val.profitTarget);
          if (typeof val.maxLoss === "number") setDtMaxLoss(val.maxLoss);
          if (typeof val.amount === "number") setDtAmount(val.amount);
          if (typeof val.minConf === "number") setDtMinConf(val.minConf);
          // Sincroniza o estado do monitor só na primeira carga (a app é a dona deste flag)
          if (!dtLoadedRef.current && typeof val.active === "boolean") {
            setDtActive(val.active);
            dtLoadedRef.current = true;
          }
        }
      });
      unsubBot = subSet(uid2, "botStatus", (val) => {
        if (val && typeof val === "object") setBotStatus(val);
      });
      unsubBrokers = subSet(uid2, "brokerBalances", (val) => {
        // { alpaca: 123.45, binance: 67.89, ... } — escrito pelo bot em paper/live
        if (val && typeof val === "object") setBrokerBalances(val);
      });
      subSet(uid2, "dcaAportes", (val) => {
        if (val && typeof val === "object") setDcaAportes(val);
      });
      subSet(uid2, "portfolioHistory", (val) => {
        if (Array.isArray(val)) setPortfolioHist(val);
      });
      unsubSig = subSet(uid2, "marketSignals", (val) => {
        // Só usar os sinais do bot quando ele está ativo (senão a app gera os seus)
        if (val && typeof val === "object" && botActiveRef.current) setMarketSignals(val);
      });
    }).catch(() => {});
    return () => { unsubTrades?.(); unsubBal?.(); unsubBalLive?.(); unsubTradeable?.(); unsubMktPrices?.(); unsubStrat?.(); unsubSettings?.(); unsubLive?.(); unsubLiveLegacy?.(); unsubReal?.(); unsubCtrl?.(); unsubArch?.(); unsubDt?.(); unsubBot?.(); unsubSig?.(); unsubDaily?.(); unsubBrokers?.(); unsubLogs?.(); unsubPriceStats?.(); unsubRegimeLog?.(); unsubManual?.(); };
  }, [user?.uid]);

  // ── Persistência: guardar trade quando aberto ─────────────────────────────
  // (chamado explicitamente nas funções de compra/venda)

  // ── Auth gate (after all hooks) ──────────────────────────────────────────
  const ALLOWED_EMAIL = "koresma@gmail.com";
  if (authLoading) return (
    <div style={{ minHeight:"100vh", background:"#06061a", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"sans-serif" }}>
      <div style={{ color:"#6b7280", fontSize:14 }}>◌  A carregar…</div>
    </div>
  );
  if (!user) return <LoginScreen />;
  if (user.email?.toLowerCase() !== ALLOWED_EMAIL) {
    logout();
    return (
      <div style={{ minHeight:"100vh", background:"#06061a", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"sans-serif", flexDirection:"column", gap:16 }}>
        <div style={{ fontSize:40 }}>🔒</div>
        <div style={{ color:"#e2e8f0", fontSize:18, fontWeight:700 }}>Acesso Restrito</div>
        <div style={{ color:"#6b7280", fontSize:13 }}>Esta app é privada.</div>
      </div>
    );
  }

  return (
    <div style={{
      background: T.bg, minHeight: "100vh", color: T.text,
      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 13,
      backgroundImage:
        "radial-gradient(circle at 15% 15%, rgba(99,102,241,0.09) 0%, transparent 55%), " +
        "radial-gradient(circle at 85% 85%, rgba(16,185,129,0.06) 0%, transparent 55%)",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:5px; height:5px; }
        ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:4px; }
        input::placeholder { color:rgba(107,114,128,0.5); }
        input:focus { outline: none; border-color: rgba(99,102,241,0.6) !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.1) !important; }
        select { color: #e8ecf8; background-color: #0d0d28; }
        select option { background-color: #0d0d28 !important; color: #e8ecf8 !important; }
        select:focus { outline: none; border-color: rgba(124,122,255,0.6) !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }

        /* ── RESPONSIVE — Mobile ── */
        @media (max-width: 820px) {
          /* Colapsar todas as grelhas multi-coluna para 1 coluna */
          .resp-grid { grid-template-columns: 1fr !important; }
          .resp-grid-2 { grid-template-columns: repeat(2,1fr) !important; }
          /* Esconder scrollbar horizontal de tabelas, permitir scroll */
          .resp-scroll { overflow-x: auto !important; -webkit-overflow-scrolling: touch; }
          /* Header mobile mais compacto */
          .resp-header { padding: 0 12px !important; }
          .resp-header-info { gap: 8px !important; font-size: 10px !important; }
          .resp-hide-mobile { display: none !important; }
          /* Cards e padding menores */
          .resp-main { padding: 12px !important; padding-bottom: 90px !important; }
          /* Hero do dashboard empilha */
          .resp-hero { grid-template-columns: 1fr 1fr !important; gap: 16px !important; }
        }
        @media (max-width: 480px) {
          .resp-grid-2 { grid-template-columns: 1fr !important; }
          .resp-hero { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* HEADER */}
      <header className="resp-header" style={{
        height: 56, background: "rgba(6,6,26,0.88)", backdropFilter: "blur(20px)",
        borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 24px", position: "sticky", top: 0, zIndex: 200,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30,
            background: "linear-gradient(135deg,#6366f1,#10b981)",
            borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 700,
          }}>◆</div>
          <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.02em" }}>
            TradeAI <span className="resp-hide-mobile" style={{ color: T.muted, fontWeight: 400, fontSize: 13 }}>Simulator</span>
          </span>
        </div>
        <div className="resp-header-info" style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 12 }}>
          {/* ── TOGGLE SIMULAÇÃO / LIVE ── */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (simMode) {
                const indoReal = botModoReal; // o bot está mesmo em dinheiro real?
                setConfirmModal({
                  danger: indoReal,
                  title: indoReal ? "Ativar modo DINHEIRO REAL?" : "Ativar modo Live (Paper)?",
                  message: indoReal
                    ? "O bot está em modo REAL. Os trades são executados com dinheiro REAL na tua corretora."
                    : "O bot está em modo PAPER (dinheiro fictício na Alpaca). Vais ver e controlar as posições de paper — não é dinheiro real.",
                  lines: indoReal
                    ? ["Perdas em modo REAL são dinheiro real perdido", "Confirma que é mesmo isto que queres", "Podes voltar a Simulação a qualquer momento"]
                    : ["É paper trading — dinheiro fictício, sem risco real", "Serve para validar antes do dinheiro a sério", "Podes voltar a Simulação a qualquer momento"],
                  confirmLabel: indoReal ? "Ativar DINHEIRO REAL" : "Ativar Paper",
                  onConfirm: () => {
                    setSimMode(false);
                    simModeRef.current = false;
                    toast(indoReal ? "● Modo REAL ativado — dinheiro real" : "📝 Modo Paper ativado — dinheiro fictício", indoReal ? "warn" : "success");
                  },
                });
              } else {
                setSimMode(true);
                simModeRef.current = true;
                toast("◎ Modo Simulação ativado", "success");
              }
            }}
            style={{
              display: "flex", alignItems: "center", gap: 0,
              background: "rgba(0,0,0,0.35)",
              border: `1px solid ${simMode ? T.green+"44" : T.red+"55"}`,
              borderRadius: 99, overflow: "hidden", cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            <div style={{
              padding: "5px 14px", fontSize: 10, fontWeight: 700, letterSpacing: "0.09em",
              background: simMode ? `${T.green}22` : "transparent",
              color: simMode ? T.green : T.muted,
              transition: "all 0.2s",
            }}>
              ◎ SIMULAÇÃO
            </div>
            <div style={{ width: 1, height: 20, background: simMode ? T.green+"33" : T.red+"33" }} />
            <div style={{
              padding: "5px 14px", fontSize: 10, fontWeight: 700, letterSpacing: "0.09em",
              background: !simMode ? `${T.red}22` : "transparent",
              color: !simMode ? T.red : T.muted,
              transition: "all 0.2s",
            }}>
              {botModoReal ? "● REAL" : botModoPaper ? "● PAPER" : "● LIVE"}
            </div>
          </div>
          {!simMode && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, background: botModoReal ? `${T.red}14` : `${T.gold}14`, border: `1px solid ${botModoReal ? T.red : T.gold}33`, borderRadius: 99, padding: "3px 12px" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: botModoReal ? T.red : T.gold, animation: "pulse 1.5s infinite" }} />
              <span style={{ color: botModoReal ? T.red : T.gold, fontWeight: 700, fontSize: 10, letterSpacing: "0.1em" }}>
                {botModoReal ? "LIVE — DINHEIRO REAL" : botModoPaper ? "PAPER — dinheiro fictício" : "LIVE — a verificar modo…"}
              </span>
            </div>
          )}
          <span className="resp-hide-mobile" style={{ color: T.muted }}>Portfólio: <b style={{ color: T.text }}>€{portfolioV.toFixed(2)}</b></span>
          <span style={{ color: T.muted }}>P&L: <b style={{ color: totalPnl >= 0 ? T.green : T.red }}>{sign(totalPnl)}{eur(totalPnl)}</b></span>

          {/* User + logout */}
          <div style={{ display:"flex", alignItems:"center", gap:8, paddingLeft:10, borderLeft:`1px solid ${T.border}` }}>
            {user.photoURL
              ? <img src={user.photoURL} alt="" style={{ width:28, height:28, borderRadius:"50%", border:`1px solid ${T.border}` }} />
              : <div style={{ width:28, height:28, borderRadius:"50%", background:`${T.accent}33`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, color:T.aLight }}>
                  {(user.displayName||user.email||"?")[0].toUpperCase()}
                </div>
            }
            <div style={{ fontSize:11 }}>
              <div style={{ color:T.text, fontWeight:600, maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {user.displayName?.split(" ")[0] || user.email}
              </div>
            </div>
            <button onClick={logout} style={{
              background:"rgba(255,255,255,0.05)", border:`1px solid ${T.border}`,
              borderRadius:6, padding:"4px 10px", fontSize:10, color:T.muted,
              cursor:"pointer", fontFamily:"inherit", fontWeight:600,
            }}>Sair</button>
          </div>
        </div>
      </header>

      <div style={{ display: "flex" }}>
        {/* SIDEBAR — desktop only */}
        {!isMobile && (
        <nav style={{
          width: 200, background: "rgba(11,11,34,0.7)", backdropFilter: "blur(20px)",
          borderRight: `1px solid ${T.border}`,
          height: "calc(100vh - 56px)", position: "sticky", top: 56,
          display: "flex", flexDirection: "column", padding: "10px 0",
        }}>
          {NAV.filter(item => !item.mobileOnly).map(item => {
            const zonaAtiva = zonaDoTab(tab) === item.id || tab === item.id;
            const irPara = item.group ? item.group[0] : item.id;
            // Badge de notificação por zona
            let badge = 0;
            if (item.id === "investir") badge = manualOrders.length;
            else if (item.id === "lab") badge = strategies.filter(s => s.ativo).length;
            return (
              <div key={item.id} onClick={() => setTab(irPara)} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "12px 18px", cursor: "pointer", fontSize: 12.5, fontWeight: 700,
                color:      zonaAtiva ? "#fff" : T.muted,
                background: zonaAtiva ? T.gradCard : "transparent",
                borderLeft: `3px solid ${zonaAtiva ? T.accent : "transparent"}`,
                transition: "all 0.15s",
              }}>
                <span style={{ fontSize: 16, opacity: zonaAtiva ? 1 : 0.6 }}>{item.icon}</span>
                <span>{item.label}</span>
                {badge > 0 && (
                  <span style={{ marginLeft: "auto", background: item.id === "investir" ? T.gold : T.accent, color: item.id === "investir" ? "#000" : "#fff", borderRadius: 99, minWidth: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, padding: "0 5px" }}>
                    {badge}
                  </span>
                )}
              </div>
            );
          })}
          <div style={{ marginTop: "auto", padding: "16px 18px", borderTop: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>Posições Abertas</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{activePositions.length}</div>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 10, marginBottom: 4 }}>P&L Não Realizado</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: unrealized >= 0 ? T.green : T.red }}>
              {sign(unrealized)}{eur(unrealized)}
            </div>
          </div>
        </nav>
        )}

        {/* MAIN */}
        <main className="resp-main" style={{ flex: 1, padding: "22px", paddingBottom: simMode ? 90 : 22, overflowY: "auto", maxHeight: isMobile ? "none" : "calc(100vh - 56px)" }}>
          {/* Barra de sub-abas (quando estás numa zona agrupada) */}
          {(() => {
            const zona = zonaDoTab(tab);
            const subs = SUBTABS[zona];
            if (!subs) return null;
            return (
              <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap", borderBottom: `1px solid ${T.border}`, paddingBottom: 0 }}>
                {subs.map(s => {
                  const ativo = tab === s.id;
                  let badge = 0;
                  if (s.id === "dca") badge = manualOrders.length;
                  else if (s.id === "portfolio") badge = activePositions.length;
                  else if (s.id === "strategies") badge = strategies.filter(x => x.ativo).length;
                  return (
                    <div key={s.id} onClick={() => setTab(s.id)} style={{
                      display: "flex", alignItems: "center", gap: 7, padding: "10px 16px", cursor: "pointer",
                      fontSize: 12.5, fontWeight: 700, position: "relative",
                      color: ativo ? "#fff" : T.muted,
                      borderBottom: `2px solid ${ativo ? T.accent : "transparent"}`,
                      marginBottom: -1, transition: "all 0.15s",
                    }}>
                      <span style={{ fontSize: 14, opacity: ativo ? 1 : 0.6 }}>{s.icon}</span>
                      <span>{s.label}</span>
                      {badge > 0 && (
                        <span style={{ background: s.id === "dca" ? T.gold : T.accent, color: s.id === "dca" ? "#000" : "#fff", borderRadius: 99, minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, padding: "0 4px" }}>{badge}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div style={{ animation: "fadeIn 0.25s ease" }} key={tab}>
            {tab === "resumo"     && MobileResumo()}
            {tab === "dashboard"  && Dashboard()}
            {tab === "dca"        && PlanoDCA()}
            {tab === "relatorio"  && Relatorio()}
            {tab === "portfolio"  && Portfolio()}
            {tab === "markets"    && <Markets />}
            {tab === "strategies" && <Strategies />}
            {tab === "ai"         && AIIntel()}
            {tab === "history"    && History()}
            {tab === "sugestoes"  && Sugestoes()}
            {tab === "messages"   && Messages()}
            {tab === "daytrading" && DayTrading()}
            {tab === "settings"   && Settings()}
            {tab === "guide"      && Guide()}
          </div>
        </main>
      </div>

      {/* ── MOBILE BOTTOM NAV ── */}
      {isMobile && (
        <nav style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 400,
          background: "rgba(6,6,26,0.96)", backdropFilter: "blur(20px)",
          borderTop: `1px solid ${T.border}`,
          display: "flex", overflowX: "auto", padding: "6px 4px",
          paddingBottom: "max(6px, env(safe-area-inset-bottom))",
        }}>
          {NAV.map(item => {
            const active = zonaDoTab(tab) === item.id || tab === item.id;
            const irPara = item.group ? item.group[0] : item.id;
            const badge = item.id === "investir" ? manualOrders.length
                        : item.id === "lab"      ? strategies.filter(s => s.ativo).length
                        : 0;
            return (
              <div key={item.id} onClick={() => { setTab(irPara); window.scrollTo(0,0); }} style={{
                flex: "0 0 auto", minWidth: 62, display: "flex", flexDirection: "column",
                alignItems: "center", gap: 3, padding: "6px 8px", cursor: "pointer",
                position: "relative",
                color: active ? "#fff" : T.muted,
              }}>
                <span style={{ fontSize: 18, opacity: active ? 1 : 0.6 }}>{item.icon}</span>
                <span style={{ fontSize: 8.5, fontWeight: active ? 700 : 500, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>{item.label}</span>
                {active && <div style={{ position: "absolute", top: 0, width: 24, height: 2, background: T.accent, borderRadius: 2 }} />}
                {badge > 0 && (
                  <span style={{ position: "absolute", top: 2, right: 10, background: item.id==="investir"?T.gold:T.accent,
                    color: item.id==="investir"?"#000":"#fff", borderRadius: 99, minWidth: 14, height: 14,
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, padding: "0 3px" }}>
                    {badge}
                  </span>
                )}
              </div>
            );
          })}
        </nav>
      )}

      {/* ── MODAL DE CONFIRMAÇÃO BONITO ── */}
      {confirmModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 7000, backdropFilter: "blur(8px)", padding: 16,
          animation: "fadeIn 0.2s ease",
        }} onClick={() => setConfirmModal(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: T.base,
            border: `1px solid ${confirmModal.danger ? T.red : T.accent}44`,
            borderRadius: 18, padding: isMobile ? "26px 22px" : "32px 36px",
            width: isMobile ? "calc(100vw - 32px)" : 460, maxWidth: "calc(100vw - 32px)",
            boxShadow: `0 20px 80px ${confirmModal.danger ? T.red : T.accent}22`,
          }}>
            <div style={{ fontSize: 38, marginBottom: 14, textAlign: "center" }}>
              {confirmModal.danger ? "⚠️" : confirmModal.icon || "❓"}
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, textAlign: "center", marginBottom: 10, letterSpacing: "-0.01em" }}>
              {confirmModal.title}
            </div>
            {confirmModal.message && (
              <div style={{ fontSize: 13, color: T.muted, textAlign: "center", lineHeight: 1.6, marginBottom: confirmModal.lines ? 16 : 24 }}>
                {confirmModal.message}
              </div>
            )}
            {confirmModal.lines && (
              <div style={{
                background: `${confirmModal.danger ? T.red : T.accent}0c`,
                border: `1px solid ${confirmModal.danger ? T.red : T.accent}22`,
                borderRadius: 12, padding: "14px 16px", marginBottom: 24,
              }}>
                {confirmModal.lines.map((line, i) => (
                  <div key={i} style={{ fontSize: 12, color: T.text, lineHeight: 1.7, display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: confirmModal.danger ? T.red : T.accent, flexShrink: 0 }}>•</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => setConfirmModal(null)} style={{
                flex: 1, background: "rgba(255,255,255,0.05)", border: `1px solid ${T.border}`,
                borderRadius: 11, padding: "13px", fontSize: 13, color: T.muted,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
              }}>{confirmModal.cancelLabel || "Cancelar"}</button>
              {confirmModal.extraLabel && (
                <button onClick={() => { const fn = confirmModal.onExtra; setConfirmModal(null); fn?.(); }} style={{
                  flex: 1.2, background: "rgba(255,255,255,0.05)", border: `1px solid ${T.border}`,
                  borderRadius: 11, padding: "13px", fontSize: 12, color: T.aLight,
                  cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
                }}>{confirmModal.extraLabel}</button>
              )}
              {confirmModal.extra2Label && (
                <button onClick={() => { const fn = confirmModal.onExtra2; setConfirmModal(null); fn?.(); }} style={{
                  flex: 1.3, background: `${T.accent}1e`, border: `1px solid ${T.accent}55`,
                  borderRadius: 11, padding: "13px", fontSize: 12, color: T.aLight,
                  cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
                }}>{confirmModal.extra2Label}</button>
              )}
              <button onClick={() => {
                const fn = confirmModal.onConfirm;
                setConfirmModal(null);
                fn?.();
              }} style={{
                flex: 1.4,
                background: confirmModal.danger ? `${T.red}1e` : `${T.green}1e`,
                border: `1px solid ${confirmModal.danger ? T.red : T.green}55`,
                borderRadius: 11, padding: "13px", fontSize: 13,
                color: confirmModal.danger ? T.red : T.green,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 800,
              }}>{confirmModal.confirmLabel || "Confirmar"}</button>
            </div>
          </div>
        </div>
      )}

      {/* TOASTS */}
      <div style={{ position: "fixed", bottom: 20, right: 20, display: "flex", flexDirection: "column", gap: 8, zIndex: 9999, maxWidth: 330 }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            background:
              t.type === "success" ? `rgba(16,185,129,0.12)` :
              t.type === "buy"     ? `rgba(99,102,241,0.12)` :
              t.type === "warn"    ? `rgba(245,158,11,0.12)` :
                                     `rgba(244,63,94,0.12)`,
            border: `1px solid ${t.type === "success" ? T.green : t.type === "buy" ? T.accent : t.type === "warn" ? T.gold : T.red}44`,
            borderRadius: 10, padding: "10px 16px", fontSize: 12,
            backdropFilter: "blur(12px)", boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
            animation: "fadeIn 0.2s ease",
          }}>{t.msg}</div>
        ))}
      </div>

      {/* ── PAINEL SIMULAÇÃO FLUTUANTE ── */}
      {simMode && (
        <div style={{
          position: "fixed",
          bottom: isMobile ? 76 : 20,
          left:   isMobile ? 8 : 212,
          right:  isMobile ? 8 : "auto",
          zIndex: 1000,
          background: "rgba(6,6,26,0.96)", backdropFilter: "blur(16px)",
          border: `1px solid ${T.green}33`, borderRadius: 14,
          padding: "14px 18px",
          minWidth: isMobile ? "auto" : 320,
          maxWidth: isMobile ? "none" : 360,
          boxShadow: `0 0 32px rgba(16,185,129,0.1)`,
        }}>
          {/* Header painel */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: simMinimized ? 0 : 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: T.green, animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: T.green, letterSpacing: "0.09em" }}>{
                (() => {
                  const m = (botStatus?.mode || "").toLowerCase();
                  if (!simMode) return m === "real" ? "LIVE EM CURSO" : m === "paper" ? "PAPER EM CURSO" : "LIVE EM CURSO";
                  return "SIMULAÇÃO EM CURSO";
                })()
              }</span>
              {simMinimized && (() => {
                // Valor TOTAL da simulação = saldo livre + investido + P&L não realizado.
                // (antes usava só o saldo livre, dando uma % errada tipo -82%)
                const simInvested   = simPositions.reduce((s, p) => s + (p.amount || 0), 0);
                const simUnrealized = simPositions.reduce((s, p) => {
                  const a = ASSETS.find(x => x.id === p.assetId);
                  const px = a ? (mktData[a.id]?.price ?? a.price) : null;
                  return s + (px ? (px - p.entryPrice) * p.units : 0);
                }, 0);
                const simEquity = simBalance + simInvested + simUnrealized;
                const pct = simCapital > 0 ? ((simEquity - simCapital) / simCapital) * 100 : 0;
                return (
                  <span style={{ fontSize:11, color:simEquity>=simCapital?T.green:T.red, fontWeight:700, marginLeft:6 }}>
                    €{simEquity.toFixed(2)} ({sign(simEquity-simCapital)}{Math.abs(pct).toFixed(1)}%)
                  </span>
                );
              })()}
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={() => setSimMinimized(p => !p)}
                style={{ background:"rgba(255,255,255,0.06)", border:`1px solid ${T.border}`, borderRadius:6, padding:"3px 8px", fontSize:10, color:T.muted, cursor:"pointer", fontFamily:"inherit" }}>
                {simMinimized ? "▲" : "▼"}
              </button>
              {(() => {
                const simAtiva = simPositions.length > 0 || simClosed.length > 0;
                return simAtiva ? (
                  <button onClick={finishSim}
                    style={{ background:`${T.red}18`, border:`1px solid ${T.red}33`, borderRadius:6, padding:"3px 10px", fontSize:10, color:T.red, cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>
                    ■ Terminar
                  </button>
                ) : (
                  <button onClick={() => {
                    setSimStartedAt(new Date());
                    const nAtivas = strategies.filter(s => s.ativo).length;
                    if (nAtivas > 0) toast(`◎ Simulação iniciada! ${nAtivas} estratégia(s) ativa(s) vão operar.`, "success");
                    else toast("◎ Simulação iniciada! Cria/ativa estratégias ou compra manualmente.", "info");
                  }}
                    style={{ background:`${T.green}18`, border:`1px solid ${T.green}33`, borderRadius:6, padding:"3px 10px", fontSize:10, color:T.green, cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>
                    ▶ Começar
                  </button>
                );
              })()}
            </div>
          </div>
          {!simMinimized && <div>
          {/* Capital selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px" }}>
            <span style={{ fontSize: 10, color: T.muted, whiteSpace: "nowrap" }}>Capital SIM:</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>€</span>
            <input
              type="number" value={simCapital}
              onChange={e => {
                const v = Math.max(10, +e.target.value || 100);
                setSimCapital(v);
                setSimBalance(v);
                simBalRef.current = v;
                setSimPositions([]); simPosRef.current = [];
                setSimClosed([]);
                setSimStartedAt(new Date());
              }}
              style={{ width: 90, background: "transparent", border: "none", color: T.aLight, fontSize: 15, fontWeight: 800, fontFamily: "inherit", outline: "none" }}
            />
            <span style={{ fontSize: 9, color: T.muted, marginLeft: "auto" }}>↵ para reiniciar</span>
          </div>
          {/* Stats — TODAS as posições (manuais + estratégias + day trading) */}
          {(() => {
            const unrealSim = simPositions.reduce((sum, pos) => {
              const a = resolveAsset(pos);
              return sum + (a ? (a.price - pos.entryPrice) * pos.units : 0);
            }, 0);
            const capInvestido = simPositions.reduce((s,p) => s+p.amount, 0);
            // P&L total = realizado (trades fechados) + não-realizado (abertas).
            // NÃO usar (saldo+investido+unreal - simCapital): se o saldo no servidor
            // e as posições visíveis não baterem certo (posições órfãs), isso
            // inventaria perdas falsas como o antigo "-€160".
            const realizadoSim = simClosed.reduce((s,t) => s + (t.pnl || 0), 0);
            const pnlTotal = +(realizadoSim + unrealSim).toFixed(2);
            const roiTotal = simCapital > 0 ? (pnlTotal / simCapital) * 100 : 0;
            // Separar por origem
            const porOrigem = { manual: 0, estrategia: 0, daytrading: 0, aibrain: 0 };
            simPositions.forEach(p => {
              if (p.stratId === "manual") porOrigem.manual++;
              else if (p.stratId === "daytrading") porOrigem.daytrading++;
              else if (p.stratId === "ai-brain") porOrigem.aibrain++;
              else porOrigem.estrategia++;
            });
            // "Capital em uso": medir contra o que REALMENTE tens disponível
            // agora (saldo livre + já investido), não contra o capital INICIAL.
            // Com lucros acumulados o saldo cresce acima do capital inicial; usar
            // o inicial dava leituras falsas tipo 112%. Esta base é o património
            // de trabalho atual e nunca ultrapassa 100% sem sobre-alavancagem real.
            const baseDisponivel = simBalance + capInvestido; // saldo livre + investido
            const pctUsado = baseDisponivel > 0 ? (capInvestido / baseDisponivel) * 100 : 0;
            return (
              <>
                {/* Barra de capital usado */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.muted, marginBottom: 4 }}>
                    <span>CAPITAL EM USO: €{capInvestido.toFixed(2)} de €{baseDisponivel.toFixed(2)}</span>
                    <span>{pctUsado.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 99, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, pctUsado)}%`, background: pctUsado > 90 ? T.red : pctUsado > 70 ? T.gold : T.green, borderRadius: 99, transition: "width 0.3s" }} />
                  </div>
                  {pctUsado > 90 && <div style={{ fontSize: 8, color: T.red, marginTop: 3 }}>⚠ Capital quase esgotado — novas compras serão bloqueadas</div>}
                </div>
                {/* Valor total + ROI */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                  {[
                    { l: "Valor Total",  v: `€${(simCapital + pnlTotal).toFixed(2)}`,                  c: T.text },
                    { l: "P&L Total",    v: `${sign(pnlTotal)}€${Math.abs(pnlTotal).toFixed(2)}`,   c: pnlTotal>=0?T.green:T.red },
                    { l: "ROI",          v: `${sign(roiTotal)}${Math.abs(roiTotal).toFixed(1)}%`,    c: pnlTotal>=0?T.green:T.red },
                  ].map(s => (
                    <div key={s.l} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: "7px 9px" }}>
                      <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>{s.l}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
                    </div>
                  ))}
                </div>
                {/* Saldo livre + posições por origem */}
                {(() => {
                  // Win rate REAL: conta os ganhos fechados sobre TODAS as posições
                  // resolvidas + as abertas que estão NESTE momento em perda. Sem
                  // isto, a win rate parece inflada (os vencedores fecham cedo com
                  // micro-lucro e os perdedores ficam abertos sem contar).
                  const closedWins = simClosed.filter(t => (t.pnl || 0) > 0).length;
                  const closedLosses = simClosed.filter(t => (t.pnl || 0) <= 0).length;
                  const openLosers = simPositions.filter(p => {
                    const a = assets.find(x => x.id === p.assetId);
                    const price = a?.price || p.entryPrice;
                    return (price - p.entryPrice) * p.units < 0;
                  }).length;
                  const denom = closedWins + closedLosses + openLosers;
                  const wrReal = denom ? (closedWins / denom) * 100 : null;
                  const wrClosed = simClosed.length ? (closedWins / simClosed.length) * 100 : null;
                  return (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                  {[
                    { l: "Saldo Livre", v: `€${simBalance.toFixed(2)}`, c: T.text },
                    { l: "P&L Aberto",  v: `${sign(unrealSim)}€${Math.abs(unrealSim).toFixed(2)}`, c: unrealSim>=0?T.green:T.red },
                    { l: "Win Real", v: wrReal !== null ? `${wrReal.toFixed(0)}%` : "—", c: wrReal !== null && wrReal >= 50 ? T.green : T.gold,
                      sub: wrClosed !== null ? `fechadas: ${wrClosed.toFixed(0)}%` : null },
                  ].map(s => (
                    <div key={s.l} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: "7px 9px" }}>
                      <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>{s.l}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
                      {s.sub && <div style={{ fontSize: 7, color: T.muted, marginTop: 2 }}>{s.sub}</div>}
                    </div>
                  ))}
                </div>
                  );
                })()}
                {/* Posições abertas por origem */}
                <div style={{ display: "flex", gap: 6, fontSize: 9, flexWrap: "wrap" }}>
                  <span style={{ background: `${T.blue}18`, color: T.blue, padding: "3px 8px", borderRadius: 99 }}>🤖 AI Brain: {porOrigem.aibrain}</span>
                  <span style={{ background: `${T.accent}18`, color: T.aLight, padding: "3px 8px", borderRadius: 99 }}>🎯 Estratégias: {porOrigem.estrategia}</span>
                  <span style={{ background: `${T.gold}18`, color: T.gold, padding: "3px 8px", borderRadius: 99 }}>⚡ Day Trading: {porOrigem.daytrading}</span>
                  <span style={{ background: "rgba(255,255,255,0.06)", color: T.muted, padding: "3px 8px", borderRadius: 99 }}>✋ Manuais: {porOrigem.manual}</span>
                  <span style={{ background: "rgba(255,255,255,0.06)", color: T.muted, padding: "3px 8px", borderRadius: 99 }}>Fechados: {simClosed.length}</span>
                </div>
              </>
            );
          })()}
          {/* Mini trade log */}
          {simClosed.length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 100, overflowY: "auto" }}>
              {simClosed.slice(0, 6).map(t => (
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${T.border}22`, fontSize: 10 }}>
                  <span style={{ color: T.muted }}>{t.assetSym} · {t.openedAt}</span>
                  <span style={{ fontWeight: 700, color: t.pnl >= 0 ? T.green : T.red }}>{sign(t.pnl)}€{Math.abs(t.pnl).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          </div>}
        </div>
      )}

      {/* ── MODAL RESUMO FINAL DA SIMULAÇÃO ── */}
      {simSummary && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 6000, backdropFilter: "blur(10px)",
        }}>
          <div style={{
            background: T.base, border: `1px solid ${simSummary.roi >= 0 ? T.green : T.red}44`,
            borderRadius: 20, padding: isMobile ? "24px 18px" : "36px 40px", width: isMobile ? "calc(100vw - 24px)" : 560, maxWidth: "calc(100vw - 24px)", maxHeight: "88vh", overflowY: "auto",
            boxShadow: `0 0 80px ${simSummary.roi >= 0 ? T.green : T.red}18`, position: "relative",
          }}>
            {/* Botão fechar */}
            <button onClick={() => setSimSummary(null)} style={{
              position: "absolute", top: 16, right: 16, width: 32, height: 32,
              background: "rgba(255,255,255,0.06)", border: `1px solid ${T.border}`,
              borderRadius: 8, color: T.muted, cursor: "pointer", fontSize: 16,
              fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center",
            }}>✕</button>
            {/* Header */}
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={{ fontSize: 48, marginBottom: 10 }}>{simSummary.roi >= 0 ? "🏆" : "📉"}</div>
              <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Resumo da Simulação</div>
              <div style={{ fontSize: 12, color: T.muted }}>Terminada em {simSummary.terminadaEm} · {simSummary.duration} minutos</div>
            </div>
            {/* Resultado principal */}
            <div style={{
              background: `${simSummary.roi >= 0 ? T.green : T.red}0e`,
              border: `1px solid ${simSummary.roi >= 0 ? T.green : T.red}30`,
              borderRadius: 14, padding: "22px 24px", marginBottom: 22, textAlign: "center",
            }}>
              <div style={{ fontSize: 11, color: T.muted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8 }}>Saldo Final</div>
              <div style={{ fontSize: 44, fontWeight: 800, color: simSummary.roi >= 0 ? T.green : T.red }}>€{simSummary.saldoFinal.toFixed(2)}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: simSummary.roi >= 0 ? T.green : T.red, marginTop: 6 }}>
                {sign(simSummary.totalPnl)}€{Math.abs(simSummary.totalPnl).toFixed(2)} ({sign(simSummary.roi)}{Math.abs(simSummary.roi).toFixed(2)}%)
              </div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>Capital inicial: €{simSummary.capitalInicial}</div>
            </div>
            {/* Stats grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 22 }}>
              {[
                { l: "Total Trades",  v: simSummary.totalTrades, c: T.accent },
                { l: "Ganhos",        v: simSummary.wins,         c: T.green  },
                { l: "Perdas",        v: simSummary.losses,       c: T.red    },
                { l: "Win Rate",      v: `${simSummary.winRate.toFixed(1)}%`,  c: simSummary.winRate >= 50 ? T.green : T.red },
                { l: "Melhor Trade",  v: simSummary.trades.length ? `+€${Math.max(...simSummary.trades.map(t=>t.pnl||0)).toFixed(2)}` : "—", c: T.green },
                { l: "Pior Trade",    v: simSummary.trades.length ? `-€${Math.abs(Math.min(...simSummary.trades.map(t=>t.pnl||0))).toFixed(2)}` : "—", c: T.red },
              ].map(s => (
                <div key={s.l} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "14px 16px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>{s.l}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: s.c }}>{s.v}</div>
                </div>
              ))}
            </div>
            {/* Lista trades */}
            {simSummary.trades.length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>Histórico de Trades</div>
                <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {simSummary.trades.map(t => (
                    <div key={t.id} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: `${t.pnl >= 0 ? T.green : T.red}0a`,
                      border: `1px solid ${t.pnl >= 0 ? T.green : T.red}22`,
                      borderRadius: 8, padding: "9px 14px", fontSize: 11,
                    }}>
                      <div>
                        <span style={{ fontWeight: 700 }}>{t.assetSym}</span>
                        <span style={{ color: T.muted, marginLeft: 8 }}>entrada ${t.entryPrice?.toFixed(2)} → saída {Number.isFinite(+t.closePrice) ? `$${t.closePrice.toFixed(2)}` : "—"}</span>
                      </div>
                      <span style={{ fontWeight: 800, color: t.pnl >= 0 ? T.green : T.red }}>
                        {sign(t.pnl)}€{Math.abs(t.pnl||0).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Conclusão IA */}
            <div style={{ background: `${T.accent}0a`, border: `1px solid ${T.accent}22`, borderRadius: 10, padding: "14px 16px", marginBottom: 24, fontSize: 12, color: T.muted, lineHeight: 1.7 }}>
              {simSummary.winRate >= 55 && simSummary.roi >= 0
                ? `✅ Boa simulação! Win rate de ${simSummary.winRate.toFixed(0)}% e ROI de +${simSummary.roi.toFixed(1)}%. Se estes resultados se mantiverem consistentes por 15 dias, podes considerar passar para modo LIVE com confiança.`
                : simSummary.roi >= 0
                ? `⚠ Resultado positivo mas win rate abaixo de 55%. Continua a simular mais alguns dias para validar a estratégia antes de passar para LIVE.`
                : `📉 Simulação negativa (${simSummary.roi.toFixed(1)}%). Ajusta as estratégias nas Definições antes de arriscar dinheiro real.`}
            </div>
            {/* Botões */}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => {
                setSimSummary(null);
                setSimBalance(simCapital);
                simBalRef.current = simCapital;
                setSimPositions([]); simPosRef.current = [];
                setSimClosed([]);
                setSimStartedAt(new Date());
                toast("◎ Nova simulação iniciada!", "success");
              }} style={{
                flex: 1, background: `${T.accent}18`, border: `1px solid ${T.accent}44`,
                borderRadius: 10, padding: "13px", fontSize: 13, color: T.aLight,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
              }}>◎ Nova Simulação</button>
              <button onClick={() => {
                setSimSummary(null);
                if (simSummary.roi > 0 && simSummary.winRate >= 50) {
setConfirmModal({
                    danger: true,
                    title: "Passar para LIVE?",
                    message: "Vais começar a operar com dinheiro real com base nestes resultados de simulação.",
                    lines: ["Resultados em simulação não garantem lucro real", "Começa com pouco capital"],
                    confirmLabel: "Passar para LIVE",
                    onConfirm: () => { setSimMode(false); simModeRef.current = false; },
                  });
                }
              }} style={{
                flex: 1, background: `${T.green}18`, border: `1px solid ${T.green}44`,
                borderRadius: 10, padding: "13px", fontSize: 13, color: T.green,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
              }}>● Passar para LIVE</button>
            </div>
            {/* Fechar sem ação */}
            <button onClick={() => setSimSummary(null)} style={{
              width: "100%", marginTop: 10, background: "transparent",
              border: `1px solid ${T.border}`, borderRadius: 10, padding: "11px",
              fontSize: 12, color: T.muted, cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
            }}>Fechar (continuar depois)</button>
          </div>
        </div>
      )}
    </div>
  );
}
