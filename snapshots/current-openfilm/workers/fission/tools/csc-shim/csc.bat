@echo off
rem CET workaround: forward csc args to "dotnet exec csc.dll" (host form skips the CET check
rem that FailFast-crashes the SDK apphost on unpatched Win10 19044 builds).
rem Dynamically resolves the newest installed SDK's csc.dll so it works on CI runners too.
rem Wired from Directory.Build.props (CscToolPath/CscToolExe).
setlocal
set "DOT=%DOTNET_ROOT%"
if "%DOT%"=="" set "DOT=C:\Program Files\dotnet"
set "CSC="
for /f "tokens=*" %%d in ('dir /b /ad "%DOT%\sdk" 2^>nul') do (
  if exist "%DOT%\sdk\%%d\Roslyn\bincore\csc.dll" set "CSC=%DOT%\sdk\%%d\Roslyn\bincore\csc.dll"
)
if "%CSC%"=="" (
  echo csc-shim: no SDK csc.dll found under "%DOT%" 1>&2
  exit /b 41
)
dotnet exec "%CSC%" %*
