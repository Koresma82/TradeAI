# ◆ TradeAI Simulator

Bot de trading simulado com IA — estratégias em linguagem natural, preços reais BTC/ETH, P&L em tempo real.

---

## 📁 Estrutura do Projeto

```
tradeai/
├── src/
│   ├── App.jsx          ← componente principal (toda a UI + lógica)
│   ├── firebase.js      ← funções Firestore (guardar estratégias e trades)
│   └── main.jsx         ← entry point React
├── public/
│   └── favicon.svg
├── index.html
├── package.json
├── vite.config.js
├── netlify.toml         ← configuração deploy Netlify
├── .env.example         ← variáveis de ambiente (copia para .env)
└── README.md
```

---

## 🚀 PASSO 1 — Abrir o Projeto Localmente

### Pré-requisitos
- Node.js 18 ou 20 instalado → https://nodejs.org

### Instalar e correr

```bash
# 1. Entra na pasta do projeto
cd tradeai

# 2. Instala dependências
npm install

# 3. Copia o ficheiro de variáveis de ambiente
cp .env.example .env

# 4. Corre em modo desenvolvimento
npm run dev
```

Abre o browser em **http://localhost:5173** — a app está a correr!

---

## 🔥 PASSO 2 — Criar o Projeto Firebase

1. Vai a https://console.firebase.google.com
2. Clica em **"Add project"** → dá um nome (ex: `tradeai-simulator`)
3. Desativa Google Analytics (opcional) → **Create project**
4. No menu lateral: **Build → Firestore Database**
   - Clica **"Create database"**
   - Escolhe **"Start in test mode"** (para desenvolvimento)
   - Região: `europe-west1` (Bélgica — mais próximo de PT)
5. No menu lateral: **Project Settings** (ícone ⚙️)
   - Vai a **"Your apps"** → clica **"</>"** (Web)
   - Dá um nome (ex: `tradeai-web`) → **Register app**
   - Copia os valores do `firebaseConfig`

### Preenche o ficheiro `.env`

Abre o ficheiro `.env` e substitui os valores:

```env
VITE_FIREBASE_API_KEY=AIzaSy...            ← apiKey
VITE_FIREBASE_AUTH_DOMAIN=xxx.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=tradeai-simulator
VITE_FIREBASE_STORAGE_BUCKET=xxx.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123...
VITE_FIREBASE_APP_ID=1:123...:web:abc...
```

### Regras Firestore (para produção)

Na Firebase Console → Firestore → **Rules**, cola estas regras:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true; // temporário — adiciona auth depois
    }
  }
}
```

---

## 🌐 PASSO 3 — Deploy no Netlify

### Opção A — Via GitHub (recomendado)

```bash
# 1. Cria repositório no GitHub
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/SEU_USER/tradeai.git
git push -u origin main
```

2. Vai a https://app.netlify.com → **"Add new site" → "Import an existing project"**
3. Liga a tua conta GitHub → escolhe o repositório `tradeai`
4. Netlify detecta automaticamente o `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
5. **Environment variables** → clica **"Add a variable"** e adiciona cada linha do teu `.env`:
   - `VITE_FIREBASE_API_KEY` = `AIzaSy...`
   - `VITE_FIREBASE_AUTH_DOMAIN` = `...`
   - (e assim por diante para cada variável)
6. Clica **"Deploy site"** → aguarda ~2 minutos

✅ A tua app está online em `https://nome-aleatorio.netlify.app`

### Opção B — Drag & Drop (sem GitHub)

```bash
npm run build
```

Arrasta a pasta `dist/` para https://app.netlify.com/drop

> ⚠ Nesta opção as variáveis de ambiente têm de ser injetadas antes do build.

---

## 🔧 Como Integrar o Firebase na App

O ficheiro `src/firebase.js` já tem todas as funções preparadas.
Para activar a persistência, edita `src/App.jsx` e substitui o `useState` inicial por subscriptions Firestore:

```jsx
// No topo do App.jsx, importa as funções:
import { subscribeStrategies, saveStrategy, deleteStrategy, subscribeTrades, saveTrade } from "./firebase.js";

// No useEffect de inicialização:
useEffect(() => {
  const unsubStrat  = subscribeStrategies(setStrategies);
  const unsubTrades = subscribeTrades(setTrades);      // trades fechados
  return () => { unsubStrat(); unsubTrades(); };
}, []);

// Quando criar estratégia:
setStrategies(p => [s, ...p]);
await saveStrategy(s);               // persiste no Firestore

// Quando fechar trade:
setClosed(p => [closedPos, ...p]);
await saveTrade(closedPos);          // persiste no Firestore
```

---

## 💡 Arquitectura Resumida

```
Browser (React + Vite)
  ↓ preços simulados (2s interval)
  ↓ BTC/ETH reais (CoinGecko, 60s)
  ↓ estratégias → motor de ordens
  ↓ P&L em tempo real
  ↓ guardar/ler no Firestore
Firebase Firestore
  ← strategies (criadas pela IA)
  ← trades (abertos + fechados)
  ← settings (saldo inicial)
Netlify
  ← serve a app (React build)
  ← variáveis de ambiente seguras
```

---

## 🤖 Como Funciona o Bot de Simulação

1. **Crias uma estratégia** em linguagem natural (ex: *"ouro e prata conservador"*)
2. **A IA (Claude)** define os parâmetros: ativos, % queda para compra, stop-loss, take-profit
3. **O motor** monitoriza preços a cada 2s e dispara ordens quando a condição é cumprida
4. **Stop-loss e take-profit** fecham posições automaticamente ao preço exacto
5. **P&L** é calculado em tempo real (não realizado) e ao fechar (realizado)

---

## 📦 Dependências

| Pacote | Uso |
|--------|-----|
| `react` + `react-dom` | Framework UI |
| `recharts` | Gráficos de área e linha |
| `firebase` | Firestore para persistência |
| `vite` | Build tool rápido |
| `@vitejs/plugin-react` | Suporte JSX no Vite |

---

## ⚠ Avisos

- Esta app é uma **ferramenta educacional de simulação**
- Os preços (excepto BTC/ETH) são **simulados** com random walk
- Trading real envolve risco de perda de capital
- A chave da API Anthropic é gerida pelo claude.ai quando usada como artifact
