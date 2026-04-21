param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}

$prompt = $input.prompt

if ([string]::IsNullOrEmpty($prompt)) {
    exit 0
}

if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}

# Create temporary file with prompt content (stdin is already occupied by hook input)
$tempFile = [System.IO.Path]::GetTempFileName()

try {
    $prompt | Set-Content -Path $tempFile -NoNewline -Encoding UTF8

    # Scan prompt for secrets (using file instead of stdin pipe)
    & sonar analyze secrets $tempFile | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = 0
} finally {
    if (Test-Path $tempFile) {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

if ($exitCode -eq 51) {
    $reason = "Sonar detected secrets in prompt"
    $response = @{
        decision = "block"
        reason = $reason
    } | ConvertTo-Json
    Write-Host $response
}

exit 0
