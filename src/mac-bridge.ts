import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { equal } from './adapters.ts';

export interface MacMessage {
  rowid: number; id: string; chatId: string; sender: string; text: string | null;
  isFromMe: number; service: string; associatedType: number; itemType: number;
  attributedBody?: Uint8Array | null;
}
export interface MacSource {
  latest(): number;
  read(after: number): MacMessage[] | Promise<MacMessage[]>;
}
export interface BridgeReply { id: string; chatId: string; text: string }

// Open the live database read-only; never copy chat.db without its WAL.
export class MessagesSource implements MacSource {
  readonly db: DatabaseSync;
  private allowed: Set<string>;
  private decoder: string;
  constructor(path: string, allowed: Set<string>, decoder: string) {
    this.allowed = allowed; this.decoder = decoder;
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');
  }
  latest(): number {
    return (this.db.prepare('SELECT coalesce(max(ROWID),0) n FROM message').get() as { n: number }).n;
  }
  async read(after: number): Promise<MacMessage[]> {
    // Read every row, including ignored messages, so the cursor always advances.
    const rows = this.db.prepare(`SELECT m.ROWID rowid, m.guid id, m.text, m.attributedBody,
      m.is_from_me isFromMe, m.service, m.associated_message_type associatedType,
      m.item_type itemType, h.id sender,
      (SELECT c.guid FROM chat_message_join j JOIN chat c ON c.ROWID=j.chat_id
        WHERE j.message_id=m.ROWID ORDER BY c.ROWID LIMIT 1) chatId
      FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
      WHERE m.ROWID>? ORDER BY m.ROWID LIMIT 200`).all(after) as unknown as MacMessage[];
    for (const row of rows) {
      if (row.text === null && row.attributedBody?.length && this.allowed.has(row.sender) &&
          row.isFromMe === 0 && row.service === 'iMessage' && row.associatedType === 0 && row.itemType === 0) {
        row.text = await decodeAttributedBody(this.decoder, row.attributedBody);
      }
      if (row.text) row.text = row.text.replace(/\uFFFC/g, '');
      delete row.attributedBody;
    }
    return rows;
  }
  close(): void { this.db.close(); }
}

export function decodeAttributedBody(executable: string, body: Uint8Array): Promise<string> {
  if (body.length > 1024 * 1024) return Promise.reject(new Error('Attributed body too large'));
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [], { timeout: 10_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error('Attributed body decoder failed')); return; }
      try {
        const result = JSON.parse(stdout) as { text?: unknown };
        if (typeof result.text !== 'string') throw new Error('Invalid decoder result');
        resolve(result.text);
      } catch { reject(new Error('Invalid decoder result')); }
    });
    child.stdin?.on('error', () => { /* Exit callback reports decoder failure. */ });
    child.stdin?.end(Buffer.from(body).toString('base64'));
  });
}

export class BridgeStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, sender TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound (
        seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL,
        sender TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbound (
        seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, chatId TEXT NOT NULL,
        text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');`);
  }
  cursor(): number | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key='cursor'").get() as { value: number } | undefined)?.value;
  }
  initialize(latest: number): void {
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('cursor', ?)").run(latest);
  }
  capture(rows: MacMessage[], allowed: Set<string>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (row.id && row.chatId?.startsWith('iMessage;') && allowed.has(row.sender) && row.isFromMe === 0 &&
            row.service === 'iMessage' && row.associatedType === 0 && row.itemType === 0 &&
            row.text?.trim() && row.text.length <= 32_000) {
          this.db.prepare('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET sender=excluded.sender').run(row.chatId, row.sender);
          const body = JSON.stringify({ id: row.id, chatId: row.chatId, sender: row.sender, text: row.text, isFromMe: false });
          this.db.prepare('INSERT OR IGNORE INTO inbound(id,body,sender) VALUES (?,?,?)').run(row.id, body, row.sender);
        }
        this.db.prepare("UPDATE meta SET value=? WHERE key='cursor'").run(row.rowid);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pendingCount(): number {
    return (this.db.prepare("SELECT (SELECT count(*) FROM inbound WHERE done=0) + (SELECT count(*) FROM outbound WHERE state!='sent') n").get() as { n: number }).n;
  }
  accept(reply: BridgeReply, allowed: Set<string>): 'accepted' | 'conflict' | 'forbidden' | 'full' {
    const existing = this.db.prepare('SELECT chatId,text FROM outbound WHERE id=?').get(reply.id) as BridgeReply | undefined;
    if (existing) return existing.chatId === reply.chatId && existing.text === reply.text ? 'accepted' : 'conflict';
    const chat = this.db.prepare('SELECT sender FROM chats WHERE id=?').get(reply.chatId) as { sender: string } | undefined;
    if (!chat || !allowed.has(chat.sender)) return 'forbidden';
    if (this.pendingCount() >= 10_000) return 'full';
    this.db.prepare('INSERT INTO outbound(id,chatId,text) VALUES (?,?,?)').run(reply.id, reply.chatId, reply.text);
    return 'accepted';
  }
  close(): void { this.db.close(); }
}

