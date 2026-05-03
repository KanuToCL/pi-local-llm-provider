# dead-man.ps1 — Windows Scheduled-Task dead-man switch for pi-comms.
#
# Per ~/.llms/plans/pi_comms_daemon.plan.md §"Phase 4.0 (NEW) Dead-man switch
# independent of daemon" (line 1151). Mirror of scripts/dead-man.sh.
#
# Run by Windows Task Scheduler every 5 minutes — the install script
# scripts/install-deadman-task.ps1 wires up the trigger and supplies
# StartIn so PI_COMMS_HOME is resolvable.
#
# Required env:
#   PI_COMMS_DEADMAN_NTFY_TOPIC  ntfy.sh topic (when transport is ntfy)
#
# Optional env:
#   PI_COMMS_HOME                 default %USERPROFILE%\.pi-comms
#   PI_COMMS_DEADMAN_TRANSPORT    'ntfy' (default) | 'pushover' | 'mailgun'
#   PI_COMMS_DEADMAN_STALE_SECS   default 180
#   PI_COMMS_DEADMAN_SUPPRESS_SECS default 1800
#   PI_COMMS_DEADMAN_NTFY_HOST    default https://ntfy.sh
#   PI_COMMS_DEADMAN_PUSHOVER_TOKEN
#   PI_COMMS_DEADMAN_PUSHOVER_USER
#   PI_COMMS_DEADMAN_MAILGUN_API_KEY
#   PI_COMMS_DEADMAN_MAILGUN_DOMAIN
#   PI_COMMS_DEADMAN_MAILGUN_TO

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-EnvOrDefault {
    param([string]$Name, [string]$Default)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

$PiCommsHome = Get-EnvOrDefault 'PI_COMMS_HOME' (Join-Path $env:USERPROFILE '.pi-comms')
$HeartbeatPath = Join-Path $PiCommsHome 'daemon.heartbeat'
$LastNotifyPath = Join-Path $PiCommsHome 'dead-man-last-notify.ts'
$StaleSecs = [int](Get-EnvOrDefault 'PI_COMMS_DEADMAN_STALE_SECS' '180')
$SuppressSecs = [int](Get-EnvOrDefault 'PI_COMMS_DEADMAN_SUPPRESS_SECS' '1800')
$Transport = (Get-EnvOrDefault 'PI_COMMS_DEADMAN_TRANSPORT' 'ntfy').ToLowerInvariant()

function Write-Log {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Write-Host "[dead-man $ts] $Message"
}

function Send-Ntfy {
    param([string]$Message)
    $topic = [Environment]::GetEnvironmentVariable('PI_COMMS_DEADMAN_NTFY_TOPIC')
    # AUDIT-A: rename `$host` (shadows PowerShell's automatic `$host`
    # variable, which holds the script's `Host` runtime — overwriting
    # it can cause subtle breakage in cmdlets that introspect it).
    $ntfyHost = Get-EnvOrDefault 'PI_COMMS_DEADMAN_NTFY_HOST' 'https://ntfy.sh'
    if ([string]::IsNullOrWhiteSpace($topic)) {
        Write-Log "ERROR: PI_COMMS_DEADMAN_NTFY_TOPIC unset; cannot notify via ntfy"
        return $false
    }
    $headers = @{
        'Title'    = 'pi-comms dead'
        'Priority' = 'urgent'
        'Tags'     = 'warning,skull'
    }
    try {
        Invoke-RestMethod -Method Post -Uri "$ntfyHost/$topic" -Headers $headers -Body $Message | Out-Null
        return $true
    } catch {
        Write-Log "ERROR: ntfy POST failed: $_"
        return $false
    }
}

function Send-Pushover {
    param([string]$Message)
    $token = [Environment]::GetEnvironmentVariable('PI_COMMS_DEADMAN_PUSHOVER_TOKEN')
    $user = [Environment]::GetEnvironmentVariable('PI_COMMS_DEADMAN_PUSHOVER_USER')
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($user)) {
        Write-Log "ERROR: PI_COMMS_DEADMAN_PUSHOVER_{TOKEN,USER} required"
        return $false
    }
    $body = @{
        token    = $token
        user     = $user
        title    = 'pi-comms dead'
        priority = 1
        message  = $Message
    }
    try {
        Invoke-RestMethod -Method Post -Uri 'https://api.pushover.net/1/messages.json' -Body $body | Out-Null
        return $true
    } catch {
        Write-Log "ERROR: pushover POST failed: $_"
        return $false
    }
}

