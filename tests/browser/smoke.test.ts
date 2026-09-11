import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it('launches Chromium and operates a synthetic form without external services', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.setContent(`
      <!doctype html>
      <html lang="en">
        <head><title>Phase 0 browser smoke test</title></head>
        <body>
          <form>
            <label for="member">Member ID</label>
            <input id="member" name="member" required>
            <button type="submit">Search</button>
          </form>
          <p role="status"></p>
          <script>
            document.querySelector('form').addEventListener('submit', (event) => {
              event.preventDefault();
              document.querySelector('[role="status"]').textContent =
                'Ready: ' + document.querySelector('input').value;
            });
          </script>
        </body>
      </html>
    `);

    await page.getByRole('textbox', { name: 'Member ID', exact: true }).fill('12345');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Ready: 12345');
    expect(await page.locator('body').ariaSnapshot()).toContain('Ready: 12345');
  } finally {
    await browser.close();
  }
});
