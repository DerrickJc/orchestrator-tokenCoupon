import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { normalizeWorkspacePath, workspaceEnvironment } from "./workspace-path.js";

export type NativePickerKind = "directory" | "files";
export interface NativePickerResult { cancelled: boolean; paths: string[]; }
const execute = promisify(execFile);
let opening = false;

// Windows PowerShell 5 uses .NET Framework's legacy FolderBrowserDialog.
// Call the Common Item Dialog directly so no PowerShell/.NET upgrade is required.
// COM methods must stay in native vtable order, including the unused slots.
const folderPickerSource = String.raw`using System;
using System.Runtime.InteropServices;

namespace TokenCoupon {
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr types);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem item, uint hint, out int order);
    }

    public static class FolderPicker {
        private const uint FOS_PICKFOLDERS = 0x20;
        private const uint FOS_FORCEFILESYSTEM = 0x40;
        private const uint FOS_PATHMUSTEXIST = 0x800;
        private const uint FOS_NOCHANGEDIR = 0x8;
        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private const int Cancelled = unchecked((int)0x800704C7);

        public static string Pick(IntPtr owner) {
            IFileDialog dialog = null;
            IShellItem item = null;
            IntPtr name = IntPtr.Zero;
            try {
                dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
                dialog.SetTitle("Token Coupon：选择工作区文件夹");
                dialog.SetOkButtonLabel("选择文件夹");
                int result = dialog.Show(owner);
                if (result == Cancelled) return null;
                Marshal.ThrowExceptionForHR(result);
                dialog.GetResult(out item);
                item.GetDisplayName(SIGDN_FILESYSPATH, out name);
                return Marshal.PtrToStringUni(name);
            } finally {
                if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
                if (item != null) Marshal.ReleaseComObject(item);
                if (dialog != null) Marshal.ReleaseComObject(dialog);
            }
        }
    }
}`;

export function nativePickerCapability() {
  const env = workspaceEnvironment();
  return { available: env.platform === "win32" || env.isWsl, kind: "windows-native", note: "在运行后台的 Windows 桌面打开系统选择框；WSL 通过 PowerShell 调用。取消选择不会创建工作区。" };
}
export function nativePickerScript(kind: NativePickerKind, requestId?: string) {
  if (requestId && !/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("native_picker_request_invalid");
  // No path or other client text is interpolated into PowerShell source.
  return `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${requestId ? `$tokenCouponPickerId = '${requestId}'` : ""}
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Write-Output 'TOKEN_COUPON_PICKER:starting'
Add-Type -AssemblyName System.Windows.Forms
${kind === "directory" ? `Add-Type -TypeDefinition @'
${folderPickerSource}
'@` : ""}
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.Text = 'Token Coupon - select folder or files'
$owner.ShowInTaskbar = $true
$owner.Opacity = 0
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Show()
$owner.Activate()
$owner.BringToFront()
Write-Output 'TOKEN_COUPON_PICKER:dialog'
try {
${kind === "directory" ? `$path = [TokenCoupon.FolderPicker]::Pick($owner.Handle)
$cancelled = ($null -eq $path)
$paths = @()
if (!$cancelled) { $paths = @($path) }
@{ cancelled = $cancelled; paths = @($paths) } | ConvertTo-Json -Compress` : `$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Token Coupon: select reference files'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
try {
$result = $dialog.ShowDialog($owner)
$paths = @()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $paths = @($dialog.FileNames) }
@{ cancelled = ($result -ne [System.Windows.Forms.DialogResult]::OK); paths = @($paths) } | ConvertTo-Json -Compress
} finally { $dialog.Dispose() }`}
} finally { $owner.Close(); $owner.Dispose() }`;
}
export async function pickNativePath(kind: NativePickerKind, signal?: AbortSignal): Promise<NativePickerResult> {
  if (signal?.aborted) return { cancelled: true, paths: [] };
  if (!nativePickerCapability().available) throw new Error("native_picker_unavailable：当前后台没有 Windows 桌面选择器，请使用手动路径；不会改用自定义目录窗口。");
  if (opening) throw new Error("native_picker_busy：系统选择窗口已打开，请在 Windows 桌面完成选择或取消。");
  opening = true;
  const requestId = randomUUID();
  const command = workspaceEnvironment().platform === "win32" ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  try {
    const { stdout } = await execute(command, ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(nativePickerScript(kind, requestId), "utf16le").toString("base64")], { signal, timeout: 300_000, maxBuffer: 512 * 1024, windowsHide: true });
    const data = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!.replace(/^\uFEFF/, "")) as NativePickerResult;
    if (typeof data.cancelled !== "boolean" || !Array.isArray(data.paths) || data.paths.length > 100 || data.paths.some(path => typeof path !== "string")) throw new Error("invalid_picker_reply");
    return data;
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean; stdout?: string };
    if (signal?.aborted || failure.killed) {
      // Killing WSL's interop relay alone may leave a Windows GUI process alive.
      // Match only this invocation's host-generated marker; never kill other pickers.
      const cleanup = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "name='powershell.exe'" | ForEach-Object { if ($_.ProcessId -ne $PID -and $_.CommandLine -match '(?i)-EncodedCommand\\s+([A-Za-z0-9+/=]+)') { try { $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])); if ($source.Contains("$" + "tokenCouponPickerId = '${requestId}'")) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {} } }`;
      await execute(command, ["-NoProfile", "-EncodedCommand", Buffer.from(cleanup, "utf16le").toString("base64")], { timeout: 8000, windowsHide: true }).catch(() => {});
      if (signal?.aborted) return { cancelled: true, paths: [] };
      throw new Error("native_picker_timeout：文件夹选择等待超过 5 分钟，已请求关闭窗口。请重新选择或手动填写路径。");
    }
    if (failure.code === "ENOENT") throw new Error("native_picker_unavailable：未找到 Windows PowerShell，请确认 WSL 的 Windows 互操作可用；也可手动填写路径。");
    const phase = failure.stdout?.includes("TOKEN_COUPON_PICKER:dialog") ? "系统窗口返回失败" : failure.stdout?.includes("TOKEN_COUPON_PICKER:starting") ? "Windows 选择器初始化失败" : "Windows PowerShell 未正常启动";
    throw new Error(`native_picker_failed：${phase}。请确认后台运行在有桌面的 Windows／WSL 会话；也可手动填写路径。`);
  }
  finally { opening = false; }
}
export async function normalizePickedPaths(result: NativePickerResult, kind: NativePickerKind, workspace?: string) {
  if (result.cancelled) return { cancelled: true, paths: [] };
  if (!result.paths.length || result.paths.length > 100) throw new Error("native_picker_invalid：选择结果为空或过多");
  const root = workspace ? await realpath(workspace) : undefined;
  const paths: string[] = [];
  for (const raw of result.paths) {
    const actual = await realpath(await normalizeWorkspacePath(raw));
    if (kind === "directory") { if (!(await stat(actual)).isDirectory()) throw new Error("native_picker_invalid：请选择文件夹"); paths.push(actual); }
    else {
      if (!root || !(await stat(actual)).isFile()) throw new Error("native_picker_invalid：请先打开工作区，再选择文件");
      const child = relative(root, actual);
      if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new Error("native_picker_outside_workspace：请选择当前工作区内的参考文件，或先切换工作区。");
      paths.push(child.split(sep).join("/"));
    }
  }
  return { cancelled: false, paths: [...new Set(paths)] };
}
