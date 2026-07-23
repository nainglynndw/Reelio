import { spawnSync } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

// Meta (Facebook/Instagram) rejects http:// OAuth redirect URIs, so Reelio serves the
// callback over HTTPS on localhost. This installs a locally-trusted certificate with mkcert
// and generates a cert for localhost, so the browser trusts https://localhost with no warning.

const certDir = path.resolve(process.env.REELIO_DATA_DIR || ".reelio", "certs");
const certFile = path.join(certDir, "localhost.pem");
const keyFile = path.join(certDir, "localhost-key.pem");
const httpsPort = process.env.REELIO_HTTPS_PORT ?? "8789";

if (!has("mkcert")) {
  process.stdout.write("mkcert is required to create a locally-trusted certificate.\n");
  if (has("brew")) {
    process.stdout.write("Installing mkcert and nss via Homebrew…\n");
    run("brew", ["install", "mkcert", "nss"]);
  } else {
    process.stderr.write("Homebrew was not found. Install mkcert first:\n  https://github.com/FiloSottile/mkcert#installation\nThen re-run: npm run https:setup\n");
    process.exit(1);
  }
}

process.stdout.write("Installing the local mkcert certificate authority (you may be prompted for your macOS password)…\n");
run("mkcert", ["-install"]);

await mkdir(certDir, { recursive: true });
process.stdout.write("Generating a trusted certificate for localhost…\n");
run("mkcert", ["-cert-file", certFile, "-key-file", keyFile, "localhost", "127.0.0.1", "::1"]);
await chmod(keyFile, 0o600);

if (!(await exists(certFile)) || !(await exists(keyFile))) {
  process.stderr.write("Certificate generation did not produce the expected files. Re-run npm run https:setup.\n");
  process.exit(1);
}

process.stdout.write(
  `\nHTTPS is ready. Reelio will serve its OAuth callback at https://localhost:${httpsPort}.\n\n` +
  "Next steps:\n" +
  `  1. In your Meta app → Facebook Login → Settings, add this Valid OAuth Redirect URI:\n` +
  `       https://localhost:${httpsPort}/oauth/facebook/callback\n` +
  "  2. Restart the local worker (stop and re-run npm run dev) so it picks up the certificate.\n" +
  "  3. Open Settings → Facebook → Connect.\n",
);

function has(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0
    || spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`${command} ${args.join(" ")} failed.\n`);
    process.exit(result.status ?? 1);
  }
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}
