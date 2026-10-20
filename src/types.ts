export type Channel = 'telegram' | 'slack' | 'whatsapp' | 'imessage';
export interface Incoming {
  channel: Channel;
  eventId: string;
  conversationKey: string;
  sender: string;
  text: string;
  destination: Record<string, string>;
}
export interface Outgoing {
  id: string;
  channel: Channel;
  destination: Record<string, string>;
  text: string;
}
export interface Adapter {
  channel: Channel;
  path: string;
  receive(raw: Buffer, headers: import('node:http').IncomingHttpHeaders, url: URL, method: string): { status?: number; body?: string; messages?: Incoming[] };
  send(message: Outgoing): Promise<void>;
}
