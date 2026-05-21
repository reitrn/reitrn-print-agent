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
 * PowerShell fallback for raw printing.
 */
function printViaPowerShell(printerName, data) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const tmpFile = path.join(os.tmpdir(), `reitrn_${Date.now()}.prn`);
    fs.writeFileSync(tmpFile, Buffer.from(data, 'utf8'));

    const escaped = tmpFile.replace(/\\/g, '\\\\');
    const printerEscaped = printerName.replace(/"/g, '\\"');

    const script = `
      $printerName = "${printerEscaped}"
      $filePath = "${escaped}"
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $printerQueue = New-Object System.Printing.PrintQueue(
        (New-Object System.Printing.LocalPrintServer), $printerName
      )
      $job = $printerQueue.AddJob()
      $stream = $job.JobStream
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Close()
      $job.Commit()
      Remove-Item $filePath -Force
    `;

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve();
        }
      },
    );
  });
}

module.exports = { getInstalledPrinters, printRaw };
