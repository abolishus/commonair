// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SLSA v1 build provenance predicates (ADR 0023 §4), attached with
 * `cosign attest --type slsaprovenance1` (images) or `cosign attest-blob` (relay binaries), so
 * they verify with `cosign verify-attestation` / `verify-blob-attestation` alone, without
 * GitHub's attestation API.
 *
 *   bun scripts/release/provenance.ts --artifact <name> --version <v> --commit <sha> --out <file>
 *
 * The GitHub run context comes from the runner's GITHUB_* variables. The signing certificate
 * (Fulcio, from the workflow's OIDC token) binds the attestation to the workflow identity; this
 * predicate records what was built from which source.
 */
import { writeFileSync } from "node:fs";

export const BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";

export interface RunContext {
  serverUrl: string;
  repository: string;
  /** `<owner>/<repo>/.github/workflows/<file>@<ref>`. */
  workflowRef: string;
  ref: string;
  eventName: string;
  runId: string;
  runAttempt: string;
  repositoryId: string;
  repositoryOwnerId: string;
  runnerEnvironment: string;
}

export interface Subject {
  artifact: string;
  version: string;
  commit: string;
}

export function contextFromEnv(env: Record<string, string | undefined>): RunContext {
  const get = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set (run inside GitHub Actions)`);
    return v;
  };
  return {
    serverUrl: get("GITHUB_SERVER_URL"),
    repository: get("GITHUB_REPOSITORY"),
    workflowRef: get("GITHUB_WORKFLOW_REF"),
    ref: get("GITHUB_REF"),
    eventName: get("GITHUB_EVENT_NAME"),
    runId: get("GITHUB_RUN_ID"),
    runAttempt: get("GITHUB_RUN_ATTEMPT"),
    repositoryId: env.GITHUB_REPOSITORY_ID ?? "",
    repositoryOwnerId: env.GITHUB_REPOSITORY_OWNER_ID ?? "",
    runnerEnvironment: env.RUNNER_ENVIRONMENT ?? "",
  };
}

export function slsaPredicate(ctx: RunContext, s: Subject) {
  if (!/^[0-9a-f]{40}$/.test(s.commit)) throw new Error(`invalid commit: ${s.commit}`);
  const at = ctx.workflowRef.indexOf("@");
  if (at < 0) throw new Error(`invalid workflow ref: ${ctx.workflowRef}`);
  const path = ctx.workflowRef.slice(ctx.repository.length + 1, at);
  const repoUrl = `${ctx.serverUrl}/${ctx.repository}`;
  return {
    buildDefinition: {
      buildType: BUILD_TYPE,
      externalParameters: {
        workflow: { ref: ctx.workflowRef.slice(at + 1), repository: repoUrl, path },
        artifact: s.artifact,
        version: s.version,
      },
      internalParameters: {
        github: {
          event_name: ctx.eventName,
          repository_id: ctx.repositoryId,
          repository_owner_id: ctx.repositoryOwnerId,
          runner_environment: ctx.runnerEnvironment,
        },
      },
      resolvedDependencies: [{ uri: `git+${repoUrl}@${ctx.ref}`, digest: { gitCommit: s.commit } }],
    },
    runDetails: {
      builder: { id: `${ctx.serverUrl}/${ctx.workflowRef}` },
      metadata: { invocationId: `${repoUrl}/actions/runs/${ctx.runId}/attempts/${ctx.runAttempt}` },
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [artifact, version, commit, out] = [opt("artifact"), opt("version"), opt("commit"), opt("out")];
  if (!artifact || !version || !commit || !out) {
    console.error("usage: provenance.ts --artifact <name> --version <v> --commit <sha> --out <file>");
    process.exit(2);
  }
  const predicate = slsaPredicate(contextFromEnv(process.env), { artifact, version, commit });
  writeFileSync(out, `${JSON.stringify(predicate, null, 2)}\n`);
}
