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

  // Fallback: use PowerShell to list printers
  try {
    const { execSync } = require('child_process');
    const output = execSync(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8', timeout: 5000 },
    );
    return output.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.error('[Printer] PowerShell fallback failed:', err.message);
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
      // Fallback: write to temp file and send via PowerShell
      printViaPowerShell(printerName, data).then(resolve).catch(reject);
    }
  });
}

/**
 * PowerShell raw printing via WinSpool P/Invoke — most reliable Windows approach.
 */
function printViaPowerShell(printerName, data) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const tmpFile = path.join(os.tmpdir(), `reitrn_${Date.now()}.prn`);
    fs.writeFileSync(tmpFile, Buffer.from(data, 'utf8'));

    const filePath      = tmpFile.replace(/\\/g, '\\\\');
    const printerEscaped = printerName.replace(/'/g, "''");

    // Use WinSpool API via PowerShell P/Invoke — the gold standard for raw Windows printing
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
[WinSpool]::OpenPrinter('${printerEscaped}', [ref]$h, [IntPtr]::Zero) | Out-Null
$di = New-Object WinSpool+DOCINFO; $di.pDocName = 'reitrn'; $di.pDataType = 'RAW'
[WinSpool]::StartDocPrinter($h, 1, [ref]$di) | Out-Null
[WinSpool]::StartPagePrinter($h) | Out-Null
$bytes = [System.IO.File]::ReadAllBytes('${filePath}')
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$w = 0; [WinSpool]::WritePrinter($h, $ptr, $bytes.Length, [ref]$w) | Out-Null
[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
[WinSpool]::EndPagePrinter($h) | Out-Null
[WinSpool]::EndDocPrinter($h) | Out-Null
[WinSpool]::ClosePrinter($h) | Out-Null
Remove-Item '${filePath}' -Force
`;

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      },
    );
  });
}

module.exports = { getInstalledPrinters, printRaw };
