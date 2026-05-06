#!/usr/bin/env bash
# Convierte un archivo Markdown con bloques Mermaid a PDF usando Puppeteer.
# Uso: ./md-to-pdf.sh archivo.md

set -euo pipefail

INPUT="${1:-}"
if [[ -z "$INPUT" || ! -f "$INPUT" ]]; then
  echo "Uso: $0 archivo.md"
  exit 1
fi

BASENAME=$(basename "$INPUT" .md)
DIR=$(dirname "$(realpath "$INPUT")")
OUTPUT="$DIR/$BASENAME.pdf"

PUPPETEER_DIR="/home/crifa/.npm/_npx/668c188756b835f3/node_modules"
MERMAID_JS="$PUPPETEER_DIR/mermaid/dist/mermaid.min.js"

if [[ ! -f "$MERMAID_JS" ]]; then
  echo "❌ No se encontró mermaid.min.js en $MERMAID_JS"
  exit 1
fi

echo "🔄 Generando PDF desde $INPUT..."

node - "$INPUT" "$OUTPUT" "$PUPPETEER_DIR" "$MERMAID_JS" <<'EOF'
const fs   = require('fs');
const path = require('path');

const [,, inputFile, outputFile, puppeteerDir, mermaidJs] = process.argv;
const md = fs.readFileSync(inputFile, 'utf8');
const mermaidSrc = fs.readFileSync(mermaidJs, 'utf8');

function escape(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\bfab:fa-github\b/g, '');
}

function mdToHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '```mermaid') {
      let diagram = '';
      i++;
      while (i < lines.length && lines[i].trim() !== '```') {
        diagram += lines[i] + '\n';
        i++;
      }
      // limpiar iconos de fontawesome que mermaid no soporta en este contexto
      const clean = diagram.replace(/fab:fa-\w+/g, '').trim();
      html += `<div class="mermaid">${clean}</div>\n`;
      i++; continue;
    }

    if (line.trim().startsWith('```')) {
      let code = '';
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code += lines[i] + '\n';
        i++;
      }
      html += `<pre><code>${escape(code.trim())}</code></pre>\n`;
      i++; continue;
    }

    if (line.includes('|') && lines[i+1] && lines[i+1].match(/^\|?[\s\-|:]+\|?$/)) {
      const headers = line.split('|').filter(c => c.trim()).map(c => `<th>${inline(c.trim())}</th>`).join('');
      html += `<table><thead><tr>${headers}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i].includes('|')) {
        const cells = lines[i].split('|').filter(c => c.trim()).map(c => `<td>${inline(c.trim())}</td>`).join('');
        html += `<tr>${cells}</tr>`;
        i++;
      }
      html += `</tbody></table>\n`; continue;
    }

    if (line.startsWith('>')) {
      html += `<blockquote>${inline(line.slice(1).trim())}</blockquote>\n`;
      i++; continue;
    }

    if (line.match(/^[-*] /)) {
      html += '<ul>';
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        html += `<li>${inline(lines[i].slice(2))}</li>`;
        i++;
      }
      html += '</ul>\n'; continue;
    }

    if (line.match(/^---+$/)) { html += '<hr>\n'; i++; continue; }

    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      html += `<h${hMatch[1].length}>${inline(hMatch[2])}</h${hMatch[1].length}>\n`;
      i++; continue;
    }

    if (line.trim()) html += `<p>${inline(line)}</p>\n`;
    else html += '\n';
    i++;
  }
  return html;
}

const body = mdToHtml(md);

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; max-width: 860px; margin: 0 auto; padding: 30px 40px; color: #1a1a1a; line-height: 1.65; }
  h1 { font-size: 1.9em; border-bottom: 2px solid #d0d7de; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 1.35em; border-bottom: 1px solid #e8e8e8; padding-bottom: 4px; margin-top: 2em; color: #0d1117; }
  h3 { font-size: 1.05em; color: #444; margin-top: 1.5em; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 12px 16px; overflow-x: auto; font-size: 11.5px; border: 1px solid #e0e0e0; }
  code { background: #eef0f3; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #4a90d9; margin: 12px 0; padding: 8px 16px; background: #f0f6ff; border-radius: 0 6px 6px 0; color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 12px; }
  th { background: #f0f4f8; font-weight: 600; }
  td, th { border: 1px solid #dde1e7; padding: 6px 11px; text-align: left; }
  tr:nth-child(even) td { background: #fafbfc; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 24px 0; }
  .mermaid { margin: 20px auto; text-align: center; page-break-inside: avoid; }
  .mermaid svg { max-width: 100%; height: auto; }
  ul { padding-left: 1.5em; } li { margin-bottom: 4px; }
  p { margin: 8px 0; }
</style>
</head>
<body>
${body}
<script>${mermaidSrc}</script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });
</script>
</body>
</html>`;

const htmlFile = outputFile.replace(/\.pdf$/, '.html');
fs.writeFileSync(htmlFile, html);

(async () => {
  const puppeteer = require(path.join(puppeteerDir, 'puppeteer'));
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Esperar a que Mermaid termine de renderizar
  await page.waitForFunction(() => {
    const divs = document.querySelectorAll('.mermaid');
    return [...divs].every(d => d.querySelector('svg'));
  }, { timeout: 15000 }).catch(() => console.warn('⚠️  Timeout esperando Mermaid — continuando'));

  await page.pdf({
    path: outputFile,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
  });

  await browser.close();
  console.log(`✅ PDF generado: ${outputFile}`);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
EOF
