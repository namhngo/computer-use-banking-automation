import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export function layout(title: string, content: HtmlEscapedString | Promise<HtmlEscapedString>, embedded = false) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${title} | Harbor Operations</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; background: #eeefea; color: #182f38; font: 16px/1.5 system-ui, sans-serif; }
          header { background: #182f38; color: #fff; padding: 20px max(20px, calc((100% - 960px) / 2)); }
          header strong { font-size: 19px; letter-spacing: .05em; }
          header small { display: block; color: #c8d7d7; margin-top: 4px; }
          main { max-width: 960px; margin: 32px auto; padding: 0 20px; }
          main.embedded { margin: 0; padding: 16px; background: #fff; }
          h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
          h2 { font-size: 20px; }
          p { margin: 12px 0; }
          a { color: #095e64; text-underline-offset: 3px; }
          .panel { background: white; border: 1px solid #c6cfcc; padding: 24px; margin: 20px 0; }
          .meta { font: 12px/1.5 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; }
          .muted { color: #56666b; }
          .alert { border-left: 4px solid #a4492f; background: #fff1e8; padding: 12px 16px; }
          label { display: block; font-weight: 600; margin: 16px 0 6px; }
          input { display: block; font: inherit; padding: 10px; border: 1px solid #879b9b; width: min(100%, 360px); }
          button { font: inherit; padding: 10px 18px; background: #145d60; color: white; border: 0; cursor: pointer; margin-top: 16px; }
          button.secondary { background: #e5ebea; color: #182f38; }
          a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #c57916; outline-offset: 3px; }
          .scroll { overflow-x: auto; }
          table { width: 100%; border-collapse: collapse; margin: 12px 0; }
          th, td { text-align: left; border-bottom: 1px solid #d8dedb; padding: 12px 8px; }
          th { font-size: 13px; color: #56666b; }
          td.amount { font-family: ui-monospace, monospace; white-space: nowrap; }
          iframe { display: block; width: 100%; height: 360px; border: 1px solid #c6cfcc; background: white; }
          footer { margin-top: 28px; font-size: 13px; color: #56666b; }
          @media (max-width: 480px) { main { margin-top: 24px; padding: 0 12px; } .panel { padding: 16px; } }
        </style>
      </head>
      <body>
        ${embedded ? '' : html`<header><strong>HARBOR / OPERATIONS</strong><small>Credit union servicing sandbox</small></header>`}
        <main class="${embedded ? 'embedded' : ''}">
          ${embedded ? '' : html`<p class="meta">Synthetic data only &nbsp; / &nbsp; Local training environment</p>`}
          ${content}
          ${embedded ? '' : html`<footer>Harbor Core v1.0 &middot; No real member data or transactions.</footer>`}
        </main>
      </body>
    </html>`;
}

export function loginPage(message?: string) {
  return layout('Operator sign in', html`
    <h1>Operator sign in</h1>
    <p class="muted">Access the local member servicing workspace.</p>
    ${message ? html`<p role="alert" class="alert">${message}</p>` : ''}
    <section class="panel">
      <form method="post" action="/login">
        <label for="username">Operator ID</label>
        <input id="username" name="username" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
      </form>
    </section>
  `);
}

export function searchPage(message?: string, result?: { id: string; name: string }) {
  return layout(result ? 'Search results' : 'Member search', html`
    <h1>${result ? 'Search results' : 'Member search'}</h1>
    <p class="muted">Find a member to review their account information.</p>
    <section class="panel">
      <form method="post" action="/members/search">
        <label for="member-id">Member ID</label>
        <input id="member-id" name="memberId" inputmode="numeric" autocomplete="off" required>
        <button type="submit">Search</button>
      </form>
      ${message ? html`<p role="alert" class="alert">${message}</p>` : ''}
      ${result ? html`<div class="scroll"><table>
        <thead><tr><th>Member ID</th><th>Name</th><th>Action</th></tr></thead>
        <tbody><tr><td>${result.id}</td><td>${result.name}</td><td><a href="/members/${result.id}">View member</a></td></tr></tbody>
      </table></div>` : ''}
    </section>
    <form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
  `);
}
