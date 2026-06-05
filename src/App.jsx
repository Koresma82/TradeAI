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
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens, system, messages }),
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
  bg:    "#06061a",
  base:  "#0b0b22",
  card:  "rgba(255,255,255,0.045)",
  border:"rgba(255,255,255,0.08)",
  accent:"#6366f1",
  aLight:"#a5b4fc",
  green: "#10b981",
  red:   "#f43f5e",
  gold:  "#f59e0b",
  blue:  "#3b82f6",
  text:  "#e2e8f0",
  muted: "#6b7280",
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
const pctFmt = v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const riskC = r => r === "ALTO" ? T.red : r === "MÉDIO" ? T.gold : T.green;
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
      background: T.card,
      border: `1px solid ${glow ? T.accent + "55" : T.border}`,
      borderRadius: 16,
      backdropFilter: "blur(16px)",
      boxShadow: glow
        ? `0 0 32px rgba(99,102,241,0.14), inset 0 1px 0 rgba(255,255,255,0.06)`
        : `inset 0 1px 0 rgba(255,255,255,0.04)`,
      ...style,
    }}>{children}</div>
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
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: solid ? color : `${color}15`,
      color: solid ? "#fff" : color,
      border: `1px solid ${solid ? color + "aa" : color + "44"}`,
      borderRadius: sm ? 8 : 10,
      padding: sm ? "5px 12px" : "10px 20px",
      fontSize: sm ? 11 : 12, fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "inherit", opacity: disabled ? 0.45 : 1,
      transition: "all 0.14s", letterSpacing: "0.05em",
      width: full ? "100%" : "auto", ...style,
    }}>{children}</button>
  );
}

function SectionLabel({ children }) {
  return <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}

