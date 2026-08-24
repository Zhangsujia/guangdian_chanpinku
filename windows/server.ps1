$ErrorActionPreference = "Stop"

$AppName = "ProductLinkAssistant"
$WebRoot = Join-Path $PSScriptRoot "web"
$DataRoot = Join-Path $env:LOCALAPPDATA $AppName
$DataFile = Join-Path $DataRoot "data.json"
$BackupFile = Join-Path $DataRoot "data.backup.json"
$Utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false

if (-not (Test-Path $WebRoot)) {
  Write-Host "缺少 web 文件夹，请重新解压完整安装包。" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $DataRoot)) { New-Item -ItemType Directory -Path $DataRoot | Out-Null }
if (-not (Test-Path $DataFile)) {
  [System.IO.File]::WriteAllText($DataFile, '{"version":1,"products":[]}', $Utf8)
}

function Find-HeaderEnd([byte[]]$Bytes) {
  for ($i = 0; $i -le $Bytes.Length - 4; $i++) {
    if ($Bytes[$i] -eq 13 -and $Bytes[$i + 1] -eq 10 -and $Bytes[$i + 2] -eq 13 -and $Bytes[$i + 3] -eq 10) { return $i }
  }
  return -1
}

function Read-Request($Stream) {
  $memory = New-Object System.IO.MemoryStream
  $buffer = New-Object byte[] 8192
  $headerEnd = -1
  $contentLength = 0
  while ($true) {
    $read = $Stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { break }
    $memory.Write($buffer, 0, $read)
    $bytes = $memory.ToArray()
    if ($headerEnd -lt 0) {
      $headerEnd = Find-HeaderEnd $bytes
      if ($headerEnd -ge 0) {
        $headerText = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $headerEnd)
        foreach ($line in ($headerText -split "`r`n")) {
          if ($line -match '^Content-Length:\s*(\d+)$') { $contentLength = [int]$Matches[1] }
        }
      }
    }
    if ($headerEnd -ge 0 -and $bytes.Length -ge ($headerEnd + 4 + $contentLength)) { break }
    if ($memory.Length -gt 52428800) { throw "Request too large" }
  }
  $all = $memory.ToArray()
  if ($headerEnd -lt 0) { throw "Invalid HTTP request" }
  $headerText = [System.Text.Encoding]::ASCII.GetString($all, 0, $headerEnd)
  $lines = $headerText -split "`r`n"
  $requestParts = $lines[0] -split ' '
  $body = if ($contentLength -gt 0) { [System.Text.Encoding]::UTF8.GetString($all, $headerEnd + 4, $contentLength) } else { "" }
  return @{ Method = $requestParts[0]; Path = $requestParts[1]; Body = $body }
}

function Send-Response($Stream, [int]$Status, [string]$ContentType, [byte[]]$Body) {
  $reason = switch ($Status) { 200 { "OK" } 400 { "Bad Request" } 404 { "Not Found" } 405 { "Method Not Allowed" } 500 { "Internal Server Error" } default { "OK" } }
  $headers = "HTTP/1.1 $Status $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

function Send-Json($Stream, [int]$Status, $Object) {
  $json = $Object | ConvertTo-Json -Depth 12 -Compress
  $jsonBytes = $Utf8.GetBytes($json)
  Send-Response $Stream $Status "application/json; charset=utf-8" $jsonBytes
}

function Check-Link([string]$Url) {
  if ($Url -notmatch '^https?://') { return @{ kind = "unreachable"; message = "链接格式不正确"; status = 0 } }
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $true
  $handler.MaxAutomaticRedirections = 6
  $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
  $client.Timeout = [TimeSpan]::FromSeconds(12)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 ProductLinkAssistant/1.0")
  try {
    $request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::Head), $Url
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $code = [int]$response.StatusCode
    if ($code -eq 405) {
      $request.Dispose()
      $request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::Get), $Url
      $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      $code = [int]$response.StatusCode
    }
    if ($code -ge 200 -and $code -lt 400) { return @{ kind = "reachable"; message = "网页可以访问，商品状态仍建议人工确认"; status = $code } }
    if ($code -eq 401 -or $code -eq 403 -or $code -eq 429) { return @{ kind = "protected"; message = "平台限制了自动检测，请人工打开确认"; status = $code } }
    if ($code -eq 404 -or $code -eq 410) { return @{ kind = "suspected"; message = "网页返回 $code，链接疑似失效"; status = $code } }
    return @{ kind = "unreachable"; message = "网页返回状态码 $code，请人工复核"; status = $code }
  } catch {
    return @{ kind = "unreachable"; message = "暂时无法访问，请检查网络或人工打开确认"; status = 0 }
  } finally {
    if ($null -ne $request) { $request.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
  }
}

$listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), 0
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$address = "http://127.0.0.1:$port/"
Write-Host ""
Write-Host "产品链接管家已启动" -ForegroundColor Green
Write-Host "数据位置：$DataFile"
Write-Host "关闭本窗口即可停止程序。"
Write-Host ""
Start-Process $address

try {
  while ($true) {
    $clientConnection = $listener.AcceptTcpClient()
    try {
      $stream = $clientConnection.GetStream()
      $request = Read-Request $stream
      $pathOnly = [System.Uri]::UnescapeDataString(($request.Path -split '\?')[0])

      if ($request.Method -eq "GET" -and $pathOnly -eq "/api/data") {
        $bytes = [System.IO.File]::ReadAllBytes($DataFile)
        Send-Response $stream 200 "application/json; charset=utf-8" $bytes
      } elseif ($request.Method -eq "POST" -and $pathOnly -eq "/api/data") {
        try {
          $parsed = $request.Body | ConvertFrom-Json
          if ($null -eq $parsed.products) { throw "Invalid data" }
          $tempFile = Join-Path $DataRoot "data.new.json"
          [System.IO.File]::WriteAllText($tempFile, $request.Body, $Utf8)
          if (Test-Path $DataFile) {
            [System.IO.File]::Replace($tempFile, $DataFile, $BackupFile, $true)
          } else {
            [System.IO.File]::Move($tempFile, $DataFile)
          }
          Send-Json $stream 200 @{ ok = $true }
        } catch {
          Send-Json $stream 400 @{ ok = $false; error = "数据格式不正确" }
        }
      } elseif ($request.Method -eq "POST" -and $pathOnly -eq "/api/check-link") {
        try {
          $payload = $request.Body | ConvertFrom-Json
          Send-Json $stream 200 (Check-Link ([string]$payload.url))
        } catch {
          Send-Json $stream 400 @{ kind = "unreachable"; message = "检测请求格式不正确"; status = 0 }
        }
      } elseif ($request.Method -eq "GET") {
        $relative = if ($pathOnly -eq "/") { "index.html" } else { $pathOnly.TrimStart('/') }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $WebRoot $relative))
        $rootFull = [System.IO.Path]::GetFullPath($WebRoot)
        if (-not $candidate.StartsWith($rootFull) -or -not (Test-Path $candidate -PathType Leaf)) {
          $notFoundBytes = $Utf8.GetBytes("Not Found")
          Send-Response $stream 404 "text/plain; charset=utf-8" $notFoundBytes
        } else {
          $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
          $contentType = switch ($extension) { ".html" { "text/html; charset=utf-8" } ".js" { "application/javascript; charset=utf-8" } ".css" { "text/css; charset=utf-8" } ".svg" { "image/svg+xml" } ".png" { "image/png" } default { "application/octet-stream" } }
          Send-Response $stream 200 $contentType ([System.IO.File]::ReadAllBytes($candidate))
        }
      } else {
        $methodBytes = $Utf8.GetBytes("Method Not Allowed")
        Send-Response $stream 405 "text/plain; charset=utf-8" $methodBytes
      }
    } catch {
      try { Send-Json $stream 500 @{ ok = $false; error = "本地服务处理失败" } } catch { }
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
      $clientConnection.Close()
    }
  }
} finally {
  $listener.Stop()
}
