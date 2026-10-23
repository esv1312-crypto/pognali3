const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const out = 'test-results/pognali-visual';
fs.mkdirSync(out, { recursive: true });

test('capture real Pognali UI and inspect responsive layout', async ({ browser }) => {
  const errors = [];
  const report = { testedAt: new Date().toISOString(), pages: [], pageErrors: errors };
  const devices = [
    { name: 'phone-390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: 'small-phone-320', viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true },
    { name: 'desktop-1440', viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false },
  ];

  for (const device of devices) {
    const context = await browser.newContext({
      viewport: device.viewport,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ device: device.name, message: error.message }));
    await page.goto('http://127.0.0.1:4173/docs/telegram/index.html', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await expect(page.locator('.app')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(3500);

    const initial = await page.evaluate(() => ({
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
      app: (() => {
        const el = document.querySelector('.app');
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      })(),
      visibleText: document.body.innerText.slice(0, 1600),
      nav: [...document.querySelectorAll('.bottomnav .nav')].map((el, i) => ({
        index: i, text: el.innerText.trim(), disabled: el.disabled,
        rect: (() => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; })()
      })),
      buttons: [...document.querySelectorAll('button')].filter(el => el.getClientRects().length).map(el => ({
        text: (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().slice(0,100),
        disabled: el.disabled
      })).slice(0, 100),
    }));
    report.pages.push({ device: device.name, ...initial });
    await page.screenshot({ path: path.join(out, device.name + '-home.png'), fullPage: true, animations: 'disabled' });

    // Exercise the main bottom navigation one item at a time and capture each visible screen.
    const navButtons = page.locator('.bottomnav .nav');
    const count = await navButtons.count();
    for (let i = 0; i < count; i++) {
      const button = navButtons.nth(i);
      const label = ((await button.innerText().catch(() => 'nav-' + i)) || 'nav-' + i)
        .replace(/[^a-zA-Z0-9а-яА-Я_-]+/g, '-').slice(0, 32) || ('nav-' + i);
      if (await button.isVisible() && await button.isEnabled()) {
        await button.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({
          path: path.join(out, device.name + '-nav-' + i + '-' + label + '.png'),
          fullPage: true,
          animations: 'disabled',
        }).catch(() => {});
      }
    }
    await context.close();
  }

  fs.writeFileSync(path.join(out, 'visual-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'visual-report.md'), [
    '# Погнали — visual inspection',
    '',
    'Generated: ' + report.testedAt,
    '',
    '## Captured viewports',
    ...report.pages.map(p => '- **' + p.device + '**: viewport ' + p.viewport.width + '×' + p.viewport.height +
      ', document width ' + p.document.width + ', app ' + Math.round(p.app.width) + '×' + Math.round(p.app.height) +
      ', bottom-nav items ' + p.nav.length),
    '',
    '## JavaScript page errors',
    errors.length ? errors.map(e => '- [' + e.device + '] ' + e.message).join('\n') : 'No uncaught page errors observed.',
    '',
    'Screenshots for each viewport and bottom-navigation state are stored alongside this report.',
    'This is a browser-based visual smoke test, not a guarantee that every Telegram-only flow works.',
  ].join('\n'));

  expect(report.pages).toHaveLength(devices.length);
  expect(report.pages.every(p => p.title.includes('Погнали'))).toBeTruthy();
  expect(report.pages.every(p => p.nav.length > 0)).toBeTruthy();
  expect(errors, 'uncaught JavaScript page errors').toEqual([]);
});
