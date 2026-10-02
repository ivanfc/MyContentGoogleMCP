<#
.SYNOPSIS
  Despliega mycontent-google-ads-mcp desde Windows sin imprimir ningún secreto.

.DESCRIPTION
  1. Carga las credenciales con tu cargador DPAPI (cargar-credenciales.ps1).
  2. Pide el developer token de Google Ads si no está ya en el entorno (entrada oculta).
  3. Inicia sesión en Cloudflare con `wrangler login` si hace falta (navegador).
  4. Despliega el Worker y sube los 7 secretos con `wrangler secret bulk` (fichero temporal que se borra).
  5. Comprueba el endpoint (401 + metadata OAuth) y ejecuta la integración contra la cuenta real
     (solo lectura + validateOnly; nunca aplica cambios).

.EXAMPLE
  cd C:\ruta\MyContentGoogleMCP
  git fetch origin; git checkout claude/determined-shannon-wpmamr; git pull
  .\scripts\deploy.ps1 -CredentialLoader C:\ruta\scripts\cargar-credenciales.ps1
#>
param(
	[Parameter(Mandatory = $true)][string]$CredentialLoader,
	[switch]$SkipIntegration
)

# Continue: en Windows PowerShell 5.1, 'Stop' convierte cualquier línea de stderr de npx en error fatal.
# Los fallos reales se comprueban con $LASTEXITCODE y throw.
$ErrorActionPreference = 'Continue'
$WorkerUrl = 'https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev'
$env:CLOUDFLARE_ACCOUNT_ID = 'c6ba6a99369e2c4ade1a5e7d5c855a45'
$SecretNames = @(
	'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN',
	'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'COOKIE_ENCRYPTION_KEY'
)

Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path 'wrangler.jsonc')) { throw 'Ejecuta el script desde el repo MyContentGoogleMCP.' }

Write-Host '== 1/6 Credenciales'
& $CredentialLoader
if (-not $env:GOOGLE_ADS_DEVELOPER_TOKEN) {
	$sec = Read-Host 'Developer token de Google Ads (MCC 2567236642 > Admin > API Center)' -AsSecureString
	$env:GOOGLE_ADS_DEVELOPER_TOKEN = [System.Net.NetworkCredential]::new('', $sec).Password
}
$missing = $SecretNames | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) { throw "Faltan variables: $($missing -join ', ')" }
Write-Host "   7 secretos presentes (no se muestran)."

Write-Host '== 2/6 Dependencias y tests unitarios'
npm ci --no-audit --no-fund | Out-Null
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests unitarios en rojo: no se despliega.' }

Write-Host '== 3/6 Cloudflare'
$who = (npx wrangler whoami 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $who -match 'not authenticated') { npx wrangler login; if ($LASTEXITCODE -ne 0) { throw 'wrangler login falló' } }

Write-Host '== 4/6 Deploy + secretos'
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy falló' }
$tmp = [IO.Path]::Combine($env:TEMP, "gads-mcp-$([guid]::NewGuid()).json")
try {
	$obj = [ordered]@{}
	foreach ($n in $SecretNames) { $obj[$n] = [Environment]::GetEnvironmentVariable($n) }
	[IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
	npx wrangler secret bulk $tmp
	if ($LASTEXITCODE -ne 0) { throw 'wrangler secret bulk falló' }
} finally {
	if (Test-Path $tmp) { Remove-Item $tmp -Force }
	$obj = $null
}

Write-Host '== 5/6 Comprobación del endpoint'
try { Invoke-WebRequest -Uri "$WorkerUrl/mcp" -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing | Out-Null; Write-Warning '/mcp no pidió autenticación (inesperado)' }
catch {
	$r = $_.Exception.Response
	if ($r -and [int]$r.StatusCode -eq 401) { Write-Host "   /mcp -> 401 (pide OAuth, correcto)" } else { throw "Respuesta inesperada de /mcp: $($_.Exception.Message)" }
}
$prm = Invoke-RestMethod "$WorkerUrl/.well-known/oauth-protected-resource"
Write-Host "   resource: $($prm.resource)"

if (-not $SkipIntegration) {
	Write-Host '== 6/6 Integración contra la cuenta real (solo lectura + validateOnly)'
	npm run integration
	if ($LASTEXITCODE -ne 0) { Write-Warning 'La integración ha fallado: copia la salida y pásamela.' }
}

foreach ($n in $SecretNames) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host "Conector listo: $WorkerUrl/mcp"
Write-Host "Recuerda: el cliente OAuth debe tener como redirect URI autorizado $WorkerUrl/callback"
