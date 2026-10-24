import { watch } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSessionEvent } from './session-events.mjs';

// A native log is tailed only for an explicitly watched exact session. Directory
// notifications also cover atomic replacement. No history-wide scan or timer.
export async function watchJsonLines(filename, provider, { cursor, onEvent, onError }) {
  let info = await stat(filename), offset = cursor?.offset ?? info.size;
  let identity = `${info.dev}:${info.ino}`, state = cursor?.state ?? {};
  let closed = false, reading = false, pending = false;
  if (cursor && (cursor.identity !== identity || offset > info.size)) {
    offset = 0; state = {};
    onEvent([{ name: 'session.source.gap', sourceId: `replacement:${identity}`, scope: 'source' }]);
  }
  async function drain() {
    if (closed) return;
    if (reading) { pending = true; return; }
    reading = true;
    try {
      do {
        pending = false; info = await stat(filename);
        const current = `${info.dev}:${info.ino}`;
        if (current !== identity || info.size < offset) {
          identity = current; offset = 0; state = {};
          onEvent([{ name: 'session.source.gap', sourceId: `replacement:${identity}:${info.size}`, scope: 'source' }]);
        }
        if (info.size === offset) continue;
        const handle = await open(filename, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(1024 * 1024, info.size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          let start = 0; const events = [];
          for (let index = 0; index < bytesRead; index++) {
            if (buffer[index] !== 10) continue;
            const sourceId = `${identity}:${offset + start}`;
            const line = buffer.subarray(start, index).toString('utf8'); start = index + 1;
            try { events.push(...normalizeSessionEvent(provider, JSON.parse(line), sourceId, state)); }
            catch { events.push({ name: 'session.source.gap', sourceId, scope: 'source' }); }
          }
          if (start) {
            offset += start;
            onEvent(events, { identity, offset, state: structuredClone(state) });
            if (offset < info.size) pending = true;
          } else if (bytesRead >= 1024 * 1024) throw new Error('Native event line exceeded the 1 MiB observation bound.');
        } finally { await handle.close(); }
      } while (pending && !closed);
    } catch { if (!closed) { closed = true; watcher.close(); onError(); } }
    finally { reading = false; }
  }
  const watcher = watch(path.dirname(filename), { persistent: false }, (_event, name) => {
    if (!name || String(name) === path.basename(filename)) void drain();
  });
  watcher.on('error', () => { if (!closed) { closed = true; watcher.close(); onError(); } });
  // Persist the initial tail before returning. Existing messages are not new events.
  onEvent([], { identity, offset, state: structuredClone(state) });
  void drain();
  return async () => { closed = true; watcher.close(); };
}
