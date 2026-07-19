const webUrl = process.env.REELIO_WEB_URL ?? "http://localhost:3000";
const serviceUrl = process.env.NEXT_PUBLIC_REELIO_SERVICE_URL ?? "http://127.0.0.1:8788";

const checks = await Promise.allSettled([
  fetch(webUrl, { signal: AbortSignal.timeout(5_000) }),
  fetch(`${serviceUrl}/ready`, { signal: AbortSignal.timeout(5_000) }),
]);

const web = checks[0].status === "fulfilled" && checks[0].value.ok;
const worker = checks[1].status === "fulfilled" && checks[1].value.ok;
process.stdout.write(`Web studio: ${web ? "healthy" : "unavailable"}\nLocal worker: ${worker ? "healthy" : "unavailable"}\n`);
if (!web || !worker) process.exitCode = 1;
