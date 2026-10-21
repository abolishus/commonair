// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Trust and safety web rules: role boundaries, explicit evidence views, frame reveal, and uploads. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EvidenceItem } from "../src/components/safety/legal.tsx";
import { RestrictedStream } from "../src/components/safety/mature-gate.tsx";
import { playerStage } from "../src/components/safety/stage.ts";
import { CaseDetailView } from "../src/components/safety/mod-queue.tsx";
import type { EvidenceObjectDto, MaturityClient, ModerationCaseDetailDto } from "../src/components/safety/client.ts";
import {
  isLegal,
  isPlatformModerator,
  isSafetyStaff,
  mayOpenAdminPage,
  requireAdminPage,
} from "../src/components/safety/access.ts";
import { isMatureGate } from "../src/components/safety/client.ts";
import { uploadChannelFile, uploadFailureMessage, type UploadClient } from "../src/components/safety/upload.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const evidence: EvidenceObjectDto = {
  id: "0192f000-0000-7000-8000-000000000001",
  caseId: "0192f000-0000-7000-8000-000000000002",
  kind: "frame",
  storage: "inline",
  contentType: "image/png",
  sizeBytes: 12,
  sha256: "fixture-digest",
  sourceSubjectType: "broadcast",
  sourceSubjectId: "0192f000-0000-7000-8000-000000000003",
  capturedAt: "2026-10-21T12:00:00.000Z",
};

describe("trust and safety role boundary", () => {
  it("keeps legal cases exclusive to legal and report/appeal queues to platform moderators", () => {
    const legal = { role: "legal" };
    const moderator = { role: "moderator" };
    const admin = { role: "admin" };
    expect(isSafetyStaff(legal)).toBe(true);
    expect(isPlatformModerator(legal)).toBe(false);
    expect(isLegal(legal)).toBe(true);
    expect(mayOpenAdminPage("legal", legal)).toBe(true);
    expect(mayOpenAdminPage("legal", moderator)).toBe(false);
    expect(mayOpenAdminPage("moderation", legal)).toBe(true);
    expect(mayOpenAdminPage("appeals", legal)).toBe(false);
    expect(mayOpenAdminPage("appeals", admin)).toBe(true);
    expect(mayOpenAdminPage("moderation", null)).toBe(false);
  });

  it("returns not-found from the legal route guard to signed-out and non-legal users", async () => {
    await expect(requireAdminPage("/admin/legal", async () => null)).rejects.toMatchObject({ isNotFound: true });
    await expect(requireAdminPage("/admin/legal", async () => ({ role: "moderator" }))).rejects.toMatchObject({
      isNotFound: true,
    });
    await expect(requireAdminPage("/admin/legal", async () => ({ role: "legal" }))).resolves.toMatchObject({
      me: { role: "legal" },
    });
  });

  it("recognizes only the playback mature-gate refusal", () => {
    expect(isMatureGate({ code: "FORBIDDEN", data: { reason: "mature_gate" } })).toBe(true);
    expect(isMatureGate({ code: "FORBIDDEN", data: { reason: "banned" } })).toBe(false);
    expect(isMatureGate({ code: "UNAUTHORIZED", data: { reason: "mature_gate" } })).toBe(false);
  });
});

const caseDetail: ModerationCaseDetailDto = {
  id: "0192f000-0000-7000-8000-000000000010",
  tier: "t1",
  status: "open",
  origin: "classifier",
  subjectType: "broadcast",
  subjectId: "0192f000-0000-7000-8000-000000000011",
  channel: null,
  user: null,
  category: "sexual",
  priority: 100,
  slaDueAt: "2026-10-21T12:15:00.000Z",
  createdAt: "2026-10-21T12:00:00.000Z",
  resolvedAt: null,
  resolution: null,
  resolutionNote: null,
  flags: ["a", "b"].map((suffix) => ({
    id: `0192f000-0000-7000-8000-00000000001${suffix === "a" ? "2" : "3"}`,
    tier: "t1",
    origin: "classifier",
    category: "sexual",
    score: 0.91,
    listCategory: null,
    distance: null,
    provider: "scripted",
    providerVersion: "fixture-1",
    hasFrame: true,
    capturedAt: "2026-10-21T12:00:00.000Z",
  })),
  history: [],
  notScored: [],
  label: null,
};

