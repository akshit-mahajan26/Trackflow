import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "trackflow.theme";

const ThemeContext = createContext<{ pref: ThemePref; dark: boolean; setPref: (p: ThemePref) => void } | null>(null);

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  const dark = pref === "dark" || (pref === "system" && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  };
  return <ThemeContext.Provider value={{ pref, dark, setPref }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
