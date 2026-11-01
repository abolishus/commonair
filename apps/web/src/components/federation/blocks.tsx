// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/admin/federation` (ADR 0030 decision 7, docs/testing/b7-selectors.md "Federation"): the
 * instance's domain block list (add with validation and the subdomain rule explained, remove
 * with confirmation) and "Rotate all keys". Every action ends in a toast. While the instance does
 * not federate, the page says how to turn federation on instead.
 */
import { ConfirmDialog, EmptyState, RelativeTime, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { toast } from "@commonair/ui/toast";
import { Key01Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { errorCode } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import {
  checkBlockDomain,
  federationAdminClient,
  type BlockDomainCheck,
  type FederationAdminClient,
  type FederationBlockDto,
} from "./client.ts";

/** The setting an operator turns on (`.env`), shown as code, not translated. */
export const FEDERATION_ENV_SETTING = "FEDERATION_ENABLED=true";

export interface FederationAdminPageProps {
  /** `instance.info().features.federation`. */
  instanceEnabled: boolean;
  /** Tests pass a fake; the API otherwise. */
  client?: FederationAdminClient;
}

export function FederationAdminPage({
  instanceEnabled,
  client: clientProp,
}: FederationAdminPageProps): React.JSX.Element {
  const client = React.useMemo(() => clientProp ?? federationAdminClient(), [clientProp]);
  return (
    <div data-testid="federation-admin-page" className="flex min-w-0 flex-col gap-6">
      {instanceEnabled ? (
        <>
          <FederationBlocks client={client} />
          <KeyRotation client={client} />
        </>
      ) : (
        <FederationOff />
      )}
    </div>
  );
}

function FederationOff(): React.JSX.Element {
  return (
    <Card data-testid="federation-admin-off">
      <CardHeader>
        <CardTitle>{t("federation.admin.offTitle")}</CardTitle>
        <CardDescription>{t("federation.admin.offBody")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3 text-sm">
        <p>{t("federation.admin.offHowTo")}</p>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm">
          <code>{FEDERATION_ENV_SETTING}</code>
        </pre>
        <p className="text-muted-foreground">{t("federation.admin.offThen")}</p>
      </CardContent>
    </Card>
  );
}

/** The message for a failed check. */
export function blockCheckMessage(check: Exclude<BlockDomainCheck, { ok: true }>): string {
  switch (check.error) {
    case "invalid":
      return t("federation.blocks.invalid");
    case "duplicate":
      return t("federation.blocks.duplicate", { domain: check.domain });
    case "covered":
      return t("federation.blocks.covered", { domain: check.domain, parent: check.by });
  }
}

export function FederationBlocks({ client }: { client: FederationAdminClient }): React.JSX.Element {
  const [blocks, setBlocks] = React.useState<FederationBlockDto[] | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const inputId = React.useId();
  const hintId = React.useId();
  const errorId = React.useId();
  const listHeadingId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    client
      .blocks()
      .then((b) => !cancelled && setBlocks(b))
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (adding) return;
    const check = checkBlockDomain(
      input,
      (blocks ?? []).map((b) => b.domain),
    );
    if (!check.ok) {
      setError(blockCheckMessage(check));
      return;
    }
    setError(null);
    setAdding(true);
    try {
      const added = await client.addBlock(check.domain);
      setBlocks((prev) => [added, ...(prev ?? []).filter((b) => b.domain !== added.domain)]);
      setInput("");
      toast.success(t("federation.blocks.added", { domain: added.domain }));
    } catch (err) {
      if (errorCode(err) === "BAD_REQUEST") setError(t("federation.blocks.invalid"));
      else toastActionError(err, t("federation.blocks.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (domain: string) => {
    await client.removeBlock(domain);
    setBlocks((prev) => prev?.filter((b) => b.domain !== domain) ?? prev);
    toast.success(t("federation.blocks.removed", { domain }));
  };

  return (
    <Card data-testid="federation-blocks-card">
      <CardHeader>
        <CardTitle>{t("federation.blocks.title")}</CardTitle>
        <CardDescription>{t("federation.blocks.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        <form className="flex min-w-0 flex-col gap-2" onSubmit={(e) => void submit(e)} noValidate>
          <Field>
            <FieldLabel htmlFor={inputId}>{t("federation.blocks.domainLabel")}</FieldLabel>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Input
                id={inputId}
                data-testid="federation-block-domain"
                className="min-w-0 flex-1 basis-48"
                value={input}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                placeholder={t("federation.blocks.domainPlaceholder")}
                aria-invalid={error !== null || undefined}
                aria-describedby={error !== null ? `${hintId} ${errorId}` : hintId}
                onChange={(e) => {
                  setInput(e.currentTarget.value);
                  if (error !== null) setError(null);
                }}
              />
              <Button
                type="submit"
                data-testid="federation-block-add"
                disabled={adding}
                aria-busy={adding || undefined}
              >
                {t("federation.blocks.add")}
              </Button>
            </div>
            <FieldDescription id={hintId}>{t("federation.blocks.subdomains")}</FieldDescription>
          </Field>
          {error !== null && (
            <div id={errorId} data-testid="federation-block-error">
              <FormError>{error}</FormError>
            </div>
          )}
        </form>
        <section aria-labelledby={listHeadingId} className="flex min-w-0 flex-col gap-2">
          <h3 id={listHeadingId} className="text-sm font-medium">
            {t("federation.blocks.listTitle")}
          </h3>
          <div data-testid="federation-blocks" className="min-w-0">
            {loadFailed ? (
              <FormError>{t("federation.blocks.loadFailed")}</FormError>
            ) : blocks === null ? (
              <SkeletonGroup label={t("federation.blocks.loading")}>
                <SkeletonText lines={3} />
              </SkeletonGroup>
            ) : blocks.length === 0 ? (
              <EmptyState
                icon={UnavailableIcon}
                headingLevel={4}
                title={t("federation.blocks.empty")}
                description={t("federation.blocks.emptyHint")}
              />
            ) : (
              <ul className="flex min-w-0 flex-col divide-y" aria-labelledby={listHeadingId}>
                {blocks.map((b) => (
                  <BlockRow key={b.domain} block={b} onRemove={() => remove(b.domain)} />
                ))}
              </ul>
            )}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function BlockRow({
  block,
  onRemove,
}: {
  block: FederationBlockDto;
  onRemove: () => Promise<void>;
}): React.JSX.Element {
  return (
    <li
      data-testid="federation-block"
      data-domain={block.domain}
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 break-all font-medium">{block.domain}</span>
        <span className="text-sm text-muted-foreground">
          {block.createdBy
            ? t("federation.blocks.blockedBy", { username: block.createdBy.username })
            : t("federation.blocks.blocked")}{" "}
          <RelativeTime date={block.createdAt} />
        </span>
      </div>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="federation-block-remove"
            aria-label={t("federation.blocks.removeLabel", { domain: block.domain })}
          >
            {t("federation.blocks.remove")}
          </Button>
        }
        title={t("federation.blocks.removeTitle", { domain: block.domain })}
        description={t("federation.blocks.removeBody")}
        confirmLabel={t("federation.blocks.remove")}
        onConfirm={onRemove}
        onError={(err) => toastActionError(err, t("federation.blocks.removeFailed"))}
      />
    </li>
  );
}

function KeyRotation({ client }: { client: FederationAdminClient }): React.JSX.Element {
  const rotate = async () => {
    const rotated = await client.rotateAll();
    toast.success(t("federation.keys.rotated", { count: rotated }));
  };
  return (
    <Card data-testid="federation-keys">
      <CardHeader>
        <CardTitle>{t("federation.keys.title")}</CardTitle>
        <CardDescription>{t("federation.keys.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" data-testid="federation-keys-rotate">
              {t("federation.keys.rotate")}
            </Button>
          }
          icon={Key01Icon}
          title={t("federation.keys.confirmTitle")}
          description={t("federation.keys.confirmBody")}
          confirmLabel={t("federation.keys.rotate")}
          onConfirm={rotate}
          onError={(err) => toastActionError(err, t("federation.keys.rotateFailed"))}
        />
      </CardContent>
    </Card>
  );
}
