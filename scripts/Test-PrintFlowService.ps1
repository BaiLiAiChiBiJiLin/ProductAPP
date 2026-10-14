param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 47822,
    [string]$ExpectedHostIp = '192.168.0.66'
)

# Connectivity probe only: no business data, database or file writes.
$ErrorActionPreference = 'Stop'
$probeId = [Guid]::NewGuid().ToString()
$localIps = @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
    ForEach-Object { $_.ToString() })
$identity = @{
    service = 'PrintFlow connectivity probe'
    probeId = $probeId
    computerName = [System.Net.Dns]::GetHostName()
    localIPv4 = $localIps
    expectedHostIp = $ExpectedHostIp
    runningOnExpectedHost = ($localIps -contains $ExpectedHostIp)
    port = $Port
    startedAt = [DateTime]::UtcNow.ToString('o')
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try {
    $listener.Start()
    Write-Host "Running on computer: $($identity.computerName)"
    Write-Host "Local IPv4: $($localIps -join ', ')"
    Write-Host "Probe ID: $probeId"
    if (-not $identity.runningOnExpectedHost) {
        Write-Warning "This process is NOT running on $ExpectedHostIp. Launching a script from a share runs it on YOUR computer."
    }
    Write-Host "Test URL: http://${ExpectedHostIp}:$Port/health"
    Write-Host 'Leave this window open. Press Ctrl+C to stop.'
    while ($true) {
        if (-not $listener.Pending()) {
            Start-Sleep -Milliseconds 100
            continue
        }
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 3000
            $stream.WriteTimeout = 3000
            $requestBytes = [byte[]]::new(8192)
            $count = 0
            $requestText = ''
            while ($count -lt $requestBytes.Length) {
                $read = $stream.Read($requestBytes, $count, $requestBytes.Length - $count)
                if ($read -eq 0) { break }
                $count += $read
                $requestText = [System.Text.Encoding]::ASCII.GetString($requestBytes, 0, $count)
                if ($requestText.Contains("`r`n`r`n")) { break }
            }
            if (-not $requestText.Contains("`r`n`r`n")) { continue }
            $requestLine = ($requestText -split "`r`n", 2)[0]
            if ($requestLine -match '^GET /health HTTP/1\.[01]$') {
                $status = '200 OK'
                $body = $identity | ConvertTo-Json -Depth 3 -Compress
            } else {
                $status = '404 Not Found'
                $body = '{"error":"Only GET /health is available"}'
            }
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(
                "HTTP/1.1 $status`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
            )
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bodyBytes, 0, $bodyBytes.Length)
            $stream.Flush()
        } catch {
            Write-Warning "Probe request failed: $($_.Exception.Message)"
        } finally {
            $client.Dispose()
        }
    }
} finally {
    $listener.Stop()
}
