import type { ElementHandle } from 'playwright';
import type { Effect } from '../policy/policy.js';

/**
 * Measures what acting on a node would structurally do, from the live DOM. This is the only
 * input policy uses to decide risk, and it is never derived from a label, a model-provided
 * key, or page text:
 *
 *   <a href> same-origin, same-window, no download   -> navigate(destination)
 *   submit button / submit input / <form>            -> submit(action, method, exact field set)
 *   text-like field or select inside a form          -> input(form)
 *   any other node                                   -> read (text only; a click is denied)
 *
 * Disconnected, disabled, cross-window, downloadable and formless controls are `unknown`.
 */
export async function classifyEffect(handle: ElementHandle<Element>, origin: string): Promise<Effect> {
  // No inner named functions here: the body is serialised into the page, where bundler helpers do not exist.
  const details = await handle.evaluate((element) => {
    const isField = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
    const isButton = element instanceof HTMLButtonElement;
    const control = isField || isButton ? element : null;
    const form = element instanceof HTMLFormElement ? element : control?.form ?? null;
    const submitter = (isButton && element.type === 'submit')
      || (element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'image')) ? element : null;
    const link = element instanceof HTMLAnchorElement && element.hasAttribute('href') ? element : null;
    let formDetails: { action: string; method: string; target: string; fields: string[] } | null = null;
    if (form) {
      const names = new Set<string>();
      let readable = true;
      try {
        new FormData(form, submitter ?? undefined).forEach((_value, name) => { names.add(name); });
      } catch { readable = false; }
      if (readable) {
        formDetails = {
          action: submitter?.hasAttribute('formaction') ? submitter.formAction : form.action,
          method: submitter?.hasAttribute('formmethod') ? submitter.formMethod : form.method,
          target: submitter?.hasAttribute('formtarget') ? submitter.formTarget : form.target,
          fields: [...names].sort(),
        };
      }
    }
    const kind: 'link' | 'submit' | 'input' | 'other' = link ? 'link' : submitter || element instanceof HTMLFormElement ? 'submit'
      : isField && !(element instanceof HTMLInputElement && ['button', 'reset', 'hidden', 'checkbox', 'radio', 'file'].includes(element.type)) ? 'input'
        : 'other';
    return {
      connected: element.isConnected,
      disabled: control !== null && control.disabled,
      kind,
      link: link ? { href: link.href, target: link.target, download: link.hasAttribute('download') } : null,
      form: formDetails,
    };
  });
  if (!details.connected || details.disabled) return { kind: 'unknown' };
  if (details.kind === 'link') {
    const destination = URL.parse(details.link!.href);
    if (!destination || destination.origin !== origin || destination.username || destination.password || destination.hash
      || !['', '_self'].includes(details.link!.target) || details.link!.download) return { kind: 'unknown' };
    return { kind: 'navigate', destination: destination.href };
  }
  if (details.kind === 'submit' || details.kind === 'input') {
    const form = details.form;
    if (!form || !['', '_self'].includes(form.target) || form.fields.length > 50
      || form.fields.some((name) => !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name) || name.length > 64)) return { kind: 'unknown' };
    return { kind: details.kind, form: { action: form.action, method: form.method, fields: form.fields } };
  }
  return { kind: 'read' };
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
