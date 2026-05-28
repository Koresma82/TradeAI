// netlify/functions/market.js
// Preços reais — CoinGecko (crypto) + Yahoo Finance (todo o resto)

const YAHOO_MAP = {
  // Tradeable
  wti:    "CL=F",   brent:  "BZ=F",   gold:   "GC=F",
  silver: "SI=F",   spy:    "SPY",     qqq:    "QQQ",
  eurusd: "EURUSD=X",
  // Extra commodities
  natgas: "NG=F",   copper: "HG=F",   plat:   "PL=F",
  wheat:  "ZW=F",   corn:   "ZC=F",
  // Extra ETFs
  iwm:    "IWM",    gld:    "GLD",    tlt:    "TLT",
  xle:    "XLE",    eem:    "EEM",    vti:    "VTI",
  // Extra Forex
  gbpusd: "GBPUSD=X", usdjpy: "JPY=X",
  usdchf: "CHF=X",    audusd: "AUDUSD=X", usdcad: "CAD=X",
};

const CG_IDS = {
  btc: "bitcoin", eth: "ethereum", bnb: "binancecoin",
  sol: "solana",  xrp: "ripple",   ada: "cardano",
  doge:"dogecoin",avax:"avalanche-2", dot:"polkadot", link:"chainlink",
};

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=false`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!r.ok) throw new Error(`Yahoo ${symbol}: ${r.status}`);
  return r.json();
}

async function fetchCoinGecko() {
  const ids = Object.values(CG_IDS).join(",");
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=24h`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko: ${r.status}`);
  return r.json();
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };
  try {
    const results = {};

    // ── Crypto via CoinGecko (um pedido para tudo) ────────────────────────
    try {
      const cgData = await fetchCoinGecko();
      const cgMap  = Object.fromEntries(Object.entries(CG_IDS).map(([id, cgId]) => [cgId, id]));
      for (const coin of cgData) {
        const id = cgMap[coin.id];
        if (!id) continue;
        results[id] = {
          price:     coin.current_price,
          change:    coin.price_change_percentage_24h ?? 0,
          high24h:   coin.high_24h,
          low24h:    coin.low_24h,
          volume:    coin.total_volume,
          marketCap: coin.market_cap,
          sparkline: (coin.sparkline_in_7d?.price || []).slice(-48).map((v, i) => ({ i, v: +v.toFixed(4) })),
          source:    "coingecko",
          liveAt:    new Date().toISOString(),
        };
      }
    } catch (e) { console.error("CoinGecko:", e.message); }

    // ── Yahoo Finance (todos em paralelo, falha silenciosa por ticker) ────
    await Promise.all(Object.entries(YAHOO_MAP).map(async ([id, symbol]) => {
      try {
        const data  = await fetchYahoo(symbol);
        const chart = data?.chart?.result?.[0];
        if (!chart) return;
        const meta    = chart.meta;
        const quotes  = chart.indicators?.quote?.[0] || {};
        const closes  = (quotes.close  || []).filter(Boolean);
        const highs   = (quotes.high   || []).filter(Boolean);
        const lows    = (quotes.low    || []).filter(Boolean);
        const volumes = (quotes.volume || []).filter(Boolean);
        const price      = meta.regularMarketPrice ?? closes.at(-1) ?? 0;
        const prevClose  = meta.chartPreviousClose  ?? meta.previousClose ?? price;
        const change     = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
        const isForex    = id.includes("usd") || id === "usdjpy" || id === "usdchf" || id === "usdcad" || id === "audusd" || id === "gbpusd";
        results[id] = {
          price:    +price.toFixed(isForex ? 4 : 2),
          change:   +change.toFixed(3),
          high24h:  highs.length  ? +Math.max(...highs).toFixed(isForex ? 4 : 2)  : price,
          low24h:   lows.length   ? +Math.min(...lows).toFixed(isForex ? 4 : 2)   : price,
          volume:   volumes.reduce((s, v) => s + v, 0),
          sparkline: closes.slice(-48).map((v, i) => ({ i, v: +v.toFixed(isForex?4:2) })),
          symbol,
          source:   "yahoo",
          liveAt:   new Date().toISOString(),
        };
      } catch (e) { console.error(`Yahoo ${symbol}:`, e.message); }
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, data: results, count: Object.keys(results).length, fetchedAt: new Date().toISOString() }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