function Send-Mailgun {
    param([string]$Message)
    $apiKey = [Environment]::GetEnvironmentVariable('PI_COMMS_DEADMAN_MAILGUN_API_KEY')
    $domain = [Environment]::GetEnvironmentVariable('PI_COMMS_DEADMAN_MAILGUN_DOMAIN')
    $to = [Environment]::GetEnvironmentVariable('PI_COMMS_DEADMAN_MAILGUN_TO')
    if ([string]::IsNullOrWhiteSpace($apiKey) -or [string]::IsNullOrWhiteSpace($domain) -or [string]::IsNullOrWhiteSpace($to)) {
        Write-Log "ERROR: PI_COMMS_DEADMAN_MAILGUN_{API_KEY,DOMAIN,TO} required"
        return $false
    }
    $pair = "api:$apiKey"
    $bytes = [Text.Encoding]::ASCII.GetBytes($pair)
    $auth = 'Basic ' + [Convert]::ToBase64String($bytes)
    $form = @{
        from    = "pi-comms <pi-comms@$domain>"
        to      = $to
        subject = 'pi-comms dead'
        text    = $Message
    }
    try {
        Invoke-RestMethod -Method Post `
            -Uri "https://api.mailgun.net/v3/$domain/messages" `
            -Headers @{ Authorization = $auth } `
            -Body $form | Out-Null
        return $true
    } catch {
        Write-Log "ERROR: mailgun POST failed: $_"
        return $false
    }
}

function Dispatch-Notification {
    param([string]$Message)
    switch ($Transport) {
        'ntfy'     { return (Send-Ntfy -Message $Message) }
        'pushover' { return (Send-Pushover -Message $Message) }
        'mailgun'  { return (Send-Mailgun -Message $Message) }
        default {
            Write-Log "ERROR: unknown PI_COMMS_DEADMAN_TRANSPORT: $Transport"
            return $false
        }
    }
}

# -- Main -------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $PiCommsHome)) {
    New-Item -ItemType Directory -Path $PiCommsHome -Force | Out-Null
}

$nowSecs = [int][Math]::Floor((Get-Date -UFormat %s))

$stale = $false
$ageDisplay = 'missing'
if (Test-Path -LiteralPath $HeartbeatPath) {
    $mtime = (Get-Item -LiteralPath $HeartbeatPath).LastWriteTime
    $mtimeSecs = [int][Math]::Floor((Get-Date $mtime.ToUniversalTime() -UFormat %s))
    $age = $nowSecs - $mtimeSecs
    $ageDisplay = "${age}s"
    if ($age -gt $StaleSecs) { $stale = $true }
} else {
    $stale = $true
}

if (-not $stale) {
    if (Test-Path -LiteralPath $LastNotifyPath) {
        Remove-Item -LiteralPath $LastNotifyPath -Force
    }
    exit 0
}

# Stale — decide whether to notify.
$shouldNotify = $true
if (Test-Path -LiteralPath $LastNotifyPath) {
    $lastRaw = Get-Content -LiteralPath $LastNotifyPath -Raw -ErrorAction SilentlyContinue
    if ($lastRaw -match '^\s*([0-9]+)\s*$') {
        $lastTs = [int]$matches[1]
        $sinceLast = $nowSecs - $lastTs
        if ($sinceLast -lt $SuppressSecs) {
            $shouldNotify = $false
            Write-Log "stale (age=$ageDisplay) but suppressed (last notify ${sinceLast}s ago < ${SuppressSecs}s)"
        }
    }
}

if ($shouldNotify) {
    $hostName = $env:COMPUTERNAME
    if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = 'unknown' }
    $message = "pi-comms heartbeat stale on $($hostName): heartbeat age=$ageDisplay threshold=${StaleSecs}s. Daemon may be dead."
    if (Dispatch-Notification -Message $message) {
        Set-Content -LiteralPath $LastNotifyPath -Value $nowSecs
        Write-Log "notified via ${Transport}: $message"
    } else {
        Write-Log "ERROR: failed to dispatch notification via $Transport"
        exit 1
    }
}

exit 0
