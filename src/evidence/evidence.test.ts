import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceSink, type SafeSnapshot } from './evidence.js';

function snapshot(): SafeSnapshot {
  return {
    frames: [{
      index: 0, allowed: true, path: '/members/:memberId/accounts', truncated: false,
      nodes: [{ tag: 'input', role: 'textbox', visible: true, childCount: 0, textPresent: false, valuePresent: true }],
    }],
  };
}

describe('EvidenceSink', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evidence-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes ordered, complete JSONL events and flushes concurrent writes on close', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run_123' });
    expect(sink.files).toEqual(['events.jsonl']);
    expect(await readFile(join(sink.directory, 'events.jsonl'), 'utf8')).toBe('');
    const writes = Array.from({ length: 100 }, (_, strategyIndex) => sink.event({
      type: 'STEP_ATTEMPT', phase: 'replay', stepId: 'open_accounts', action: 'click',
      targetKey: 'accountsTab', strategyIndex, code: 'SUCCESS', attempt: 1,
      outcome: 'completed', durationMs: 0.25,
    }));
    await sink.close();
    await Promise.all(writes);
    const text = await readFile(join(sink.directory, 'events.jsonl'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const events = text.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(100);
    for (const [index, event] of events.entries()) {
      expect(event).toEqual({
        type: 'STEP_ATTEMPT', phase: 'replay', stepId: 'open_accounts', action: 'click',
        targetKey: 'accountsTab', strategyIndex: index, code: 'SUCCESS', attempt: 1,
        outcome: 'completed', durationMs: 0.25, runId: 'run_123', ts: expect.any(String) as unknown,
      });
      expect(new Date(event.ts as string).toISOString()).toBe(event.ts);
    }
    await sink.close();
    await expect(sink.event({ type: 'late' })).rejects.toThrow('Evidence sink is closed.');
    await expect(sink.snapshot(snapshot())).rejects.toThrow('Evidence sink is closed.');
  });

  it.each([
    'text', 'payload', 'value', 'values', 'input', 'inputs', 'output', 'outputs',
    'url', 'urls', 'error', 'errors', 'message', 'ts', 'runId', 'private_payload',
  ])('rejects the unknown event field %s without echoing it', async (field) => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await expect(sink.event({ type: 'failure', [field]: `private-secret ${root}` }))
      .rejects.toThrow(new Error('Invalid evidence event.'));
    await sink.close();
    expect(await readFile(join(sink.directory, 'events.jsonl'), 'utf8')).toBe('');
  });

  it.each([
    null, [], 'private-secret', new Error('private-secret'), {},
    { type: '' }, { type: 'contains private text' }, { type: 'https://private.test' },
    { type: 'line\nbreak' }, { type: 'a'.repeat(65) }, { type: '12345' },
    { type: 'ok', phase: null }, { type: 'ok', stepId: {} },
    { type: 'ok', action: 'click/private' }, { type: 'ok', targetKey: 'member@private.test' },
    { type: 'ok', code: 'private-error!' }, { type: 'ok', outcome: 'not complete' },
    { type: 'ok', strategyIndex: -1 }, { type: 'ok', strategyIndex: 0.1 },
    { type: 'ok', strategyIndex: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'ok', attempt: 0 }, { type: 'ok', attempt: 1.5 },
    { type: 'ok', durationMs: -1 }, { type: 'ok', durationMs: Infinity },
    { type: 'ok', durationMs: NaN }, { type: 'ok', durationMs: '1' },
  ])('rejects malformed event metadata %#', async (input) => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await expect(sink.event(input)).rejects.toThrow(new Error('Invalid evidence event.'));
    await sink.close();
  });

  it('sanitizes thrown getters rather than exposing their errors', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await expect(sink.event({ get type() { throw new Error(`private-secret ${root}`); } }))
      .rejects.toThrow(new Error('Invalid evidence event.'));
    await sink.close();
  });

  it('redacts known values recursively, including run metadata and overlapping structural tokens', async () => {
    const secrets = ['operatorSecret', 'member12345', 'privateRun', 'input', 'textbox', 'memberId'];
    const sink = await EvidenceSink.create({ root, runId: 'privateRun', sensitiveValues: secrets });
    await sink.event({ type: 'step', stepId: 'operatorSecret_member12345', durationMs: 0 });
    const filename = await sink.snapshot(snapshot());
    await sink.close();
    const log = await readFile(join(sink.directory, 'events.jsonl'), 'utf8');
    const structural = await readFile(join(sink.directory, filename), 'utf8');
    for (const secret of secrets) expect(log + structural).not.toContain(secret);
    expect(JSON.parse(log)).toMatchObject({ runId: '[REDACTED]', stepId: '[REDACTED]_[REDACTED]' });
    expect(JSON.parse(structural)).toEqual({ frames: [{
      ...snapshot().frames[0], path: '[unavailable]',
      nodes: [{ ...snapshot().frames[0]!.nodes[0], tag: 'other', role: 'other' }],
    }] });
  });

  it('rejects raw and commonly encoded secrets in text-bearing fields before persistence', async () => {
    const secret = 'private/"credential\\\n';
    const sink = await EvidenceSink.create({ root, runId: 'run', sensitiveValues: [secret] });
    const json = JSON.stringify(secret).slice(1, -1);
    for (const value of [secret, json, JSON.stringify(json).slice(1, -1), encodeURIComponent(secret), '\\u0070rivate']) {
      await expect(sink.event({ type: value })).rejects.toThrow(new Error('Invalid evidence event.'));
      await expect(sink.snapshot({ frames: [{ ...snapshot().frames[0]!, path: value }] }))
        .rejects.toThrow(new Error('Invalid evidence snapshot.'));
    }
    await sink.close();
    expect(await readFile(join(sink.directory, 'events.jsonl'), 'utf8')).toBe('');
    expect(await readdir(sink.directory)).toEqual(['events.jsonl']);
  });

  it('copies sensitive values and event/snapshot data before writes are queued', async () => {
    const sensitiveValues = ['privateSecret'];
    const sink = await EvidenceSink.create({ root, runId: 'run', sensitiveValues });
    sensitiveValues.length = 0;
    const event = { type: 'step', stepId: 'privateSecret' };
    const data = snapshot();
    const eventWrite = sink.event(event);
    const snapshotWrite = sink.snapshot(data);
    event.type = 'mutated';
    data.frames[0]!.path = '/private-secret';
    await Promise.all([eventWrite, snapshotWrite, sink.close()]);
    expect(JSON.parse(await readFile(join(sink.directory, 'events.jsonl'), 'utf8')))
      .toMatchObject({ type: 'step', stepId: '[REDACTED]' });
    expect(JSON.parse(await readFile(join(sink.directory, 'snapshot_1.json'), 'utf8'))).toEqual(snapshot());
  });

  it('writes only generated snapshot filenames and returns an independent files list', async () => {
    const sink = await EvidenceSink.create({ root: join(root, 'nested', 'runs'), runId: 'run' });
    const initial = sink.files;
    initial.push('private-file');
    const filenames = await Promise.all(Array.from({ length: 10 }, () => sink.snapshot(snapshot())));
    expect(filenames).toEqual(Array.from({ length: 10 }, (_, index) => `snapshot_${index + 1}.json`));
    const files = sink.files;
    files.splice(0, files.length);
    expect(sink.files).toEqual(['events.jsonl', ...filenames]);
    expect(initial).toEqual(['events.jsonl', 'private-file']);
    await expect(sink.snapshot(snapshot())).rejects.toThrow('Evidence snapshot limit reached.');
    await sink.close();
    expect((await readdir(sink.directory)).sort()).toEqual(sink.files.sort());
    for (const filename of filenames) {
      expect(JSON.parse(await readFile(join(sink.directory, filename), 'utf8'))).toEqual(snapshot());
    }
  });

  it('enforces the snapshot budget even for simultaneous calls', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => sink.snapshot(snapshot())));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    expect(results[10]).toEqual({ status: 'rejected', reason: new Error('Evidence snapshot limit reached.') });
    await sink.close();
    expect(sink.files).toHaveLength(11);
  });

  it.each([
    { text: 'private-secret' }, { value: 'private-secret' }, { attributes: { id: 'private-secret' } },
    { tag: 'private-secret' }, { role: 'private-secret' }, { role: 'button private-secret' },
    { tag: 'DIV' }, { role: '' }, { visible: 'yes' }, { childCount: -1 },
    { childCount: 1.5 }, { textPresent: 'private-secret' }, { valuePresent: null },
  ])('rejects unsafe or malformed snapshot nodes %#', async (fields) => {
    const sink = await EvidenceSink.create({ root, runId: 'run', sensitiveValues: ['private-secret'] });
    const input = snapshot();
    Object.assign(input.frames[0]!.nodes[0]!, fields);
    await expect(sink.snapshot(input)).rejects.toThrow(new Error('Invalid evidence snapshot.'));
    await sink.close();
    expect(await readdir(sink.directory)).toEqual(['events.jsonl']);
  });

  it.each([
    { path: '/members/12345' }, { path: '/members/12345/accounts' },
    { path: 'http://localhost/login' }, { path: '/login?password=private-secret' },
    { path: '/login#private-secret' }, { path: '/unknown' }, { path: '/members/%3AmemberId' },
    { index: -1 }, { index: 0.5 }, { allowed: 'true' }, { truncated: null },
    { text: 'private-secret' }, { url: 'http://private.test' },
  ])('rejects unsafe or malformed snapshot frames %#', async (fields) => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    const input = snapshot();
    Object.assign(input.frames[0]!, fields);
    await expect(sink.snapshot(input)).rejects.toThrow(new Error('Invalid evidence snapshot.'));
    await sink.close();
  });

  it('rejects unknown top-level snapshot fields, missing fields, and excessive counts', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    for (const input of [
      null, {}, { frames: [], text: 'private-secret' }, { frames: [{ index: 0 }] },
      { frames: Array.from({ length: 11 }, () => snapshot().frames[0]) },
      { frames: [{ ...snapshot().frames[0], nodes: Array.from({ length: 301 }, () => snapshot().frames[0]!.nodes[0]) }] },
    ]) {
      await expect(sink.snapshot(input as SafeSnapshot)).rejects.toThrow(new Error('Invalid evidence snapshot.'));
    }
    expect(await sink.snapshot({ frames: [] })).toBe('snapshot_1.json');
    await sink.close();
  });

  it('accepts all canonical paths and maximum bounded structural data', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    const paths = ['/', '/login', '/members/search', '/members/:memberId', '/members/:memberId/accounts', '/notice', '[blocked]', '[unavailable]'];
    const input = { frames: Array.from({ length: 10 }, (_, index) => ({
      ...snapshot().frames[0]!, index, allowed: index < 6, path: paths[index % paths.length]!, truncated: true,
      nodes: Array.from({ length: 300 }, (_, nodeIndex) => ({
        ...snapshot().frames[0]!.nodes[0]!, tag: 'other', role: nodeIndex % 2 === 0 ? null : 'other',
      })),
    })) };
    const filename = await sink.snapshot(input);
    await sink.close();
    expect(JSON.parse(await readFile(join(sink.directory, filename), 'utf8'))).toEqual(input);
  });

  it('creates private run directories and files', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await sink.event({ type: 'started', strategyIndex: 0, durationMs: 0 });
    await sink.snapshot(snapshot());
    await sink.close();
    expect((await stat(sink.directory)).mode & 0o777).toBe(0o700);
    for (const filename of sink.files) expect((await stat(join(sink.directory, filename))).mode & 0o777).toBe(0o600);
  });

  it('fails generically on duplicate runs without changing existing evidence', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await sink.event({ type: 'started' });
    await sink.close();
    const before = await readFile(join(sink.directory, 'events.jsonl'), 'utf8');
    await expect(EvidenceSink.create({ root, runId: 'run' })).rejects.toThrow(new Error('Unable to create evidence.'));
    expect(await readFile(join(sink.directory, 'events.jsonl'), 'utf8')).toBe(before);
  });

  it.each(['', '.', '..', '../private', 'nested/run', '/absolute', 'nested\\run', 'run\n', 'run\0', '%2e%2e', 'a'.repeat(129)])(
    'rejects invalid run IDs %# before filesystem changes', async (runId) => {
      await expect(EvidenceSink.create({ root, runId })).rejects.toThrow(new Error('Unable to create evidence.'));
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('bounds sensitive-value configuration without leaking rejected values', async () => {
    for (const sensitiveValues of [Array<string>(101).fill('private-secret'), ['x'.repeat(4097)], Array<string>(5).fill('x'.repeat(4096))]) {
      await expect(EvidenceSink.create({ root, runId: 'run', sensitiveValues }))
        .rejects.toThrow(new Error('Unable to create evidence.'));
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('sanitizes filesystem creation failures', async () => {
    const privatePath = join(root, 'private-secret');
    await writeFile(privatePath, 'existing');
    await expect(EvidenceSink.create({ root: privatePath, runId: 'run' }))
      .rejects.toThrow(new Error('Unable to create evidence.'));
  });

  it('never overwrites an existing snapshot and keeps subsequent writes and close rejected', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await writeFile(join(sink.directory, 'snapshot_1.json'), 'existing');
    await expect(sink.snapshot(snapshot())).rejects.toThrow(new Error('Unable to write evidence.'));
    await expect(sink.event({ type: 'later' })).rejects.toThrow(new Error('Unable to write evidence.'));
    await expect(sink.snapshot(snapshot())).rejects.toThrow(new Error('Unable to write evidence.'));
    await expect(sink.close()).rejects.toThrow(new Error('Unable to write evidence.'));
    expect(sink.files).toEqual(['events.jsonl']);
    expect(await readFile(join(sink.directory, 'snapshot_1.json'), 'utf8')).toBe('existing');
    expect(await readFile(join(sink.directory, 'events.jsonl'), 'utf8')).toBe('');
    expect(await readdir(sink.directory)).not.toContain('snapshot_2.json');
  });

  it('fails closed if the event log disappears instead of silently recreating it', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    await rm(join(sink.directory, 'events.jsonl'));
    const writes = [sink.event({ type: 'first' }), sink.event({ type: 'second' })];
    const results = await Promise.allSettled([...writes, sink.close()]);
    for (const result of results) expect(result).toEqual({ status: 'rejected', reason: new Error('Unable to write evidence.') });
    expect(await readdir(sink.directory)).toEqual([]);
  });

  it('does not follow substituted event-log symlinks', async () => {
    const sink = await EvidenceSink.create({ root, runId: 'run' });
    const target = join(root, 'private-target');
    await writeFile(target, 'existing');
    await rm(join(sink.directory, 'events.jsonl'));
    await symlink(target, join(sink.directory, 'events.jsonl'));
    await expect(sink.event({ type: 'started' })).rejects.toThrow(new Error('Unable to write evidence.'));
    await expect(sink.close()).rejects.toThrow(new Error('Unable to write evidence.'));
    expect(await readFile(target, 'utf8')).toBe('existing');
  });
});
