import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser } from '@spectra/contracts';
import { getMe, logout as requestLogout } from './auth-api.js';

interface AuthState {
  user: AuthUser | undefined;
  loading: boolean;
  setUser: (user: AuthUser | undefined) => void;
  logout: () => Promise<void>;
}

const Context = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    getMe(controller.signal)
      .then(setUser)
      .catch(() => setUser(undefined))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      setUser,
      logout: async () => {
        await requestLogout();
        setUser(undefined);
      },
    }),
    [loading, user],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(Context);
  if (!value) throw new Error('useAuth requiere AuthProvider');
  return value;
}
