// src/AuthContext.jsx
import { createContext, useContext, useEffect, useState, useMemo } from "react";
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

  // Memoizar o value para que os consumidores (e os seus useEffect com deps [user])
  // não re-corram a cada render do Provider.
  const value = useMemo(() => ({ user, loading }), [user, loading]);

  return (
    <AuthCtx.Provider value={value}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
