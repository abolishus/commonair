// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Importing a portability bundle on `/move` (ADR 0037 decision 5): pick the archive (presigned
 * upload), read the preview with its standing badge and per-item choices, assert the right to the
 * emote art when emotes are chosen (ADR 0031), start, and follow the result while the worker
 * applies it. `ImportView` is drawn from props so tests render every state; `useImport` runs it.
 */
import { StatusBadge, type StatusTone } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Label } from "@commonair/ui/components/label";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import {
  defaultChoices,
  IMPORT_POLL_MS,
  importErrorReason,
  isChosen,
  isImportRunning,
  isSelectable,
  ITEM_KIND_KEYS,
  OUTCOME_KEYS,
  reasonKey,
  STANDING_KEYS,
  STANDING_REFUSALS,
  standingBadge,
  toggleChoice,
  type ImportChoices,
  type ImportDto,
  type ImportItemDto,
  type StandingBadge,
} from "./lib.ts";

export type ImportPhase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "refused"; reason: string }
  | { kind: "preview"; dto: ImportDto }
  | { kind: "applying"; dto: ImportDto };

export interface ImportViewProps {
  phase: ImportPhase;
  choices: ImportChoices;
  asserted: boolean;
  onFile: (file: File) => void;
  onToggle: (item: ImportItemDto) => void;
  onAssert: (on: boolean) => void;
  onStart: () => void;
  onReset: () => void;
}

const STANDING_TONE: Record<StandingBadge, StatusTone> = {
  verified: "success",
  unverified: "warning",
  refused: "danger",
};

function StandingRow({ state, issuer }: { state: StandingBadge; issuer: string | null }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <StatusBadge tone={STANDING_TONE[state]} data-testid="bundle-import-standing" data-state={state}>
        {t(STANDING_KEYS[state])}
      </StatusBadge>
      {state === "verified" && issuer && (
        <span className="min-w-0 break-all text-xs text-muted-foreground">
          {t("portability.import.standing.issuer", { issuer })}
        </span>
      )}
    </div>
  );
}

function ItemLine({ item }: { item: ImportItemDto }): React.JSX.Element {
  const label =
    item.kind === "schedule" ? t("portability.import.scheduleCount", { count: Number(item.label) }) : item.label;
  return (
    <span className="min-w-0 break-words text-sm">
      <span className="text-muted-foreground">{t(ITEM_KIND_KEYS[item.kind])}: </span>
      {label || t("portability.import.untitled")}
    </span>
  );
}

export function ImportView(props: ImportViewProps): React.JSX.Element {
  const { phase } = props;
  const fileId = React.useId();
  const hintId = React.useId();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const emotesChosen = props.choices.emotes.length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("portability.import.title")}</CardTitle>
        <CardDescription>{t("portability.import.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {(phase.kind === "idle" || phase.kind === "uploading" || phase.kind === "refused") && (
          <Field>
            <FieldLabel htmlFor={fileId}>{t("portability.import.file")}</FieldLabel>
            {/* The native picker stays in the label but out of sight; the button opens it. */}
            <Input
              ref={fileInput}
              id={fileId}
              data-testid="bundle-import-file"
              type="file"
              accept="application/zip,.zip"
              className="sr-only"
              tabIndex={-1}
              aria-describedby={hintId}
              disabled={phase.kind === "uploading"}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) props.onFile(file);
              }}
            />
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={phase.kind === "uploading"}
                aria-busy={phase.kind === "uploading" || undefined}
                aria-describedby={hintId}
                onClick={() => fileInput.current?.click()}
              >
                {phase.kind === "uploading" ? t("portability.import.reading") : t("portability.import.choose")}
              </Button>
            </div>
            <FieldDescription id={hintId}>{t("portability.import.fileHint")}</FieldDescription>
          </Field>
        )}
        {phase.kind === "refused" && (
          <div className="flex min-w-0 flex-col gap-2">
            {STANDING_REFUSALS.has(phase.reason) && <StandingRow state="refused" issuer={null} />}
            <FormError>{t(reasonKey(phase.reason) ?? "portability.reason.other")}</FormError>
          </div>
        )}
        {phase.kind === "preview" && <PreviewBody {...props} dto={phase.dto} emotesChosen={emotesChosen} />}
        {phase.kind === "applying" && <ResultBody dto={phase.dto} onReset={props.onReset} />}
      </CardContent>
    </Card>
  );
}

