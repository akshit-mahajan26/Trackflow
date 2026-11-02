import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api";

export interface PublicConfig { allow_registration: boolean; site_name: string }

/** Public workspace config (site name, registration); also sets the document title. */
export function usePublicConfig() {
  const q = useQuery({ queryKey: ["public-config"], queryFn: () => api.get<PublicConfig>("/auth/config"), staleTime: 300_000 });
  const name = q.data?.site_name || "TrackFlow";
  useEffect(() => {
    document.title = name;
  }, [name]);
  return { ...q, siteName: name };
}
