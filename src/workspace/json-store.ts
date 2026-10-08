import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';

/** `yuilink-demo/data` — same path from `src/` (ts) and `dist/` (build). */
const DATA_DIR = join(__dirname, '..', '..', 'data');

/**
 * Tiny JSON-file "DB" for the demo: each file holds one array of rows.
 *
 * Every read-modify-write must run inside `exclusive()` — one in-process queue,
 * so two requests never overwrite each other's changes. Writes go through a
 * tmp file + rename, so a plain `read()` never sees a half-written file.
 * Not safe across processes (one app instance only).
 */
@Injectable()
export class JsonStore {
  private queue: Promise<unknown> = Promise.resolve();

  async read<T>(file: string): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(join(DATA_DIR, file), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async write<T>(file: string, rows: T[]): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const target = join(DATA_DIR, file);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rows, null, 2) + '\n');
    await fs.rename(tmp, target);
  }

  exclusive<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