describe("moderation review frames", () => {
  it("loads frames for review blurred and reveals only the chosen frame", async () => {
    const loadFrame = vi.fn<() => Promise<{ contentType: string; dataBase64: string }>>(async () => ({
      contentType: "image/png",
      dataBase64: "aGVsbG8=",
    }));
    wrap(<CaseDetailView detail={caseDetail} loadFrame={loadFrame} onReview={async () => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId("modq-frame-reveal")).toHaveLength(2));
    const frames = screen.getAllByTestId("modq-frame");
    expect(frames.map((frame) => frame.getAttribute("data-revealed"))).toEqual(["false", "false"]);
    const sensitive = frames.map((frame) => frame.querySelector("[data-obscured]"));
    expect(sensitive.map((frame) => frame?.getAttribute("data-obscured"))).toEqual(["true", "true"]);

    fireEvent.click(screen.getAllByTestId("modq-frame-reveal")[0] as HTMLElement);
    expect(frames.map((frame) => frame.getAttribute("data-revealed"))).toEqual(["true", "false"]);
    expect(sensitive.map((frame) => frame?.getAttribute("data-obscured"))).toEqual(["false", "true"]);
  });
});

describe("channel player stage", () => {
  const base = { live: true, mature: false, restricted: false, confirmed: false, gateHit: false };

  it("a restricted stream shows its interstitial, never the generic 18+ gate, even after playback refused", () => {
    expect(playerStage({ ...base, restricted: true })).toBe("restricted-locked");
    expect(playerStage({ ...base, restricted: true, gateHit: true })).toBe("restricted-locked");
    expect(playerStage({ ...base, restricted: true, mature: true })).toBe("restricted-locked");
  });

  it("mounts the player under the blur only for a confirmed adult", () => {
    expect(playerStage({ ...base, restricted: true, confirmed: true })).toBe("restricted-player");
  });

  it("mature streams gate unconfirmed viewers; a refused playback gates too", () => {
    expect(playerStage({ ...base, mature: true })).toBe("mature-gate");
    expect(playerStage({ ...base, mature: true, confirmed: true })).toBe("player");
    expect(playerStage({ ...base, gateHit: true })).toBe("mature-gate");
    expect(playerStage(base)).toBe("player");
    expect(playerStage({ ...base, live: false, mature: true, restricted: true })).toBe("player");
  });
});

describe("restricted stream reveal", () => {
  it("re-blurs immediately when sign-in or mature confirmation eligibility is lost", () => {
    const client: MaturityClient = {
      me: vi.fn<() => Promise<{ isAdult: boolean; matureConfirmed: boolean }>>(async () => ({
        isAdult: true,
        matureConfirmed: true,
      })),
      confirmMature: vi.fn<() => Promise<unknown>>(async () => undefined),
    };
    const view = wrap(
      <RestrictedStream signedIn confirmed onConfirmed={() => undefined} client={client}>
        <div>synthetic stream placeholder</div>
      </RestrictedStream>,
    );
    fireEvent.click(screen.getByTestId("stream-restricted-reveal"));
    expect(screen.getByTestId("stream-restricted").getAttribute("data-revealed")).toBe("true");

    view.rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <RestrictedStream signedIn confirmed={false} onConfirmed={() => undefined} client={client}>
            <div>synthetic stream placeholder</div>
          </RestrictedStream>
        </TooltipProvider>
      </LocaleProvider>,
    );
    const restricted = screen.getByTestId("stream-restricted");
    expect(restricted.getAttribute("data-revealed")).toBe("false");
    expect(restricted.getAttribute("data-obscured")).toBe("true");
  });
});

