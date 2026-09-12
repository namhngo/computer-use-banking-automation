import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, ElementHandle, Frame, Locator, Page } from 'playwright';
import { bindText } from '../artifact/bindings.js';
import { targetSchema } from '../artifact/schema.js';
import type { Condition, Target } from '../artifact/schema.js';
import type { SafeSnapshot } from '../evidence/evidence.js';
import { authorizeAction, authorizeRequest } from '../policy/policy.js';
import type { Policy } from '../policy/policy.js';
import { SurfaceError } from './errors.js';
import { classifyHarborTarget, elementSignature, harborApp } from './harbor-profile.js';
import { startPolicyProxy } from './network.js';

type Inputs = Record<string, string | number | boolean>;
type Selector = NonNullable<Target['scope']>['frames'][number];
type Control = { handle: ElementHandle<Element>; frame: Frame; signature: string; epoch: number; strategyIndex: number };
export type SurfaceEvent = { type: string; action?: string; targetKey?: string; strategyIndex?: number; code?: string };
export type Observation = { generation: number; controls: Array<{ ref: string; tag: string; label: string; text: string; target: Target }> };

export class PlaywrightAdapter {
  private epoch = 0;
  private serial = 0;
  private readonly controls = new Map<string, Control>();
  private fatal: SurfaceError | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    /** Developer/operator access only. Never expose Page to model tools. */
    readonly page: Page,
    readonly origin: string,
    private readonly policy: Policy,
    private readonly proxy: Awaited<ReturnType<typeof startPolicyProxy>>,
    private readonly timeoutMs: number,
    private readonly deadline: number,
    private readonly onEvent?: (event: SurfaceEvent) => Promise<void>,
  ) {
    this.timer = setTimeout(() => {
      this.fail('RUN_TIMEOUT');
    }, Math.max(1, deadline - Date.now()));
    this.page.on('framenavigated', (frame) => {
      this.invalidate();
      if (frame.url() !== 'about:blank' && !this.allowed(frame.url())) this.fail('POLICY_BLOCKED');
    });
    this.page.on('dialog', (dialog) => {
      this.fail('UNEXPECTED_DIALOG');
      // Cancel, never accept. Real native-dialog handoff is a later phase.
      void dialog.dismiss().catch(() => {});
    });
    this.page.on('download', (download) => {
      this.fail('POLICY_BLOCKED');
      void download.cancel().catch(() => {});
    });
    this.context.on('page', (popup) => {
      this.fail('POLICY_BLOCKED');
      void popup.close().catch(() => {});
    });
  }

  static async create(options: {
    origin: string; policy: Policy; headless?: boolean; timeoutMs: number; deadline: number;
    onEvent?: (event: SurfaceEvent) => Promise<void>;
  }): Promise<PlaywrightAdapter> {
    if (options.policy.appId !== harborApp.appId || options.policy.appVersion !== harborApp.appVersion
      || !Number.isFinite(options.deadline) || options.deadline <= Date.now()
      || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new SurfaceError('POLICY_BLOCKED');
    let adapter: PlaywrightAdapter | undefined;
    let violation: string | undefined;
    let browser: Browser | undefined;
    const sessionToken = randomUUID().replaceAll('-', '');
    const proxy = await startPolicyProxy({
      policy: options.policy, origin: options.origin, timeoutMs: Math.max(1, options.deadline - Date.now()),
      sessionToken,
      onViolation: (code) => { violation ??= code; adapter?.fail(code); },
    });
    try {
      browser = await chromium.launch({
        headless: options.headless ?? true, proxy: { server: proxy.server, bypass: proxy.bypass },
        timeout: Math.max(1, options.deadline - Date.now()),
        args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
        extraHTTPHeaders: { 'x-automation-session': sessionToken } });
      context.on('request', (request) => {
        if (URL.parse(request.url())?.origin !== options.origin
          || !authorizeRequest(options.policy, { url: request.url(), method: request.method() }).allowed) {
          violation ??= 'POLICY_BLOCKED';
          adapter?.fail('POLICY_BLOCKED');
        }
      });
      context.on('response', (response) => {
        void response.headerValue('x-automation-denied').then((denied) => {
          if (denied) { violation ??= 'POLICY_BLOCKED'; adapter?.fail('POLICY_BLOCKED'); }
        }).catch(() => {});
      });
      await context.routeWebSocket('**/*', (socket) => {
        violation ??= 'POLICY_BLOCKED';
        adapter?.fail('POLICY_BLOCKED');
        void socket.close({ code: 1008, reason: 'Policy blocked' }).catch(() => {});
      });
      const page = await context.newPage();
      context.setDefaultTimeout(options.timeoutMs);
      adapter = new PlaywrightAdapter(browser, context, page, options.origin, options.policy, proxy,
        options.timeoutMs, options.deadline, options.onEvent);
      if (violation) adapter.fail(violation);
      adapter.health();
      return adapter;
    } catch {
      await browser?.close().catch(() => {});
      await proxy.close();
      throw new SurfaceError(violation ?? 'BROWSER_ERROR');
    }
  }

  private fail(code: string) {
    if (this.closed || this.fatal) return;
    this.fatal = new SurfaceError(code);
    this.invalidate();
    // Revoke transport first: an already-pending browser operation must not send another request.
    void this.proxy.close().catch(() => {});
    void this.context.close().catch(() => {});
  }
  health(): void {
    if (this.fatal) throw this.fatal;
    if (this.closed || this.page.isClosed()) throw new SurfaceError('SURFACE_CLOSED');
    if (Date.now() >= this.deadline) throw new SurfaceError('RUN_TIMEOUT');
  }
  private remaining() {
    this.health();
    return Math.max(1, Math.min(this.timeoutMs, this.deadline - Date.now()));
  }
  private allowed(url: string) {
    return URL.parse(url)?.origin === this.origin && authorizeRequest(this.policy, { url, method: 'GET' }).allowed;
  }
  private readable(frame: Frame) {
    this.health();
    if (frame.url() === 'about:blank') throw new SurfaceError('FRAME_NOT_FOUND');
    if (!this.allowed(frame.url())) { this.fail('POLICY_BLOCKED'); this.health(); }
  }
  private invalidate() {
    this.epoch++;
    for (const control of this.controls.values()) void control.handle.dispose().catch(() => {});
    this.controls.clear();
  }
  private selector(root: Frame | Locator, selector: Selector, inputs: Inputs): Locator {
    switch (selector.kind) {
      case 'role': return root.getByRole(selector.role, { name: bindText(selector.name, inputs), exact: true });
      case 'label': return root.getByLabel(bindText(selector.text, inputs), { exact: true });
      case 'text': return root.getByText(bindText(selector.text, inputs), { exact: true });
      case 'css': return root.locator(`css=${selector.selector}`);
    }
  }
  private async unique(locator: Locator, missingCode = 'TARGET_NOT_FOUND'): Promise<ElementHandle<Element>> {
    const count = await locator.count();
    if (count === 0) throw new SurfaceError(missingCode);
    if (count !== 1) throw new SurfaceError('AMBIGUOUS_TARGET');
    const handle = await locator.elementHandle({ timeout: this.remaining() });
    if (!handle) throw new SurfaceError(missingCode);
    return handle;
  }

  private async resolveElement(target: Target, inputs: Inputs): Promise<Control> {
    this.health();
    let frame = this.page.mainFrame();
    this.readable(frame);
    for (const selector of target.scope?.frames ?? []) {
      const element = await this.unique(this.selector(frame, selector, inputs), 'FRAME_NOT_FOUND');
      let child: Frame | null;
      try {
        if (!await element.evaluate((node) => node.tagName === 'IFRAME' || node.tagName === 'FRAME')) throw new SurfaceError('INVALID_TARGET');
        child = await element.contentFrame();
      } finally { await element.dispose(); }
      if (!child) throw new SurfaceError('FRAME_NOT_FOUND');
      frame = child;
      this.readable(frame);
    }
    const container = target.scope?.container ? this.selector(frame, target.scope.container, inputs) : undefined;
    if (container) {
      const handle = await this.unique(container);
      await handle.dispose();
    }
    const root = container ?? frame;
    for (let strategyIndex = 0; strategyIndex < target.strategies.length; strategyIndex++) {
      const strategy = target.strategies[strategyIndex]!;
      let locator: Locator;
      if (strategy.kind === 'table_cell') {
        const tables = container && await container.evaluate((element) => element.tagName === 'TABLE') ? container : root.locator('table');
        const count = await tables.count();
        if (count === 0) continue;
        if (count !== 1) throw new SurfaceError('AMBIGUOUS_TARGET');
        const rowLabel = bindText(strategy.row, inputs);
        const column = typeof strategy.column === 'number' ? strategy.column : bindText(strategy.column, inputs);
        const indices = await tables.locator('tr').evaluateAll((rows, args) => {
          const cells = rows.map((row) => Array.from(row.children).filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH'));
          const matches = cells.flatMap((row, index) => (row[0]?.textContent ?? '').replace(/\s+/g, ' ').trim() === args.rowLabel ? [index] : []);
          const columns = typeof args.column === 'number' ? [args.column - 1] : cells
            .filter((row) => row.length > 0 && row.every((cell) => cell.tagName === 'TH'))
            .flatMap((row) => row.flatMap((cell, index) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim() === args.column ? [index] : []));
          return { matches, columns };
        }, { rowLabel, column });
        if (indices.matches.length > 1 || indices.columns.length > 1) throw new SurfaceError('AMBIGUOUS_TARGET');
        if (indices.matches.length === 0 || indices.columns.length === 0) continue;
        locator = tables.locator('tr').nth(indices.matches[0]!).locator(':scope > td, :scope > th').nth(indices.columns[0]!);
      } else {
        locator = this.selector(root, strategy, inputs);
      }
      if (await locator.count() === 0) continue;
      const handle = await this.unique(locator);
      if (!await handle.isVisible()) { await handle.dispose(); continue; }
      if (!await handle.isEnabled()) { await handle.dispose(); continue; }
      if (await handle.ownerFrame() !== frame) { await handle.dispose(); throw new SurfaceError('INVALID_TARGET'); }
      return { handle, frame, signature: await elementSignature(handle), epoch: this.epoch, strategyIndex };
    }
    throw new SurfaceError('TARGET_NOT_FOUND');
  }

  async resolve(target: Target, inputs: Inputs): Promise<{ ref: string; strategyIndex: number }> {
    try {
      const control = await this.resolveElement(targetSchema.parse(target), inputs);
      const ref = `e${this.epoch}_${++this.serial}`;
      this.controls.set(ref, control);
      return { ref, strategyIndex: control.strategyIndex };
    } catch (error) {
      this.health();
      if (error instanceof SurfaceError) throw error;
      throw new SurfaceError('INVALID_TARGET');
    }
  }

  async navigate(path: string): Promise<void> {
    this.health();
    if (!/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path)) { this.fail('POLICY_BLOCKED'); this.health(); }
    const url = `${this.origin}${path}`;
    if (!authorizeAction(this.policy, { ...harborApp, url, action: 'navigate' }).allowed) { this.fail('POLICY_BLOCKED'); this.health(); }
    await this.onEvent?.({ type: 'action_authorized', action: 'navigate' });
    this.invalidate();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.remaining() });
      this.health();
      this.readable(this.page.mainFrame());
    } catch (error) {
      this.health();
      if (error instanceof SurfaceError) throw error;
      throw new SurfaceError('NAVIGATION_FAILED');
    }
  }

  async act(ref: string, action: 'click' | 'fill' | 'select' | 'extract', value?: string): Promise<string | undefined> {
    this.health();
    const control = this.controls.get(ref);
    if (!control || control.epoch !== this.epoch) throw new SurfaceError('STALE_REF');
    let revokePost: (() => void) | undefined;
    try {
      this.readable(control.frame);
      if (await elementSignature(control.handle) !== control.signature) throw new SurfaceError('STALE_REF');
      if (await this.unknownDialog()) throw new SurfaceError('UNEXPECTED_DIALOG');
      const targetKey = await classifyHarborTarget(control.handle, control.frame, this.origin);
      const decision = authorizeAction(this.policy, {
        ...harborApp, url: control.frame.url(), action, ...(targetKey === undefined ? {} : { targetKey }),
      });
      if (!decision.allowed || !targetKey) { this.fail('POLICY_BLOCKED'); throw new SurfaceError('POLICY_BLOCKED'); }
      await this.onEvent?.({ type: 'action_authorized', action, targetKey, strategyIndex: control.strategyIndex });
      this.health();
      if (await this.unknownDialog()) throw new SurfaceError('UNEXPECTED_DIALOG');
      if (await classifyHarborTarget(control.handle, control.frame, this.origin) !== targetKey) throw new SurfaceError('STALE_REF');
      if (control.epoch !== this.epoch || await elementSignature(control.handle) !== control.signature) throw new SurfaceError('STALE_REF');
      const timeout = this.remaining();
      let navigation: Promise<SurfaceError | undefined> | undefined;
      if (action === 'click') {
        const submission = await control.handle.evaluate((element) => {
          if (!(element instanceof HTMLButtonElement) || !element.form) return null;
          const form = element.form;
          const body = new URLSearchParams();
          new FormData(form, element).forEach((field, name) => {
            if (typeof field !== 'string') throw new Error('Unsupported form payload');
            body.append(name, field);
          });
          return { url: element.hasAttribute('formaction') ? element.formAction : form.action, body: body.toString() };
        });
        this.health();
        if (submission) revokePost = this.proxy.grantPost(submission.url, submission.body);
        // All click grants in the Harbor profile cause document navigation, including same-URL POSTs.
        navigation = control.frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout })
          .then(() => undefined, () => new SurfaceError('NAVIGATION_FAILED'));
      }
      // Guard and DOM dispatch share one browser task: no actionability retry can outlive authorization.
      const dispatched = await control.handle.evaluate((element, args) => {
        // Keep this guard identical to elementSignature; it never crosses the evidence boundary.
        const signature = JSON.stringify({
          connected: element.isConnected,
          html: element.outerHTML,
          document: element.ownerDocument.documentElement.outerHTML,
          url: element.ownerDocument.URL,
          parentUrl: element.ownerDocument.defaultView?.parent.location.href,
          values: element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement
            ? Array.from(element.form?.elements ?? []).map((field) => field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : null) : undefined,
        });
        const style = getComputedStyle(element);
        if (signature !== args.signature || !element.isConnected || element.getClientRects().length === 0
          || style.visibility === 'hidden' || style.display === 'none') return { code: 'STALE_REF' };
        if ((element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement)
          && element.disabled) return { code: 'STALE_REF' };
        if (args.action === 'click') {
          if (!(element instanceof HTMLElement)) return { code: 'INVALID_TARGET' };
          HTMLElement.prototype.click.call(element);
        } else if (args.action === 'fill') {
          if (!(element instanceof HTMLInputElement) || element.readOnly || args.value === undefined) return { code: 'INVALID_VALUE' };
          const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (!descriptor?.set) return { code: 'INVALID_TARGET' };
          descriptor.set.call(element, args.value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (args.action === 'select') {
          if (!(element instanceof HTMLSelectElement) || args.value === undefined
            || !Array.from(element.options).some((option) => option.value === args.value && !option.disabled)) return { code: 'INVALID_VALUE' };
          element.value = args.value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (args.action === 'extract') {
          return { text: (element.textContent ?? '').trim() };
        } else return { code: 'INVALID_ACTION' };
        return {};
      }, { action, value, signature: control.signature });
      if (dispatched.code) throw new SurfaceError(dispatched.code);
      if (navigation) {
        const failed = await navigation;
        if (failed) throw failed;
      }
      this.health();
      this.readable(this.page.mainFrame());
      return dispatched.text;
    } catch (error) {
      this.health();
      if (error instanceof SurfaceError) throw error;
      throw new SurfaceError('ACTION_FAILED');
    } finally { revokePost?.(); this.invalidate(); }
  }

  async checkCondition(condition: Condition, inputs: Inputs): Promise<boolean> {
    this.health();
    if ('conditions' in condition) {
      for (const child of condition.conditions) {
        const matches = await this.checkCondition(child, inputs);
        if (condition.kind === 'all' && !matches) return false;
        if (condition.kind === 'any' && matches) return true;
      }
      return condition.kind === 'all';
    }
    if (condition.kind === 'path_equals') {
      if (this.page.url() === 'about:blank') return false;
      this.readable(this.page.mainFrame());
      return new URL(this.page.url()).pathname === condition.path;
    }
    let control: Control | undefined;
    try {
      control = await this.resolveElement(condition.target, inputs);
      if (condition.kind === 'visible') return true;
      const text = (await control.handle.textContent() ?? '').replace(/\s+/g, ' ').trim();
      return text === bindText(condition.expected, inputs).replace(/\s+/g, ' ').trim();
    } catch (error) {
      this.health();
      if (error instanceof SurfaceError && ['TARGET_NOT_FOUND', 'FRAME_NOT_FOUND'].includes(error.code)) return false;
      if (error instanceof SurfaceError) throw error;
      throw new SurfaceError('CONDITION_FAILED');
    } finally { await control?.handle.dispose(); }
  }

  async authenticate(credentials: { username: string; password: string }): Promise<void> {
    await this.navigate('/login');
    const footer = this.page.locator('footer');
    if (await footer.count() !== 1 || !(await footer.textContent())?.includes('Harbor Core v1.0')) throw new SurfaceError('APP_MISMATCH');
    for (const [label, value] of [['Operator ID', credentials.username], ['Password', credentials.password]] as const) {
      const control = await this.resolve({ strategies: [{ kind: 'label', text: { source: 'literal', value: label } }] }, {});
      await this.act(control.ref, 'fill', value);
    }
    const submit = await this.resolve({ strategies: [{ kind: 'role', role: 'button', name: { source: 'literal', value: 'Sign in' } }] }, {});
    await this.act(submit.ref, 'click');
    if (!['/members/search', '/notice'].includes(new URL(this.page.url()).pathname)) throw new SurfaceError('AUTH_FAILED');
  }

  async unknownDialog(): Promise<boolean> {
    this.health();
    for (const frame of this.page.frames()) {
      if (frame.url() === 'about:blank') continue;
      this.readable(frame);
      const dialogs = frame.locator('[role="dialog"], [role="alertdialog"], dialog[open]');
      const known = frame.getByRole('dialog', { name: 'System notice', exact: true });
      for (const dialog of await dialogs.elementHandles()) {
        try {
          if (await dialog.isVisible() && (await known.count() !== 1
            || !await known.evaluate((node, actual) => node === actual, dialog))) return true;
        } finally { await dialog.dispose(); }
      }
    }
    return false;
  }

  async observe(): Promise<Observation> {
    this.health();
    this.invalidate();
    const generation = this.epoch;
    const controls: Observation['controls'] = [];
    for (const frame of this.page.frames()) {
      if (frame.url() === 'about:blank') continue;
      this.readable(frame);
      const frames: NonNullable<Target['scope']>['frames'] = [];
      for (let child = frame; child.parentFrame(); child = child.parentFrame()!) {
        if (frames.length === 4) throw new SurfaceError('OBSERVATION_LIMIT');
        const element = await child.frameElement();
        try {
          const selector = await element.evaluate((node) => {
            if (!(node instanceof Element)) throw new Error('Expected frame element');
            const tag = node.tagName.toLowerCase();
            if (node.id) return `${tag}#${CSS.escape(node.id)}`;
            const title = node.getAttribute('title');
            return title ? `${tag}[title="${CSS.escape(title)}"]` : tag;
          });
          if (await child.parentFrame()!.locator(`css=${selector}`).count() !== 1) throw new SurfaceError('AMBIGUOUS_TARGET');
          frames.unshift({ kind: 'css', selector });
        } finally { await element.dispose(); }
      }
      const scope = frames.length > 0 ? { frames } : undefined;
      // This fixed CSS query returns elements, never text/comment nodes.
      const elements = await frame.locator('input, button, select, a, td, th, h1, h2, [role]').elementHandles() as ElementHandle<Element>[];
      for (const handle of elements) {
        if (controls.length >= 200 || !await handle.isVisible()) { await handle.dispose(); continue; }
        const info = await handle.evaluate((element) => {
          const field = element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? element : null;
          const label = (field?.labels?.[0]?.textContent ?? element.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
          const row = element.closest('tr');
          const cells = row ? Array.from(row.children).filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH') : [];
          const column = cells.indexOf(element);
          const headers = Array.from(row?.closest('table')?.querySelectorAll('tr') ?? [])
            .filter((candidate) => candidate.cells.length > 0 && Array.from(candidate.cells).every((cell) => cell.tagName === 'TH'));
          return {
            tag: element.tagName.toLowerCase(), label, text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
            column, rowLabel: (cells[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            header: headers.length === 1 ? (headers[0]?.cells[column]?.textContent ?? '').replace(/\s+/g, ' ').trim() : '',
          };
        });
        const strategies: Target['strategies'] = [];
        if (info.tag === 'td' && info.column >= 0) {
          strategies.push({ kind: 'table_cell', row: { source: 'literal', value: info.rowLabel },
            column: info.header ? { source: 'literal', value: info.header } : info.column + 1 });
        } else {
          if (['button', 'a', 'h1', 'h2'].includes(info.tag)) {
            strategies.push({ kind: 'role', role: info.tag === 'button' ? 'button' : info.tag === 'a' ? 'link' : 'heading',
              name: { source: 'literal', value: info.label || info.text } });
          }
          if (info.label) strategies.push({ kind: 'label', text: { source: 'literal', value: info.label } });
          if (info.text) strategies.push({ kind: 'text', text: { source: 'literal', value: info.text } });
        }
        if (strategies.length === 0) { await handle.dispose(); continue; }
        const target: Target = { strategies, ...(scope ? { scope } : {}) };
        const ref = `e${generation}_${++this.serial}`;
        this.controls.set(ref, { handle, frame, signature: await elementSignature(handle), epoch: generation, strategyIndex: 0 });
        controls.push({ ref, tag: info.tag, label: info.label, text: info.text, target });
      }
    }
    if (generation !== this.epoch) throw new SurfaceError('STALE_REF');
    return { generation, controls };
  }

  async snapshot(): Promise<SafeSnapshot> {
    const frames: SafeSnapshot['frames'] = [];
    if (this.page.isClosed()) return { frames: [{ index: 0, allowed: false, path: '[unavailable]', nodes: [], truncated: true }] };
    for (const [index, frame] of this.page.frames().slice(0, 10).entries()) {
      const allowed = this.allowed(frame.url());
      let path = allowed ? new URL(frame.url()).pathname.replace(/\/[0-9]{5}(?=\/|$)/g, '/:memberId') : '[blocked]';
      if (!['/', '/login', '/members/search', '/members/:memberId', '/members/:memberId/accounts', '/notice', '[blocked]'].includes(path)) path = '[unavailable]';
      if (!allowed) { frames.push({ index, allowed, path, nodes: [], truncated: false }); continue; }
      try {
        const nodes = await frame.locator('body, body *').evaluateAll((elements) => {
          const tags = new Set(['body', 'main', 'header', 'footer', 'section', 'div', 'p', 'span', 'strong', 'h1', 'h2', 'form', 'input', 'label', 'button', 'select', 'option', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'iframe']);
          const roles = new Set(['alert', 'alertdialog', 'dialog', 'status', 'button', 'textbox', 'link', 'heading', 'row', 'cell', 'table', 'combobox']);
          return elements.slice(0, 300).map((element) => {
            const tag = element.tagName.toLowerCase();
            const role = element.getAttribute('role');
            return {
              tag: tags.has(tag) ? tag : 'other', role: role === null ? null : roles.has(role) ? role : 'other',
              visible: element.getClientRects().length > 0, childCount: element.children.length,
              textPresent: Boolean(element.textContent?.trim()),
              valuePresent: element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? Boolean(element.value) : false,
            };
          });
        });
        frames.push({ index, allowed, path, nodes, truncated: nodes.length === 300 });
      } catch { frames.push({ index, allowed: false, path: '[unavailable]', nodes: [], truncated: true }); }
    }
    return { frames };
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      clearTimeout(this.timer);
      this.invalidate();
      try { await this.browser.close(); } finally { await this.proxy.close(); }
    })();
    return this.closePromise;
  }
}
