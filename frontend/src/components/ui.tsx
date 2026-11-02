import clsx from "clsx";
import { AlertTriangle, Inbox, Loader2, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../lib/api";
import type { UserBrief } from "../lib/types";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm",
        {
          primary: "bg-primary text-white hover:bg-primary-hover",
          secondary: "border bg-surface hover:bg-surface-2",
          ghost: "hover:bg-surface-2 text-muted hover:text-fg",
          subtle: "bg-surface-2 hover:bg-surface-3",
          danger: "bg-danger text-white hover:opacity-90",
        }[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

const field = "rounded-md border bg-surface px-2.5 text-sm placeholder:text-subtle focus:border-primary focus:outline-none disabled:opacity-60";
// Full width unless the caller sets its own width (avoids conflicting w-* classes).
const width = (className?: string) => (className && /(^|\s)(w-|max-w-)/.test(className) ? "" : "w-full");

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={clsx(field, width(className), "h-8", className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...p },
  ref,
) {
  return <textarea ref={ref} className={clsx(field, width(className), "py-2", className)} {...p} />;
});

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(field, width(className), "h-8 pr-7", className)} {...p}>
      {children}
    </select>
  );
}

export function Label({ children, htmlFor, required }: { children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-muted">
      {children}
      {required && <span className="text-danger"> *</span>}
    </label>
  );
}

/** Wrapping <label> associates the text with its control for screen readers and click-to-focus. */
export function Field({ label, children, required, hint }: { label: string; children: ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx("rounded-lg border bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={clsx("flex items-center justify-center gap-2 py-10 text-muted", className)} role="status">
      <Loader2 size={18} className="animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <div className="text-subtle">{icon ?? <Inbox size={32} />}</div>
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/5 p-4">
      <AlertTriangle className="mt-0.5 shrink-0 text-danger" size={18} />
      <div className="flex-1">
        <p className="font-semibold">Something went wrong</p>
        <p className="text-sm text-muted">{errorMessage(error)}</p>
      </div>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Parents usually pass an inline onClose that changes every render; keep the latest in a ref so the
  // open/focus effect runs only when the dialog opens — otherwise focus is stolen on every keystroke.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    document.addEventListener("keydown", onKey);
    // Respect a field that already took focus (autoFocus); otherwise focus the first field in the body,
    // then the first footer button. Never the header close button.
    if (!ref.current?.contains(document.activeElement)) {
      const target = bodyRef.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")
        ?? ref.current?.querySelector<HTMLElement>("footer button");
      target?.focus();
    }
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}
        className={clsx("w-full rounded-xl border bg-surface shadow-2xl", width)}>
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div ref={bodyRef} className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  loading,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }>
      <div className="space-y-3 text-sm text-muted">{message}{children}</div>
    </Modal>
  );
}

export function Badge({ children, className, tone = "neutral" }: { children: ReactNode; className?: string; tone?: "neutral" | "blue" | "green" | "red" | "amber" }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", {
      neutral: "bg-surface-3 text-muted",
      blue: "bg-primary-soft text-primary",
      green: "bg-success/15 text-success",
      red: "bg-danger/15 text-danger",
      amber: "bg-warning/15 text-warning",
    }[tone], className)}>
      {children}
    </span>
  );
}

export function Avatar({ user, size = 24, title }: { user: UserBrief | null | undefined; size?: number; title?: string }) {
  if (!user) {
    return (
      <span title={title ?? "Unassigned"} style={{ width: size, height: size }}
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed text-[10px] text-subtle">?</span>
    );
  }
  const initials = user.full_name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <span title={title ?? user.full_name} style={{ width: size, height: size, background: user.avatar_color, fontSize: size * 0.4 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white">
      {initials}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={clsx("-mb-px border-b-2 px-3 py-2 text-sm font-medium",
            value === t.value ? "border-primary text-primary" : "border-transparent text-muted hover:text-fg")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Lightweight dropdown menu (click outside / Escape closes). */
export function Menu({ trigger, children, align = "right", width = "w-56" }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div className={clsx("absolute z-40 mt-1 rounded-lg border bg-surface p-1 shadow-xl", width, align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, danger, icon }: { children: ReactNode; onClick: () => void; danger?: boolean; icon?: ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2", danger && "text-danger")}>
      {icon}
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t" />;
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "red" | "green" | "blue"; hint?: string }) {
  return (
    <div className="rounded-lg border bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={clsx("mt-1 text-2xl font-semibold tabular-nums", tone === "red" && "text-danger", tone === "green" && "text-success", tone === "blue" && "text-primary")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

export function ProgressBar({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-xs text-muted">{breadcrumb}</div>}
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
