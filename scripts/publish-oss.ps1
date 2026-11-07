$ErrorActionPreference = 'Stop'

# Refresh persisted User credentials even when the desktop app was started
# before they were configured. Values never appear in command arguments.
foreach ($taskName in @('OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_SECURITY_TOKEN')) {
  $taskValue = [Environment]::GetEnvironmentVariable($taskName, 'User')
  if (-not [string]::IsNullOrWhiteSpace($taskValue)) {
    [Environment]::SetEnvironmentVariable($taskName, $taskValue, 'Process')
  }
}
$env:DEBUG = ''
$env:NODE_DEBUG = ''
$taskScript = Join-Path $PSScriptRoot 'publish-oss.mjs'
& node $taskScript @args
exit $LASTEXITCODE