// Fixed script, arguments passed separately: message text cannot inject AppleScript.
export const sendScript = `on run argv
  set chatID to item 1 of argv
  set bodyText to item 2 of argv
  tell application "Messages"
    set targetChat to chat id chatID
    send bodyText to targetChat
  end tell
end run`;
const exec = promisify(execFile);
export async function sendWithMessages(reply: BridgeReply): Promise<void> {
  await exec('/usr/bin/osascript', ['-e', sendScript, reply.chatId, reply.text], { timeout: 30_000, maxBuffer: 64 * 1024 });
}

export class BridgeWorker {
  private store: BridgeStore;
  private source: MacSource;
  private allowed: Set<string>;
  private forward: (body: string) => Promise<void>;
  private send: (reply: BridgeReply) => Promise<void>;
  constructor(store: BridgeStore, source: MacSource, allowed: Set<string>, forward: (body: string) => Promise<void>, send: (reply: BridgeReply) => Promise<void>) {
    this.store = store; this.source = source; this.allowed = allowed; this.forward = forward; this.send = send;
  }
  async tick(): Promise<void> {
    // Initialize once, without replaying years of private chat history.
    if (this.store.cursor() === undefined) this.store.initialize(this.source.latest());
    try {
      if (this.store.pendingCount() < 9800) this.store.capture(await this.source.read(this.store.cursor()!), this.allowed);
    } catch { console.error(JSON.stringify({ event: 'mac_poll_retry' })); }
    const db = this.store.db;
    const incoming = db.prepare('SELECT seq,body,sender FROM inbound WHERE done=0 ORDER BY seq LIMIT 1').get() as { seq: number; body: string; sender: string } | undefined;
    if (incoming) {
      try {
        if (this.allowed.has(incoming.sender)) await this.forward(incoming.body);
        db.prepare('UPDATE inbound SET done=1 WHERE seq=?').run(incoming.seq);
      } catch { console.error(JSON.stringify({ event: 'mac_forward_retry', seq: incoming.seq })); }
    }
    // An interrupted AppleScript send is ambiguous. Block that chat rather than
    // silently sending a duplicate; other chats remain usable. See recovery docs.
    const candidates = db.prepare(`SELECT o.seq,o.id,o.chatId,o.text,c.sender FROM outbound o
      JOIN chats c ON c.id=o.chatId WHERE o.state='pending' AND NOT EXISTS (
        SELECT 1 FROM outbound older WHERE older.chatId=o.chatId AND older.seq<o.seq AND older.state!='sent'
      ) ORDER BY o.seq`).all() as unknown as (BridgeReply & { seq: number; sender: string })[];
    const reply = candidates.find(candidate => this.allowed.has(candidate.sender));
    if (reply) {
      db.prepare("UPDATE outbound SET state='sending' WHERE seq=?").run(reply.seq);
      try {
        await this.send(reply);
        db.prepare("UPDATE outbound SET state='sent' WHERE seq=?").run(reply.seq);
      } catch { console.error(JSON.stringify({ event: 'mac_send_uncertain', seq: reply.seq })); }
    }
  }
}

export function createBridgeServer(store: BridgeStore, token: string, allowed: Set<string>) {
  let requests = 0, windowStart = Date.now();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-content-type-options', 'nosniff');
    const finish = (status: number, ok = false) => { res.writeHead(status).end(JSON.stringify({ ok })); };
    try {
      if (req.url === '/healthz' && req.method === 'GET') { finish(200, true); return; }
      if (req.url !== '/send') { finish(404); return; }
      if (req.method !== 'POST') { finish(405); return; }
      if (!equal(typeof req.headers.authorization === 'string' ? req.headers.authorization : '', `Bearer ${token}`)) { finish(401); return; }
      if (Date.now() - windowStart >= 60_000) { requests = 0; windowStart = Date.now(); }
      if (++requests > 600) { finish(429); return; }
      const buffers: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) { finish(413); return; }
        buffers.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      if (!body || typeof body !== 'object') { finish(400); return; }
      const r = body as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id || r.id.length > 256 || req.headers['idempotency-key'] !== r.id ||
          typeof r.chatId !== 'string' || !r.chatId || r.chatId.length > 1024 ||
          typeof r.text !== 'string' || !r.text.trim() || r.text.length > 32_000) { finish(400); return; }
      const result = store.accept({ id: r.id, chatId: r.chatId, text: r.text }, allowed);
      finish({ accepted: 200, conflict: 409, forbidden: 403, full: 503 }[result], result === 'accepted');
    } catch { finish(400); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  return server;
}

export function bridgeConfig(env: NodeJS.ProcessEnv) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const webhook = new URL(required('MAC_AGENT_WEBHOOK_URL'));
  if (webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.search || webhook.hash || webhook.pathname !== '/webhooks/imessage') throw new Error('Invalid MAC_AGENT_WEBHOOK_URL');
  const inboundToken = required('MAC_WEBHOOK_TOKEN'), outboundToken = required('MAC_BRIDGE_TOKEN');
  if (inboundToken === outboundToken) throw new Error('Bridge tokens must be distinct');
  const allowed = new Set(required('MAC_ALLOWED_SENDERS').split(',').map(s => s.trim()).filter(Boolean));
  if (!allowed.size || allowed.has('*')) throw new Error('MAC_ALLOWED_SENDERS must list explicit sender IDs');
  const port = Number(env.MAC_PORT ?? 3040);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MAC_PORT');
  return { webhook: webhook.href, inboundToken, outboundToken, allowed, port };
}
