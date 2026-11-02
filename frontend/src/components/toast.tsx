import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  message: string;
}

interface ToastApi {
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: Kind, message: string) => {
      const id = ++seq;
      setToasts((t) => [...t.slice(-4), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({ success: (m) => push("success", m), error: (m) => push("error", m), info: (m) => push("info", m) }),
    [push],
  );
  const icon = { success: CheckCircle2, error: XCircle, info: Info };
  const color = { success: "text-success", error: "text-danger", info: "text-primary" };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => {
          const Icon = icon[t.kind];
          return (
            <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
              className="flex items-start gap-2 rounded-lg border bg-surface p-3 shadow-lg">
              <Icon size={18} className={`mt-0.5 shrink-0 ${color[t.kind]}`} />
              <p className="flex-1 text-sm">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg" aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
