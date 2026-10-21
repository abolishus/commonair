// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModerationT0Job } from "@commonair/contracts/internal";
import { uuidv7 } from "@commonair/db";

/** Durable local copies of sealed T0 jobs remain until the worker's hash-list action commits. */
export class T0Outbox {
  constructor(private readonly dir: string) {}

  async persist(job: ModerationT0Job): Promise<{ path: string; job: ModerationT0Job }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const parent = await open(dirname(this.dir), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const destination = join(this.dir, `${job.subjectType}-${job.subjectId}.json`);
    const temporary = join(this.dir, `${uuidv7()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(job), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // link is atomic and does not replace an earlier evidence record for this subject.
      await link(temporary, destination).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "EEXIST") return;
        throw err;
      });
      const directory = await open(this.dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return { path: destination, job: ModerationT0Job.parse(JSON.parse(await readFile(destination, "utf8"))) };
  }

  async pending(): Promise<Array<{ job: ModerationT0Job; path: string }>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.dir, { withFileTypes: true });
    const out: Array<{ job: ModerationT0Job; path: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.dir, entry.name);
      const job = ModerationT0Job.parse(JSON.parse(await readFile(path, "utf8")));
      out.push({ job, path });
    }
    return out;
  }

  async accepted(path: string): Promise<void> {
    await unlink(path).catch((err: unknown) => {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    });
  }
}
