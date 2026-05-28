import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "./AuthContext.jsx";
import { logout } from "./firebase.js";
import LoginScreen from "./LoginScreen.jsx";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── AI HELPER ───────────────────────────────────────────────────────────────
// Chama a Netlify Function proxy — a API key fica no servidor, nunca no browser
const AI_ENDPOINT = "/.netlify/functions/ai";

async function callAI({ messages, system, max_tokens = 1000 }) {
  const res = await fetch(AI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens, system, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Erro na API");
  const text = data.content?.[0]?.text || "{}";
  // Estimar custo: input ~€0.003/1K tokens, output ~€0.015/1K tokens (Sonnet)
  const inTok  = data.usage?.input_tokens  || 400;
  const outTok = data.usage?.output_tokens || max_tokens * 0.6;
  const cost   = +((inTok * 0.003 + outTok * 0.015) / 1000).toFixed(5);
  const result = JSON.parse(text.replace(/```json|```/g, "").trim());
  return { result, cost };
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

function isMarketOpen(id) {
  const h = MARKET_HOURS[id];
  if (!h || h.always) return true;
  const now  = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const dow  = now.getUTCDay(); // 0=Dom, 6=Sáb
  if (h.weekdays && (dow === 0 || dow === 6)) return false;
  return utcH >= h.openH && utcH < h.closeH;
}

// ─── ASSETS ──────────────────────────────────────────────────────────────────
const ASSETS = [
  { id:"btc",    name:"Bitcoin",      sym:"BTC",     cat:"Crypto",    base:67420,  icon:"₿",  vol:0.0038, cg:"bitcoin"   },
  { id:"eth",    name:"Ethereum",     sym:"ETH",     cat:"Crypto",    base:3580,   icon:"Ξ",  vol:0.0045, cg:"ethereum"  },
  { id:"wti",    name:"Petróleo WTI", sym:"WTI",     cat:"Commodity", base:78.42,  icon:"🛢", vol:0.0022, cg:null        },
  { id:"gold",   name:"Ouro",         sym:"XAU",     cat:"Commodity", base:2341,   icon:"🥇", vol:0.0009, cg:null        },
  { id:"silver", name:"Prata",        sym:"XAG",     cat:"Commodity", base:27.85,  icon:"🥈", vol:0.0026, cg:null        },
  { id:"spy",    name:"S&P 500 ETF",  sym:"SPY",     cat:"ETF",       base:524.3,  icon:"📈", vol:0.0011, cg:null        },
  { id:"qqq",    name:"Nasdaq ETF",   sym:"QQQ",     cat:"ETF",       base:448.6,  icon:"💻", vol:0.0014, cg:null        },
  { id:"eurusd", name:"EUR/USD",      sym:"EUR/USD", cat:"Forex",     base:1.0842, icon:"💶", vol:0.0003, cg:null        },
];

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

  // ── Auth gate ──
  if (authLoading) return (
    <div style={{ minHeight:"100vh", background:"#06061a", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"sans-serif" }}>
      <div style={{ color:"#6b7280", fontSize:14 }}>◌  A carregar…</div>
    </div>
  );
  if (!user) return <LoginScreen />;

  const INIT_BAL = 10000;

  // ── Simulação separada ──
  const [simCapital, setSimCapital]   = useState(1000);   // capital definido pelo user
  const [simBalance, setSimBalance]   = useState(1000);   // saldo actual da simulação
  const [simPositions, setSimPositions] = useState([]);   // posições abertas SIM
  const [simClosed,   setSimClosed]   = useState([]);     // trades fechados SIM
  const [simSummary,  setSimSummary]  = useState(null);   // resultado final mostrado no modal
  const [simStartedAt, setSimStartedAt] = useState(null); // timestamp início
  const simBalRef   = useRef(1000);
  const simPosRef   = useRef([]);

  const [tab, setTab]             = useState("dashboard");
  const [balance, setBalance]     = useState(INIT_BAL);
  const [assets, setAssets]       = useState(() =>
    ASSETS.map(a => ({ ...a, price: a.base, hist: genH(a.base), change: (Math.random() - 0.48) * 3.5 }))
  );
  const [positions, setPositions] = useState([]);
  const [closed, setClosed]       = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [objective, setObjective]   = useState("");
  const [aiLoading, setAiLoading]   = useState(false);
  const [aiRec, setAiRec]           = useState(null);
  const [aiSuggestions, setAiSuggestions] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [toasts, setToasts]         = useState([]);
  const [tick, setTick]             = useState(0);
  const [liveData, setLiveData]     = useState(false);

  // ── Definições ──
  const [settings, setSettings] = useState({
    capitalTotal:        5000,
    modoValor:           "fixo",
    valorFixo:           100,
    percentagem:         5,
    riscoPerfil:         "moderado",
    maxPosicoesAbertas:  5,
    stopLossPadrao:      6,
    takeProfitPadrao:    12,
    autoInvestir:        false,
  });
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
    setOrderAmount(settings.modoValor === "fixo" ? settings.valorFixo : Math.max(10, +(INIT_BAL * settings.percentagem / 100).toFixed(0)));
  }, [settings]);
  const calcTradeAmount = useCallback(() => {
    const s = settingsRef.current;
    if (s.modoValor === "percentagem") return Math.max(10, +(balRef.current * s.percentagem / 100).toFixed(2));
    return s.valorFixo;
  }, []);

  // Stable refs for interval
  const balRef    = useRef(INIT_BAL);
  const stratRef  = useRef([]);
  const posRef    = useRef([]);
  const closedRef = useRef([]);
  const assRef    = useRef(assets);
  const highs     = useRef({});    // { assetId: { p, t } }
  const cds       = useRef({});    // cooldown ticks { stratId_assetId: n }

  useEffect(() => { balRef.current = balance; }, [balance]);
  useEffect(() => { simBalRef.current = simBalance; }, [simBalance]);
  useEffect(() => { simPosRef.current = simPositions; }, [simPositions]);
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

        // 1. Update prices — pausa se hover num gráfico
        if (hoveredChart.current) return prev;
        const upd = assRef.current.map(a => {
          const noise = (Math.random() - 0.492) * a.price * a.vol;
          const p     = +(Math.max(a.price + noise, a.price * 0.45)).toFixed(a.id === "eurusd" ? 4 : 2);
          const chg   = a.id === "btc" || a.id === "eth" ? a.change : ((p - a.base) / a.base) * 100;

          // Track rolling high (reset every 60 ticks)
          const h = highs.current[a.id];
          if (!h || p > h.p || t - h.t > 60) highs.current[a.id] = { p, t };

          return { ...a, price: p, change: chg, hist: [...a.hist.slice(-79), { i: t, v: p }] };
        });
        setAssets(upd);

        // 2. Check SL/TP on open positions
        const toClose = [], toKeep = [];
        posRef.current.forEach(pos => {
          const a = upd.find(x => x.id === pos.assetId);
          if (!a) { toKeep.push(pos); return; }
          if (a.price <= pos.sl) {
            const pnl = (pos.sl - pos.entryPrice) * pos.units;
            toClose.push({ ...pos, status: "SL", closePrice: pos.sl, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl });
            setBalance(b => { const n = +(b + pos.amount + pnl).toFixed(2); balRef.current = n; return n; });
            toast(`🛑 SL ${a.sym} — ${sign(pnl)}${eur(pnl)}`, "warn");
          } else if (a.price >= pos.tp) {
            const pnl = (pos.tp - pos.entryPrice) * pos.units;
            toClose.push({ ...pos, status: "TP", closePrice: pos.tp, closedAt: new Date().toLocaleTimeString("pt-PT"), pnl });
            setBalance(b => { const n = +(b + pos.amount + pnl).toFixed(2); balRef.current = n; return n; });
            toast(`✅ TP ${a.sym} +${eur(pnl)}`, "success");
          } else {
            toKeep.push(pos);
          }
        });
        if (toClose.length) {
          setClosed(p => [...toClose, ...p]);
          setPositions(toKeep);
        }

        // 3. Strategy signals
        stratRef.current.filter(s => s.ativo).forEach(s => {
          s.ativos.forEach(aid => {
            const key = `${s.id}_${aid}`;
            if ((cds.current[key] || 0) > 0) { cds.current[key]--; return; }
            const a = upd.find(x => x.id === aid);
            if (!a) return;
            const high     = highs.current[aid]?.p || a.price;
            const dropPct  = ((high - a.price) / high) * 100;
            if (dropPct >= s.compra && balRef.current >= s.perTrade) {
              const units = +(s.perTrade / a.price).toFixed(7);
              const sl    = +(a.price * (1 - s.sl / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
              const tp    = +(a.price * (1 + s.tp / 100)).toFixed(a.id === "eurusd" ? 4 : 2);
              const pos   = {
                id: uid(), assetId: a.id, assetName: a.name, assetSym: a.sym,
                entryPrice: a.price, units, amount: s.perTrade,
                strategy: s.nome, stratId: s.id, sl, tp,
                openedAt: new Date().toLocaleTimeString("pt-PT"), status: "ABERTA",
              };
              setPositions(p => [...p, pos]);
              setBalance(b => { const n = +(Math.max(0, b - s.perTrade)).toFixed(2); balRef.current = n; return n; });
              setStrategies(p => p.map(x => x.id === s.id ? { ...x, trades: x.trades + 1 } : x));
              cds.current[key] = 22;
              toast(`📈 BUY ${a.sym} @$${a.price.toFixed(2)} · "${s.nome}"`, "buy");
            }
          });
        });

        return t;
      });
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  // ── Derived ──
  const invested    = positions.reduce((s, p) => s + p.amount, 0);
  const unrealized  = positions.reduce((s, p) => {
    const a = assets.find(x => x.id === p.assetId);
    return s + (a ? (a.price - p.entryPrice) * p.units : 0);
  }, 0);
  const realized    = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  const totalPnl    = unrealized + realized;
  const portfolioV  = balance + invested + unrealized;
  const winRate     = closed.length ? (closed.filter(p => p.pnl > 0).length / closed.length) * 100 : null;

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
      const s = { ...obj2, id: uid(), objetivo: objective, trades: 0, ativo: true, criado: new Date().toLocaleString("pt-PT") };
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
      const lines = assets.map(a => `${a.name} (${a.sym}): $${fmt(a.price, a.id)} (${pctFmt(a.change)})`).join("\n");
      const { result, cost: c3 } = await callAI({
        max_tokens: 1000,
        system: "És um analista de mercados financeiros. Responde SEMPRE com JSON puro válido, sem markdown nem texto exterior.",
        messages: [{ role: "user", content:
`Analisa estes mercados e dá recomendações detalhadas para um investidor português.
Saldo: €${balance.toFixed(0)} | Posições: ${positions.length} | P&L não realizado: €${unrealized.toFixed(2)}

Preços${liveData ? " reais" : " simulados"}:
${lines}

Para cada ativo: "previsao" = frase simples sobre os próximos 1-5 dias.

JSON puro:
{
  "resumo": "análise geral 2 frases pt",
  "oportunidade": "melhor oportunidade agora 1 frase pt",
  "risco": "BAIXO|MÉDIO|ALTO",
  "melhor": "id do melhor ativo",
  "recs": [
    {"id":"btc","sinal":"COMPRAR|VENDER|AGUARDAR","confianca":78,"entrada":67000,"sl":60300,"tp":77050,"razao":"explicação simples 1-2 frases pt","previsao":"expectativa próximos dias 1 frase pt","horizonte":"2-4 dias"}
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
    const btc = assets.find(a => a.id === "btc");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Hero card */}
        <Glass style={{
          padding: "28px 32px",
          background: "linear-gradient(135deg,rgba(99,102,241,0.18) 0%,rgba(16,185,129,0.07) 100%)",
          border: "1px solid rgba(99,102,241,0.28)",
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 28 }}>
            <div>
              <div style={{ fontSize: 10, color: T.aLight, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 8 }}>Portfólio Simulado Total</div>
              <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em" }}>€{portfolioV.toFixed(2)}</div>
              <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ color: totalPnl >= 0 ? T.green : T.red, fontWeight: 700, fontSize: 15 }}>
                  {sign(totalPnl)}{eur(totalPnl)}
                </span>
                <span style={{ color: T.muted, fontSize: 12 }}>vs capital inicial €{INIT_BAL.toLocaleString()}</span>
              </div>
            </div>
            <KPI label="Disponível"      value={`€${balance.toFixed(0)}`}     sub={`${((balance / INIT_BAL) * 100).toFixed(1)}% livre`} />
            <KPI label="P&L Não Realiz." value={`${sign(unrealized)}${eur(unrealized)}`} sub={`${positions.length} posições abertas`} color={unrealized >= 0 ? T.green : T.red} />
            <KPI label="P&L Realizado"   value={`${sign(realized)}${eur(realized)}`}     sub={`${closed.length} trades fechados`}       color={realized >= 0 ? T.green : T.red} />
          </div>
        </Glass>

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
          {[
            { l: "Estratégias Ativas", v: strategies.filter(s => s.ativo).length, c: T.accent },
            { l: "Total Trades",       v: positions.length + closed.length,        c: T.blue   },
            { l: "Win Rate",           v: winRate !== null ? `${winRate.toFixed(0)}%` : "—",   c: T.gold  },
            { l: "Capital Investido",  v: `€${invested.toFixed(0)}`,               c: T.aLight },
          ].map(m => (
            <Glass key={m.l} style={{ padding: "18px 20px" }}>
              <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 8 }}>{m.l}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: m.c }}>{m.v}</div>
            </Glass>
          ))}
          {/* Custo AI */}
          <Glass style={{ padding: "18px 20px", background: `${T.accent}08`, border: `1px solid ${T.accent}22` }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 4 }}>Custo AI (€)</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: T.accent }}>€{aiCost.toFixed(4)}</div>
            <div style={{ fontSize: 9, color: T.muted, marginTop: 4 }}>~€0.007 por chamada</div>
          </Glass>
        </div>

        {/* Chart + movers */}
        <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 12 }}>
          {btc && (() => {
            const btcPos   = positions.find(p => p.assetId === "btc");
            const btcPosPnl = btcPos ? (btc.price - btcPos.entryPrice) * btcPos.units : null;
            return (
            <Glass style={{ padding: "20px 20px 10px" }}
              onMouseEnter={() => hoveredChart.current = "btc"}
              onMouseLeave={() => hoveredChart.current = null}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>Bitcoin</span>
                    {liveData && <span style={{ fontSize: 10, color: T.green }}>● LIVE</span>}
                    {hoveredChart.current === "btc" && <span style={{ fontSize: 9, color: T.gold }}>⏸ Pausado</span>}
                  </div>
                  <div style={{ fontSize: 11, color: T.muted }}>Preço{liveData ? " real" : " sim"} · passa o rato para pausar</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>${fmt(btc.price, "btc")}</div>
                  <div style={{ color: btc.change >= 0 ? T.green : T.red, fontSize: 12, fontWeight: 700 }}>{pctFmt(btc.change)} 24h</div>
                  {btcPos && <div style={{ fontSize: 11, fontWeight: 700, color: btcPosPnl >= 0 ? T.green : T.red }}>{sign(btcPosPnl)}€{Math.abs(btcPosPnl).toFixed(2)} P&L</div>}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={btc.hist}>
                  <defs>
                    <linearGradient id="btcG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={T.accent} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={T.accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="i" hide />
                  <YAxis domain={["auto","auto"]} hide />
                  <Tooltip
                    contentStyle={{ background: T.base, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 11, color: T.text }}
                    formatter={v => [`$${(+v).toFixed(2)}`]} labelFormatter={() => ""}
                  />
                  <Area type="monotone" dataKey="v" stroke={T.accent} strokeWidth={2} fill="url(#btcG)" dot={false} />
                  {btcPos && (
                    <ReferenceLine y={btcPos.entryPrice} stroke={T.gold} strokeDasharray="5 3" strokeWidth={2}
                      label={{ value: `Minha entrada $${btcPos.entryPrice.toFixed(0)}`, position:"insideTopLeft", fill: T.gold, fontSize: 10, fontWeight:700 }} />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </Glass>
          );})()}
          <Glass style={{ padding: "20px" }}>
            <SectionLabel>Todos os Ativos</SectionLabel>
            {assets.map(a => (
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

        {/* Open positions */}
        {positions.length > 0 && (
          <Glass style={{ padding: "20px" }}>
            <SectionLabel>Posições Abertas ({positions.length})</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {positions.map(pos => {
                const a    = assets.find(x => x.id === pos.assetId);
                const pnl  = a ? (a.price - pos.entryPrice) * pos.units : 0;
                const pct2 = (pnl / pos.amount) * 100;
                return (
                  <div key={pos.id} style={{
                    display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr",
                    gap: 8, padding: "12px 16px",
                    background: `${pnl >= 0 ? T.green : T.red}0a`,
                    border: `1px solid ${pnl >= 0 ? T.green : T.red}22`, borderRadius: 12,
                    alignItems: "center", fontSize: 12,
                  }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{pos.assetName}</div>
                      <div style={{ fontSize: 10, color: T.muted }}>{pos.strategy} · {pos.openedAt}</div>
                    </div>
                    <div><div style={{ fontSize: 9, color: T.muted }}>ENTRADA</div><div>${pos.entryPrice.toFixed(2)}</div></div>
                    <div><div style={{ fontSize: 9, color: T.muted }}>ATUAL</div><div>${a ? fmt(a.price, a.id) : "—"}</div></div>
                    <div><div style={{ fontSize: 9, color: T.muted }}>INVESTIDO</div><div>€{pos.amount}</div></div>
                    <div><div style={{ fontSize: 9, color: T.muted }}>SL / TP</div><div style={{ fontSize: 10 }}>${pos.sl} / ${pos.tp}</div></div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: pnl >= 0 ? T.green : T.red }}>{sign(pnl)}{eur(pnl)}</div>
                      <div style={{ fontSize: 10, color: pnl >= 0 ? T.green : T.red }}>{pctFmt(pct2)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Glass>
        )}

        {/* Gráfico das posições abertas */}
        {positions.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>Gráfico das Posições em Aberto</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              {positions.map(pos => {
                const a   = assets.find(x => x.id === pos.assetId);
                if (!a) return null;
                const pnl = (a.price - pos.entryPrice) * pos.units;
                const col = pnl >= 0 ? T.green : T.red;
                return (
                  <Glass key={pos.id} style={{ padding: "14px 16px 8px" }}
                    onMouseEnter={() => hoveredChart.current = pos.assetId}
                    onMouseLeave={() => hoveredChart.current = null}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 12 }}>{a.name}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>entrada ${pos.entryPrice.toFixed(2)}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: col }}>{sign(pnl)}€{Math.abs(pnl).toFixed(2)}</div>
                        <div style={{ fontSize: 10, color: col }}>{sign((pnl/pos.amount)*100)}{Math.abs((pnl/pos.amount)*100).toFixed(1)}%</div>
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={56}>
                      <AreaChart data={a.hist.slice(-40)} margin={{ top:2, bottom:2 }}>
                        <defs>
                          <linearGradient id={`pg${pos.id}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={col} stopOpacity={0.22}/>
                            <stop offset="95%" stopColor={col} stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="i" hide /><YAxis domain={["auto","auto"]} hide />
                        <Tooltip contentStyle={{ background: T.base, border:`1px solid ${T.border}`, borderRadius:7, fontSize:10 }}
                          formatter={v => [`$${(+v).toFixed(2)}`]} labelFormatter={() => ""}/>
                        <Area type="monotone" dataKey="v" stroke={col} strokeWidth={2} fill={`url(#pg${pos.id})`} dot={false}/>
                        <ReferenceLine y={pos.entryPrice} stroke={T.gold} strokeDasharray="5 3" strokeWidth={2}
                          label={{ value:`Entrada $${pos.entryPrice.toFixed(0)}`, position:"insideTopLeft", fill:T.gold, fontSize:9, fontWeight:700 }}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </Glass>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // AI: Sugerir oportunidades agora
  // ─────────────────────────────────────────────
  const getSuggestions = async () => {
    setSuggestLoading(true);
    try {
      const lines = assets.map(a => `${a.name} (${a.sym}): $${fmt(a.price, a.id)} (${pctFmt(a.change)} 24h)`).join("\n");
      const s     = settingsRef.current;
      const amount = calcTradeAmount();
      const { result, cost: c1 } = await callAI({
        max_tokens: 1200,
        system: "És um trader profissional experiente. Analisa mercados e dá oportunidades concretas e realistas. Responde SEMPRE com JSON puro, sem markdown.",
        messages: [{ role: "user", content:
`Analisa estes mercados AGORA e diz-me as melhores oportunidades de investimento para hoje.

Perfil do investidor: ${s.riscoPerfil} | Valor por trade: €${amount} | SL padrão: ${s.stopLossPadrao}% | TP padrão: ${s.takeProfitPadrao}%

Preços atuais:
${lines}

Seleciona 3 a 5 oportunidades concretas com maior potencial AGORA. Para cada uma explica em português simples (sem jargão) porquê é boa oportunidade.

JSON puro:
{
  "resumo": "análise geral do mercado em 1 frase simples em português",
  "momento": "BOM|NEUTRO|MAU",
  "oportunidades": [
    {
      "id": "btc",
      "nome": "Bitcoin",
      "icone": "₿",
      "sinal": "COMPRAR|AGUARDAR",
      "porque": "explicação simples em 1-2 frases, sem jargão, em português",
      "confianca": 78,
      "risco": "BAIXO|MÉDIO|ALTO",
      "entrada": 67000,
      "sl": 62100,
      "tp": 75000,
      "retornoEsperado": 11.9,
      "prazo": "2-5 dias"
    }
  ]
}` }],
      });
      setAiCost(p => +(p + c1).toFixed(4));
      setAiSuggestions({ ...result, geradoEm: new Date().toLocaleTimeString("pt-PT"), amount });
      toast("✦ Oportunidades atualizadas!", "success");
    } catch (e) { toast(`Erro: ${e.message}`, "error"); }
    setSuggestLoading(false);
  };

  // Investir numa sugestão diretamente
  const investirSugestao = (op) => {
    const amount = aiSuggestions?.amount || calcTradeAmount();
    const s = {
      id:          uid(),
      nome:        `${op.icone} ${op.nome}`,
      descricao:   op.porque,
      logica:      `Entrada $${op.entrada} · SL $${op.sl} · TP $${op.tp}`,
      ativos:      [op.id],
      compra:      0.5,
      perTrade:    amount,
      sl:          +((1 - op.sl / op.entrada) * 100).toFixed(1),
      tp:          +((op.tp / op.entrada - 1) * 100).toFixed(1),
      prazo:       op.prazo,
      risco:       op.risco,
      objetivo:    `Sugestão AI: ${op.porque.slice(0, 60)}…`,
      trades:      0,
      ativo:       true,
      criado:      new Date().toLocaleString("pt-PT"),
    };
    setStrategies(p => [s, ...p]);
    toast(`✅ A investir em ${op.nome}!`, "buy");
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
        <Glass style={{ padding: "0" }}>
          {/* Resumo topo */}
          <div style={{ padding: "16px 22px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: momentoC, boxShadow: `0 0 8px ${momentoC}` }} />
            <div style={{ fontSize: 13, color: T.text }}>{aiSuggestions.resumo}</div>
          </div>
          {/* Header tabela */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr 140px", gap: 0, padding: "10px 22px", borderBottom: `1px solid ${T.border}` }}>
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
                display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr 140px",
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
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {["Cripto hoje", "Commodities", "ETFs conservador", "Tudo (diversificado)"].map(s => (
              <button key={s} onClick={getSuggestions} style={{
                background: `${T.accent}12`, border: `1px solid ${T.accent}30`,
                borderRadius: 99, padding: "6px 16px", fontSize: 11, color: T.aLight,
                cursor: "pointer", fontFamily: "inherit",
              }}>{s}</button>
            ))}
          </div>
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
                onClick={() => setStrategies(p => p.map(x => x.id === s.id ? { ...x, ativo: !x.ativo } : x))}>
                {s.ativo ? "⏸ Pausar" : "▶ Ativar"}
              </Btn>
              <Btn sm color={T.red} onClick={() => setStrategies(p => p.filter(x => x.id !== s.id))}>✕</Btn>
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
  const [simMode, setSimMode] = useState(true); // true = simulação | false = live real
  const [mktData,    setMktData]    = useState({});   // { id: { price, change, high24h, low24h, volume, sparkline } }
  const [mktLoading, setMktLoading] = useState(true);
  const [mktError,   setMktError]   = useState(null);
  const [mktLastAt,  setMktLastAt]  = useState(null);
  const [orderModal,    setOrderModal]    = useState(null);
  const [orderAmount,   setOrderAmount]   = useState(100);
  const [aiCost,        setAiCost]        = useState(0);
  const [marketSignals, setMarketSignals] = useState({});
  const [mktCatTab,     setMktCatTab]     = useState("Todos");
  const [simMinimized,  setSimMinimized]  = useState(false);
  const [dailyVolume,   setDailyVolume]   = useState({});
  const hoveredChart = useRef(null);

  // ── Market quick signals (AI cada 5 min) ──────────────────────────────────
  const fetchMarketSignals = useCallback(async () => {
    try {
      const lines = ASSETS.map(a => {
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
    try {
      const r = await fetch("/.netlify/functions/market");
      const d = await r.json();
      if (d.ok && d.data) {
        setMktData(d.data);
        setMktError(null);
        setMktLastAt(new Date().toLocaleTimeString("pt-PT"));
        // Sync asset prices with real data
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
      const pos = {
        id: uid(), assetId, assetName: a?.name || assetId, assetSym: a?.sym || assetId,
        entryPrice: price, units, amount, sl, tp,
        strategy: "Manual (Mercados)", stratId: "manual",
        openedAt: new Date().toLocaleTimeString("pt-PT"), status: "ABERTA",
        mode: isSim ? "sim" : "live",
      };
      if (isSim) {
        setSimPositions(p => [...p, pos]);
        setSimBalance(b => { const n = +(Math.max(0, b - amount)).toFixed(2); simBalRef.current = n; return n; });
      } else {
        setPositions(p => [...p, pos]);
        setBalance(b => { const n = +(Math.max(0, b - amount)).toFixed(2); balRef.current = n; return n; });
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
          setSimBalance(b => { const n = +(b + openPos.amount + pnl).toFixed(2); simBalRef.current = n; return n; });
        } else {
          setClosed(p => [closedTrade, ...p]);
          setPositions(p => p.filter(x => x.id !== openPos.id));
          setBalance(b => { const n = +(b + openPos.amount + pnl).toFixed(2); balRef.current = n; return n; });
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
    const wins   = allSimTrades.filter(t => t.pnl > 0);
    const losses = allSimTrades.filter(t => t.pnl <= 0);
    const totalPnlSim = allSimTrades.reduce((s, t) => s + (t.pnl||0), 0);
    const duration = simStartedAt ? Math.round((Date.now() - simStartedAt.getTime()) / 60000) : 0;
    setSimSummary({
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
      terminadaEm:    new Date().toLocaleString("pt-PT"),
    });
  };

  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // RENDER: CARTEIRA (PORTFOLIO)
  // ─────────────────────────────────────────────
  const Portfolio = () => {
    const allPositions = [...positions, ...simPositions];
    const allClosed    = [...closed, ...simClosed];

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
            const a = assets.find(x=>x.id===p.assetId);
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
                const a       = assets.find(x=>x.id===pos.assetId);
                if (!a) return null;
                const live    = mktData[pos.assetId] || {};
                const price   = live.price ?? a.price;
                const pnl     = (price - pos.entryPrice) * pos.units;
                const pnlPct  = (pnl / pos.amount) * 100;
                const col     = pnl>=0 ? T.green : T.red;
                const spark   = live.sparkline?.length ? live.sparkline : a.hist.slice(-60);
                const open    = isMarketOpen(pos.assetId);
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
                const a   = assets.find(x=>x.id===t.assetId);
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
                    <div><Badge label={t.status||"MANUAL"} color={t.status==="TP"?T.green:t.status==="SL"?T.red:T.muted}/></div>
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

      {/* Cards grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14 }}>
        {assets.filter(a => mktCatTab==="Todos" || a.cat===mktCatTab).map(a => {
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
                          const sc2 = sig.sinal==="COMPRAR"?T.green:sig.sinal==="VENDER"?T.red:T.gold;
                          return <span title={sig.razao||""} style={{ background:`${sc2}18`, color:sc2, border:`1px solid ${sc2}33`, borderRadius:99, padding:"1px 8px", fontSize:9, fontWeight:700, cursor:"help" }}>◆ {sig.sinal}</span>;
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
              borderRadius: 20, padding: "28px 32px", width: 460,
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
              {sig && (
                <div style={{ margin:"12px 0", padding:"10px 14px", borderRadius:9,
                  background: `${sig.sinal==="COMPRAR"?T.green:sig.sinal==="VENDER"?T.red:T.gold}10`,
                  border: `1px solid ${sig.sinal==="COMPRAR"?T.green:sig.sinal==="VENDER"?T.red:T.gold}30`,
                  fontSize:11, color:T.muted, lineHeight:1.6 }}>
                  <b style={{ color: sig.sinal==="COMPRAR"?T.green:sig.sinal==="VENDER"?T.red:T.gold }}>◆ AI: {sig.sinal}</b>
                  {" · "}{sig.razao}
                  {sig.previsao && <div style={{marginTop:3, fontStyle:"italic"}}>{sig.previsao}</div>}
                </div>
              )}

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

  const AIIntel = () => {
    const sc = s => s === "COMPRAR" ? T.green : s === "VENDER" ? T.red : T.gold;

    // Calcular mais movimentados do dia (baseado em % change)
    const topMovers = [...assets]
      .map(a => ({ ...a, absChange: Math.abs(a.change) }))
      .sort((a,b) => b.absChange - a.absChange)
      .slice(0, 5);

    // Filtrar recs por categoria
    const filteredRecs = (aiRec?.recs || []).filter(rec => {
      if (aiCat === "Todos") return true;
      const asset = assets.find(x => x.id === rec.id);
      return asset?.cat === aiCat;
    });

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 200 }}>

        {/* ── TOP MOVERS HOJE ── */}
        <Glass style={{ padding: "16px 20px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontSize:13, fontWeight:700 }}>🔥 Mais Movimentados Hoje</div>
            <span style={{ fontSize:10, color:T.muted }}>variação % nas últimas 24h</span>
          </div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {topMovers.map((a, i) => (
              <div key={a.id} style={{
                flex:1, minWidth:90,
                background: a.change>=0 ? `${T.green}0d` : `${T.red}0d`,
                border: `1px solid ${a.change>=0 ? T.green : T.red}25`,
                borderRadius:10, padding:"10px 12px",
              }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
                  <span style={{ fontSize:18 }}>{a.icon}</span>
                  <span style={{ fontWeight:700, fontSize:12 }}>{a.sym}</span>
                  {i===0 && <span style={{ fontSize:9, color:T.gold }}>👑</span>}
                </div>
                <div style={{ fontWeight:800, fontSize:16, color: a.change>=0?T.green:T.red }}>
                  {a.change>=0?"▲":"▼"}{Math.abs(a.change).toFixed(2)}%
                </div>
                <div style={{ fontSize:10, color:T.muted }}>${fmt(a.price, a.id)}</div>
              </div>
            ))}
          </div>
        </Glass>

        {/* ── ANÁLISE BOTÃO ── */}
        <Glass style={{ padding: "20px 24px" }} glow>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>◆ Análise Profunda com IA</div>
              <div style={{ fontSize: 11, color: T.muted }}>
                Gera recomendações detalhadas com previsão de tendência e análise de risco para cada ativo.
              </div>
            </div>
            <Btn onClick={analyseMarket} disabled={aiLoading} color={T.accent} style={{ padding: "11px 24px", fontSize: 13, flexShrink:0, marginLeft:16 }}>
              {aiLoading ? "◌ A analisar…" : "◆ Analisar Agora"}
            </Btn>
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
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:12 }}>
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
                      <div style={{ marginTop:8, display:"flex", justifyContent:"space-between", fontSize:10, color:T.muted }}>
                        <span>Confiança: <b style={{ color:T.aLight }}>{rec.confianca}%</b></span>
                        {rec.horizonte && <span>Prazo: {rec.horizonte}</span>}
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
    const allTrades = [
      ...positions.map(p => {
        const a = assets.find(x => x.id === p.assetId);
        const pnl = a ? (a.price - p.entryPrice) * p.units : 0;
        return { ...p, curPnl: pnl, livePrice: a?.price };
      }),
      ...closed,
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          {[
            { l: "P&L Realizado",    v: `${sign(realized)}${eur(realized)}`,                                c: realized >= 0 ? T.green : T.red },
            { l: "P&L Não Realizado",v: `${sign(unrealized)}${eur(unrealized)}`,                            c: unrealized >= 0 ? T.green : T.red },
            { l: "Win Rate",         v: winRate !== null ? `${winRate.toFixed(1)}%` : "—",                   c: T.gold },
            { l: "Total Trades",     v: allTrades.length,                                                    c: T.accent },
          ].map(m => (
            <Glass key={m.l} style={{ padding: "18px 20px" }}>
              <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 8 }}>{m.l}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: m.c }}>{m.v}</div>
            </Glass>
          ))}
        </div>

        {allTrades.length === 0 ? (
          <Glass style={{ padding: "56px 24px", textAlign: "center" }}>
            <div style={{ color: T.muted, fontSize: 13 }}>Nenhum trade ainda. Cria uma estratégia e deixa o bot trabalhar.</div>
          </Glass>
        ) : (
          <Glass style={{ padding: "20px", overflowX: "auto" }}>
            <SectionLabel>Todos os Trades ({allTrades.length})</SectionLabel>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 820 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Ativo","Estratégia","Abertura","Entrada $","Preço Atual","Investido","Stop Loss","Take Profit","P&L","Status"].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: T.muted, fontSize: 8, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allTrades.map(t => {
                  const pnl    = t.pnl !== undefined ? t.pnl : t.curPnl;
                  const isOpen = t.status === "ABERTA";
                  return (
                    <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}20` }}>
                      <td style={{ padding: "10px 12px", fontWeight: 700 }}>{t.assetSym}</td>
                      <td style={{ padding: "10px 12px", color: T.muted, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.strategy}</td>
                      <td style={{ padding: "10px 12px", color: T.muted }}>{t.openedAt}</td>
                      <td style={{ padding: "10px 12px" }}>${t.entryPrice?.toFixed(2)}</td>
                      <td style={{ padding: "10px 12px" }}>{isOpen ? `$${t.livePrice ? fmt(t.livePrice, t.assetId) : "—"}` : `$${(+t.closePrice).toFixed(2)}`}</td>
                      <td style={{ padding: "10px 12px" }}>€{t.amount}</td>
                      <td style={{ padding: "10px 12px", color: T.red }}>${t.sl}</td>
                      <td style={{ padding: "10px 12px", color: T.green }}>${t.tp}</td>
                      <td style={{ padding: "10px 12px" }}>
                        {pnl !== undefined && (
                          <span style={{ color: pnl >= 0 ? T.green : T.red, fontWeight: 700 }}>
                            {sign(pnl)}{eur(pnl)}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <Badge
                          label={isOpen ? "ABERTA" : t.status === "TP" ? "✓ TP" : "✗ SL"}
                          color={isOpen ? T.blue : t.status === "TP" ? T.green : T.red}
                        />
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

  // ─────────────────────────────────────────────
  // RENDER: GUIA
  // ─────────────────────────────────────────────
  const Guide = () => {
    const steps = [
      {
        n: "01", c: T.aLight, title: "Interactive Brokers (IBKR) — Corretora Recomendada",
        body: (
          <>
            <p style={{ color: T.muted, fontSize: 12, lineHeight: 1.8, marginBottom: 14 }}>
              O <b style={{ color: T.text }}>IBKR</b> é a melhor opção para PT: acesso a futuros reais de petróleo (WTI/Brent), ações US, ETFs, forex, API robusta, e levantamento SEPA gratuito para IBAN PT. Regulado SEC/FCA/CMVM.
            </p>
            {[["Site", "ibkr.com → Open Account → Individual"], ["Documentos", "Cartão de Cidadão (frente+verso) + comprovativo morada recente"], ["NIF", "Obrigatório no registo português"], ["Aprovação", "1–3 dias úteis, 100% online"], ["2FA", "Ativar autenticação dois fatores — obrigatório"]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 14, padding: "7px 0", borderBottom: `1px solid ${T.border}44`, fontSize: 12 }}>
                <span style={{ color: T.accent, fontWeight: 700, minWidth: 110, flexShrink: 0 }}>{k}</span>
                <span style={{ color: T.muted }}>{v}</span>
              </div>
            ))}
            <div style={{ marginTop: 14, background: `${T.blue}10`, border: `1px solid ${T.blue}25`, borderRadius: 8, padding: "10px 14px", fontSize: 11, color: T.muted }}>
              💡 Alternativas: <b style={{ color: T.text }}>XTB</b> (interface PT, CFDs, zero comissão ETFs) · <b style={{ color: T.text }}>Trading 212</b> (mais simples, sem futuros)
            </div>
          </>
        ),
      },
      {
        n: "02", c: T.green, title: "Depositar Dinheiro — SEPA do teu banco PT",
        body: (
          <>
            <ol style={{ color: T.muted, fontSize: 12, lineHeight: 2.2, paddingLeft: 18 }}>
              <li>IBKR → <b style={{ color: T.text }}>Transfer & Pay → Deposit → SEPA Credit Transfer</b></li>
              <li>IBKR dá-te um IBAN (luxemburguês) para receber a transferência</li>
              <li>No teu banco PT faz transferência SEPA em EUR para esse IBAN</li>
              <li>Chega em <b style={{ color: T.text }}>1–2 dias úteis</b> · maioria dos bancos PT não cobra taxa</li>
              <li>Aparece diretamente em EUR na tua conta IBKR, sem conversão</li>
            </ol>
            <div style={{ marginTop: 12, background: `${T.gold}0f`, border: `1px solid ${T.gold}25`, borderRadius: 8, padding: "10px 14px", fontSize: 11, color: T.muted }}>
              💡 Começa com <b style={{ color: T.text }}>€500–1.000</b> para validar a lógica antes de escalar. IBKR sem depósito mínimo.
            </div>
          </>
        ),
      },
      {
        n: "03", c: T.gold, title: "Levantar Lucros para IBAN Português",
        body: (
          <>
            <ol style={{ color: T.muted, fontSize: 12, lineHeight: 2.2, paddingLeft: 18 }}>
              <li>IBKR → <b style={{ color: T.text }}>Transfer & Pay → Withdraw → SEPA Credit Transfer</b></li>
              <li>Insere o teu <b style={{ color: T.text }}>IBAN PT (PT50…)</b> em teu nome</li>
              <li>Mínimo: <b style={{ color: T.text }}>€200</b> por levantamento · IBKR não cobra taxa SEPA</li>
              <li>Chega em <b style={{ color: T.text }}>1–3 dias úteis</b> diretamente na tua conta PT</li>
              <li>Primeira vez pede verificação do IBAN — nas seguintes é instantâneo</li>
            </ol>
            <div style={{ marginTop: 12, background: `${T.green}0f`, border: `1px solid ${T.green}25`, borderRadius: 8, padding: "10px 14px", fontSize: 11, color: T.muted }}>
              ✓ Conversão EUR→EUR: sem custo de câmbio. O IBKR mantém a conta em EUR se depositares em EUR.
            </div>
          </>
        ),
      },
      {
        n: "04", c: T.red, title: "Impostos em Portugal — IRS",
        body: (
          <>
            {[
              ["Mais-valias (ações, ETFs, futuros)", "Categoria G — taxa autónoma 28% sobre o lucro", T.red],
              ["Dividendos", "Categoria E — 28% (ou englobamento se taxa marginal < 28%)", T.gold],
              ["Quando declarar", "Ganhos de 2025 → IRS de Abril/Junho 2026", T.green],
              ["Documentação", "IBKR fornece relatório anual PDF/CSV com todos os trades — guarda tudo", T.blue],
            ].map(([k, v, c]) => (
              <div key={k} style={{ padding: "9px 0", borderBottom: `1px solid ${T.border}44` }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: c, marginBottom: 2 }}>{k}</div>
                <div style={{ fontSize: 11, color: T.muted }}>{v}</div>
              </div>
            ))}
            <div style={{ marginTop: 12, background: `${T.red}0d`, border: `1px solid ${T.red}22`, borderRadius: 8, padding: "10px 14px", fontSize: 11, color: T.muted }}>
              ⚠ Consulta um TOC/contabilista para a tua situação específica — regras fiscais podem mudar.
            </div>
          </>
        ),
      },
      {
        n: "05", c: T.accent, title: "Integrar no Netlify + Firebase (o teu stack)",
        body: (
          <>
            <p style={{ color: T.muted, fontSize: 12, lineHeight: 1.8, marginBottom: 12 }}>
              Este React pode ser integrado diretamente no teu setup Netlify + Firebase. O Firebase guarda estratégias, histórico de trades e configuração do bot.
            </p>
            <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: "14px 16px", fontFamily: "monospace", fontSize: 11, color: T.aLight, lineHeight: 1.9 }}>
              {`// firestore.js\nimport { doc, setDoc, collection, onSnapshot } from "firebase/firestore";\n\n// Guardar estratégia\nawait setDoc(doc(db, "strategies", id), strategy);\n\n// Ouvir trades em tempo real\nonSnapshot(collection(db, "trades"), snap => setTrades(...));\n\n// Bot Node.js (Hetzner ~€4/mês)\n// Lê estratégias do Firestore → IBKR API → escreve trades`}
            </div>
            <div style={{ marginTop: 12, background: `${T.accent}0a`, border: `1px solid ${T.accent}25`, borderRadius: 8, padding: "10px 14px", fontSize: 11, color: T.muted }}>
              📦 Stack do bot: <b style={{ color: T.text }}>Node.js 20 + @stoqey/ib + firebase-admin + node-cron + PM2</b>
            </div>
          </>
        ),
      },
    ];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Glass style={{
          padding: "24px 28px",
          background: "linear-gradient(135deg,rgba(99,102,241,0.12),rgba(16,185,129,0.07))",
          border: `1px solid ${T.accent}30`,
        }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Guia Completo — Do Zero ao Bot a Investir</div>
          <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.7 }}>
            Tudo o que precisas para ter dinheiro real gerido automaticamente, com levantamento direto para IBAN PT sem complicações.
          </div>
        </Glass>
        {steps.map(s => (
          <Glass key={s.n} style={{ padding: "22px 24px", display: "flex", gap: 20 }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: s.c, opacity: 0.25, flexShrink: 0, lineHeight: 1, paddingTop: 2 }}>{s.n}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: s.c, marginBottom: 14 }}>{s.title}</div>
              {s.body}
            </div>
          </Glass>
        ))}
        <div style={{ textAlign: "center", padding: 18, color: T.muted, fontSize: 11, borderTop: `1px solid ${T.border}` }}>
          ⚠ App educacional de simulação. Trading envolve risco real de perda de capital.
        </div>
      </div>
    );
  };

  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // RENDER: DEFINIÇÕES
  // ─────────────────────────────────────────────
  const Settings = () => {
    const [local, setLocal] = useState({ ...settings });
    const upd = (k, v) => setLocal(p => ({ ...p, [k]: v }));
    const save = () => { setSettings(local); toast("✅ Definições guardadas!", "success"); };

    const perfilInfo = {
      conservador: { desc: "Quedas maiores para acionar compra, SL/TP mais apertados. Menos trades, mais seguros.", sl: 4, tp: 8,  compra: 2.5 },
      moderado:    { desc: "Equilíbrio entre oportunidades e risco. Recomendado para começar.",                    sl: 6, tp: 12, compra: 1.5 },
      agressivo:   { desc: "Mais trades, entradas mais frequentes. Potencial de ganho e perda maior.",             sl: 9, tp: 18, compra: 0.8 },
    };
    const info = perfilInfo[local.riscoPerfil];
    const amountPreview = local.modoValor === "fixo"
      ? local.valorFixo
      : Math.max(10, +(local.capitalTotal * local.percentagem / 100).toFixed(2));

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 780 }}>

        {/* Banner intro */}
        <Glass style={{ padding: "20px 24px", background: "linear-gradient(135deg,rgba(99,102,241,0.14),rgba(16,185,129,0.07))", border: `1px solid ${T.accent}30` }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>⚙ As tuas Definições</div>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.7 }}>
            Configura quanto queres arriscar por trade e o teu perfil. A IA usa estas definições para criar estratégias adequadas a ti.
            <b style={{ color: T.aLight }}> Não precisas de perceber de trading</b> — ajusta o risco e deixa o bot trabalhar.
          </div>
        </Glass>

        {/* Capital e valor por trade */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 16 }}>💰 Capital e Valor por Trade</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Capital total disponível (€)</div>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 8, lineHeight: 1.55 }}>
                O total que tens para investir. O bot nunca gasta mais do que isto.
              </div>
              <input type="number" value={local.capitalTotal} onChange={e => upd("capitalTotal", +e.target.value)}
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
                  <input type="number" value={local.valorFixo} onChange={e => upd("valorFixo", +e.target.value)}
                    style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: `1px solid ${T.accent}33`, borderRadius: 8, padding: "10px 14px", color: T.text, fontSize: 15, fontWeight: 700, fontFamily: "inherit", outline: "none" }} />
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>Percentagem da banca por trade: <b style={{ color: T.aLight }}>{local.percentagem}%</b></div>
                  <input type="range" min={1} max={25} value={local.percentagem} onChange={e => upd("percentagem", +e.target.value)}
                    style={{ width: "100%", accentColor: T.accent }} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.muted, marginTop: 4 }}>
                    <span>Conservador 1%</span><span>Agressivo 25%</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* Preview */}
          <div style={{ background: `${T.green}0d`, border: `1px solid ${T.green}22`, borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: T.muted }}>💡 Com estas definições, cada trade investirá:</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: T.green }}>€{amountPreview}</span>
          </div>
        </Glass>

        {/* Perfil de risco */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 16 }}>🎯 Perfil de Risco</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { id: "conservador", emoji: "🛡️", label: "Conservador",  desc: "Menos trades, mais seguros" },
              { id: "moderado",    emoji: "⚖️", label: "Moderado",     desc: "Equilíbrio (recomendado)" },
              { id: "agressivo",   emoji: "🚀", label: "Agressivo",    desc: "Mais trades, mais risco" },
            ].map(p => (
              <div key={p.id} onClick={() => upd("riscoPerfil", p.id)} style={{
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

        {/* Limites de segurança */}
        <Glass style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.aLight, marginBottom: 6 }}>🔒 Limites de Segurança</div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 16, lineHeight: 1.6 }}>
            Proteções automáticas para não perderes mais do que estás disposto. O bot para automaticamente se estes limites forem atingidos.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[
              { k: "maxPosicoesAbertas", l: "Máx. posições em simultâneo", desc: "O bot não abre mais trades além deste número", min: 1, max: 20 },
              { k: "stopLossPadrao",     l: "Stop Loss padrão (%)",         desc: "Vende automaticamente se o preço cair esta percentagem", min: 1, max: 30 },
              { k: "takeProfitPadrao",   l: "Take Profit padrão (%)",       desc: "Vende automaticamente se o preço subir esta percentagem", min: 2, max: 50 },
            ].map(f => (
              <div key={f.k} style={{ background: "rgba(0,0,0,0.18)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{f.l}</div>
                <div style={{ fontSize: 10, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>{f.desc}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="range" min={f.min} max={f.max} value={local[f.k]} onChange={e => upd(f.k, +e.target.value)}
                    style={{ flex: 1, accentColor: T.accent }} />
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.aLight, minWidth: 38, textAlign: "right" }}>{local[f.k]}{f.k !== "maxPosicoesAbertas" ? "%" : ""}</div>
                </div>
              </div>
            ))}
            <div style={{ background: `${T.accent}0a`, border: `1px solid ${T.accent}22`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Auto-Investir com sugestões AI</div>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>
                A IA analisa e investe automaticamente sem precisares de carregar em "Investir". Usar com cuidado.
              </div>
              <div onClick={() => upd("autoInvestir", !local.autoInvestir)} style={{
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
              }}>
                <div style={{
                  width: 44, height: 24, borderRadius: 12, transition: "all 0.2s",
                  background: local.autoInvestir ? T.green : "rgba(255,255,255,0.1)",
                  position: "relative",
                }}>
                  <div style={{
                    position: "absolute", top: 3, left: local.autoInvestir ? 22 : 2,
                    width: 18, height: 18, borderRadius: "50%", background: "#fff",
                    transition: "left 0.2s",
                  }} />
                </div>
                <span style={{ fontSize: 12, color: local.autoInvestir ? T.green : T.muted, fontWeight: 700 }}>
                  {local.autoInvestir ? "ATIVADO" : "Desativado"}
                </span>
              </div>
            </div>
          </div>
        </Glass>

        {/* Guardar */}
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <Btn color={T.muted} onClick={() => setLocal({ ...settings })}>Cancelar</Btn>
          <Btn color={T.green} solid onClick={save} style={{ padding: "11px 32px", fontSize: 14 }}>
            ✓ Guardar Definições
          </Btn>
        </div>
      </div>
    );
  };

  // NAV + LAYOUT
  // ─────────────────────────────────────────────
  const NAV = [
    { id: "dashboard",  icon: "◈", label: "Dashboard"       },
    { id: "portfolio",  icon: "💼", label: "Carteira"        },
    { id: "markets",    icon: "◎", label: "Mercados"         },
    { id: "strategies", icon: "🎯", label: "Estratégias"     },
    { id: "ai",         icon: "◆", label: "AI Intel"         },
    { id: "history",    icon: "≡", label: "Histórico"        },
    { id: "settings",   icon: "⚙", label: "Definições"      },
    { id: "guide",      icon: "◉", label: "Guia Setup"       },
  ];

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
      `}</style>

      {/* HEADER */}
      <header style={{
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
            TradeAI <span style={{ color: T.muted, fontWeight: 400, fontSize: 13 }}>Simulator</span>
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 12 }}>
          {/* ── TOGGLE SIMULAÇÃO / LIVE ── */}
          <div
            onClick={() => {
              if (simMode) {
                if (window.confirm(
                  "⚠️ ATENÇÃO — Modo LIVE\n\n" +
                  "Em modo LIVE os trades serão executados com dinheiro REAL no IBKR.\n\n" +
                  "Confirmas que tens o TWS aberto e a conta configurada?\n\n" +
                  "(Podes voltar a Simulação a qualquer momento)"
                )) { setSimMode(false); }
              } else {
                setSimMode(true);
                // Reinicia simulação com capital configurado
                setSimBalance(simCapital);
                simBalRef.current = simCapital;
                setSimPositions([]);
                simPosRef.current = [];
                setSimClosed([]);
                setSimStartedAt(new Date());
                toast("◎ Nova simulação iniciada com €" + simCapital, "success");
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
          <span style={{ color: T.muted }}>Portfólio: <b style={{ color: T.text }}>€{portfolioV.toFixed(2)}</b></span>
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
        {/* SIDEBAR */}
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
              {item.id === "portfolio" && (positions.length + simPositions.length) > 0 && (
                <span style={{ marginLeft: "auto", background: T.green, color: "#000", borderRadius: 99, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>
                  {positions.length + simPositions.length}
                </span>
              )}
            </div>
          ))}
          {/* Bottom info */}
          <div style={{ marginTop: "auto", padding: "16px 18px", borderTop: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>Posições Abertas</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{positions.length}</div>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 10, marginBottom: 4 }}>P&L Não Realizado</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: unrealized >= 0 ? T.green : T.red }}>
              {sign(unrealized)}{eur(unrealized)}
            </div>
          </div>
        </nav>

        {/* MAIN */}
        <main style={{ flex: 1, padding: "22px", overflowY: "auto", maxHeight: "calc(100vh - 56px)" }}>
          <div style={{ animation: "fadeIn 0.25s ease" }} key={tab}>
            {tab === "dashboard"  && <Dashboard />}
            {tab === "portfolio"  && <Portfolio />}
            {tab === "markets"    && <Markets />}
            {tab === "strategies" && <Strategies />}
            {tab === "ai"         && <AIIntel />}
            {tab === "history"    && <History />}
            {tab === "settings"   && <Settings />}
            {tab === "guide"      && <Guide />}
          </div>
        </main>
      </div>

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

      {/* ── PAINEL SIMULAÇÃO FLUTUANTE (canto inferior esquerdo) ── */}
      {simMode && (
        <div style={{
          position: "fixed", bottom: 20, left: 212, zIndex: 1000,
          background: "rgba(6,6,26,0.92)", backdropFilter: "blur(16px)",
          border: `1px solid ${T.green}33`, borderRadius: 14,
          padding: "14px 18px", minWidth: 320,
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
              <button onClick={finishSim}
                style={{ background:`${T.red}18`, border:`1px solid ${T.red}33`, borderRadius:6, padding:"3px 10px", fontSize:10, color:T.red, cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>
                ■ Terminar
              </button>
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
          {/* Stats — inclui P&L não realizado das posições abertas */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {(() => {
              const unrealSim = simPositions.reduce((sum, pos) => {
                const a = assets.find(x => x.id === pos.assetId);
                return sum + (a ? (a.price - pos.entryPrice) * pos.units : 0);
              }, 0);
              const totalSim = simBalance + simPositions.reduce((s,p) => s+p.amount, 0) + unrealSim;
              const pnlTotal = totalSim - simCapital;
              const roiTotal = simCapital > 0 ? (pnlTotal / simCapital) * 100 : 0;
              return [
                { l: "Saldo Livre",   v: `€${simBalance.toFixed(2)}`,                                 c: T.text },
                { l: "P&L Total",     v: `${sign(pnlTotal)}€${Math.abs(pnlTotal).toFixed(2)}`,        c: pnlTotal>=0?T.green:T.red },
                { l: "ROI",           v: `${sign(roiTotal)}${Math.abs(roiTotal).toFixed(1)}%`,         c: pnlTotal>=0?T.green:T.red },
                { l: "Posições",      v: simPositions.length,                                          c: T.accent },
                { l: "Trades Fech.", v: simClosed.length,                                              c: T.muted },
                { l: "Win Rate",      v: simClosed.length ? `${(simClosed.filter(t=>t.pnl>0).length/simClosed.length*100).toFixed(0)}%`:"—", c: T.gold },
              ];
            })().map(s => (
              <div key={s.l} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>{s.l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
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
            borderRadius: 20, padding: "36px 40px", width: 560, maxHeight: "88vh", overflowY: "auto",
            boxShadow: `0 0 80px ${simSummary.roi >= 0 ? T.green : T.red}18`,
          }}>
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
                  if (window.confirm("Passar para modo LIVE com dinheiro real?")) setSimMode(false);
                }
              }} style={{
                flex: 1, background: `${T.green}18`, border: `1px solid ${T.green}44`,
                borderRadius: 10, padding: "13px", fontSize: 13, color: T.green,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 700,
              }}>● Passar para LIVE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
