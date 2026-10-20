import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Incoming, Outgoing, Channel } from './types.ts';
import type { Agent } from './agent.ts';

export function conversationId(message: Incoming): string {
  return JSON.stringify([message.channel, message.conversationKey]);
}
export function eventId(message: Incoming): string {
  return createHash('sha256').update(JSON.stringify([message.channel, message.eventId])).digest('hex');
}
export function chunks(text: string, limit = 3000): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < chars.length; i += limit) result.push(chars.slice(i, i + limit).join(''));
  return result;
}
interface Job {
  id: string;
  route: string;
  input: string;
  parts: string | null;
  sent: number;
  attempts: number;
}

export class Queue {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        route TEXT NOT NULL, input TEXT NOT NULL, parts TEXT,
        sent INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pending_jobs ON jobs(done, seq);`);
  }
  accept(messages: Incoming[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO jobs(id, route, input) VALUES (?, ?, ?)');
      for (const message of messages) insert.run(eventId(message), conversationId(message), JSON.stringify(message));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  next(active: Set<string>, now = Date.now()): Job | undefined {
    // Earlier unfinished requests block only their own conversation, including during backoff.
    const rows = this.db.prepare(`SELECT id,route,input,parts,sent,attempts FROM jobs j
      WHERE done=0 AND next_at<=? AND NOT EXISTS (
        SELECT 1 FROM jobs older WHERE older.route=j.route AND older.done=0 AND older.seq<j.seq
      ) ORDER BY seq LIMIT 100`).all(now) as unknown as Job[];
    return rows.find(row => !active.has(row.route));
  }
  async process(job: Job, agent: Agent, send: (message: Outgoing) => Promise<void>): Promise<void> {
    const incoming = JSON.parse(job.input) as Incoming;
    let parts = job.parts ? JSON.parse(job.parts) as string[] : undefined;
    if (!parts) {
      const answer = await agent.answer(job.route, job.id, incoming.text);
      parts = chunks(answer);
      this.db.prepare('UPDATE jobs SET parts=? WHERE id=?').run(JSON.stringify(parts), job.id);
    }
    for (let i = job.sent; i < parts.length; i++) {
      await send({ id: `${job.id}:${i}`, channel: incoming.channel, destination: incoming.destination, text: parts[i] });
      this.db.prepare('UPDATE jobs SET sent=? WHERE id=?').run(i + 1, job.id);
    }
    this.db.prepare('UPDATE jobs SET done=1 WHERE id=?').run(job.id);
  }
  retry(job: Job): void {
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 9));
    this.db.prepare('UPDATE jobs SET attempts=attempts+1, next_at=? WHERE id=?').run(Date.now() + delay, job.id);
  }
  pending(): number {
    return (this.db.prepare('SELECT count(*) n FROM jobs WHERE done=0').get() as { n: number }).n;
  }
  pendingChannels(): Channel[] {
    return (this.db.prepare("SELECT DISTINCT json_extract(input, '$.channel') channel FROM jobs WHERE done=0").all() as { channel: Channel }[]).map(row => row.channel);
  }
  close(): void { this.db.close(); }
}

export class Worker {
  private active = new Set<string>();
  private running = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private queue: Queue;
  private agent: Agent;
  private send: (message: Outgoing) => Promise<void>;
  constructor(queue: Queue, agent: Agent, send: (message: Outgoing) => Promise<void>) {
    this.queue = queue; this.agent = agent; this.send = send;
  }
  start(): void {
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }
  private tick(): void {
    while (this.running.size < 4) {
      const job = this.queue.next(this.active);
      if (!job) break;
      this.active.add(job.route);
      const work = this.queue.process(job, this.agent, this.send).catch(() => {
        // Do not log provider exceptions: they can contain keys, URLs, or message text.
        console.error(JSON.stringify({ event: 'job_retry', id: job.id, attempt: job.attempts + 1 }));
        this.queue.retry(job);
      }).finally(() => { this.active.delete(job.route); this.running.delete(work); });
      this.running.add(work);
    }
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled(this.running);
  }
}
