import type { IssueFilter } from "./types";

const TOKEN_KEY = "trackflow.token";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session stays in memory only */
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

function detailMessage(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((x: unknown) => x !== "body").join(".") : "";
        return loc ? `${loc}: ${d.msg}` : d.msg;
      })
      .join("; ");
  }
  return "Request failed";
}

type Body = object | FormData | undefined;

export async function request<T>(method: string, path: string, body?: Body): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check your network connection.");
  }
  if (res.status === 401 && token) onUnauthorized?.();
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = detailMessage((await res.json()).detail);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: Body) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: Body) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: Body) => request<T>("PUT", path, body),
  del: <T = void>(path: string) => request<T>("DELETE", path),
};

/** Serialise a filter into repeated query params (?status_ids=1&status_ids=2). */
export function filterToQuery(f: IssueFilter, extra: Record<string, string | number | undefined> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Authenticated file download (attachments, CSV exports). */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = detailMessage((await res.json()).detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = decodeURIComponent(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
