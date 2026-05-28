// src/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { onAuthChange } from "./firebase.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(undefined); // undefined = a carregar, null = não autenticado
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthChange(u => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
