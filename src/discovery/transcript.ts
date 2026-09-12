import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { targetSchema } from '../artifact/schema.js';
import { transcriptSchema } from './contracts.js';
import { createSecretGuard } from './privacy.js';

export async function writeTranscript(
  directory: string,
  transcript: unknown,
  options: { inputs: { memberId?: string }; secrets: readonly string[]; sensitiveValues?: readonly string[] },
): Promise<'discovery.json'> {
  let content: string;
  try {
    const parsed = transcriptSchema.parse(transcript);
    const { memberId } = options.inputs;
    if ((memberId !== undefined && !/^[0-9]{5}$/.test(memberId))
      || (memberId === undefined && (parsed.records.length > 0 || parsed.status === 'SUCCESS'
        || parsed.calls.some((call) => call.phase !== 'intent' || call.turn !== 0)))) throw new Error();
    const guard = createSecretGuard([...(memberId ? [memberId] : []), ...options.secrets, ...(options.sensitiveValues ?? [])]);
    const paths = new Set([
      '/', '/login', '/members/search', '/members/:memberId',
      '/members/:memberId/accounts', '/notice', '[unavailable]', '[blocked]',
    ]);

    function parameterize(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(parameterize);
      if (value === null || typeof value !== 'object') return value;
      const object = value as Record<string, unknown>;
      if (memberId !== undefined && object.source === 'literal' && object.value === memberId) return { source: 'input', name: 'memberId' };
      if (object.source === 'input' && object.name !== 'memberId') throw new Error();
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, parameterize(child)]));
    }

    for (const record of parsed.records) {
      // The dispatcher must omit proposals on failure; status is not proof of dispatch here.
      if (record.status !== 'succeeded' && [record.target, record.targetKey, record.value, record.path, record.framePath]
        .some((value) => value !== undefined)) throw new Error();
      if (record.target) record.target = targetSchema.parse(parameterize(record.target));
      if (record.value) {
        if (record.tool !== 'fill') throw new Error();
        if (record.value.source === 'literal' && record.value.value === memberId) {
          record.value = { source: 'input', name: 'memberId' };
        }
        if (record.value.source !== 'input' || record.value.name !== 'memberId') throw new Error();
      }
      for (const key of ['path', 'framePath'] as const) {
        const path = record[key];
        if (path === undefined) continue;
        const canonical = path.replace(/^\/members\/([0-9]+)(?=\/|$)/, (_match, segment: string) => {
          if (segment !== memberId) throw new Error();
          return '/members/:memberId';
        });
        if (!paths.has(canonical)) throw new Error();
        record[key] = canonical;
      }
    }

    function checkStrings(value: unknown): void {
      if (typeof value === 'string') {
        if (guard.contains(value)) throw new Error();
      } else if (Array.isArray(value)) {
        value.forEach(checkStrings);
      } else if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(checkStrings);
      }
      // Numeric leaves are counters/indices, not data. Opaque string IDs are checked
      // conservatively even when a short member ID happens to occur by coincidence.
    }
    checkStrings(parsed);
    content = `${JSON.stringify(transcriptSchema.parse(parsed))}\n`;
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error();
  } catch {
    throw new Error('TRANSCRIPT_UNSAFE');
  }

  try {
    // EvidenceSink owns the already-private directory; this is not a filesystem sandbox.
    const temporary = join(directory, `.discovery-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.chmod(0o600);
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, join(directory, 'discovery.json'));
    } finally {
      await unlink(temporary);
    }
    return 'discovery.json';
  } catch {
    // Do not attach filesystem causes: they can contain private directory names.
    throw new Error('TRANSCRIPT_WRITE_FAILED');
  }
}
