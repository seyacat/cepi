# Dump the cepi Postgres DB to a timestamped .sql.gz under backups/.
# Windows-side equivalent of scripts/backup-db.sh — wire from Task Scheduler.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#   $env:DB_NAME = 'other'; .\scripts\backup-db.ps1
#
# Restore:
#   gzip -d -c backups\<file>.sql.gz | psql -h localhost -U postgres -d cepi

$ErrorActionPreference = 'Stop'

$DB_HOST = if ($env:DB_HOST) { $env:DB_HOST } else { 'localhost' }
$DB_PORT = if ($env:DB_PORT) { $env:DB_PORT } else { '5432' }
$DB_USER = if ($env:DB_USER) { $env:DB_USER } else { 'postgres' }
$DB_NAME = if ($env:DB_NAME) { $env:DB_NAME } else { 'cepi' }
$DB_PASS = if ($env:DB_PASSWORD) { $env:DB_PASSWORD } else { 'cerebro' }
$PRUNE_DAYS = if ($env:BACKUP_PRUNE_DAYS) { [int]$env:BACKUP_PRUNE_DAYS } else { 14 }

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$outDir = Join-Path $root 'backups'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$outFile = Join-Path $outDir "cepi_$stamp.sql.gz"

Write-Host "[backup-db] dumping $DB_USER@${DB_HOST}:$DB_PORT/$DB_NAME -> $outFile"

$env:PGPASSWORD = $DB_PASS
# pg_dump (plain) | gzip via System.IO.Compression to avoid an external gzip dep.
$dumpArgs = @('--host', $DB_HOST, '--port', $DB_PORT, '--username', $DB_USER,
              '--dbname', $DB_NAME, '--format=plain', '--no-owner', '--no-privileges')

$tmp = [System.IO.Path]::GetTempFileName()
try {
    & pg_dump @dumpArgs | Out-File -FilePath $tmp -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
    $inStream = [System.IO.File]::OpenRead($tmp)
    $outStream = [System.IO.File]::Create($outFile)
    $gzip = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionMode]::Compress)
    try { $inStream.CopyTo($gzip) } finally { $gzip.Dispose(); $outStream.Dispose(); $inStream.Dispose() }
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

Get-Item $outFile | Format-List Name, Length, LastWriteTime

# Prune old backups
if ($PRUNE_DAYS -gt 0) {
    $cutoff = (Get-Date).AddDays(-$PRUNE_DAYS)
    Get-ChildItem $outDir -Filter 'cepi_*.sql.gz' |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            Write-Host "[backup-db] pruning $($_.Name)"
            Remove-Item $_.FullName -Force
        }
}

Write-Host '[backup-db] done.'