// ─── APP ─────────────────────────────────────────────────────────────────────
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
  const [simMode, setSimMode] = useState(true);   // true = simulação | false = live real
  const simModeRef = useRef(true);
  const [liveSettings, setLiveSettings] = useState({      // definições separadas para live
    capitalTotal: 1000, modoValor: "fixo", valorFixo: 50,
    percentagem: 3, riscoPerfil: "conservador",
    maxPosicoesAbertas: 3, stopLossPadrao: 5, takeProfitPadrao: 10, autoInvestir: false,
  });
  const liveSettingsRef = useRef({ capitalTotal:1000, modoValor:"fixo", valorFixo:50, percentagem:3,
    riscoPerfil:"conservador", maxPosicoesAbertas:3, stopLossPadrao:5, takeProfitPadrao:10, autoInvestir:false });
  const [histTab, setHistTab] = useState("sim");   // "sim" | "live"
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
  const [histOpenDay, setHistOpenDay] = useState(null); // dia de arquivo expandido no histórico
  const [simStartedAt, setSimStartedAt] = useState(null); // timestamp início
  const simBalRef   = useRef(1000);
  const simPosRef   = useRef([]);
  const simStartedRef = useRef(false); // true quando a simulação está em curso

  const [tab, setTab]             = useState("dashboard");
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
  const [positions, setPositions] = useState([]);
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
  const [tick, setTick]             = useState(0);
  const [liveData, setLiveData]     = useState(false);
  // Estado do bot 24/7 (Railway). Quando vivo, a app não opera — só mostra.
  const [botStatus, setBotStatus]   = useState(null); // { alive, mode, lastSeen, features }
  const botActiveRef = useRef(false);
  const dtLoadedRef  = useRef(false); // garante que o flag do monitor só é sincronizado uma vez

  // ── Definições ──
  const [settings, setSettings] = useState({
    capitalTotal:        5000,
    modoValor:           "fixo",
    valorFixo:           100,
    percentagem:         5,
    riscoPerfil:         "moderado",
    maxPosicoesAbertas:  5,
    maxManuais:          5,
    maxEstrategias:      5,
    maxDayTrading:       5,
    rotacaoAtiva:        false,
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
  });
  const balRef    = useRef(INIT_BAL);
  const stratRef  = useRef([]);
  const posRef    = useRef([]);
  const closedRef = useRef([]);
  const assRef    = useRef(assets);
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

  // Stable refs for interval


  useEffect(() => { balRef.current = balance; }, [balance]);
  useEffect(() => { simModeRef.current = simMode; }, [simMode]);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => { simBalRef.current = simBalance; }, [simBalance]);
  useEffect(() => { liveSettingsRef.current = liveSettings; }, [liveSettings]);
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

  // ── CoinGecko real prices ──
  useEffect(() => {
    const fetch_ = async () => {
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
          // Se o bot 24/7 está a operar (SIM), não geramos ruído — os preços reais
          // chegam via fetchMarkets (market.js). Mantemos o preço atual.
          if (simModeRef.current && botActiveRef.current) {
            const h0 = highs.current[a.id];
            if (!h0 || a.price > h0.p || t - h0.t > 120) highs.current[a.id] = { p: a.price, t };
            return { ...a, hist: [...a.hist.slice(-79), { i: t, v: a.price }] };
          }
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

        // ⛔ Se o bot 24/7 está ativo e estamos em SIM, o BOT é a única autoridade de
        //    trading. O browser não abre nem fecha posições (evita conflitos de saldo).
        //    A app continua apenas a mostrar o que o bot escreve no Firestore.
        //    Vale para sim E live: se o bot 24/7 está vivo, ele é a única autoridade.
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
            toClose.push({ ...p2, status: "AI-EXIT", closePrice: a.price, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl });
            setBal(b => { const n = +(b + p2.amount + pnl).toFixed(2); balRefCur.current = n; return n; });
            toast(`🤖 IA fechou ${a.sym} (sinal mudou) ${sign(pnl)}${eur(pnl)}`, pnl >= 0 ? "success" : "warn");
            return;
          }

          if (a.price <= p2.sl) {
            const pnl = (p2.sl - p2.entryPrice) * p2.units;
            const wasTrail = p2.sl > pos.entryPrice && trailingOn;
            toClose.push({ ...p2, status: wasTrail ? "TRAIL" : "SL", closePrice: p2.sl, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl });
            setBal(b => { const n = +(b + p2.amount + pnl).toFixed(2); balRefCur.current = n; return n; });
            toast(`${wasTrail ? "🔒 Trailing" : "🛑 SL"} ${a.sym} — ${sign(pnl)}${eur(pnl)}`, pnl >= 0 ? "success" : "warn");
          } else if (a.price >= p2.tp) {
            const pnl = (p2.tp - p2.entryPrice) * p2.units;
            toClose.push({ ...p2, status: "TP", closePrice: p2.tp, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl });
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
          // Persistir no Firestore
          if (user) {
            import("./firebase.js").then(({ updateTrade, saveSetting }) => {
              toClose.forEach(t => updateTrade(user.uid, t.id, {
                status: t.status, closePrice: t.closePrice, pnl: t.pnl, closedAt: t.closedAt,
              }).catch(() => {}));
              saveSetting(user.uid, isSim ? "simBalance" : "liveBalance", balRefCur.current).catch(() => {});
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
            .filter(p => p.stratId && p.stratId !== "manual" && p.stratId !== "daytrading").length;
          let openedThisTick = 0;
          stratRef.current.filter(s => s.ativo).forEach(s => {
            s.ativos.forEach(aid => {
              const key = `${s.id}_${aid}`;
              if ((cds.current[key] || 0) > 0) { cds.current[key]--; return; }
              const a = upd.find(x => x.id === aid);
              if (!a) return;
              if (stratOpen + openedThisTick >= maxStrat) return; // limite atingido
              // Máximo de referência: o maior entre o rolling-high e o pico do histórico visível.
              const histHigh = a.hist.length ? Math.max(...a.hist.map(pt => pt.v)) : a.price;
              const high     = Math.max(highs.current[aid]?.p || a.price, histHigh);
              const dropPct  = ((high - a.price) / high) * 100;
              const balNow   = balRefCur.current;
              if (dropPct >= s.compra && balNow >= s.perTrade) {
                const units = +(s.perTrade / a.price).toFixed(7);
                const sl    = +(a.price * (1 - s.sl / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
                const tp    = +(a.price * (1 + s.tp / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
                const pos   = {
                  id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
                  entryPrice: a.price, units, amount: s.perTrade, peak: a.price,
                  strategy: s.nome, stratId: s.id, sl, tp,
                  openedAt: new Date().toLocaleTimeString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
                  mode: isSim ? "sim" : "live",
                };
                setPos(p => { const next = [...p, pos]; if (isSim) simPosRef.current = next; return next; });
                setBal(b => { const n = +(Math.max(0, b - s.perTrade)).toFixed(2); balRefCur.current = n; return n; });
                setStrategies(p => p.map(x => x.id === s.id ? { ...x, trades: x.trades + 1 } : x));
                cds.current[key] = 22;
                openedThisTick++;
                if (user) import("./firebase.js").then(({ saveTrade }) => saveTrade(user.uid, pos).catch(()=>{})).catch(()=>{});
                toast(`📈 ${isSim ? "[SIM] " : ""}BUY ${a.sym} @$${a.price.toFixed(2)} · "${s.nome}"`, "buy");
              }
            });
          });
        }

        // 4. Cérebro AI autónomo — entra sozinho quando a IA dá COMPRAR com confiança ≥ slider.
        //    Respeita o mesmo gate de "simRunning" e o limite de posições de estratégia.
        if (simRunning && cfg.aiBrain) {
          const minConf  = cfg.aiBrainConfianca || 78;
          const maxStrat = cfg.maxEstrategias ?? 5;
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
            if (brainOpen + openedBrain >= maxStrat) return;
            if (balRefCur.current < perTrade) return;
            const slPct = cfg.stopLossPadrao || 6;
            const tpPct = cfg.takeProfitPadrao || 12;
            const units = +(perTrade / a.price).toFixed(7);
            const sl    = +(a.price * (1 - slPct / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
            const tp    = +(a.price * (1 + tpPct / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
            const pos   = {
              id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
              entryPrice: a.price, units, amount: perTrade, peak: a.price,
              strategy: `🤖 AI Brain (${sg.confianca}%)`, stratId: "ai-brain", sl, tp,
              openedAt: new Date().toLocaleTimeString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
              mode: isSim ? "sim" : "live",
            };
            setPos(p => { const next = [...p, pos]; if (isSim) simPosRef.current = next; return next; });
            setBal(b => { const n = +(Math.max(0, b - perTrade)).toFixed(2); balRefCur.current = n; return n; });
            cds.current[key] = 30; // cooldown ~60s por ativo
            openedBrain++;
            if (user) import("./firebase.js").then(({ saveTrade }) => saveTrade(user.uid, pos).catch(()=>{})).catch(()=>{});
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
    return s + (a ? (a.price - p.entryPrice) * p.units : 0);
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

  // Conjunto de ativos onde tens posição aberta (modo ativo) — usado para validar sinais VENDER
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
      if (ativosOk.length === 0) ativosOk = ["btc", "eth"]; // fallback seguro
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

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Estado do bot 24/7 */}
        {botAtivo ? (
          <div style={{
            display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderRadius:12,
            background:`${T.green}10`, border:`1px solid ${T.green}33`,
          }}>
            <div style={{ width:9, height:9, borderRadius:"50%", background:T.green, animation:"pulse 1.2s infinite", flexShrink:0 }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:700, color:T.green }}>🤖 Bot 24/7 ativo — a operar no servidor</div>
              <div style={{ fontSize:10, color:T.muted, marginTop:2 }}>
                As tuas posições são geridas no servidor, mesmo com a app fechada.
                {botStatus?.features?.aiBrain && " · Cérebro AI ON"}
                {botStatus?.features?.trailingStop && " · Trailing Stop ON"}
              </div>
            </div>
            <span style={{ fontSize:9, color:T.muted }}>visto {Math.round((Date.now()-botStatus.lastSeen)/1000)}s atrás</span>
          </div>
        ) : (() => {
          // Diagnóstico do motivo de estar offline (a app infere a partir do Firestore)
          const seenMs   = botStatus?.lastSeen ? Date.now() - botStatus.lastSeen : null;
          const agoTxt   = seenMs == null ? null
            : seenMs < 90000      ? `${Math.round(seenMs/1000)}s`
            : seenMs < 3600000    ? `${Math.round(seenMs/60000)} min`
            : `${Math.round(seenMs/3600000)}h`;
          const modeTxt  = simMode ? "Simulação" : "LIVE";

          let titulo, detalhe;
          if (!botStatus) {
            // Nunca recebeu nenhum heartbeat
            titulo  = "Bot 24/7 offline — nunca recebeu sinal";
            detalhe = "A app ainda não viu nenhum heartbeat do bot. Causas comuns: o USER_UID no Railway não é igual ao teu (Definições → Copiar UID), o deploy falhou, ou falta o FIREBASE_ADMIN_JSON. Confirma os Deploy Logs no Railway.";
          } else if (botHeartbeatRecente && !botModoBate) {
            // Bot vivo mas noutro modo
            titulo  = `Bot ativo em ${botStatus.mode === "sim" ? "Simulação" : "LIVE"}, mas estás em ${modeTxt}`;
            detalhe = `O bot está a operar em modo ${botStatus.mode === "sim" ? "Simulação" : "LIVE"}. Muda o toggle no topo para ${botStatus.mode === "sim" ? "Simulação" : "LIVE"} para o veres a gerir as posições aqui.`;
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
            const cor = estado === "ok" ? T.green : estado === "fail" ? T.red : T.muted;
            const txt = estado === "ok" ? "OK" : estado === "fail" ? "Falha" : "—";
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
          const fonteEstado = (s) => s?.ok === true ? "ok" : s?.ok === false ? "fail" : "unknown";
          return (
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", padding:"0 4px" }}>
              <span style={{ fontSize:10, color:T.muted, marginRight:2 }}>APIs:</span>
              {pill("Cérebro AI (Groq)", h.groq?.ok ? "ok" : "fail", groqDet)}
              {pill("Stooq", fonteEstado(h.stooq), h.stooq?.err ? "rede" : null)}
              {pill("CoinGecko", fonteEstado(h.coingecko), h.coingecko?.err ? "rede" : null)}
            </div>
          );
        })()}
        {/* Hero */}
        <Glass style={{
          padding: "28px 32px",
          background: "linear-gradient(135deg,rgba(99,102,241,0.18) 0%,rgba(16,185,129,0.07) 100%)",
          border: "1px solid rgba(99,102,241,0.28)",
        }}>
          <div className="resp-hero" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 28 }}>
            <div>
              <div style={{ fontSize: 10, color: T.aLight, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8 }}>Portfólio Total</div>
              <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em" }}>€{portfolioV.toFixed(2)}</div>
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
                  return sum + (a ? (a.price - p.entryPrice) * p.units : 0);
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
              📂 Os meus Investimentos — {myPositions.length} posição{myPositions.length > 1 ? "ões" : ""} aberta{myPositions.length > 1 ? "s" : ""}
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
                const pnl    = (price - pos.entryPrice) * pos.units;
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
                          label={{ value: `Entrada $${pos.entryPrice.toFixed(0)}`, position: "insideTopLeft", fill: T.gold, fontSize: 9, fontWeight: 700 }} />
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
  const investirSugestao = (op) => {
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
    const amount = aiSuggestions?.amount || calcTradeAmount();
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
            Atualizado às {aiSuggestions.geradoEm} · €{aiSuggestions.amount} por trade ·{" "}
            <span style={{ color: momentoC, fontWeight: 700 }}>Momento {aiSuggestions.momento}</span>
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
                    <Btn color={T.green} solid onClick={() => investirSugestao(op)}
                      style={{ width: "100%", fontSize: 12, padding: "9px 0" }}>
                      ▶ Investir €{aiSuggestions.amount}
                    </Btn>
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
                setStrategies(p => p.filter(x => x.id !== s.id));
                if (user) import("./firebase.js").then(({ deleteStrategy }) => deleteStrategy(user.uid, s.id).catch(()=>{}));
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
  const [mktLoading, setMktLoading] = useState(true);
  const [mktError,   setMktError]   = useState(null);
  const [mktLastAt,  setMktLastAt]  = useState(null);
  const [orderModal,    setOrderModal]    = useState(null);
  const [orderAmount,   setOrderAmount]   = useState(100);
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
    const timer = setTimeout(fetchMarketSignals, 3000);
    const iv = setInterval(fetchMarketSignals, 5 * 60 * 1000);
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
    fetchMarkets();
    const iv = setInterval(fetchMarkets, 30000); // refresh 30s
    return () => clearInterval(iv);
  }, [fetchMarkets]);

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
    const price = a?.price || pos.entryPrice;
    const pnl   = (price - pos.entryPrice) * pos.units;
    const closedTrade = { ...pos, status: "MANUAL", closePrice: price, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl };
    if (isSim) {
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
    } else {
      setClosed(p => [closedTrade, ...p]);
      setPositions(p => p.filter(x => x.id !== posId));
      setBalance(b => {
        const n = +(b + pos.amount + pnl).toFixed(2); balRef.current = n;
        if (user) import("./firebase.js").then(({ updateTrade, saveSetting }) => {
          updateTrade(user.uid, posId, { status: "MANUAL", closePrice: price, pnl, closedAt: closedTrade.closedAt }).catch(()=>{});
          saveSetting(user.uid, "liveBalance", n).catch(()=>{});
        }).catch(()=>{});
        return n;
      });
    }
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
        openedAt: new Date().toLocaleTimeString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
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
        const closedTrade = { ...openPos, status: "MANUAL", closePrice: price, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl };
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
                const pnl     = (price - pos.entryPrice) * pos.units;
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
                                  const o = pos.stratId === "ai-brain"   ? { l:"🤖 AI Brain",   c:T.accent }
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
                                label={{ value:`Minha entrada $${pos.entryPrice.toFixed(a.id==="eurusd"?4:2)}`, position:"insideTopLeft", fill:T.gold, fontSize:10, fontWeight:700 }}/>
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
                    <div><div style={{ fontSize:9, color:T.muted }}>SAÍDA</div><div style={{ fontWeight:600, fontSize:12 }}>${(+t.closePrice).toFixed(2)}</div></div>
                    <div><div style={{ fontSize:9, color:T.muted }}>INVESTIDO</div><div style={{ fontWeight:600 }}>€{t.amount}</div></div>
                    <div><Badge label={t.status||"MANUAL"} color={t.status==="SL"?T.red:t.status==="TP"?T.green:(t.pnl||0)>=0?T.green:T.red}/></div>
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
          const posPnl    = openPos ? (price - openPos.entryPrice) * openPos.units : null;

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
                        {isLive
                          ? <span style={{ fontSize: 9, color: T.green, fontWeight: 700 }}>● LIVE</span>
                          : <span style={{ fontSize: 9, color: T.gold }}>◎ SIM</span>}
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

              {/* BUY / SELL buttons */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: `1px solid ${T.border}33` }}>
                <button onClick={() => setOrderModal({ assetId: a.id, side: "BUY" })} style={{
                  background: `${T.green}12`, color: T.green, border: "none",
                  borderRight: `1px solid ${T.border}33`,
                  padding: "12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                  fontFamily: "inherit", transition: "background 0.12s",
                }}>▲ COMPRAR</button>
                <button onClick={() => setOrderModal({ assetId: a.id, side: "SELL" })} style={{
                  background: `${T.red}12`, color: T.red, border: "none",
                  padding: "12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                  fontFamily: "inherit", transition: "background 0.12s",
                }}>▼ VENDER</button>
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
                    {simMode ? "◎ Simulação — sem dinheiro real" : "⚠ LIVE — dinheiro real no IBKR"}
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
                  const colRec = sc(rec.sinal);
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
                        <Badge label={rec.sinal} color={colRec} />
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
      return { ...p, curPnl: a ? (a.price - p.entryPrice) * p.units : 0, livePrice: a?.price, mode: "live" };
    }), ...closed.map(t => ({...t, mode:"live"}))];

    const activeTrades = histTab === "sim" ? simTrades : liveTrades;

    // Classificar origem de cada trade
    const origemDe = (t) =>
      t.stratId === "ai-brain"   ? "🤖 AI Brain"
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

    // Resumo por origem (só trades fechados) — para comparar o que compensa
    const resumoOrigem = {};
    activeTrades.filter(t => t.status !== "ABERTA").forEach(t => {
      const o = origemDe(t);
      if (!resumoOrigem[o]) resumoOrigem[o] = { n: 0, wins: 0, pnl: 0 };
      resumoOrigem[o].n++;
      if ((t.pnl || 0) > 0) resumoOrigem[o].wins++;
      resumoOrigem[o].pnl += t.pnl || 0;
    });

    const filteredClosed  = filtered.filter(t => t.status !== "ABERTA");
    const filteredWins    = filteredClosed.filter(t => (t.pnl||t.curPnl||0) > 0);
    const filteredPnl     = filteredClosed.reduce((s,t) => s + (t.pnl||0), 0);
    const filteredWR      = filteredClosed.length ? filteredWins.length / filteredClosed.length * 100 : null;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Mode tabs */}
        <div style={{ display: "flex", gap: 0, background: "rgba(0,0,0,0.3)", borderRadius: 10, overflow: "hidden", width: "fit-content" }}>
          {[["sim","◎ Simulação"], ["live","● Live"]].map(([id, label]) => (
            <button key={id} onClick={() => { setHistTab(id); setHistCat("Todos"); }} style={{
              padding: "10px 22px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: histTab===id ? (id==="sim"?`${T.gold}20`:`${T.red}20`) : "transparent",
              color: histTab===id ? (id==="sim"?T.gold:T.red) : T.muted,
              border: "none", fontFamily: "inherit",
            }}>{label}</button>
          ))}
        </div>

        {/* KPIs */}
        <div className="resp-grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          {[
            { l: "P&L Realizado",     v: `${sign(filteredPnl)}${eur(filteredPnl)}`,                            c: filteredPnl >= 0 ? T.green : T.red },
            { l: "P&L Não Realizado", v: `${sign(unrealized)}${eur(unrealized)}`,                               c: unrealized >= 0 ? T.green : T.red },
            { l: "Win Rate",          v: filteredWR !== null ? `${filteredWR.toFixed(1)}%` : "—",               c: T.gold   },
            { l: "Total Trades",      v: filtered.length,                                                        c: T.accent },
          ].map(m => (
            <Glass key={m.l} style={{ padding: "18px 20px" }}>
              <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 8 }}>{m.l}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: m.c }}>{m.v}</div>
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
        {histTab === "sim" && dailyArchives.length > 0 && (
          <Glass style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 12 }}>🗓 Arquivo Diário ({dailyArchives.length} dias)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {dailyArchives.map((a) => {
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
                        display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 0.4fr",
                        gap: 12, padding: "10px 14px", alignItems: "center",
                        fontSize: 12, cursor: "pointer",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700 }}>{a.day}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{a.count} trades</div>
                      </div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>P&L</div><div style={{ fontWeight: 700, color: pnlPos ? T.green : T.red }}>{sign(a.pnl || 0)}€{Math.abs(a.pnl || 0).toFixed(2)}</div></div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>Win Rate</div><div style={{ fontWeight: 700, color: T.gold }}>{(a.winRate || 0).toFixed(0)}%</div></div>
                      <div><div style={{ fontSize: 9, color: T.muted }}>Wins</div><div style={{ fontWeight: 700 }}>{a.wins ?? 0}/{a.count}</div></div>
                      <div style={{ textAlign: "right", color: T.muted, fontSize: 13 }}>{isOpen ? "▲" : "▼"}</div>
                    </div>
                    {isOpen && Array.isArray(a.trades) && (
                      <div style={{ padding: "0 14px 12px", overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, minWidth: 560 }}>
                          <thead>
                            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                              {["Ativo","Estratégia","Entrada","Saída","P&L","Status"].map(h => (
                                <th key={h} style={{ padding: "6px 8px", textAlign: "left", color: T.muted, fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {a.trades.map((t, ti) => {
                              const tp = (t.pnl || 0) >= 0;
                              return (
                                <tr key={t.id || ti} style={{ borderBottom: `1px solid ${T.border}55` }}>
                                  <td style={{ padding: "6px 8px", fontWeight: 700 }}>{t.assetSym || t.assetId}</td>
                                  <td style={{ padding: "6px 8px", color: T.muted }}>{t.strategy || t.stratId || "—"}</td>
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
        )}

        {/* Trades table */}
        {filtered.length === 0 ? (
          <Glass style={{ padding: "56px 24px", textAlign: "center" }}>
            <div style={{ color: T.muted, fontSize: 13 }}>
              {histTab === "sim" ? "Sem trades de simulação ainda." : "Sem trades live ainda."}
            </div>
          </Glass>
        ) : (
          <Glass style={{ padding: "20px", overflowX: "auto" }}>
            <SectionLabel>Trades — {histTab === "sim" ? "Simulação" : "Live"} · {histCat} ({filtered.length})</SectionLabel>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 1040 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Ativo","Cat.","Estratégia","Abertura","Entrada","Preço Atual","Investido","SL","TP","P&L","%","IA","Hold","Status","Mercado"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: T.muted, fontSize: 8, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => {
                  const pnl    = t.pnl !== undefined ? t.pnl : t.curPnl;
                  const isOpen = t.status === "ABERTA";
                  const a      = findAsset(t);
                  return (
                    <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}20` }}>
                      <td style={{ padding: "9px 10px", fontWeight: 700 }}>{a?.icon || "◆"} {a?.sym || t.assetSym || t.assetId}</td>
                      <td style={{ padding: "9px 10px", color: T.muted }}>{a?.cat || "—"}</td>
                      <td style={{ padding: "9px 10px", color: T.muted, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.strategy}</td>
                      <td style={{ padding: "9px 10px", color: T.muted }}>{t.openedAt}</td>
                      <td style={{ padding: "9px 10px" }}>${t.entryPrice?.toFixed(2)}</td>
                      <td style={{ padding: "9px 10px" }}>{isOpen ? `$${t.livePrice ? fmt(t.livePrice, a?.id || t.assetId) : "—"}` : `$${(+t.closePrice).toFixed(2)}`}</td>
                      <td style={{ padding: "9px 10px" }}>€{t.amount}</td>
                      <td style={{ padding: "9px 10px", color: T.red }}>${t.sl}</td>
                      <td style={{ padding: "9px 10px", color: T.green }}>${t.tp}</td>
                      <td style={{ padding: "9px 10px" }}>
                        {pnl !== undefined && <span style={{ color: pnl >= 0 ? T.green : T.red, fontWeight: 700 }}>{sign(pnl)}{eur(pnl)}</span>}
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        {(() => {
                          // % de lucro sobre o investido
                          if (pnl === undefined || !t.amount) return <span style={{ color: T.muted }}>—</span>;
                          const pct = (pnl / t.amount) * 100;
                          return <span style={{ color: pct >= 0 ? T.green : T.red, fontWeight: 700 }}>{sign(pct)}{Math.abs(pct).toFixed(2)}%</span>;
                        })()}
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
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        {(() => {
                          const lbl = isOpen ? "ABERTA"
                            : t.status === "TP" ? "✓ TP"
                            : t.status === "MANUAL" ? "✓ Manual"
                            : t.status === "TRAIL" ? "🔒 Trailing"
                            : t.status === "AI-EXIT" ? "🤖 AI"
                            : "✗ SL";
                          const c = isOpen ? T.blue
                            : t.status === "SL" ? T.red
                            : (t.pnl || 0) >= 0 ? T.green : T.red;
                          return <Badge label={lbl} color={c} />;
                        })()}
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        {isOpen ? <MarketBadge assetId={t.assetId} /> : <span style={{ color: T.muted, fontSize: 10 }}>—</span>}
                      </td>
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
    const isSimTab = defTab === "sim";
    const currentSettings      = isSimTab ? settings : liveSettings;
    const setCurrentSettings   = isSimTab ? setSettings : setLiveSettings;
    // local edit state vive no top-level (settingsLocal) para sobreviver ao re-render de 2s
    const brainDefaults = { aiBrain: false, aiBrainConfianca: 78, trailingStop: false, trailingStopPct: 4, aiExitOnFlip: true, aiSignalsMin: 15 };
    const local = { ...brainDefaults, ...(settingsLocal || currentSettings) };
    const setLocal = (updater) => {
      setSettingsLocal(prev => {
        const base = prev || { ...currentSettings };
        return typeof updater === "function" ? updater(base) : updater;
      });
    };

    const switchTab = (tab) => {
      setDefTab(tab);
      setSettingsLocal({ ...(tab === "sim" ? settings : liveSettings) });
    };

    const upd  = (k, v) => setLocal(p => ({ ...p, [k]: v }));
    const perfilInfo = {
      conservador: { desc: "Quedas maiores para acionar compra, SL/TP mais apertados. Menos trades, mais seguros.", sl: 4, tp: 8,  compra: 2.5 },
      moderado:    { desc: "Equilíbrio entre oportunidades e risco. Recomendado para começar.",                    sl: 6, tp: 12, compra: 1.5 },
      agressivo:   { desc: "Mais trades, entradas mais frequentes. Potencial de ganho e perda maior.",             sl: 9, tp: 18, compra: 0.8 },
    };

    const save = () => {
      // Garantir que SL/TP correspondem ao perfil selecionado (a não ser que o user os tenha alterado manualmente)
      const finalSettings = { ...local };
      setCurrentSettings(finalSettings);
      setSettingsLocal(null);
      if (user) import("./firebase.js").then(({ saveSetting }) =>
        saveSetting(user.uid, isSimTab ? "settings" : "liveSettings", finalSettings).catch(()=>{}));
      toast(`✅ Definições ${isSimTab?"simulação":"live"} guardadas! (Perfil ${finalSettings.riscoPerfil}: SL ${finalSettings.stopLossPadrao}% / TP ${finalSettings.takeProfitPadrao}%)`, "success");
    };
    const info = perfilInfo[local.riscoPerfil];
    const amountPreview = local.modoValor === "fixo"
      ? local.valorFixo
      : Math.max(10, +(local.capitalTotal * local.percentagem / 100).toFixed(2));

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 820, paddingBottom: 80 }}>

        {/* Mode tabs */}
        <div style={{ display: "flex", gap: 0, background: "rgba(0,0,0,0.3)", borderRadius: 10, overflow: "hidden", width: "fit-content" }}>
          {[["sim","◎ Simulação"], ["live","● Live (Real)"]].map(([id, label]) => (
            <button key={id} onClick={() => switchTab(id)} style={{
              padding: "10px 24px", fontSize: 13, fontWeight: 700, cursor: "pointer",
              background: defTab===id ? (id==="sim"?`${T.gold}20`:`${T.red}20`) : "transparent",
              color: defTab===id ? (id==="sim"?T.gold:T.red) : T.muted,
              border: "none", fontFamily: "inherit",
            }}>{label}</button>
          ))}
        </div>

        {isSimTab && (
          <div style={{ background: `${T.gold}0a`, border: `1px solid ${T.gold}25`, borderRadius: 10, padding: "10px 16px", fontSize: 11, color: T.muted }}>
            ◎ Estas definições aplicam-se apenas à simulação — para praticar sem risco.
          </div>
        )}
        {!isSimTab && (
          <div style={{ background: `${T.red}0a`, border: `1px solid ${T.red}25`, borderRadius: 10, padding: "10px 16px", fontSize: 11, color: T.muted }}>
            ⚠ Estas definições aplicam-se ao modo LIVE — trades com dinheiro real no IBKR.
          </div>
        )}

        {/* Capital */}
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
            <span style={{ fontSize: 12, color: T.muted }}>💡 Cada trade investirá:</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: T.green }}>€{amountPreview}</span>
          </div>
        </Glass>

        {/* Perfil de risco */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 16 }}>🎯 Perfil de Risco</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { id: "conservador", emoji: "🛡️", label: "Conservador",  desc: "Menos trades, mais seguros" },
              { id: "moderado",    emoji: "⚖️", label: "Moderado",     desc: "Equilíbrio (recomendado)"  },
              { id: "agressivo",   emoji: "🚀", label: "Agressivo",    desc: "Mais trades, mais risco"   },
            ].map(p => (
              <div key={p.id} onClick={() => {
                const pi = perfilInfo[p.id];
                setLocal(prev => ({ ...prev, riscoPerfil: p.id, stopLossPadrao: pi.sl, takeProfitPadrao: pi.tp }));
              }} style={{
                padding: "16px", borderRadius: 12, cursor: "pointer",
                background: local.riscoPerfil === p.id ? `${riskC(p.id.toUpperCase())}18` : "rgba(255,255,255,0.03)",
                border: `2px solid ${local.riscoPerfil === p.id ? riskC(p.id.toUpperCase()) : T.border}`,
                textAlign: "center", transition: "all 0.15s",
              }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>{p.emoji}</div>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{p.label}</div>
                <div style={{ fontSize: 11, color: T.muted }}>{p.desc}</div>
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

        {/* Limites */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 6 }}>🔒 Limites de Segurança</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 16, lineHeight: 1.6 }}>Proteções automáticas. O bot para se estes limites forem atingidos.</div>
          {/* Limites de posições por tipo */}
          <div style={{ fontSize: 11, color: T.aLight, fontWeight: 700, marginBottom: 10 }}>Máximo de posições abertas por tipo</div>
          <div className="resp-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 16 }}>
            {[
              { k: "maxManuais",     l: "✋ Manuais",     desc: "Compras tuas em Mercados", max: 20 },
              { k: "maxEstrategias", l: "🎯 Estratégias", desc: "Trades automáticos do bot", max: 20 },
              { k: "maxDayTrading",  l: "⚡ Day Trading",  desc: "Scalping rápido", max: 50 },
            ].map(f => (
              <div key={f.k} style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>{f.l}</div>
                <div style={{ fontSize: 9, color: T.muted, marginBottom: 10, lineHeight: 1.4 }}>{f.desc}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="range" min={1} max={f.max} value={local[f.k] ?? 5} onChange={e => upd(f.k, +e.target.value)} style={{ flex: 1, accentColor: T.accent }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.aLight, minWidth: 24, textAlign: "right" }}>{local[f.k] ?? 5}</div>
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
        <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center" }}>
          {/* Limpar simulações */}
          <button onClick={() => {
            navigator.clipboard?.writeText(user.uid);
            toast(`UID copiado: ${user.uid}`, "success");
          }} style={{
            background: `${T.blue}12`, border: `1px solid ${T.blue}33`, borderRadius: 8,
            padding: "10px 18px", fontSize: 11, color: T.blue, cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
          }}>📋 Copiar UID (para o bot)</button>
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
      // Se o bot 24/7 está ativo (modo SIM), é ele que faz o day trading no servidor.
      // O scan automático da app pára (evita trades/tokens duplicados). O "Scan Agora"
      // manual continua a funcionar como análise informativa, mas não auto-compra.
      if (auto && simModeRef.current && botActiveRef.current) return;
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

        // Auto-executar se urgência = AGORA e ação = COMPRAR e modo activo
        // (não auto-compra se o bot 24/7 estiver a gerir o day trading no servidor)
        const botGereDayTrading = simModeRef.current && botActiveRef.current;
        if (dtActive && !botGereDayTrading && result.oportunidades) {
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
              const price = mktData[a.id]?.price || a.price;
              const units = +(dtAmount / price).toFixed(7);
              const sl    = +(price * (1 - dtMaxLoss    / 100)).toFixed(2);
              const tp    = +(price * (1 + dtProfitTarget / 100)).toFixed(2);
              const trade = {
                id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
                action: "COMPRAR", entryPrice: price, units, amount: dtAmount,
                sl, tp, strategy: `DayTrade — ${op.previsao?.slice(0,40)}`,
                openedAt: new Date().toLocaleTimeString("pt-PT"), openedTs: Date.now(), status: "ABERTA",
                mode: simMode ? "sim" : "live",
              };
              setDtTrades(p => [trade, ...p]);
              if (simMode) {
                setSimPositions(p => [...p, { ...trade, stratId: "daytrading" }]);
                setSimBalance(b => { const n = +(Math.max(0, b - dtAmount)).toFixed(2); simBalRef.current = n; return n; });
              } else {
                setPositions(p => [...p, { ...trade, stratId: "daytrading" }]);
                setBalance(b => { const n = +(Math.max(0, b - dtAmount)).toFixed(2); balRef.current = n; return n; });
              }
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
      setDtTrades(p => p.map(t => {
        if (t.id !== tradeId || t.status !== "ABERTA") return t;
        const a    = resolveAsset(t);
        const price = a?.price || mktData[a?.id]?.price || t.entryPrice;
        const pnl  = (price - t.entryPrice) * t.units;
        setDtDailyPnl(prev => +(prev + pnl).toFixed(2));
        // Fechar na posições
        if (simMode) {
          setSimPositions(prev => prev.filter(x => x.id !== tradeId));
          setSimClosed(prev => [{ ...t, status: "MANUAL", closePrice: price, pnl, closedAt: new Date().toLocaleTimeString("pt-PT") }, ...prev]);
          setSimBalance(b => { const n = +(b + t.amount + pnl).toFixed(2); simBalRef.current = n; return n; });
        } else {
          setPositions(prev => prev.filter(x => x.id !== tradeId));
          setClosed(prev => [{ ...t, status: "MANUAL", closePrice: price, pnl }, ...prev]);
          setBalance(b => { const n = +(b + t.amount + pnl).toFixed(2); balRef.current = n; return n; });
        }
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
                {simMode ? "◎ Simulação" : "● Live Real"}
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
                const col   = op.acao==="COMPRAR" ? T.green : op.acao==="VENDER" ? T.red : T.gold;
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
                        <Badge label={op.acao} color={col} />
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
                        const units2 = +(dtAmount / price2).toFixed(7);
                        const sl2    = +(price2 * (1 - dtMaxLoss    /100)).toFixed(2);
                        const tp2    = +(price2 * (1 + dtProfitTarget/100)).toFixed(2);
                        const trade  = {
                          id: uid(), assetId:a?.id||op.id, assetName:a?.name||op.nome, assetSym:a?.sym||op.id,
                          action:"COMPRAR", entryPrice:price2, units:units2, amount:dtAmount,
                          sl:sl2, tp:tp2, strategy:`DayTrade`,
                          openedAt:new Date().toLocaleTimeString("pt-PT"), status:"ABERTA",
                          mode: simMode ? "sim" : "live",
                        };
                        setDtTrades(p => [trade, ...p]);
                        if (simMode) {
                          setSimPositions(p => [...p, { ...trade, stratId:"daytrading" }]);
                          setSimBalance(b => { const n = +(Math.max(0,b-dtAmount)).toFixed(2); simBalRef.current=n; return n; });
                        } else {
                          setPositions(p => [...p, { ...trade, stratId:"daytrading" }]);
                          setBalance(b => { const n = +(Math.max(0,b-dtAmount)).toFixed(2); balRef.current=n; return n; });
                        }
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

  // NAV + LAYOUT
  // ─────────────────────────────────────────────
  const NAV = [
    { id: "dashboard",  icon: "◈",  label: "Dashboard"     },
    { id: "portfolio",  icon: "💼",  label: "Carteira"      },
    { id: "markets",    icon: "◎",  label: "Mercados"       },
    { id: "strategies", icon: "🎯", label: "Estratégias"   },
    { id: "daytrading", icon: "⚡",  label: "Day Trading"   },
    { id: "ai",         icon: "◆",  label: "AI Intel"       },
    { id: "history",    icon: "≡",  label: "Histórico"      },
    { id: "settings",   icon: "⚙",  label: "Definições"    },
    { id: "guide",      icon: "◉",  label: "Guia Setup"     },
  ];

  // ── Persistência Firestore: carregar estado ao iniciar ──────────────────
  useEffect(() => {
    if (!user) return;
    const uid2 = user.uid;
    // Carregar posições simuladas abertas
    let unsubTrades = null, unsubBal = null, unsubBalLive = null, unsubTradeable = null;
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
    }).catch(() => {});
    // Carregar estratégias guardadas
    let unsubStrat = null, unsubSettings = null, unsubLive = null, unsubArch = null, unsubDt = null, unsubBot = null, unsubSig = null, unsubDaily = null;
    import("./firebase.js").then(({ subscribeStrategies, subscribeSetting: subSet, subscribeArchives }) => {
      if (subscribeArchives) {
        unsubDaily = subscribeArchives(uid2, (arcs) => {
          if (Array.isArray(arcs)) setDailyArchives(arcs);
        });
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
      unsubLive = subSet(uid2, "liveSettings", (val) => {
        if (val && typeof val === "object") { setLiveSettings(val); liveSettingsRef.current = val; }
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
      unsubSig = subSet(uid2, "marketSignals", (val) => {
        // Só usar os sinais do bot quando ele está ativo (senão a app gera os seus)
        if (val && typeof val === "object" && botActiveRef.current) setMarketSignals(val);
      });
    }).catch(() => {});
    return () => { unsubTrades?.(); unsubBal?.(); unsubBalLive?.(); unsubTradeable?.(); unsubStrat?.(); unsubSettings?.(); unsubLive?.(); unsubArch?.(); unsubDt?.(); unsubBot?.(); unsubSig?.(); unsubDaily?.(); };
  }, [user]);

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
                setConfirmModal({
                  danger: true,
                  title: "Ativar modo LIVE?",
                  message: "Em modo LIVE os trades são executados com dinheiro REAL na tua corretora.",
                  lines: [
                    "Precisas da corretora (Alpaca/IBKR) configurada e com saldo",
                    "Perdas em modo LIVE são dinheiro real perdido",
                    "Podes voltar a Simulação a qualquer momento",
                  ],
                  confirmLabel: "Ativar LIVE",
                  onConfirm: () => {
                    setSimMode(false);
                    simModeRef.current = false;
                    toast("● Modo LIVE ativado — dinheiro real", "warn");
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
              ● LIVE
            </div>
          </div>
          {!simMode && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, background: `${T.red}14`, border: `1px solid ${T.red}33`, borderRadius: 99, padding: "3px 12px" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: T.red, animation: "pulse 1.5s infinite" }} />
              <span style={{ color: T.red, fontWeight: 700, fontSize: 10, letterSpacing: "0.1em" }}>LIVE — DINHEIRO REAL</span>
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
          {NAV.map(item => (
            <div key={item.id} onClick={() => setTab(item.id)} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "11px 18px", cursor: "pointer", fontSize: 12, fontWeight: 600,
              color:      tab === item.id ? T.aLight : T.muted,
              background: tab === item.id ? "rgba(99,102,241,0.1)" : "transparent",
              borderLeft: `2px solid ${tab === item.id ? T.accent : "transparent"}`,
              transition: "all 0.12s",
            }}>
              <span style={{ fontSize: 15, opacity: tab === item.id ? 1 : 0.55 }}>{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "strategies" && strategies.filter(s => s.ativo).length > 0 && (
                <span style={{ marginLeft: "auto", background: T.accent, color: "#fff", borderRadius: 99, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>
                  {strategies.filter(s => s.ativo).length}
                </span>
              )}
              {item.id === "portfolio" && activePositions.length > 0 && (
                <span style={{ marginLeft: "auto", background: T.green, color: "#000", borderRadius: 99, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>
                  {activePositions.length}
                </span>
              )}
            </div>
          ))}
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
          <div style={{ animation: "fadeIn 0.25s ease" }} key={tab}>
            {tab === "dashboard"  && Dashboard()}
            {tab === "portfolio"  && Portfolio()}
            {tab === "markets"    && <Markets />}
            {tab === "strategies" && <Strategies />}
            {tab === "ai"         && AIIntel()}
            {tab === "history"    && History()}
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
            const active = tab === item.id;
            const badge = item.id === "strategies" ? strategies.filter(s => s.ativo).length
                        : item.id === "portfolio"  ? activePositions.length
                        : 0;
            return (
              <div key={item.id} onClick={() => { setTab(item.id); window.scrollTo(0,0); }} style={{
                flex: "0 0 auto", minWidth: 62, display: "flex", flexDirection: "column",
                alignItems: "center", gap: 3, padding: "6px 8px", cursor: "pointer",
                position: "relative",
                color: active ? T.aLight : T.muted,
              }}>
                <span style={{ fontSize: 18, opacity: active ? 1 : 0.6 }}>{item.icon}</span>
                <span style={{ fontSize: 8.5, fontWeight: active ? 700 : 500, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>{item.label}</span>
                {active && <div style={{ position: "absolute", top: 0, width: 24, height: 2, background: T.accent, borderRadius: 2 }} />}
                {badge > 0 && (
                  <span style={{ position: "absolute", top: 2, right: 10, background: item.id==="portfolio"?T.green:T.accent,
                    color: item.id==="portfolio"?"#000":"#fff", borderRadius: 99, minWidth: 14, height: 14,
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
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmModal(null)} style={{
                flex: 1, background: "rgba(255,255,255,0.05)", border: `1px solid ${T.border}`,
                borderRadius: 11, padding: "13px", fontSize: 13, color: T.muted,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
              }}>{confirmModal.cancelLabel || "Cancelar"}</button>
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
              <span style={{ fontSize: 11, fontWeight: 700, color: T.green, letterSpacing: "0.09em" }}>SIMULAÇÃO EM CURSO</span>
              {simMinimized && (
                <span style={{ fontSize:11, color:simBalance>=simCapital?T.green:T.red, fontWeight:700, marginLeft:6 }}>
                  €{simBalance.toFixed(2)} ({sign(simBalance-simCapital)}{Math.abs(((simBalance-simCapital)/simCapital)*100).toFixed(1)}%)
                </span>
              )}
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
            const pctUsado = simCapital > 0 ? (capInvestido / simCapital) * 100 : 0;
            return (
              <>
                {/* Barra de capital usado */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.muted, marginBottom: 4 }}>
                    <span>CAPITAL EM USO: €{capInvestido.toFixed(2)} de €{simCapital}</span>
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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                  {[
                    { l: "Saldo Livre", v: `€${simBalance.toFixed(2)}`, c: T.text },
                    { l: "P&L Aberto",  v: `${sign(unrealSim)}€${Math.abs(unrealSim).toFixed(2)}`, c: unrealSim>=0?T.green:T.red },
                    { l: "Win Rate",    v: simClosed.length ? `${(simClosed.filter(t=>t.pnl>0).length/simClosed.length*100).toFixed(0)}%`:"—", c: T.gold },
                  ].map(s => (
                    <div key={s.l} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: "7px 9px" }}>
                      <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>{s.l}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
                    </div>
                  ))}
                </div>
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
                        <span style={{ color: T.muted, marginLeft: 8 }}>entrada ${t.entryPrice?.toFixed(2)} → saída ${t.closePrice?.toFixed(2)}</span>
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
