# Local development server.
#
# The app is static and has no build step, but ES modules cannot be loaded over
# file:// - the browser refuses them on origin grounds. So it needs to be served
# over HTTP even locally.
#
# This uses only what ships with Windows, because the machine this was written
# on has no Node and no Python. If you have either, `npx serve` or
# `python -m http.server` from the repository root works just as well.
#
#   powershell -ExecutionPolicy Bypass -File tools/serve.ps1
#   powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8080
#
# Then open http://localhost:5500/ for the app, or /tests.html for the suite.

param(
  [int]$Port = 5500
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.sql'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.woff2' = 'font/woff2'
  '.pdf'  = 'application/pdf'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
  $listener.Start()
} catch {
  Write-Host "Could not bind port $Port. Is something already using it?" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  Serving $root" -ForegroundColor Green
Write-Host "  App    http://localhost:$Port/"
Write-Host "  Tests  http://localhost:$Port/tests.html"
Write-Host "  Ctrl+C to stop."
Write-Host ""

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
  } catch {
    break
  }

  $request = $context.Request
  $response = $context.Response

  $path = [System.Uri]::UnescapeDataString($request.Url.LocalPath)
  if ($path -eq '/') { $path = '/index.html' }

  $relative = $path.TrimStart('/')
  $filePath = Join-Path $root $relative

  # Refuse anything that resolves outside the repository root.
  $fullRoot = [System.IO.Path]::GetFullPath($root)
  $fullPath = $null
  try { $fullPath = [System.IO.Path]::GetFullPath($filePath) } catch { }

  if ($fullPath -and $fullPath.StartsWith($fullRoot) -and (Test-Path $fullPath -PathType Leaf)) {
    $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
    $contentType = $mime[$ext]
    if (-not $contentType) { $contentType = 'application/octet-stream' }

    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    $response.ContentType = $contentType
    # No caching: this is a dev server and a stale module is a wasted hour.
    $response.Headers.Add('Cache-Control', 'no-store')
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    Write-Host ("  200  " + $path)
  } else {
    $response.StatusCode = 404
    $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
    $response.ContentType = 'text/plain; charset=utf-8'
    $response.ContentLength64 = $body.Length
    $response.OutputStream.Write($body, 0, $body.Length)
    Write-Host ("  404  " + $path) -ForegroundColor DarkYellow
  }

  $response.OutputStream.Close()
}
