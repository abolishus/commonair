// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { FormError } from "../form-error.tsx";
import { EvidenceMedia } from "./evidence.tsx";
import {
  JURY_REASON_CODES,
  JURY_VOTES,
  KIND_KEYS,
  REASON_KEYS,
  VOTE_KEYS,
  outcomeKey,
  ruleVersion,
  type JuryCaseDto,
  type JuryReasonCode,
  type JuryVote,
} from "./model.ts";

export type OnVote = (caseId: string, vote: JuryVote, reasonCode: JuryReasonCode) => Promise<void>;

const isReason = (v: unknown): v is JuryReasonCode =>
  typeof v === "string" && (JURY_REASON_CODES as readonly string[]).includes(v);

/** Agree, disagree or unsure, a reason code, then submit; no free text (ADR 0038 §6). */
function VoteForm({ kase, onVote }: { kase: JuryCaseDto; onVote: OnVote }): React.JSX.Element {
  const [vote, setVote] = React.useState<JuryVote | null>(null);
  const [reason, setReason] = React.useState<JuryReasonCode | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const reasonId = React.useId();
  const reasons = JURY_REASON_CODES.map((code) => ({ value: code, label: t(REASON_KEYS[code]) }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vote || !reason || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onVote(kase.id, vote, reason);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t("jury.vote.legend")}</legend>
        <div className="flex flex-wrap gap-2">
          {JURY_VOTES.map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={vote === v ? "default" : "outline"}
              aria-pressed={vote === v}
              data-testid={`jury-vote-${v}`}
              onClick={() => setVote(v)}
            >
              {t(VOTE_KEYS[v])}
            </Button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor={reasonId} className="text-xs text-muted-foreground">
          {t("jury.vote.reason")}
        </Label>
        <Select
          items={reasons}
          value={reason}
          onValueChange={(value) => {
            if (isReason(value)) setReason(value);
          }}
        >
          <SelectTrigger id={reasonId} data-testid="jury-reason" data-value={reason ?? ""} className="w-full sm:w-72">
            <SelectValue>
              {(v: string | null) => (isReason(v) ? t(REASON_KEYS[v]) : t("jury.vote.reasonPlaceholder"))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {reasons.map((r) => (
              <SelectItem key={r.value} value={r.value} data-testid={`jury-reason-${r.value}`}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" data-testid="jury-vote-submit" disabled={!vote || !reason || busy}>
          {busy ? t("jury.vote.submitting") : t("jury.vote.submit")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("jury.vote.final")}</span>
      </div>
      {failed && <FormError>{t("jury.vote.failed")}</FormError>}
    </form>
  );
}

/**
 * One sampled case for a juror (ADR 0038 §5): the clause and its version, the decision and whether
 * a person or the system took it, the kept evidence (text excerpts; media blurred until revealed),
 * and the vote. Names are panel pseudonyms; the reporter is never shown.
 */
export function JuryCaseCard({ kase, onVote }: { kase: JuryCaseDto; onVote: OnVote }): React.JSX.Element {
  const version = ruleVersion(kase.ruleRef);
  const texts = kase.evidence.filter((e) => e.kind === "text");
  const images = kase.evidence.filter((e) => e.kind === "image");
  return (
    <Card
      data-testid="jury-case"
      data-case-id={kase.id}
      data-kind={kase.subjectKind}
      data-tier={kase.tier ?? "none"}
      data-automated={kase.automated ? "true" : "false"}
    >
      <CardHeader>
        <CardTitle>
          {kase.subjectPseudonym
            ? t("jury.case.title", { name: kase.subjectPseudonym })
            : t("jury.case.subjectUnknown")}
        </CardTitle>
        <CardDescription className="flex flex-wrap gap-2">
          <StatusBadge tone="neutral">{t(KIND_KEYS[kase.subjectKind])}</StatusBadge>
          {kase.tier === "t1" || kase.tier === "t2" ? (
            <StatusBadge tone="info">{t(kase.tier === "t1" ? "jury.case.tier.t1" : "jury.case.tier.t2")}</StatusBadge>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("jury.case.clause")}</dt>
            <dd data-testid="jury-case-clause" data-rule-ref={kase.ruleRef ?? ""} className="flex flex-col">
              <span className="font-medium">{kase.clauseTitle ?? t("jury.case.noClause")}</span>
              {version !== null && (
                <span className="text-xs text-muted-foreground">
                  {t("jury.case.version", { version: String(version) })}
                </span>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t("jury.case.outcome")}</dt>
            <dd className="flex flex-col">
              <span>{t(outcomeKey(kase.outcome))}</span>
              <span className="text-xs text-muted-foreground">
                {kase.automated ? t("jury.case.automated") : t("jury.case.human")}
              </span>
            </dd>
          </div>
        </dl>
        <section className="flex flex-col gap-2" aria-label={t("jury.case.evidence")}>
          <h3 className="text-sm font-medium">{t("jury.case.evidence")}</h3>
          {kase.evidence.length === 0 && <p className="text-sm text-muted-foreground">{t("jury.case.noEvidence")}</p>}
          {texts.map((e, i) => (
            <blockquote
              // Excerpts have no id; their order is the case's.
              key={`text-${String(i)}`}
              data-testid="jury-evidence-text"
              className="border-s-2 border-border ps-3 text-sm break-words whitespace-pre-wrap"
            >
              {e.value}
            </blockquote>
          ))}
          {images.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {images.map((e, i) => (
                <EvidenceMedia key={`image-${String(i)}`} src={e.value} index={i} />
              ))}
            </div>
          )}
        </section>
        {kase.myVote ? (
          <p
            data-testid="jury-voted"
            data-vote={kase.myVote.vote}
            data-reason={kase.myVote.reasonCode}
            className="text-sm"
          >
            {t("jury.vote.voted", {
              vote: t(VOTE_KEYS[kase.myVote.vote]),
              reason: t(REASON_KEYS[kase.myVote.reasonCode]),
            })}
          </p>
        ) : (
          <VoteForm kase={kase} onVote={onVote} />
        )}
      </CardContent>
    </Card>
  );
}
