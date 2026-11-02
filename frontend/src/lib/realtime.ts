import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getToken } from "./api";
import { useToast } from "../components/toast";

interface ServerEvent {
  type: string;
  project_id?: number | null;
  issue_id?: number;
  key?: string;
  actor_id?: number;
  message?: string;
}

/**
 * Keeps the UI in sync with changes made by other team members.
 * Server events invalidate the relevant TanStack Query caches; the data is then refetched from the API,
 * so the browser never trusts event payloads as the source of truth.
 */
export function useRealtime(userId: number | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useRef(0);

  useEffect(() => {
    if (!userId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = getToken();
      if (!token || closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        retry.current = 0;
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
      };
      ws.onmessage = (msg) => {
        let evt: ServerEvent;
        try {
          evt = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (evt.type === "pong") return;
        if (evt.type === "notification") {
          qc.invalidateQueries({ queryKey: ["notifications"] });
          if (evt.message) toast.info(evt.message);
          return;
        }
        if (evt.actor_id === userId && evt.type !== "sprint_changed") {
          // our own change: mutations already invalidate what they touched
          return;
        }
        qc.invalidateQueries({ queryKey: ["issues"] });
        qc.invalidateQueries({ queryKey: ["board"] });
        qc.invalidateQueries({ queryKey: ["backlog"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        if (evt.key) qc.invalidateQueries({ queryKey: ["issue", evt.key] });
        if (evt.type === "sprint_changed") qc.invalidateQueries({ queryKey: ["sprints"] });
        if (evt.type === "project_updated") qc.invalidateQueries({ queryKey: ["project"] });
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        const delay = Math.min(30000, 1000 * 2 ** retry.current++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(timer);
      ws?.close();
    };
  }, [userId, qc, toast]);
}