describe("legal evidence and uploads", () => {
  it("does not fetch evidence until the legal reviewer explicitly views it, then keeps it obscured until reveal", async () => {
    const load = vi.fn<() => Promise<{ contentType: string; dataBase64: string }>>(async () => ({
      contentType: "image/png",
      dataBase64: "aGVsbG8=",
    }));
    wrap(<EvidenceItem evidence={evidence} load={load} />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("legal-evidence-reveal")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-evidence-view"));
    });
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    const frame = screen.getByTestId("legal-evidence").querySelector("[data-obscured]");
    expect(frame?.getAttribute("data-obscured")).toBe("true");
    fireEvent.click(screen.getByTestId("legal-evidence-reveal"));
    expect(frame?.getAttribute("data-obscured")).toBe("false");
  });

  it("does not update evidence state when an explicit view finishes after unmount", async () => {
    let finishLoad: ((value: { contentType: string; dataBase64: string }) => void) | undefined;
    const load = vi.fn<() => Promise<{ contentType: string; dataBase64: string }>>(
      () =>
        new Promise<{ contentType: string; dataBase64: string }>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const view = wrap(<EvidenceItem evidence={evidence} load={load} />);
    fireEvent.click(screen.getByTestId("legal-evidence-view"));
    expect(load).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => {
      finishLoad?.({ contentType: "image/png", dataBase64: "aGVsbG8=" });
    });
    expect(screen.queryByTestId("legal-evidence")).toBeNull();
  });

  it("puts the uploaded object only through commitUpload and returns the committed key", async () => {
    const commit = vi.fn<UploadClient["commit"]>(async () => ({ key: "published/key", url: "/media/avatar" }));
    const client: UploadClient = {
      uploadUrl: vi.fn<UploadClient["uploadUrl"]>(async () => ({
        uploadUrl: "https://upload.invalid/temporary",
        key: "incoming/key",
        headers: {},
      })),
      put: vi.fn<UploadClient["put"]>(async () => ({ ok: true })),
      commit,
    };
    const result = await uploadChannelFile(client, {
      channel: "rivertide",
      purpose: "avatar",
      file: new Blob(["synthetic neutral placeholder"], { type: "image/png" }),
      contentType: "image/png",
    });
    expect(result).toEqual({ ok: true, key: "published/key", url: "/media/avatar" });
    expect(commit).toHaveBeenCalledWith({ channel: "rivertide", key: "incoming/key" });
  });

  it("shows the same generic rejection for an upload scan refusal", async () => {
    const client: UploadClient = {
      uploadUrl: vi.fn<UploadClient["uploadUrl"]>(async () => ({
        uploadUrl: "https://upload.invalid/temporary",
        key: "incoming/key",
        headers: {},
      })),
      put: vi.fn<UploadClient["put"]>(async () => ({ ok: true })),
      commit: vi.fn<UploadClient["commit"]>(async () => {
        throw { code: "UNPROCESSABLE_CONTENT", data: { reason: "upload_rejected" } };
      }),
    };
    const result = await uploadChannelFile(client, {
      channel: "rivertide",
      purpose: "avatar",
      file: new Blob(["synthetic neutral placeholder"], { type: "image/png" }),
      contentType: "image/png",
    });
    expect(result).toEqual({ ok: false, reason: "rejected" });
    expect(uploadFailureMessage("rejected")).toBe(en["safety.upload.rejected"]);
    expect(uploadFailureMessage("rejected")).not.toContain("upload_rejected");
  });

  it("reports transport failures without committing an upload", async () => {
    const commit = vi.fn<UploadClient["commit"]>(async () => ({ key: "published/key", url: "/media/avatar" }));
    const client: UploadClient = {
      uploadUrl: vi.fn<UploadClient["uploadUrl"]>(async () => ({
        uploadUrl: "https://upload.invalid/temporary",
        key: "incoming/key",
        headers: {},
      })),
      put: vi.fn<UploadClient["put"]>(async () => ({ ok: false })),
      commit,
    };
    const result = await uploadChannelFile(client, {
      channel: "rivertide",
      purpose: "avatar",
      file: new Blob(["synthetic neutral placeholder"], { type: "image/png" }),
      contentType: "image/png",
    });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(commit).not.toHaveBeenCalled();
    expect(uploadFailureMessage("failed")).toBe(en["safety.upload.failed"]);
  });
});
