$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

docker compose version *> $null
if ($LASTEXITCODE -eq 0) {
  $compose = @("docker", "compose")
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
  $compose = @("docker-compose")
} else {
  Write-Error "[refresh] Docker Compose is required but was not found."
}

function Invoke-Compose {
  param([string[]]$ComposeArgs)

  if ($compose.Length -eq 1) {
    & $compose[0] @ComposeArgs
  } else {
    & $compose[0] $compose[1] @ComposeArgs
  }
}

if (-not (Test-Path ".env")) {
  Write-Error "[refresh] Missing .env in $scriptDir"
}

$existing = docker ps -a --format "{{.Names}}" | Where-Object { $_ -eq "pulse-client" }
if ($existing) {
  Write-Host "[refresh] Removing existing pulse-client container only..."
  docker rm -f pulse-client | Out-Null
} else {
  Write-Host "[refresh] No existing pulse-client container found."
}

Write-Host "[refresh] Building pulse-client image..."
Invoke-Compose @("build", "--pull", "pulse-client")

Write-Host "[refresh] Starting pulse-client container..."
Invoke-Compose @("up", "-d", "--no-deps", "pulse-client")

Write-Host "[refresh] Current container:"
docker ps --filter "name=^/pulse-client$" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

$pidMode = docker inspect pulse-client --format "{{.HostConfig.PidMode}}"
if ($pidMode -ne "host") {
  Write-Warning "[refresh] pulse-client PidMode is '$pidMode', expected 'host'. Host process metrics may not work."
} else {
  Write-Host "[refresh] PidMode: host"
}
