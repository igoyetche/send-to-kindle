param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}

$toolName = $input.tool_name
$filePath = $input.tool_input.file_path

if ($toolName -ne "Read" -or [string]::IsNullOrEmpty($filePath) -or -not (Test-Path $filePath)) {
    exit 0
}

if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}

try {
    & sonar analyze secrets $filePath | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    exit 0
}

if ($exitCode -eq 51) {
    $reason = "Sonar detected secrets in file: $filePath"
    $response = @{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "deny"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json
    Write-Host $response
}

exit 0
