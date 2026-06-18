import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy, limit, where, serverTimestamp,
} from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

const firebaseConfig = {
  apiKey:            "AIzaSyCozfrvjzZgZYXEIUz_sCh3d4fqG1zU5JU",
  authDomain:        "tradeaisimulator-aebcd.firebaseapp.com",
  projectId:         "tradeaisimulator-aebcd",
  storageBucket:     "tradeaisimulator-aebcd.firebasestorage.app",
  messagingSenderId: "928892416408",
  appId:             "1:928892416408:web:e795c5111021398a887bed",
  measurementId:     "G-L5QF7D1PSX",
};

const app      = initializeApp(firebaseConfig);
export const db   = getFirestore(app);
export const auth = getAuth(app);

// ── AUTH ──────────────────────────────────────────────────────────────────────
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export const loginWithGoogle = () => signInWithPopup(auth, googleProvider);
export const logout          = ()  => signOut(auth);
export const onAuthChange    = (cb) => onAuthStateChanged(auth, cb);

// Token do utilizador atual (para autenticar as Netlify Functions).
export async function getIdToken() {
  const u = auth.currentUser;
  if (!u) return null;
  // forceRefresh=true: o Firebase renova o token se estiver perto de expirar,
  // evitando 401 (Token inválido ou expirado) nas chamadas às functions.
  try { return await u.getIdToken(true); } catch { return null; }
}

// ── Firestore helpers (prefixados com uid para dados por utilizador) ──────────
const userDoc  = (uid, ...segs) => doc(db, "users", uid, ...segs);
const userCol  = (uid, col_)   => collection(db, "users", uid, col_);

// ── Strategies ────────────────────────────────────────────────────────────────
export async function saveStrategy(uid, strategy) {
  await setDoc(userDoc(uid, "strategies", strategy.id), {
    ...strategy, updatedAt: serverTimestamp(),
  });
}
export async function deleteStrategy(uid, id) {
  await deleteDoc(userDoc(uid, "strategies", id));
}
export function subscribeStrategies(uid, callback) {
  const q = query(userCol(uid, "strategies"), orderBy("updatedAt", "desc"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ ...d.data(), id: d.id }))));
}

// ── Trades ────────────────────────────────────────────────────────────────────
export async function saveTrade(uid, trade) {
  await setDoc(userDoc(uid, "trades", trade.id), {
    ...trade, savedAt: serverTimestamp(),
  });
}
export async function updateTrade(uid, id, updates) {
  await setDoc(userDoc(uid, "trades", id), { ...updates, updatedAt: serverTimestamp() }, { merge: true });
}
export async function deleteTrade(uid, id) {
  await deleteDoc(userDoc(uid, "trades", id));
}
// ── Canal de comandos (app → bot) ────────────────────────────────────────────
// Escreve uma intenção do utilizador (comprar/vender) na fila que o bot lê e
// executa. A app NUNCA executa diretamente em paper/real — pede ao bot.
export async function sendCommand(uid, command) {
  const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await setDoc(userDoc(uid, "commands", id), {
    ...command, id, status: "PENDENTE", createdTs: Date.now(), createdAt: serverTimestamp(),
  });
  return id;
}
// Segue um comando específico até o bot o resolver (FEITO/FALHOU). Chama o
// callback com o estado e cancela-se sozinho após um timeout (o bot pode estar
// offline). Devolve uma função de cancelamento.
export function watchCommand(uid, id, callback, timeoutMs = 90000) {
  let done = false;
  const unsub = onSnapshot(userDoc(uid, "commands", id), snap => {
    const d = snap.data();
    if (!d || done) return;
    if (d.status && d.status !== "PENDENTE") {
      done = true;
      callback({ status: d.status, reason: d.reason || d.result || "" });
      unsub();
    }
  });
  const timer = setTimeout(() => {
    if (!done) { done = true; unsub(); callback({ status: "TIMEOUT", reason: "o bot não respondeu a tempo" }); }
  }, timeoutMs);
  return () => { done = true; clearTimeout(timer); unsub(); };
}
export function subscribeTrades(uid, callback) {
  // Duas subscrições combinadas para nunca "perder" uma posição ABERTA:
  //
  //  (A) ABERTAS — TODAS, sem limite. São poucas (limitadas por maxPosicoesTotal)
  //      e é CRÍTICO mostrá-las todas: se uma posição aberta cair fora da janela,
  //      desaparece do ecrã mas o bot continua a geri-la — não a consegues ver
  //      nem fechar. Era o bug das posições manuais que "desapareciam" quando o
  //      bot abria muitos trades novos e empurrava as antigas para fora do top-150.
  //
  //  (B) FECHADAS — só as 150 mais recentes. Os fechados de dias anteriores vêm
  //      do Arquivo Diário (subscribeArchives), por isso não é preciso reler
  //      centenas a cada mudança — poupa leituras Firestore com o bot a operar.
  //
  // Combinamos os dois snapshots e devolvemos a união (sem duplicados).
  const qOpen   = query(userCol(uid, "trades"), where("status", "==", "ABERTA"));
  const qClosed = query(userCol(uid, "trades"), orderBy("savedAt", "desc"), limit(150));

  let abertas = [], fechadas = [];
  const emit = () => {
    const ids = new Set(abertas.map(t => t.id));
    // União: todas as abertas + fechadas recentes que não estejam já incluídas.
    const merged = [...abertas, ...fechadas.filter(t => !ids.has(t.id))];
    callback(merged);
  };
  const unsubOpen = onSnapshot(qOpen, snap => {
    abertas = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    emit();
  });
  const unsubClosed = onSnapshot(qClosed, snap => {
    fechadas = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    emit();
  });
  return () => { unsubOpen(); unsubClosed(); };
}
// Eventos do bot (tab Mensagens): docs logs/{dia}, cada um com items[]. Lê os
// últimos 5 dias por data desc e junta tudo num array ordenado por tempo.
export function subscribeLogs(uid, callback) {
  const q = query(userCol(uid, "logs"), orderBy("day", "desc"), limit(5));
  return onSnapshot(q, snap => {
    const all = [];
    snap.docs.forEach(d => { (d.data().items || []).forEach(it => all.push(it)); });
    all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    callback(all);
  });
}
// Limpar todas as mensagens (apaga os docs da coleção logs).
export async function clearLogs(uid) {
  const snap = await getDocs(userCol(uid, "logs"));
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
}

