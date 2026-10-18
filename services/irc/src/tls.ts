// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * TLS material for the IRC TLS listener. Production must supply cert/key files.
 * In development and tests, an ephemeral self-signed certificate (ECDSA P-256,
 * SAN localhost/127.0.0.1/::1) is generated in-process, so neither openssl nor
 * a dependency is needed. The minimal DER encoder below covers exactly the
 * X.509 structures used here.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface TlsMaterial {
  cert: string;
  key: string;
  ephemeral: boolean;
}

// ------------------------------------------------------------ DER

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  const n = body.length;
  let len: Uint8Array;
  if (n < 0x80) len = Uint8Array.of(n);
  else if (n < 0x100) len = Uint8Array.of(0x81, n);
  else if (n < 0x10000) len = Uint8Array.of(0x82, n >> 8, n & 0xff);
  else throw new Error("DER value too long");
  return concat([Uint8Array.of(tag), len, body]);
}

const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
const explicit = (n: number, ...c: Uint8Array[]) => tlv(0xa0 + n, ...c);
const octets = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array) => tlv(0x03, Uint8Array.of(0), b);
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const bool = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0));

function integer(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1] ?? 0) < 0x80) b = b.subarray(1);
  if ((b[0] ?? 0) >= 0x80) b = concat([Uint8Array.of(0), b]);
  return tlv(0x02, b);
}

function oid(dotted: string): Uint8Array {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk: number[] = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] ?? 0) | 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** UTCTime for years < 2050, GeneralizedTime after, as RFC 5280 requires. */
function time(d: Date): Uint8Array {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  const year = d.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, new TextEncoder().encode(`${iso.slice(2)}Z`))
    : tlv(0x18, new TextEncoder().encode(`${iso}Z`));
}

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "")}\n-----END ${label}-----\n`;

// ------------------------------------------------------------ certificate

export function generateSelfSignedCert(commonName = "localhost", days = 30, now = new Date()): TlsMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;

  const san = seq(
    tlv(0x82, new TextEncoder().encode("localhost")), // dNSName
    tlv(0x87, Uint8Array.of(127, 0, 0, 1)), // iPAddress
    tlv(0x87, Uint8Array.from([...Array<number>(15).fill(0), 1])), // ::1
  );
  const extensions = explicit(
    3,
    seq(
      seq(oid("2.5.29.19"), bool(true), octets(seq())), // basicConstraints: not a CA
      seq(oid("2.5.29.17"), octets(san)),
    ),
  );
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  const tbs = seq(
    explicit(0, integer(Uint8Array.of(2))), // v3
    integer(serial),
    ecdsaSha256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    extensions,
  );
  const signature = new Uint8Array(sign("sha256", tbs, privateKey));
  const cert = seq(tbs, ecdsaSha256, bitString(signature));
  return {
    cert: pem("CERTIFICATE", cert),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ephemeral: true,
  };
}

/**
 * Cert/key files when configured; otherwise an ephemeral cert outside production.
 * Production without files is a configuration error.
 */
export async function loadTls(opts: {
  certFile?: string | undefined;
  keyFile?: string | undefined;
  production: boolean;
}): Promise<TlsMaterial> {
  if (opts.certFile && opts.keyFile) {
    const [cert, key] = await Promise.all([readFile(opts.certFile, "utf8"), readFile(opts.keyFile, "utf8")]);
    return { cert, key, ephemeral: false };
  }
  if (opts.certFile || opts.keyFile) throw new Error("IRC_TLS_CERT_FILE and IRC_TLS_KEY_FILE must be set together");
  if (opts.production) throw new Error("IRC_TLS_CERT_FILE and IRC_TLS_KEY_FILE are required in production");
  return generateSelfSignedCert();
}
