import type { PublishingReadiness } from "./types";

export const SERVICE_URL = process.env.NEXT_PUBLIC_REELIO_SERVICE_URL ?? "http://localhost:8788";

export async function serviceFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const response = await fetch(input, { ...init, credentials: "include" });
  const target = String(input);
  if (response.status === 401 && !target.includes("/auth/login") && !target.includes("/auth/session")) {
    window.dispatchEvent(new Event("reelio:auth-required"));
  }
  return response;
}

export async function fetchPublishingReadiness(): Promise<PublishingReadiness> {
  const response = await serviceFetch(`${SERVICE_URL}/publishing/readiness`);
  if (!response.ok) throw new Error("Publishing readiness could not be checked");
  return response.json() as Promise<PublishingReadiness>;
}