// ── Settings ──────────────────────────────────────────────────────────────────
export async function saveSetting(uid, key, value) {
  await setDoc(userDoc(uid, "settings", key), { value, updatedAt: serverTimestamp() });
}
export function subscribeSetting(uid, key, callback) {
  return onSnapshot(userDoc(uid, "settings", key), snap => {
    if (snap.exists()) callback(snap.data().value);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export async function saveStats(uid, stats) {
  const id = new Date().toISOString().split("T")[0];
  await setDoc(userDoc(uid, "stats", id), { ...stats, savedAt: serverTimestamp() });
}
export function subscribeStats(uid, callback) {
  const q = query(userCol(uid, "stats"), orderBy("savedAt", "desc"), limit(30));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ ...d.data(), id: d.id }))));
}

// ── Arquivos diários (trades fechados arquivados pelo bot à meia-noite) ─────────
export function subscribeArchives(uid, callback) {
  const q = query(userCol(uid, "archives"), orderBy("day", "desc"), limit(90));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ ...d.data(), id: d.id }))));
}

// ── Registo de mudanças do Modo Dinâmico (regime) ───────────────────────────────
// Sempre que se liga/desliga o Modo Dinâmico, gravamos um evento com timestamp.
// Assim a comparação "antes vs depois" fica ancorada em factos (não na memória):
// dá para ver exatamente em que dia/hora o modo passou a ON ou OFF, e em que modo
// (sim/paper/real). O id do doc é o ISO do instante (ordenável e único).
export async function logRegimeToggle(uid, { estado, modo }) {
  const ts = Date.now();
  const id = new Date(ts).toISOString();
  await setDoc(userDoc(uid, "regimeLog", id), {
    estado,                       // true = ligado, false = desligado
    modo,                         // "sim" | "paper" | "real"
    ts,                           // epoch ms
    data: id.split("T")[0],       // "YYYY-MM-DD" (para casar com a data de corte)
    savedAt: serverTimestamp(),
  });
}
export function subscribeRegimeLog(uid, callback) {
  const q = query(userCol(uid, "regimeLog"), orderBy("ts", "desc"), limit(50));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ ...d.data(), id: d.id }))));
}
