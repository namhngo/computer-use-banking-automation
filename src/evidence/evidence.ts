import { constants } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const identifier = z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const eventSchema = z.strictObject({
  type: identifier,
  phase: identifier.optional(),
  stepId: identifier.optional(),
  action: identifier.optional(),
  effect: identifier.optional(),
  strategyIndex: z.int().nonnegative().optional(),
  code: identifier.optional(),
  attempt: z.int().positive().optional(),
  outcome: identifier.optional(),
  durationMs: z.number().nonnegative().optional(),
});

const tagSchema = z.enum([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col',
  'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl',
  'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i',
  'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main',
  'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small',
  'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr',
  'track', 'u', 'ul', 'var', 'video', 'wbr', 'other',
]);
const roleSchema = z.enum([
  'alert', 'alertdialog', 'application', 'article', 'associationlist',
  'associationlistitemkey', 'associationlistitemvalue', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'comment', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
  'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid',
  'gridcell', 'group', 'heading', 'image', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none',
  'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio',
  'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript',
  'suggestion', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel',
  'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid',
  'treeitem', 'other',
]);
/**
 * Canonical page path: identifiers are spelled `:id`, never a real value. A segment made only of
 * digits is refused here as a last line of defence; unknown routes arrive as `[unavailable]`.
 */
export const evidencePathSchema = z.string().max(250)
  .regex(/^(?:\/|(?:\/(?:(?![0-9]+(?:\/|$))[A-Za-z0-9_-]+|:id))+|\[blocked\]|\[unavailable\])$/);
const pathSchema = evidencePathSchema;
const snapshotSchema = z.strictObject({
  frames: z.array(z.strictObject({
    index: z.int().nonnegative(),
    allowed: z.boolean(),
    path: pathSchema,
    nodes: z.array(z.strictObject({
      tag: tagSchema,
      role: roleSchema.nullable(),
      visible: z.boolean(),
      childCount: z.int().nonnegative(),
      textPresent: z.boolean(),
      valuePresent: z.boolean(),
    })).max(300),
    truncated: z.boolean(),
  })).max(10),
});

const interventionStateSchema = z.enum(['waiting', 'human_control', 'validating', 'resumed', 'aborted', 'expired']);
const timestamp = z.iso.datetime();
const interventionSchema = z.strictObject({
  id: identifier,
  runId: identifier,
  stepId: identifier,
  reason: identifier,
  path: pathSchema,
  createdAt: timestamp,
  closedAt: timestamp,
  state: interventionStateSchema,
  operatorId: identifier.optional(),
  transitions: z.array(z.strictObject({ state: interventionStateSchema, at: timestamp, code: identifier.optional() })).max(40),
  humanActions: z.array(z.strictObject({
    action: identifier, effect: identifier, outcome: identifier, path: pathSchema, at: timestamp,
  })).max(200),
});
export type InterventionRecord = z.infer<typeof interventionSchema>;

// Strings are accepted at the adapter boundary, then checked against the enums above.
export type SafeSnapshot = {
  frames: Array<{
    index: number;
    allowed: boolean;
    path: string;
    nodes: Array<{
      tag: string;
      role: string | null;
      visible: boolean;
      childCount: number;
      textPresent: boolean;
      valuePresent: boolean;
    }>;
    truncated: boolean;
  }>;
};

export class EvidenceSink {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private snapshotCount = 0;
  private interventionCount = 0;
  private readonly filenames = ['events.jsonl'];

  private constructor(
    readonly directory: string,
    private readonly runId: string,
    private sensitivePattern: RegExp | undefined,
  ) {}

