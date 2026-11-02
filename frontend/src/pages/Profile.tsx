import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "../components/toast";
import { Avatar, Button, Card, Field, Input, PageHeader, Select } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useAuth, useMe } from "../lib/auth";
import { useTheme, type ThemePref } from "../lib/theme";
import type { User } from "../lib/types";

const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#4f46e5"];

export default function Profile() {
  const me = useMe();
  const { setUser, logout } = useAuth();
  const { pref, setPref } = useTheme();
  const toast = useToast();
  const [f, setF] = useState({ full_name: me.full_name, job_title: me.job_title ?? "", avatar_color: me.avatar_color });
  const [pw, setPw] = useState({ current_password: "", new_password: "", confirm: "" });
  const save = useMutation({
    mutationFn: () => api.patch<User>("/auth/me", f),
    onSuccess: (u) => { setUser(u); toast.success("Profile saved"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const change = useMutation({
    mutationFn: () => api.post("/auth/me/password", { current_password: pw.current_password, new_password: pw.new_password }),
    onSuccess: () => { toast.success("Password changed. Please log in again."); logout(); },
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <PageHeader title="Profile & preferences" />
      <Card title="Profile">
        <form className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="flex items-center gap-3 sm:col-span-2"><Avatar user={{ ...me, ...f }} size={48} />
            <div className="flex flex-wrap gap-1.5">{COLORS.map((c) => (
              <button type="button" key={c} aria-label={`Avatar color ${c}`} onClick={() => setF({ ...f, avatar_color: c })}
                className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-surface ${f.avatar_color === c ? "ring-2 ring-fg" : ""}`} style={{ background: c }} />
            ))}</div>
          </div>
          <Field label="Full name"><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
          <Field label="Job title"><Input value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} /></Field>
          <Field label="Username"><Input disabled value={me.username} /></Field>
          <Field label="Email" hint="Ask an administrator to change your email"><Input disabled value={me.email} /></Field>
          <div><Button type="submit" variant="primary" loading={save.isPending}>Save profile</Button></div>
        </form>
      </Card>
      <Card title="Appearance">
        <div className="p-4"><Field label="Theme">
          <Select value={pref} className="w-48" onChange={(e) => { const t = e.target.value as ThemePref; setPref(t); api.patch("/auth/me", { theme: t }).catch(() => {}); }}>
            <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option>
          </Select>
        </Field></div>
      </Card>
      <Card title="Change password">
        <form className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
          <Field label="Confirm new password"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          {pw.confirm && pw.confirm !== pw.new_password && <p className="text-sm text-danger sm:col-span-3">Passwords do not match.</p>}
          {change.isError && <p role="alert" className="text-sm text-danger sm:col-span-3">{errorMessage(change.error)}</p>}
          <div><Button type="submit" variant="primary" loading={change.isPending}
            disabled={!pw.current_password || pw.new_password.length < 8 || pw.new_password !== pw.confirm}>Change password</Button></div>
        </form>
        <p className="border-t px-4 py-2 text-xs text-subtle">Changing your password signs you out on all devices.</p>
      </Card>
    </div>
  );
}
