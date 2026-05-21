let nodePrinter = null;

// Try to load the native printer module
try {
  nodePrinter = require('@thiagoelg/node-printer');
} catch (err) {
  console.warn('[Printer] Native printer module not available:', err.message);
}

/**
 * Get list of installed printers on this machine.
 * @returns {string[]}
 */
function getInstalledPrinters() {
  if (nodePrinter) {
    try {
      return nodePrinter.getPrinters().map((p) => p.name);
    } catch (err) {
      console.error('[Printer] Failed to list printers:', err.message);
    }
  }

  // Fallback: use wmic (much faster than PowerShell, no startup overhead)
  try {
    const { execSync } = require('child_process');
    const output = execSync(
      'wmic printer get name /format:list',
      { encoding: 'utf8', timeout: 10000 },
    );
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('Name='))
      .map((l) => l.replace('Name=', '').trim())
      .filter(Boolean);
  } catch (err) {
    console.error('[Printer] wmic fallback failed:', err.message);
    return [];
  }
}

/**
 * Send raw print data (TSPL or ZPL) to a named printer.
 * @param {string} printerName
 * @param {string} data
 * @returns {Promise<void>}
 */
function printRaw(printerName, data) {
  return new Promise((resolve, reject) => {
    if (nodePrinter) {
      nodePrinter.printDirect({
        data,
        printer: printerName,
        type: 'RAW',
        success: (jobId) => {
          console.log(`[Printer] Job ${jobId} sent to "${printerName}"`);
          resolve();
        },
        error: (err) => {
          console.error(`[Printer] Print failed:`, err);
          reject(new Error(String(err)));
        },
      });
    } else {
      // Fallback: try simple copy /b first, then WinSpool P/Invoke
      printViaCopy(printerName, data)
        .then(resolve)
        .catch((copyErr) => {
          console.warn('[Printer] copy /b failed, trying WinSpool:', copyErr.message);
          printViaPowerShell(printerName, data).then(resolve).catch(reject);
        });
    }
  });
}

/**
 * Simplest raw print: write data to a temp file, then `copy /b file \\localhost\PrinterName`.
 * Works for any Windows printer that accepts raw data. No P/Invoke needed.
 */
function printViaCopy(printerName, data) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const dataFile = path.join(os.tmpdir(), `reitrn_${Date.now()}.prn`);
    fs.writeFileSync(dataFile, Buffer.from(data, 'utf8'));

    const dest = `\\\\localhost\\${printerName}`;
    console.log(`[Printer] copy /b "${dataFile}" "${dest}"`);

    execFile('cmd', ['/c', 'copy', '/b', dataFile, dest], { timeout: 15000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(dataFile); } catch {}
      if (stdout) console.log('[Printer] copy stdout:', stdout.trim());
      if (stderr) console.warn('[Printer] copy stderr:', stderr.trim());
      if (err) {
        console.error('[Printer] copy /b failed:', err.message);
        reject(err);
      } else {
        console.log(`[Printer] copy /b succeeded for "${printerName}"`);
        resolve();
      }
    });
  });
}

/**
 * PowerShell raw printing via WinSpool P/Invoke.
 * Writes the PS script to a temp file to avoid inline command length/escaping issues.
 */
function printViaPowerShell(printerName, data) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const ts       = Date.now();
    const dataFile = path.join(os.tmpdir(), `reitrn_${ts}.prn`);
    const psFile   = path.join(os.tmpdir(), `reitrn_${ts}.ps1`);

    fs.writeFileSync(dataFile, Buffer.from(data, 'utf8'));

    // No backslash escaping - PowerShell single-quoted strings treat \ as literal
    const printerEscaped = printerName.replace(/'/g, "''");

    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinSpool {
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv")] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr h, int lv, ref DOCINFO di);
  [DllImport("winspool.drv")] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool WritePrinter(IntPtr h, IntPtr buf, int len, out int written);
  [DllImport("winspool.drv")] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool EndDocPrinter(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
}
"@
$h = [IntPtr]::Zero
$opened = [WinSpool]::OpenPrinter('${printerEscaped}', [ref]$h, [IntPtr]::Zero)
if (-not $opened -or $h -eq [IntPtr]::Zero) {
  Write-Error "OpenPrinter failed for '${printerEscaped}' - check printer name matches exactly"
  exit 1
}
Write-Host "OpenPrinter OK, handle=$h"
$di = New-Object WinSpool+DOCINFO
$di.pDocName  = 'reitrn'
$di.pDataType = 'RAW'
$jobId = [WinSpool]::StartDocPrinter($h, 1, [ref]$di)
if ($jobId -le 0) { Write-Error "StartDocPrinter failed"; [WinSpool]::ClosePrinter($h); exit 1 }
Write-Host "StartDocPrinter OK, jobId=$jobId"
[WinSpool]::StartPagePrinter($h) | Out-Null
$bytes = [System.IO.File]::ReadAllBytes('${dataFile}')
Write-Host "Sending $($bytes.Length) bytes to printer"
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$w = 0
$wrote = [WinSpool]::WritePrinter($h, $ptr, $bytes.Length, [ref]$w)
[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
Write-Host "WritePrinter result=$wrote, bytesWritten=$w"
[WinSpool]::EndPagePrinter($h) | Out-Null
[WinSpool]::EndDocPrinter($h) | Out-Null
[WinSpool]::ClosePrinter($h) | Out-Null
Write-Host "Done"
`;

    // Write as UTF-16 LE with BOM — PowerShell 5.1 reads this natively without encoding issues
    fs.writeFileSync(psFile, Buffer.from('﻿' + script, 'utf16le'));

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        // Always log PS output so we can see exactly what happened
        if (stdout) console.log('[Printer] PS stdout:', stdout.trim());
        if (stderr) console.warn('[Printer] PS stderr:', stderr.trim());
        try { fs.unlinkSync(dataFile); } catch {}
        try { fs.unlinkSync(psFile);   } catch {}
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      },
    );
  });
}

module.exports = { getInstalledPrinters, printRaw };
