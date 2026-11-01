// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Signed audience attestations on the web (W2b-attestations, docs/testing/w2-selectors.md): the
 * owner panel (entries with their test ids and data attributes, one broadcast's filter, share
 * create/copy/revoke) and the public verifier (input parsing, the valid and invalid results, the
 * instance domain shown prominently, the "not proof of wrongdoing" line).
 */
import type { AttestationEntry, AttestationShareLink, AttestationVerifyResult } from "@commonair/contracts/dto";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AttestationsClient, VerifierClient } from "../src/components/attestations/client.ts";
import { PROBLEM_KEYS } from "../src/components/attestations/labels.ts";
import { AttestationsPanel } from "../src/components/attestations/panel.tsx";
import {
  averageViewers,
  decodePayload,
  envelopeJson,
  figuresOf,
  hostOf,
  parseVerifierInput,
} from "../src/components/attestations/statement.ts";
import { AttestationVerifier, VerifyResult } from "../src/components/attestations/verifier.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>
  );
}
const all = (id: string, root: ParentNode) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

const statement = {
  v: 1,
  kind: "broadcast",
  origin: "https://instance.example",
  kid: "OfcT0KZEJT8EUpQhufUbmw",
  channelId: "01890000-0000-7000-8000-00000000c001",
  broadcastId: "01890000-0000-7000-8000-00000000b001",
  seq: 1,
  prevHash: null,
  supersedes: null,
  periodStart: "2026-10-30T20:00:00.000Z",
  periodEnd: "2026-10-30T22:00:00.000Z",
  signedAt: "2026-10-31T00:00:00.000Z",
  rulesetVersion: 1,
  thresholdsHash: "a".repeat(64),
  peakVerifiedConcurrent: 42,
  verifiedViewerSeconds: 151200,
  durationSeconds: 7200,
  unverifiedViewerSeconds: 3600,
  excludedViewerSeconds: 7200,
  reasonsCommitment: "b".repeat(64),
  deliveryBytes: { origin: 1, relay: 2, cdn: 0 },
};
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const payloadOf = (s: object) => b64url(JSON.stringify(s));

const entry = (over: Partial<AttestationEntry> = {}): AttestationEntry => ({
  id: "01890000-0000-7000-8000-0000000000e1",
  channelSlug: "streamer",
  broadcastId: statement.broadcastId,
  seq: 1,
  kind: "broadcast",
  kid: statement.kid,
  entryHash: "c".repeat(64),
  prevHash: null,
  supersedes: null,
  signedAt: statement.signedAt,
  envelope: { payload: payloadOf(statement), signature: "sig" },
  superseded: false,
  breakdown: { datacenter: 5400, automation: 1800 },
  salt: "salt",
  ...over,
});

