import type { ElementHandle, Frame, Locator } from 'playwright';

export const harborApp = { appId: 'harbor_core', appVersion: '1.0' } as const;

/** Match the actual node, not a model-provided label or targetKey. */
export async function classifyHarborTarget(handle: ElementHandle<Element>, frame: Frame, origin: string): Promise<string | undefined> {
  const url = new URL(frame.url());
  if (url.origin !== origin) return undefined;
  const details = await handle.evaluate((element) => {
    const control = element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement ? element : null;
    const form = control?.form;
    const submitter = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : null;
    const link = element instanceof HTMLAnchorElement ? element : null;
    const row = element.closest('tr');
    const cells = row ? Array.from(row.children).filter((cell) => /^(TD|TH)$/.test(cell.tagName)) : [];
    const column = cells.indexOf(element);
    const table = row?.closest('table');
    const headers = table ? Array.from(table.querySelectorAll('tr')).filter((candidate) =>
      candidate.cells.length > 0 && Array.from(candidate.cells).every((cell) => cell.tagName === 'TH')) : [];
    return {
      connected: element.isConnected, tag: element.tagName, text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      type: control && 'type' in control ? control.type : '',
      name: control?.name ?? '',
      destination: link?.href ?? (submitter?.hasAttribute('formaction') ? submitter.formAction : form?.action) ?? '',
      method: submitter?.hasAttribute('formmethod') ? submitter.formMethod : form?.method ?? '',
      target: link?.target ?? (submitter?.hasAttribute('formtarget') ? submitter.formTarget : form?.target) ?? '',
      download: link?.hasAttribute('download') ?? false,
      fieldNames: form ? Array.from(form.elements).filter((field) => field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)
        .map((field) => (field as HTMLInputElement).name).sort().join(',') : '',
      firstCell: (cells[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(), column,
      header: headers.length === 1 ? (headers[0]?.cells[column]?.textContent ?? '').replace(/\s+/g, ' ').trim() : '',
    };
  });
  if (!details.connected || !['', '_self'].includes(details.target) || details.download) return undefined;

  const sameNode = async (candidate: Locator) => {
    if (await candidate.count() !== 1) return false;
    return candidate.evaluate((element, actual) => element === actual, handle);
  };
  const formMatches = (path: string, fields: string) => details.destination === `${origin}${path}`
    && details.method.toLowerCase() === 'post' && details.fieldNames === fields
    && (details.tag !== 'BUTTON' || details.name === '');

  if (url.pathname === '/login' && formMatches('/login', 'password,username')) {
    if (details.tag === 'INPUT' && details.name === 'username' && details.type === 'text'
      && await sameNode(frame.getByLabel('Operator ID', { exact: true }))) return 'login_operator';
    if (details.tag === 'INPUT' && details.name === 'password' && details.type === 'password'
      && await sameNode(frame.getByLabel('Password', { exact: true }))) return 'login_password';
    if (details.tag === 'BUTTON' && details.type === 'submit'
      && await sameNode(frame.getByRole('button', { name: 'Sign in', exact: true }))) return 'sign_in';
  }
  if (url.pathname === '/members/search') {
    if (formMatches('/members/search', 'memberId')) {
      if (details.tag === 'INPUT' && details.name === 'memberId' && details.type === 'text'
        && await sameNode(frame.getByLabel('Member ID', { exact: true }))) return 'member_id';
      if (details.tag === 'BUTTON' && details.type === 'submit'
        && await sameNode(frame.getByRole('button', { name: 'Search', exact: true }))) return 'search_member';
    }
    if (formMatches('/logout', '') && details.tag === 'BUTTON' && details.type === 'submit'
      && await sameNode(frame.getByRole('button', { name: 'Sign out', exact: true }))) return 'sign_out';
    const destination = URL.parse(details.destination);
    if (details.tag === 'A' && destination?.origin === origin && !destination.username && !destination.password && !destination.search && !destination.hash
      && /^\/members\/[0-9]{5}$/.test(destination.pathname)
      && await sameNode(frame.getByRole('link', { name: 'View member', exact: true }))) return 'view_member';
  }
  const memberPath = /^\/members\/([0-9]{5})(\/accounts)?$/.exec(url.pathname);
  if (memberPath) {
    if (!memberPath[2]) {
      if (details.tag === 'A' && details.destination === `${origin}/members/search`
        && await sameNode(frame.getByRole('link', { name: 'Back to member search', exact: true }))) return 'back_to_member_search';
      if (details.tag === 'TD' && details.column === 1 && details.firstCell === 'Member ID'
        && details.text === memberPath[1]) return 'member_identity';
    } else {
      const parent = frame.parentFrame();
      if (!parent || parent.url() !== `${origin}/members/${memberPath[1]}`) return undefined;
      if (details.tag === 'STRONG' && details.text === memberPath[1]
        && await sameNode(frame.locator('strong'))) return 'member_identity';
      if (details.tag === 'TD' && details.firstCell === 'Savings') {
        if (details.header === 'Current balance') return 'savings_balance';
        if (details.header === 'Currency') return 'currency';
      }
    }
  }
  if (url.pathname === '/notice' && formMatches('/notice', '') && details.tag === 'BUTTON' && details.type === 'submit'
    && await sameNode(frame.getByRole('dialog', { name: 'System notice', exact: true })
      .getByRole('button', { name: 'OK', exact: true }))) return 'system_notice_ok';
  return undefined;
}

/** Private in-memory guard. Include ancestor/label/table state; never put this string in evidence. */
export async function elementSignature(handle: ElementHandle<Element>): Promise<string> {
  return handle.evaluate((element) => JSON.stringify({
    connected: element.isConnected,
    html: element.outerHTML,
    document: element.ownerDocument.documentElement.outerHTML,
    url: element.ownerDocument.URL,
    parentUrl: element.ownerDocument.defaultView?.parent.location.href,
    values: element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement
      ? Array.from(element.form?.elements ?? []).map((field) => field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : null) : undefined,
  }));
}
