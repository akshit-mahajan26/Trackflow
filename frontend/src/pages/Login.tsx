import { FolderKanban } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button, Field, Input } from "../components/ui";
import { errorMessage } from "../lib/api";
import { usePublicConfig } from "../lib/site";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const { data: cfg, siteName } = usePublicConfig();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ username: "", password: "", email: "", full_name: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={from} replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await login(form.username, form.password);
      else await register({ email: form.email, username: form.username, full_name: form.full_name, password: form.password });
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><FolderKanban size={20} /></span>
          <span className="text-xl font-semibold">{siteName}</span>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{mode === "login" ? "Log in to your workspace" : "Create your account"}</h1>
          {mode === "register" && (
            <>
              <Field label="Full name" required><Input value={form.full_name} onChange={set("full_name")} required autoComplete="name" /></Field>
              <Field label="Email" required><Input type="email" value={form.email} onChange={set("email")} required autoComplete="email" /></Field>
            </>
          )}
          <Field label={mode === "login" ? "Username or email" : "Username"} required>
            <Input value={form.username} onChange={set("username")} required autoFocus autoComplete="username" />
          </Field>
          <Field label="Password" required hint={mode === "register" ? "At least 8 characters" : undefined}>
            <Input type="password" value={form.password} onChange={set("password")} required minLength={mode === "register" ? 8 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} className="w-full">{mode === "login" ? "Log in" : "Create account"}</Button>
          {cfg?.allow_registration && (
            <p className="text-center text-sm text-muted">
              {mode === "login" ? "New here? " : "Already have an account? "}
              <button type="button" className="text-primary hover:underline" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
                {mode === "login" ? "Create an account" : "Log in"}
              </button>
            </p>
          )}
          {!cfg?.allow_registration && <p className="text-center text-xs text-subtle">Accounts are created by your administrator.</p>}
        </form>
      </div>
    </div>
  );
}
