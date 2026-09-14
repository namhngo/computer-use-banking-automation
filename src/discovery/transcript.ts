import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { identifierSchema, targetSchema } from '../artifact/schema.js';
import { transcriptSchema } from './contracts.js';
import { createSecretGuard } from './privacy.js';

/** Bounded, symlink-refusing read of a saved transcript file. Returns raw JSON; callers validate. */
export async function readTranscriptFile(path: string): Promise<unknown> {
  const maxBytes = 1024 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Transcript too large.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error('Transcript too large.');
    return JSON.parse(buffer.toString('utf8', 0, size)) as unknown;
  } finally {
    await file.close();
  }
}

export async function writeTranscript(
  directory: string,
  transcript: unknown,
  options: {
    /** Declared input values by name. Any literal equal to one becomes an `input` binding. */
    inputs: Record<string, string>;
    secrets: readonly string[];
    sensitiveValues?: readonly string[];
    /** Policy-driven spelling of a path for evidence (identifiers -> `:id`, unknown -> `[unavailable]`). */
    canonicalPath: (path: string) => string;
  },
): Promise<'discovery.json'> {
  let content: string;
  try {
    const parsed = transcriptSchema.parse(transcript);
    const inputs = Object.entries(options.inputs);
    if (inputs.some(([name, value]) => !identifierSchema.safeParse(name).success || typeof value !== 'string' || value.length === 0 || value.length > 200)
      || (parsed.goal === null && (inputs.length > 0 || parsed.records.length > 0 || parsed.status === 'SUCCESS'
        || parsed.calls.some((call) => call.phase !== 'intent' || call.turn !== 0)))
      || (parsed.goal !== null && Object.keys(parsed.goal.inputs).sort().join(',') !== inputs.map(([name]) => name).sort().join(','))) throw new Error();
    const declared = new Set(parsed.goal ? [...Object.keys(parsed.goal.inputs), ...Object.keys(parsed.goal.outputs)] : []);
    const guard = createSecretGuard([...inputs.map(([, value]) => value), ...options.secrets, ...(options.sensitiveValues ?? [])]);
    const byValue = new Map(inputs.map(([name, value]) => [value, name]));

    function parameterize(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(parameterize);
      if (value === null || typeof value !== 'object') return value;
      const object = value as Record<string, unknown>;
      if (object.source === 'literal' && typeof object.value === 'string' && byValue.has(object.value)) return { source: 'input', name: byValue.get(object.value) };
      if (object.source === 'input' && !(typeof object.name === 'string' && object.name in options.inputs)) throw new Error();
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, parameterize(child)]));
    }

    for (const record of parsed.records) {
      // The dispatcher must omit proposals on failure; status is not proof of dispatch here.
      if (record.status !== 'succeeded' && [record.target, record.effect, record.value, record.path, record.framePath]
        .some((value) => value !== undefined)) throw new Error();
      if (record.name !== undefined && (record.tool !== 'extract' || !declared.has(record.name))) throw new Error();
      if (record.target) record.target = targetSchema.parse(parameterize(record.target));
      if (record.value) {
        if (record.tool !== 'fill') throw new Error();
        if (record.value.source === 'literal' && byValue.has(record.value.value)) {
          record.value = { source: 'input', name: byValue.get(record.value.value)! };
        }
        if (record.value.source !== 'input' || !(record.value.name in options.inputs)) throw new Error();
      }
      for (const key of ['path', 'framePath'] as const) {
        const path = record[key];
        if (path === undefined) continue;
        // Only a plain pathname is ever recorded; anything with a query, fragment or escape is refused, not trimmed.
        if (!/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path)) throw new Error();
        const canonical = options.canonicalPath(path);
        if (canonical === '[unavailable]' || canonical === '[blocked]') throw new Error();
        record[key] = canonical;
      }
    }

    // A description may echo the user's words; the value itself never reaches disk.
    if (parsed.goal) {
      parsed.goal.description = guard.redact(parsed.goal.description);
      for (const field of [...Object.values(parsed.goal.inputs), ...Object.values(parsed.goal.outputs)]) field.description = guard.redact(field.description);
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
