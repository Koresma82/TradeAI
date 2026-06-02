import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, doc, setDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp,
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
  try { return await u.getIdToken(); } catch { return null; }
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
export function subscribeTrades(uid, callback) {
  const q = query(userCol(uid, "trades"), orderBy("savedAt", "desc"), limit(500));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ ...d.data(), id: d.id }))));
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
