# Escribe bytes CRUDOS (ESC/POS) en una impresora del spooler de Windows.
#
# Es el RawPrinterHelper clásico de la documentación de Microsoft, registrado
# al vuelo con Add-Type. Se usa para las impresoras USB: las de red van por
# socket directo al 9100 y no pasan por aquí.
#
# No se ejecuta como fichero: imprimir.js lo manda entero por -EncodedCommand
# (instalado vive dentro de app.asar, donde powershell -File no llega) y pasa
# la impresora y el fichero de bytes por variables de entorno.
$ErrorActionPreference = 'Stop'

$Printer = $env:GV_IMPRESORA
$File = $env:GV_ARCHIVO
if (-not $Printer) { throw 'Falta el nombre de la impresora (GV_IMPRESORA).' }
if (-not $File -or -not (Test-Path -LiteralPath $File)) { throw "No existe el fichero de bytes a imprimir: $File" }

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static void SendFile(string printerName, string filePath)
    {
        byte[] bytes = File.ReadAllBytes(filePath);
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("No se pudo abrir la impresora: " + printerName);
        try
        {
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "GestVenin ticket";
            di.pDataType = "RAW";
            if (!StartDocPrinter(hPrinter, 1, di)) throw new Exception("StartDocPrinter fallo");
            StartPagePrinter(hPrinter);
            IntPtr unmanaged = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, unmanaged, bytes.Length);
                int written;
                if (!WritePrinter(hPrinter, unmanaged, bytes.Length, out written) || written != bytes.Length)
                    throw new Exception("WritePrinter escribio " + written + " de " + bytes.Length);
            }
            finally { Marshal.FreeHGlobal(unmanaged); }
            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
        }
        finally { ClosePrinter(hPrinter); }
    }
}
'@

[RawPrinterHelper]::SendFile($Printer, $File)