  private static compilePattern(values: readonly string[]): RegExp | undefined {
    const checked = z.array(z.string().max(4096)).max(100).parse(values);
    if (checked.reduce((total, value) => total + value.length, 0) > 16384) throw new Error();
    const variants = new Set<string>();
    for (const value of checked) {
      if (!value) continue;
      const json = JSON.stringify(value).slice(1, -1);
      const unicode = value.split('').map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      for (const variant of [
        value, json, JSON.stringify(json).slice(1, -1), json.replaceAll('/', '\\/'),
        unicode, unicode.replace(/[a-f]/g, (char) => char.toUpperCase()),
        encodeURIComponent(value), encodeURIComponent(encodeURIComponent(value)),
      ]) variants.add(variant);
    }
    return variants.size === 0 ? undefined : new RegExp(
      [...variants].sort((a, b) => b.length - a.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g',
    );
  }

  static async create(options: {
    root?: string;
    runId: string;
    sensitiveValues?: readonly string[];
  }): Promise<EvidenceSink> {
    try {
      const runId = z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).parse(options.runId);
      const pattern = EvidenceSink.compilePattern(options.sensitiveValues ?? []);
      const root = resolve(options.root ?? 'artifacts/runs');
      const directory = resolve(root, runId);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      await writeFile(resolve(directory, 'events.jsonl'), '', { flag: 'wx', mode: 0o600 });
      return new EvidenceSink(directory, runId, pattern);
    } catch {
      // Filesystem and validation errors can expose private paths or rejected input.
      throw new Error('Unable to create evidence.');
    }
  }

  /** Values learned after the sink was opened (e.g. the inputs a model declared) are redacted from then on. */
  addSensitiveValues(values: readonly string[]): void {
    const known = this.sensitivePattern?.source;
    const added = EvidenceSink.compilePattern(values);
    if (!added) return;
    this.sensitivePattern = known ? new RegExp(`${added.source}|${known}`, 'g') : added;
  }

  get files(): string[] {
    return [...this.filenames];
  }

  private serialize(input: unknown): string {
    let remaining = 25000;
    const sanitize = (value: unknown, depth: number, key?: string): unknown => {
      if (--remaining < 0 || depth > 8) throw new Error();
      if (typeof value === 'string') {
        if (value.length > 512) throw new Error();
        const redacted = this.sensitivePattern ? value.replace(this.sensitivePattern, '[REDACTED]') : value;
        if (redacted !== value) {
          // Preserve the structural vocabulary even when a secret overlaps a safe token.
          if (key === 'tag' || key === 'role') return 'other';
          if (key === 'path') return '[unavailable]';
        }
        return redacted;
      }
      if (Array.isArray(value)) return value.map((child: unknown) => sanitize(child, depth + 1));
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([name, child]: [string, unknown]) =>
          [name, sanitize(child, depth + 1, name)]));
      }
      return value;
    };
    return JSON.stringify(sanitize(input, 0));
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(write).catch(() => {
      // Keep the queue rejected: later writes and close must also fail closed.
      throw new Error('Unable to write evidence.');
    });
    return this.queue;
  }

  async event(input: unknown): Promise<void> {
    if (this.closed) throw new Error('Evidence sink is closed.');
    let line: string;
    try {
      const event = eventSchema.parse(input);
      line = `${this.serialize({ ...event, ts: new Date().toISOString(), runId: this.runId })}\n`;
    } catch {
      throw new Error('Invalid evidence event.');
    }
    return this.enqueue(() => appendFile(resolve(this.directory, 'events.jsonl'), line, {
      // Never recreate a missing log or follow a substituted symlink.
      flag: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    }));
  }

  async snapshot(snapshot: SafeSnapshot): Promise<string> {
    if (this.closed) throw new Error('Evidence sink is closed.');
    if (this.snapshotCount >= 10) throw new Error('Evidence snapshot limit reached.');
    let content: string;
    try {
      content = this.serialize(snapshotSchema.parse(snapshot));
    } catch {
      throw new Error('Invalid evidence snapshot.');
    }
    const filename = `snapshot_${++this.snapshotCount}.json`;
    await this.enqueue(async () => {
      await writeFile(resolve(this.directory, filename), content, { flag: 'wx', mode: 0o600 });
      this.filenames.push(filename);
    });
    return filename;
  }

  /** The audit record of one handoff. Structural only: no typed values, URLs, or operator notes. */
  async intervention(record: InterventionRecord): Promise<string> {
    if (this.closed) throw new Error('Evidence sink is closed.');
    if (this.interventionCount >= 5) throw new Error('Evidence intervention limit reached.');
    let content: string;
    try {
      content = this.serialize(interventionSchema.parse(record));
    } catch {
      throw new Error('Invalid evidence intervention.');
    }
    const filename = `intervention_${++this.interventionCount}.json`;
    await this.enqueue(async () => {
      await writeFile(resolve(this.directory, filename), content, { flag: 'wx', mode: 0o600 });
      this.filenames.push(filename);
    });
    return filename;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
