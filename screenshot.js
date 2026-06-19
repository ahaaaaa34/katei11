const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 3500)); // KaTeX + fonts
  const outPath = '/Users/m4/.gemini/antigravity/brain/66a1b7e7-4b56-48ff-a5ac-912e497f2c8f/screenshot_mobile.png';
  await page.screenshot({ path: outPath });
  console.log('Screenshot saved:', outPath);
  await browser.close();
})();
