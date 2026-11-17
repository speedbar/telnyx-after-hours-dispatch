// scripts/sign.ts — test helper for POST /dv, local and live testing only.
// Plain Node, built-ins only (node:crypto, node:fs). Run by the human:
//   npx tsx scripts/sign.ts keygen
//   npx tsx scripts/sign.ts curl <base-url> [phone] [--tamper] [--stale] [--unsigned]
//
// keygen: creates .telnyx-test-key (already gitignored) holding an Ed25519
// keypair as JSON (private key as JWK, public key as base64 raw). Prints ONLY
// the base64 raw PUBLIC key. If the file exists, prints the public key from
// it. Never prints the private key.
//
// curl: prints (does not run) a ready-to-paste curl command for POST
// <base-url>/dv with a sample assistant.initialization body, signed over
// `${timestamp}|${body}` exactly as src/lib/sig.ts verifies.

import {
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exit, stderr, stdout, argv, cwd } from "node:process";

const KEY_FILE = join(cwd(), ".telnyx-test-key");

interface KeypairFile {
  privateJwk: Record<string, unknown>;
  publicKeyB64: string;
}

function loadKeypairFile(): KeypairFile {
  return JSON.parse(readFileSync(KEY_FILE, "utf8")) as KeypairFile;
}

function cmdKeygen(): void {
  if (existsSync(KEY_FILE)) {
    stdout.write(loadKeypairFile().publicKeyB64 + "\n");
    return;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" }) as unknown as Record<
    string,
    unknown
  >;
  const publicJwk = publicKey.export({ format: "jwk" }) as unknown as {
    x: string;
  };
  // JWK x is base64url; the webhook verifier expects standard base64.
  const publicKeyB64 = Buffer.from(publicJwk.x, "base64url").toString("base64");
  writeFileSync(KEY_FILE, JSON.stringify({ privateJwk, publicKeyB64 }) + "\n", {
    mode: 0o600,
  });
  stdout.write(publicKeyB64 + "\n");
}

function cmdCurl(args: string[]): void {
  const [baseUrl, ...rest] = args;
  if (!baseUrl) {
    stderr.write(
      "usage: npx tsx scripts/sign.ts curl <base-url> [phone] [--tamper] [--stale] [--unsigned]\n",
    );
    exit(1);
  }
  if (!existsSync(KEY_FILE)) {
    stderr.write("missing .telnyx-test-key — run keygen first\n");
    exit(1);
  }
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const phone = positional[0] ?? "+61491570006";

  const { privateJwk } = loadKeypairFile();
  const privateKey = createPrivateKey({
    key: privateJwk as Parameters<typeof createPrivateKey>[0] extends {
      key: infer K;
    }
      ? K
      : never,
    format: "jwk",
  });

  const body = JSON.stringify({
    data: {
      event_type: "assistant.initialization",
      payload: {
        telnyx_end_user_target: phone,
        call_control_id: "v3:sim-test-001",
        assistant_id: "asst_sign_script",
      },
    },
  });
  // Unix seconds, now; --stale signs a timestamp 10 minutes in the past.
  const timestamp = String(
    Math.floor(Date.now() / 1000) - (flags.has("--stale") ? 600 : 0),
  );
  const signature = cryptoSign(
    null,
    Buffer.from(`${timestamp}|${body}`, "utf8"),
    privateKey,
  ).toString("base64");
  // --tamper changes one character of the body AFTER signing.
  const outBody = flags.has("--tamper") ? body.slice(0, -1) + "x" : body;

  const url = baseUrl.replace(/\/+$/, "") + "/dv";
  const lines = [`curl -sS -X POST '${url}' \\`];
  lines.push(`  -H 'content-type: application/json' \\`);
  if (!flags.has("--unsigned")) {
    lines.push(`  -H 'telnyx-signature-ed25519: ${signature}' \\`);
    lines.push(`  -H 'telnyx-timestamp: ${timestamp}' \\`);
  }
  lines.push(`  --data '${outBody}'`);
  stdout.write(lines.join("\n") + "\n");
}

const [command, ...rest] = argv.slice(2);
if (command === "keygen") {
  cmdKeygen();
} else if (command === "curl") {
  cmdCurl(rest);
} else {
  stderr.write(
    "usage: npx tsx scripts/sign.ts <keygen|curl <base-url> [phone] [--tamper] [--stale] [--unsigned]>\n",
  );
  exit(1);
}
