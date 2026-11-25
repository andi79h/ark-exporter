// Discord webhooks: lines are queued per webhook, combined into messages of up to ~1900 characters and sent
// at most every 2 seconds (Discord allows 30 messages per minute per webhook). Mentions are disabled.

interface Queue { lines: string[]; timer: NodeJS.Timeout | null; backoffUntil: number }

export class DiscordRelay {
  private readonly webhooks: Record<string, string>;
  private readonly queues = new Map<string, Queue>();
  private readonly fetchImpl: typeof fetch;
  onError: (err: Error) => void = () => undefined;

  constructor(webhooks: Record<string, string>, fetchImpl: typeof fetch = fetch) {
    this.webhooks = webhooks;
    this.fetchImpl = fetchImpl;
  }

  has(name: string): boolean { return Boolean(this.webhooks[name]); }

  /** Queues one line for a webhook name. */
  send(name: string, line: string): void {
    if (!this.webhooks[name]) return;
    let q = this.queues.get(name);
    if (!q) { q = { lines: [], timer: null, backoffUntil: 0 }; this.queues.set(name, q); }
    q.lines.push(line.length > 1900 ? `${line.slice(0, 1897)}…` : line);
    if (q.lines.length > 500) q.lines.splice(0, q.lines.length - 500);
    if (!q.timer) q.timer = setTimeout(() => this.flush(name), Math.max(300, q.backoffUntil - Date.now()));
  }

  private async flush(name: string): Promise<void> {
    const q = this.queues.get(name);
    if (!q) return;
    q.timer = null;
    let content = '';
    while (q.lines.length && (content.length + q.lines[0].length + 1) <= 1900) content += (content ? '\n' : '') + q.lines.shift();
    if (!content && q.lines.length) content = q.lines.shift()!;
    if (content) {
      try {
        const res = await this.fetchImpl(this.webhooks[name], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        });
        if (res.status === 429) {
          const retry = Number(res.headers.get('retry-after') ?? '2');
          q.backoffUntil = Date.now() + Math.ceil(retry * 1000);
          q.lines.unshift(content);
        } else if (!res.ok) {
          this.onError(new Error(`discord webhook ${name}: HTTP ${res.status}`));
        }
      } catch (err) {
        this.onError(err as Error);
      }
    }
    if (q.lines.length && !q.timer) q.timer = setTimeout(() => this.flush(name), Math.max(2000, q.backoffUntil - Date.now()));
  }

  stop(): void {
    for (const q of this.queues.values()) if (q.timer) clearTimeout(q.timer);
  }
}

/** Escapes Discord markdown in player-provided text. */
export function escapeDiscord(text: string): string {
  return text.replace(/([\\*_~`|>#\-[\]()])/g, '\\$1').replace(/@/g, '@\u200b');
}
