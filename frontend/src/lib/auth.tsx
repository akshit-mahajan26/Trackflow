import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { email: string; username: string; full_name: string; password: string }) => Promise<void>;
  logout: () => void;
  setUser: (u: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => !!getToken());
  const qc = useQueryClient();

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) return;
    api
      .get<User>("/auth/me")
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [logout]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<{ access_token: string; user: User }>("/auth/login", { username, password });
    setToken(res.access_token);
    setUser(res.user);
  }, []);

  const register = useCallback(async (data: { email: string; username: string; full_name: string; password: string }) => {
    const res = await api.post<{ access_token: string; user: User }>("/auth/register", data);
    setToken(res.access_token);
    setUser(res.user);
  }, []);

  const value = useMemo(() => ({ user, loading, login, register, logout, setUser }), [user, loading, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useMe(): User {
  const { user } = useAuth();
  if (!user) throw new Error("Not authenticated");
  return user;
}