function PreviewBody(props: ImportViewProps & { dto: ImportDto; emotesChosen: boolean }): React.JSX.Element {
  const { dto } = props;
  const assertId = React.useId();
  const itemIdBase = React.useId();
  const pending = dto.preview.channel.state === "pending";
  const nothing = !props.choices.channel && !props.choices.panels && props.choices.emotes.length === 0;
  return (
    <div data-testid="bundle-import-preview" data-import-id={dto.id} className="flex min-w-0 flex-col gap-4">
      <StandingRow state={standingBadge(dto, false)} issuer={dto.standingIssuer} />
      {dto.standingVerified !== true && (
        <AlertCallout tone="warning" description={t("portability.import.standing.unverifiedHint")} />
      )}
      {pending ? (
        <p className="text-sm text-muted-foreground">{t("portability.import.pending")}</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2" aria-label={t("portability.import.itemsLabel")}>
          {dto.preview.items.map((item) => {
            const on = isChosen(props.choices, item);
            const id = [itemIdBase, item.kind, item.ref].join("-");
            return (
              <li
                key={`${item.kind}:${item.ref}`}
                data-testid="bundle-import-item"
                data-kind={item.kind}
                data-ref={item.ref}
                className="flex min-w-0 items-start gap-3"
              >
                <Checkbox
                  id={id}
                  data-testid="bundle-import-item-toggle"
                  data-state={on ? "on" : "off"}
                  checked={on}
                  disabled={!isSelectable(item)}
                  onCheckedChange={() => props.onToggle(item)}
                />
                <Label htmlFor={id} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
                  <ItemLine item={item} />
                  {item.reason && (
                    <span className="text-xs text-muted-foreground">
                      {t(reasonKey(item.reason) ?? "portability.reason.other")}
                    </span>
                  )}
                </Label>
              </li>
            );
          })}
        </ul>
      )}
      {props.emotesChosen && (
        <Field orientation="horizontal">
          <Checkbox
            id={assertId}
            data-testid="bundle-import-assert"
            checked={props.asserted}
            onCheckedChange={(on: boolean) => props.onAssert(on)}
          />
          <FieldLabel htmlFor={assertId}>{t("portability.import.assert")}</FieldLabel>
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="bundle-import-start"
          disabled={pending || nothing || (props.emotesChosen && !props.asserted)}
          onClick={props.onStart}
        >
          {t("portability.import.start")}
        </Button>
        <Button variant="ghost" onClick={props.onReset}>
          {t("portability.import.cancel")}
        </Button>
      </div>
    </div>
  );
}

function ResultBody({ dto, onReset }: { dto: ImportDto; onReset: () => void }): React.JSX.Element {
  const running = isImportRunning(dto);
  return (
    <div data-testid="bundle-import-result" data-status={dto.status} className="flex min-w-0 flex-col gap-3">
      <p className="text-sm" aria-live="polite">
        {running
          ? t("portability.import.running")
          : dto.status === "done"
            ? t("portability.import.done")
            : t("portability.import.failed")}
      </p>
      {!running && dto.result && (
        <ul className="flex min-w-0 flex-col gap-2" aria-label={t("portability.import.resultLabel")}>
          {dto.result.map((item) => (
            <li
              key={`${item.kind}:${item.ref}`}
              data-testid="bundle-import-result-item"
              data-kind={item.kind}
              data-ref={item.ref}
              data-outcome={item.outcome ?? ""}
              data-reason={item.reason ?? ""}
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <ItemLine item={item} />
              {item.outcome && (
                <StatusBadge
                  tone={item.outcome === "imported" ? "success" : item.outcome === "rejected" ? "danger" : "neutral"}
                >
                  {t(OUTCOME_KEYS[item.outcome])}
                </StatusBadge>
              )}
              {item.reason && item.outcome !== "imported" && (
                <span className="text-xs text-muted-foreground">
                  {t(reasonKey(item.reason) ?? "portability.reason.other")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!running && (
        <div>
          <Button variant="outline" onClick={onReset}>
            {t("portability.import.another")}
          </Button>
        </div>
      )}
    </div>
  );
}

// The container -------------------------------------------------------------------------------

export interface ImportClient {
  upload(input: {
    channel: string;
    sizeBytes: number;
  }): Promise<{ key: string; uploadUrl: string; headers: Record<string, string> }>;
  put: (url: string, file: Blob, headers: Record<string, string>) => Promise<{ ok: boolean }>;
  preview: (input: { channel: string; key: string }) => Promise<ImportDto>;
  start: (input: {
    channel: string;
    id: string;
    choices: ImportChoices;
    assertEmoteRights: boolean;
  }) => Promise<ImportDto>;
  get: (input: { channel: string; id: string }) => Promise<ImportDto>;
}

export const importClient = (): ImportClient => ({
  upload: (input) => api().portability.imports.upload(input),
  put: (url, file, headers) => fetch(url, { method: "PUT", body: file, headers }),
  preview: (input) => api().portability.imports.preview(input) as Promise<ImportDto>,
  start: (input) => api().portability.imports.start(input) as Promise<ImportDto>,
  get: (input) => api().portability.imports.get(input) as Promise<ImportDto>,
});

export function ImportCard({ channel, client: given }: { channel: string; client?: ImportClient }): React.JSX.Element {
  const client = React.useMemo(() => given ?? importClient(), [given]);
  const [phase, setPhase] = React.useState<ImportPhase>({ kind: "idle" });
  const [choices, setChoices] = React.useState<ImportChoices>({ channel: false, panels: false, emotes: [] });
  const [asserted, setAsserted] = React.useState(false);

  const showPreview = (dto: ImportDto) => {
    setChoices(defaultChoices(dto.preview.items));
    setAsserted(false);
    setPhase({ kind: "preview", dto });
  };

  // Follow a pending preview or a running import until the worker is done.
  const watching = phase.kind === "applying" ? phase.dto : phase.kind === "preview" ? phase.dto : null;
  const watchId = watching?.id ?? null;
  const kind = phase.kind;
  const watch =
    watching !== null &&
    ((phase.kind === "applying" && isImportRunning(watching)) || watching.preview.channel.state === "pending");
  React.useEffect(() => {
    if (!watch || !watchId) return;
    const id = window.setInterval(() => {
      client
        .get({ channel, id: watchId })
        .then((dto) => {
          if (dto.status === "failed" && dto.preview.channel.state === "refused")
            setPhase({ kind: "refused", reason: dto.result?.[0]?.reason ?? "refused" });
          else if (kind === "preview") showPreview(dto);
          else setPhase({ kind: "applying", dto });
        })
        .catch(() => undefined);
    }, IMPORT_POLL_MS);
    return () => window.clearInterval(id);
  }, [watch, watchId, channel, client, kind]);

  const onFile = async (file: File) => {
    if (file.size === 0 || file.size > PORTABILITY_LIMITS.maxArchiveBytes) {
      setPhase({ kind: "refused", reason: "bundle_archive_too_large" });
      return;
    }
    setPhase({ kind: "uploading" });
    try {
      const up = await client.upload({ channel, sizeBytes: file.size });
      const put = await client.put(up.uploadUrl, file, up.headers);
      if (!put.ok) throw new Error("upload failed");
      showPreview(await client.preview({ channel, key: up.key }));
    } catch (err) {
      const reason = importErrorReason(err);
      if (reason) setPhase({ kind: "refused", reason });
      else {
        setPhase({ kind: "idle" });
        toastActionError(err, t("portability.import.uploadFailed"));
      }
    }
  };

  const onStart = async () => {
    if (phase.kind !== "preview") return;
    try {
      const dto = await client.start({ channel, id: phase.dto.id, choices, assertEmoteRights: asserted });
      setPhase({ kind: "applying", dto });
      toast.success(t("portability.import.started"));
    } catch (err) {
      toastActionError(
        err,
        errorCode(err) === "PRECONDITION_FAILED"
          ? t("portability.import.assertNeeded")
          : t("portability.import.startFailed"),
      );
    }
  };

  return (
    <ImportView
      phase={phase}
      choices={choices}
      asserted={asserted}
      onFile={(f) => void onFile(f)}
      onToggle={(item) => setChoices((c) => toggleChoice(c, item))}
      onAssert={setAsserted}
      onStart={() => void onStart()}
      onReset={() => setPhase({ kind: "idle" })}
    />
  );
}
