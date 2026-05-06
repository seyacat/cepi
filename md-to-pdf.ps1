# Convierte un archivo Markdown con bloques Mermaid a PDF usando Puppeteer.
# Uso: .\md-to-pdf.ps1 archivo.md

param(
  [Parameter(Mandatory=$true, Position=0)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  Write-Error "No se encuentra el archivo: $Path"
  exit 1
}

$inputFull = (Resolve-Path -LiteralPath $Path).Path
$dir       = Split-Path -Parent $inputFull
$base      = [System.IO.Path]::GetFileNameWithoutExtension($inputFull)
$output    = Join-Path $dir "$base.pdf"

# Carpeta de trabajo persistente para puppeteer (evita reinstalar cada vez)
$workDir = Join-Path $env:LOCALAPPDATA 'md-to-pdf'
if (-not (Test-Path $workDir)) { New-Item -ItemType Directory -Path $workDir | Out-Null }

Push-Location $workDir
try {
  if (-not (Test-Path (Join-Path $workDir 'node_modules\puppeteer'))) {
    Write-Host "Instalando puppeteer (solo la primera vez)..."
    if (-not (Test-Path (Join-Path $workDir 'package.json'))) {
      [System.IO.File]::WriteAllText((Join-Path $workDir 'package.json'), '{"name":"md-to-pdf","private":true}', (New-Object System.Text.UTF8Encoding($false)))
    }
    & npm install --silent puppeteer
    if ($LASTEXITCODE -ne 0) { throw "Fallo instalando puppeteer" }
  }
}
finally { Pop-Location }

$scriptFile = Join-Path $workDir 'render.js'
$nodeScript = @'
const fs = require('fs');
const path = require('path');
const [,, inputFile, outputFile] = process.argv;
const md = fs.readFileSync(inputFile, 'utf8');

function escape(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function inline(s){
  return s
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/`(.+?)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
    .replace(/\bfab:fa-github\b/g,'');
}
function mdToHtml(text){
  const lines = text.split('\n');
  let html=''; let i=0;
  while(i<lines.length){
    const line = lines[i];
    if(line.trim()==='```mermaid'){
      let diagram=''; i++;
      while(i<lines.length && lines[i].trim()!=='```'){ diagram += lines[i]+'\n'; i++; }
      const clean = diagram.replace(/fab:fa-\w+/g,'').trim();
      html += `<div class="mermaid">${clean}</div>\n`; i++; continue;
    }
    if(line.trim().startsWith('```')){
      let code=''; i++;
      while(i<lines.length && !lines[i].trim().startsWith('```')){ code += lines[i]+'\n'; i++; }
      html += `<pre><code>${escape(code.trim())}</code></pre>\n`; i++; continue;
    }
    if(line.includes('|') && lines[i+1] && lines[i+1].match(/^\|?[\s\-|:]+\|?$/)){
      const headers = line.split('|').filter(c=>c.trim()).map(c=>`<th>${inline(c.trim())}</th>`).join('');
      html += `<table><thead><tr>${headers}</tr></thead><tbody>`;
      i += 2;
      while(i<lines.length && lines[i].includes('|')){
        const cells = lines[i].split('|').filter(c=>c.trim()).map(c=>`<td>${inline(c.trim())}</td>`).join('');
        html += `<tr>${cells}</tr>`; i++;
      }
      html += `</tbody></table>\n`; continue;
    }
    if(line.startsWith('>')){ html += `<blockquote>${inline(line.slice(1).trim())}</blockquote>\n`; i++; continue; }
    if(line.match(/^[-*] /)){
      html += '<ul>';
      while(i<lines.length && lines[i].match(/^[-*] /)){ html += `<li>${inline(lines[i].slice(2))}</li>`; i++; }
      html += '</ul>\n'; continue;
    }
    if(line.match(/^---+$/)){ html += '<hr>\n'; i++; continue; }
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if(hMatch){ html += `<h${hMatch[1].length}>${inline(hMatch[2])}</h${hMatch[1].length}>\n`; i++; continue; }
    if(line.trim()) html += `<p>${inline(line)}</p>\n`; else html += '\n';
    i++;
  }
  return html;
}

const body = mdToHtml(md);
const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><style>
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
</style></head><body>
${body}
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });</script>
</body></html>`;

const htmlFile = outputFile.replace(/\.pdf$/i, '.html');
fs.writeFileSync(htmlFile, html);

(async () => {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const divs = document.querySelectorAll('.mermaid');
    return [...divs].every(d => d.querySelector('svg'));
  }, { timeout: 20000 }).catch(() => console.warn('Timeout esperando Mermaid - continuando'));
  await page.pdf({
    path: outputFile, format: 'A4', printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
  });
  await browser.close();
  console.log('PDF generado: ' + outputFile);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
'@

Set-Content -LiteralPath $scriptFile -Value $nodeScript -Encoding UTF8

Write-Host "Generando PDF desde $inputFull..."
& node $scriptFile $inputFull $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
