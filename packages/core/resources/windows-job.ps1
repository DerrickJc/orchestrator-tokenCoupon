$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TOKEN_COUPON_CHILD_CONFIG)) | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class TokenCouponJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint PageFaults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title; public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
    public short Show, ReservedBytes; public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy, uint access, bool inherit, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr kind, IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  static void Check(bool ok, string message) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), message); }
  static string Quote(string value) {
    if (value.IndexOf('"') >= 0 || value.EndsWith("\\")) throw new ArgumentException("windows_job_path_invalid");
    return "\"" + value + "\"";
  }
  public static int Run(int parentPid, string runtime, string proxy) {
    var parent = Process.GetProcessById(parentPid); var parentHandle = parent.Handle;
    // A handle pins identity; a reused PID cannot predate this already-created helper.
    if (parent.StartTime.ToUniversalTime() > Process.GetCurrentProcess().StartTime.ToUniversalTime() || parent.HasExited)
      throw new InvalidOperationException("windows_job_parent_identity_invalid");
    IntPtr job=IntPtr.Zero, attributes=IntPtr.Zero, values=IntPtr.Zero;
    IntPtr[] streams = new IntPtr[3]; ProcessInfo process = new ProcessInfo(); bool initialized=false, assigned=false;
    try {
      job=CreateJobObject(IntPtr.Zero, null); Check(job!=IntPtr.Zero, "windows_job_create_failed");
      var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; handle never inherited.
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))),"windows_job_limits_failed");
      for(int i=0;i<3;i++) Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-10-i),GetCurrentProcess(),out streams[i],0,true,2),"windows_job_stream_failed");
      IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
      attributes=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes),"windows_job_attributes_failed"); initialized=true;
      values=Marshal.AllocHGlobal(IntPtr.Size*3); for(int i=0;i<3;i++) Marshal.WriteIntPtr(values,i*IntPtr.Size,streams[i]);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),values,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"windows_job_handle_list_failed");
      var startup=new StartupEx(); startup.Info.Size=Marshal.SizeOf(typeof(StartupEx)); startup.Info.Flags=0x100;
      startup.Info.Input=streams[0]; startup.Info.Output=streams[1]; startup.Info.Error=streams[2]; startup.Attributes=attributes;
      // Only the three stdio handles cross this boundary. Start suspended, assign, then resume.
      Check(CreateProcessW(runtime,new StringBuilder(Quote(runtime)+" "+Quote(proxy)),IntPtr.Zero,IntPtr.Zero,true,0x8080004,IntPtr.Zero,null,ref startup,out process),"windows_job_process_failed");
      Check(AssignProcessToJobObject(job,process.Process),"windows_job_assignment_failed"); assigned=true;
      var watch=new Thread(()=>{try{parent.WaitForExit();}finally{Environment.Exit(125);}}); watch.IsBackground=true; watch.Start();
      Check(ResumeThread(process.Thread)!=0xffffffff,"windows_job_resume_failed");
      Check(WaitForSingleObject(process.Process,0xffffffff)==0,"windows_job_wait_failed");
      uint code; Check(GetExitCodeProcess(process.Process,out code),"windows_job_exit_failed");
      Check(TerminateJobObject(job,0),"windows_job_cleanup_failed");
      var deadline=Stopwatch.StartNew();
      while(true) {
        Accounting info; Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"windows_job_cleanup_unknown");
        if(info.Active==0) break;
        if(deadline.ElapsedMilliseconds>5000) throw new InvalidOperationException("windows_job_cleanup_unconfirmed");
        Thread.Sleep(10);
      }
      return unchecked((int)code);
    } finally {
      if(process.Process!=IntPtr.Zero && !assigned) { TerminateProcess(process.Process,126); WaitForSingleObject(process.Process,5000); }
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(process.Thread!=IntPtr.Zero) CloseHandle(process.Thread); if(process.Process!=IntPtr.Zero) CloseHandle(process.Process);
      foreach(var stream in streams) if(stream!=IntPtr.Zero) CloseHandle(stream);
      if(initialized) DeleteProcThreadAttributeList(attributes); if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes); if(values!=IntPtr.Zero) Marshal.FreeHGlobal(values);
    }
  }
}
'@
  $code = [TokenCouponJob]::Run([int]$config.parentPid, [string]$config.runtime, [string]$config.proxy)
  [Environment]::Exit($code)
} catch {
  [Console]::Error.WriteLine('windows_job_failed: ' + $_.Exception.Message)
  [Environment]::Exit(126)
}
