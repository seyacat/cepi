const puppeteer = require('D:/cepi/backend/node_modules/puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1300, deviceScaleFactor: 1 });
  const url = 'file:///' + path.resolve('D:/cepi/docs/ficha.html').replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'networkidle0' });

  // 1) Pantalla completa
  await page.screenshot({ path: 'D:/cepi/debug/ficha-screen.png', fullPage: true });

  // 2) Sólo el .ficha (lo que se imprimirá)
  const ficha = await page.$('.ficha');
  await ficha.screenshot({ path: 'D:/cepi/debug/ficha-element.png' });

  // 3) Medidas: cuánto sobra/falta vs. el alto A4 (297mm = 1122.52px @ 96dpi)
  const metrics = await page.evaluate(() => {
    const f = document.querySelector('.ficha');
    const A4_HEIGHT_PX = 297 / 25.4 * 96;       // 1122.52
    const A4_WIDTH_PX  = 210 / 25.4 * 96;       // 793.7
    const cols = [...document.querySelectorAll('.examen-grid > .col')].map(c => c.getBoundingClientRect().width);
    return {
      fichaScrollHeight: f.scrollHeight,
      fichaClientHeight: f.clientHeight,
      fichaWidth: f.clientWidth,
      A4_HEIGHT_PX, A4_WIDTH_PX,
      overflowPx: f.scrollHeight - f.clientHeight,
      lastFooterTop: document.querySelector('.firma').getBoundingClientRect().top,
      lastFooterBottom: document.querySelector('.firma').getBoundingClientRect().bottom,
      examenCols: cols,
    };
  });
  console.log(JSON.stringify(metrics, null, 2));

  // 3.5) Close-up del bloque de siluetas
  const sil = await page.$('.silhouettes');
  if (sil) await sil.screenshot({ path: 'D:/cepi/debug/ficha-silhouettes.png' });

  // 4) PDF real para ver cómo sale
  await page.pdf({
    path: 'D:/cepi/debug/ficha.pdf',
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });

  await browser.close();
})();
