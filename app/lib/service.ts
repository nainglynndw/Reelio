import type { PublishingReadiness } from "./types";

export const SERVICE_URL = process.env.NEXT_PUBLIC_REELIO_SERVICE_URL ?? "http://127.0.0.1:8788";

export async function fetchPublishingReadiness(): Promise<PublishingReadiness> {
  const response = await fetch(`${SERVICE_URL}/publishing/readiness`);
  if (!response.ok) throw new Error("Publishing readiness could not be checked");
  return response.json() as Promise<PublishingReadiness>;
}