const link = (over: Partial<AttestationShareLink> = {}): AttestationShareLink => ({
  id: "01890000-0000-7000-8000-0000000000f1",
  attestationId: "01890000-0000-7000-8000-0000000000e1",
  url: null,
  expiresAt: "2026-12-01T00:00:00.000Z",
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

function fakeClient(o: { entries?: AttestationEntry[]; links?: AttestationShareLink[] } = {}): AttestationsClient {
  return {
    list: vi.fn<AttestationsClient["list"]>(async () => ({ items: o.entries ?? [], nextCursor: null })),
    shareLinks: vi.fn<AttestationsClient["shareLinks"]>(async () => ({ items: o.links ?? [], nextCursor: null })),
    share: vi.fn<AttestationsClient["share"]>(async () =>
      link({ id: "01890000-0000-7000-8000-0000000000f2", url: "https://api.example/x" }),
    ),
    revoke: vi.fn<AttestationsClient["revoke"]>(async () => ({ ok: true })),
  };
}

describe("statement helpers", () => {
  it("decodes a payload's figures and refuses anything else", () => {
    expect(decodePayload(payloadOf(statement))).toMatchObject({ seq: 1, verifiedViewerSeconds: 151200 });
    expect(decodePayload("not base64!")).toBeNull();
    expect(decodePayload(payloadOf({ ...statement, verifiedViewerSeconds: 1.5 }))).toBeNull();
    expect(figuresOf(null)).toBeNull();
  });

  it("derives the average and the host", () => {
    expect(averageViewers({ verifiedViewerSeconds: 151200, durationSeconds: 7200 })).toBe(21);
    expect(averageViewers({ verifiedViewerSeconds: 5, durationSeconds: 0 })).toBe(0);
    expect(hostOf("https://instance.example:8443")).toBe("instance.example:8443");
    expect(hostOf("nonsense")).toBe("nonsense");
  });

  it("parses an envelope, an entry, a list and a bundle; refuses the rest", () => {
    const env = { payload: "p", signature: "s" };
    expect(parseVerifierInput(JSON.stringify(env))).toEqual({ envelope: env });
    expect(parseVerifierInput(envelopeJson(entry()))).toEqual({ envelope: entry().envelope });
    expect(parseVerifierInput(JSON.stringify({ ...entry(), envelope: env }))).toEqual({ envelope: env });
    expect(parseVerifierInput(JSON.stringify([env, { envelope: env }]))).toEqual({ bundle: [env, env] });
    expect(parseVerifierInput(JSON.stringify({ entries: [{ envelope: env }], keys: {} }))).toEqual({ bundle: [env] });
    expect(parseVerifierInput("{")).toBeNull();
    expect(parseVerifierInput("[]")).toBeNull();
    expect(parseVerifierInput(JSON.stringify([env, { nope: 1 }]))).toBeNull();
    expect(parseVerifierInput(JSON.stringify({ payload: 1, signature: "s" }))).toBeNull();
  });
});

describe("AttestationsPanel", () => {
  it("lists entries with their data attributes, breakdown and share links", async () => {
    const client = fakeClient({
      entries: [
        entry({ id: "01890000-0000-7000-8000-0000000000e3", seq: 3, kind: "supersede", entryHash: "d".repeat(64) }),
        entry({ superseded: true }),
      ],
      links: [link(), link({ id: "01890000-0000-7000-8000-0000000000f3", attestationId: "elsewhere" })],
    });
    const { container } = render(wrap(<AttestationsPanel channel="streamer" client={client} />));
    await waitFor(() => expect(all("attestation-entry", container)).toHaveLength(2));
    expect(all("attestations-panel", container)).toHaveLength(1);
    const [first, second] = all("attestation-entry", container);
    expect(first?.dataset).toMatchObject({
      seq: "3",
      kind: "supersede",
      broadcastId: statement.broadcastId,
      entryHash: "d".repeat(64),
    });
    expect(second?.dataset.superseded).toBe("true");
    expect(container.textContent).toContain(t("attestations.category.datacenter"));
    expect(container.textContent).toContain(t("attestations.entry.superseded"));
    await waitFor(() => expect(all("attestation-share-link", container)).toHaveLength(1));
    expect(all("attestation-share-link", container)[0]?.dataset).toMatchObject({
      linkId: link().id,
      expiresAt: link().expiresAt,
    });
    expect(all("attestation-share-revoke", container)).toHaveLength(1);
  });

  it("shows one broadcast's entries when given one", async () => {
    const client = fakeClient({ entries: [entry(), entry({ id: "x", broadcastId: "other" })] });
    const { container } = render(
      wrap(<AttestationsPanel channel="streamer" broadcastId={statement.broadcastId} client={client} />),
    );
    await waitFor(() => expect(all("attestation-entry", container)).toHaveLength(1));
  });

  it("creates a share link and shows its URL once", async () => {
    const client = fakeClient({ entries: [entry()] });
    const { container } = render(wrap(<AttestationsPanel channel="streamer" client={client} />));
    await waitFor(() => expect(all("attestation-share-create", container)).toHaveLength(1));
    fireEvent.click(all("attestation-share-create", container)[0]!);
    await waitFor(() => expect(client.share).toHaveBeenCalledWith({ channel: "streamer", id: entry().id }));
    await waitFor(() => expect(container.querySelector('input[value="https://api.example/x"]')).not.toBeNull());
    expect(client.shareLinks).toHaveBeenCalledTimes(2);
  });

  it("an empty chain says when statements appear; a failed load offers a retry", async () => {
    const { container } = render(wrap(<AttestationsPanel channel="streamer" client={fakeClient()} />));
    await waitFor(() => expect(container.textContent).toContain(t("attestations.panel.empty.title")));
    cleanup();
    const failing = {
      ...fakeClient(),
      list: vi.fn<AttestationsClient["list"]>(async () => Promise.reject(new Error("x"))),
    };
    const r = render(wrap(<AttestationsPanel channel="streamer" client={failing} />));
    await waitFor(() => expect(r.container.textContent).toContain(t("attestations.panel.loadFailed")));
  });
});

describe("AttestationVerifier", () => {
  const valid: AttestationVerifyResult = { valid: true, problem: null, origin: statement.origin, statement };

  it("verifies what was pasted and shows the instance domain prominently", async () => {
    const client: VerifierClient = { verify: vi.fn<VerifierClient["verify"]>(async () => valid) };
    const { container } = render(wrap(<AttestationVerifier client={client} />));
    expect(all("attestation-verify-page", container)).toHaveLength(1);
    expect(container.textContent).toContain(t("attestations.verify.notProof"));
    const input = all("attestation-verify-input", container)[0] as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: envelopeJson(entry()) } });
    fireEvent.click(all("attestation-verify-submit", container)[0]!);
    await waitFor(() => expect(all("attestation-verify-result", container)).toHaveLength(1));
    expect(client.verify).toHaveBeenCalledWith({ envelope: entry().envelope });
    const result = all("attestation-verify-result", container)[0]!;
    expect(result.dataset.valid).toBe("true");
    expect(result.dataset.reason).toBeUndefined();
    expect(all("attestation-verify-origin", container)[0]?.textContent).toBe("instance.example");
    expect(result.closest("[aria-live]")).not.toBeNull();
  });

  it("refuses input that is not a statement without calling the API", async () => {
    const client: VerifierClient = { verify: vi.fn<VerifierClient["verify"]>(async () => valid) };
    const { container } = render(wrap(<AttestationVerifier client={client} />));
    fireEvent.change(all("attestation-verify-input", container)[0]!, { target: { value: "hello" } });
    fireEvent.click(all("attestation-verify-submit", container)[0]!);
    await waitFor(() => expect(container.textContent).toContain(t("attestations.verify.unparsable")));
    expect(client.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["bad_signature", "bad_signature"],
    ["superseded", "superseded"],
    ["compromised_kid", "compromised_kid"],
    [null, "unknown"],
  ] as const)("an invalid result (%s) says why", (problem, reason) => {
    const { container } = render(
      wrap(<VerifyResult result={{ valid: false, problem, origin: null, statement: null }} />),
    );
    const result = all("attestation-verify-result", container)[0]!;
    expect(result.dataset).toMatchObject({ valid: "false", reason });
    expect(container.textContent).toContain(t(PROBLEM_KEYS[reason]));
    expect(all("attestation-verify-origin", container)).toHaveLength(0);
  });

  it("shows figures for a verified or superseded statement, never next to another failure", () => {
    const figures = t("attestations.verify.figures");
    const shown = render(wrap(<VerifyResult result={{ ...valid, valid: false, problem: "superseded" }} />));
    expect(shown.container.textContent).toContain(figures);
    shown.unmount();
    const hidden = render(wrap(<VerifyResult result={{ ...valid, valid: false, problem: "chain_break" }} />));
    expect(hidden.container.textContent).not.toContain(figures);
    expect(all("attestation-verify-origin", hidden.container)).toHaveLength(1);
  });
});
