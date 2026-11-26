import net from 'node:net';
import tls from 'node:tls';

/**
 * ClamAV connector using clamd's INSTREAM command over TCP (see the clamd(8) man page):
 *   send "zINSTREAM\0", then chunks of <4-byte big-endian length><bytes>, then a zero-length chunk;
 *   clamd replies "stream: OK" or "stream: <signature> FOUND" (or "... ERROR").
 * Off unless CLAMAV_HOST is set. clamd itself speaks plain TCP; when the scanner is not on a private network,
 * put it behind a TLS terminator (e.g. stunnel) and set CLAMAV_TLS=1 — patient documents must not cross the
 * internet unencrypted.
 * When the scanner is configured but unreachable, uploads are refused unless CLAMAV_FAIL_OPEN=1.
 */
export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'error'; detail: string };

export function scannerConfigured() { return !!process.env.CLAMAV_HOST; }
export function scannerFailOpen() { return process.env.CLAMAV_FAIL_OPEN === '1'; }

const CHUNK = 64 * 1024;

export function scanBuffer(data: Buffer, opts: { host?: string; port?: number; tls?: boolean; timeoutMs?: number } = {}): Promise<ScanResult> {
  const host = opts.host ?? process.env.CLAMAV_HOST;
  const port = opts.port ?? Number(process.env.CLAMAV_PORT ?? 3310);
  const useTls = opts.tls ?? process.env.CLAMAV_TLS === '1';
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CLAMAV_TIMEOUT_MS ?? 15000);
  if (!host) return Promise.resolve({ status: 'error', detail: 'Scanner not configured' });
  return new Promise((resolve) => {
    let settled = false; let reply = '';
    const done = (r: ScanResult) => { if (!settled) { settled = true; sock.destroy(); resolve(r); } };
    const sock: net.Socket = useTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => done({ status: 'error', detail: 'Scanner timed out' }));
    sock.on('error', (e) => done({ status: 'error', detail: `Scanner unreachable (${(e as NodeJS.ErrnoException).code ?? e.message})` }));
    sock.on('data', (d) => { reply += d.toString('utf8'); if (reply.includes('\0') || reply.includes('\n')) finish(); });
    sock.on('end', () => finish());
    const finish = () => {
      const line = reply.replace(/\0/g, '').trim();
      if (/:\s*OK$/.test(line)) return done({ status: 'clean' });
      const found = line.match(/:\s*(.+)\s+FOUND$/);
      if (found) return done({ status: 'infected', signature: found[1] });
      return done({ status: 'error', detail: line ? `Scanner said: ${line.slice(0, 200)}` : 'No reply from scanner' });
    };
    sock.once(useTls ? 'secureConnect' : 'connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4); len.writeUInt32BE(part.length);
        sock.write(len); sock.write(part);
      }
      sock.write(Buffer.alloc(4));
    });
  });
}
