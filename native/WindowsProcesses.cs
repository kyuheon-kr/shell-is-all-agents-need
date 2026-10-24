using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace ShellAgents {
    // Read-only process inspection. Never enable debug privileges or emit full
    // environments/command lines. PEB layouts are internal Windows structures;
    // unsupported or inaccessible processes are omitted rather than guessed.
    public static class WindowsProcesses {
        public sealed class Row {
            public int pid;
            public int parentPid;
            public bool isClient;
            public string session;
            public string serverSocket;
            public string startTime;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct BasicInfo {
            public IntPtr exitStatus, peb, affinity, priority, pid, parent;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
        static extern int QueryBasic(IntPtr process, int kind, out BasicInfo info, int size, out int returned);
        [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
        static extern int QueryPointer(IntPtr process, int kind, out IntPtr info, int size, out int returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsWow64Process(IntPtr process, out bool wow64);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CommandLineToArgvW(string command, out int count);
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);

        static byte[] Read(IntPtr handle, IntPtr address, int count) {
            if (address == IntPtr.Zero) throw new InvalidOperationException();
            var bytes = new byte[count];
            IntPtr read;
            if (!ReadProcessMemory(handle, address, bytes, new IntPtr(count), out read) || read.ToInt64() != count)
                throw new Win32Exception();
            return bytes;
        }
        static IntPtr Pointer(byte[] bytes, int offset, int width) {
            return width == 8 ? new IntPtr(BitConverter.ToInt64(bytes, offset)) : new IntPtr((long)BitConverter.ToUInt32(bytes, offset));
        }
        static bool SameUser(IntPtr process, SecurityIdentifier user) {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) return false; // TOKEN_QUERY
            try {
                using (var identity = new WindowsIdentity(token)) return user.Equals(identity.User);
            } finally { CloseHandle(token); }
        }
        static string Command(IntPtr process, IntPtr parameters, int width) {
            var value = Read(process, IntPtr.Add(parameters, width == 8 ? 0x70 : 0x40), width == 8 ? 16 : 8);
            int size = BitConverter.ToUInt16(value, 0);
            if (size == 0 || size % 2 != 0) throw new InvalidOperationException();
            return Encoding.Unicode.GetString(Read(process, Pointer(value, width == 8 ? 8 : 4, width), size));
        }
        static string[] Arguments(string command) {
            int count;
            IntPtr args = CommandLineToArgvW(command, out count);
            if (args == IntPtr.Zero) throw new Win32Exception();
            try {
                var result = new string[count];
                for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(args, i * IntPtr.Size));
                return result;
            } finally { LocalFree(args); }
        }
        static bool IsClient(string[] args) {
            for (int i = 1; i < args.Length; i++) {
                string arg = args[i];
                if (arg == "app-server" || arg == "exec-server") return false;
            }
            return true;
        }
        static string Session(IntPtr process, IntPtr parameters, int width) {
            IntPtr environment = Pointer(Read(process, IntPtr.Add(parameters, width == 8 ? 0x80 : 0x48), width), 0, width);
            var entry = new StringBuilder();
            // Stop at the double NUL; cap reads at 1MiB. Read to page boundaries
            // so the final block never crosses into an unmapped memory page.
            for (int offset = 0; offset < 1024 * 1024;) {
                IntPtr address = IntPtr.Add(environment, offset);
                int size = Math.Min(4096 - (int)(address.ToInt64() & 4095), 1024 * 1024 - offset);
                var bytes = Read(process, address, size);
                for (int i = 0; i < bytes.Length; i += 2) {
                    char ch = (char)BitConverter.ToUInt16(bytes, i);
                    if (ch != '\0') { entry.Append(ch); continue; }
                    if (entry.Length == 0) return null;
                    string value = entry.ToString();
                    const string key = "ZELLIJ_SESSION_NAME=";
                    if (value.StartsWith(key, StringComparison.OrdinalIgnoreCase)) return value.Substring(key.Length);
                    entry.Clear();
                }
                offset += size;
            }
            return null;
        }
        public static Row[] Snapshot(int ancestorPid) {
            var rows = new List<Row>();
            using (var identity = WindowsIdentity.GetCurrent()) {
                var ancestors = new HashSet<int>();
                for (int depth = 0; depth < 32 && ancestorPid > 0 && !ancestors.Contains(ancestorPid); depth++) {
                    IntPtr ancestor = OpenProcess(0x410, false, ancestorPid);
                    if (ancestor == IntPtr.Zero) break;
                    try {
                        if (!SameUser(ancestor, identity.User)) break;
                        BasicInfo info; int returned;
                        if (QueryBasic(ancestor, 0, out info, Marshal.SizeOf(typeof(BasicInfo)), out returned) != 0) break;
                        ancestors.Add(ancestorPid);
                        ancestorPid = checked((int)info.parent.ToInt64());
                    } finally { CloseHandle(ancestor); }
                }
                foreach (var process in Process.GetProcesses()) {
                    using (process) {
                        IntPtr handle = OpenProcess(0x410, false, process.Id); // QUERY_INFORMATION | VM_READ
                        if (handle == IntPtr.Zero) continue;
                        try {
                            if (!SameUser(handle, identity.User)) continue;
                            BasicInfo info; int returned;
                            if (QueryBasic(handle, 0, out info, Marshal.SizeOf(typeof(BasicInfo)), out returned) != 0) continue;
                            var row = new Row { pid = process.Id, parentPid = checked((int)info.parent.ToInt64()) };
                            rows.Add(row);
                            int width = IntPtr.Size;
                            IntPtr peb = info.peb;
                            bool wow64;
                            if (!IsWow64Process(handle, out wow64)) continue;
                            if (Environment.Is64BitOperatingSystem && width == 4 && !wow64) continue;
                            if (width == 8 && wow64) {
                                if (QueryPointer(handle, 26, out peb, IntPtr.Size, out returned) != 0 || peb == IntPtr.Zero) continue;
                                width = 4;
                            }
                            IntPtr parameters = Pointer(Read(handle, IntPtr.Add(peb, width == 8 ? 0x20 : 0x10), width), 0, width);
                            row.isClient = String.Equals(process.ProcessName, "codex", StringComparison.OrdinalIgnoreCase) && IsClient(Arguments(Command(handle, parameters, width)));
                            if (String.Equals(process.ProcessName, "zellij", StringComparison.OrdinalIgnoreCase)) {
                                var args = Arguments(Command(handle, parameters, width));
                                if (args.Length >= 3 && args[1] == "--server") {
                                    row.serverSocket = args[2];
                                    row.startTime = process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                                }
                            }
                            if (row.isClient || ancestors.Contains(row.pid)) row.session = Session(handle, parameters, width);
                        } catch {
                            // Processes can exit or deny access during enumeration.
                        } finally { CloseHandle(handle); }
                    }
                }
            }
            return rows.ToArray();
        }
    }
}
