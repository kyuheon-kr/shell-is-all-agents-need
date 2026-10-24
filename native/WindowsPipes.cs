using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace ShellAgents {
    // Zellij 0.45.1 renames Windows marker files without rebinding its pipes.
    // Keep aliases in a separate, same-user process until the original server
    // exits. This preserves renamed sessions across MCP host restarts.
    public static class WindowsPipes {
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafePipeHandle CreateNamedPipeW(string name, uint access, uint mode, uint instances,
            uint output, uint input, uint timeout, ref SecurityAttributes security);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [StructLayout(LayoutKind.Sequential)]
        struct StartupInfo {
            public int size;
            public IntPtr reserved, desktop, title;
            public uint x, y, width, height, columns, rows, fill, flags;
            public short show, reservedSize;
            public IntPtr reservedBytes, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SecurityAttributes security,
            uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
            IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
            ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        static string Quote(string value) {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char ch in value) {
                if (ch == '\\') { slashes++; continue; }
                result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
                result.Append(ch); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public static int StartWorker(string executable, string[] args) {
            var command = new StringBuilder(Quote(executable));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            var security = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), inherit = 1 };
            using (var input = CreateFileW("NUL", 0x80000000u, 3, ref security, 3, 128, IntPtr.Zero))
            using (var output = CreateFileW("NUL", 0x40000000u, 3, ref security, 3, 128, IntPtr.Zero)) {
                if (input.IsInvalid || output.IsInvalid) throw new System.ComponentModel.Win32Exception();
                var startup = new StartupInfo {
                    size = Marshal.SizeOf(typeof(StartupInfo)), flags = 0x101, // USESTDHANDLES | USESHOWWINDOW
                    input = input.DangerousGetHandle(), output = output.DangerousGetHandle(), error = output.DangerousGetHandle()
                };
                ProcessInfo process;
                // Break away from Node/libuv's kill-on-host-exit job. Unlike
                // DETACHED_PROCESS, NO_WINDOW with NUL handles lets PowerShell
                // start correctly. No visible console is allocated.
                const uint flags = 0x08000000u | 0x200u;
                if (!CreateProcessW(executable, new StringBuilder(command.ToString()), IntPtr.Zero, IntPtr.Zero, true,
                    flags | 0x01000000u, IntPtr.Zero, null, ref startup, out process)) {
                    // Hosts outside a breakaway-enabled job need no explicit
                    // BREAKAWAY flag; Windows jobs can also allow it silently.
                    if (!CreateProcessW(executable, new StringBuilder(command.ToString()), IntPtr.Zero, IntPtr.Zero, true,
                        flags, IntPtr.Zero, null, ref startup, out process)) throw new System.ComponentModel.Win32Exception();
                }
                CloseHandle(process.thread); CloseHandle(process.process);
                return checked((int)process.pid);
            }
        }
        static byte[] descriptor;
        static void Observe(Task task) {
            task.ContinueWith(completed => GC.KeepAlive(completed.Exception), TaskContinuationOptions.OnlyOnFaulted);
        }

        static NamedPipeServerStream Listen(string name, bool first) {
            IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
            try {
                Marshal.Copy(descriptor, 0, memory, descriptor.Length);
                var security = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = memory };
                // DUPLEX | OVERLAPPED; FIRST_PIPE_INSTANCE prevents taking over
                // another server's pipe. REJECT_REMOTE_CLIENTS keeps this local.
                var handle = CreateNamedPipeW(@"\\.\pipe\" + name, 3u | 0x40000000u | (first ? 0x80000u : 0),
                    8, 255, 65536, 65536, 0, ref security);
                if (handle.IsInvalid) { handle.Dispose(); throw new System.ComponentModel.Win32Exception(); }
                return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
            } finally { Marshal.FreeHGlobal(memory); }
        }
        static async Task Bridge(NamedPipeServerStream incoming, NamedPipeClientStream outgoing, bool reply) {
            using (incoming) using (outgoing) {
                try {
                    // Zellij uses separate one-way request and reply pipes.
                    // A closed, unused write half on the reply connection must
                    // not discard a response that the server is still sending.
                    if (reply) await outgoing.CopyToAsync(incoming).ConfigureAwait(false);
                    else await incoming.CopyToAsync(outgoing).ConfigureAwait(false);
                } catch (IOException) {} catch (ObjectDisposedException) {}
            }
        }
        static async Task Forward(string alias, string source, NamedPipeServerStream listener, bool reply) {
            while (true) {
                var incoming = listener;
                NamedPipeClientStream outgoing = null;
                try {
                    await incoming.WaitForConnectionAsync().ConfigureAwait(false);
                    outgoing = new NamedPipeClientStream(".", source, PipeDirection.InOut, PipeOptions.Asynchronous);
                    await outgoing.ConnectAsync(5000).ConfigureAwait(false);
                    // Allocate the next listener before relinquishing this one,
                    // so concurrent CLI clients never encounter a missing pipe.
                    listener = Listen(alias, false);
                    Observe(Bridge(incoming, outgoing, reply));
                } catch {
                    incoming.Dispose();
                    if (outgoing != null) outgoing.Dispose();
                    try { listener = Listen(alias, false); } catch { return; }
                }
            }
        }
        static byte[] Read(Stream stream, int count) {
            var result = new byte[count];
            for (int offset = 0; offset < count;) {
                int read = stream.Read(result, offset, count - offset);
                if (read == 0) throw new EndOfStreamException();
                offset += read;
            }
            return result;
        }
        static bool NativeAlias(string alias, int serverPid) {
            try {
                using (var main = new NamedPipeClientStream(".", alias, PipeDirection.InOut))
                using (var reply = new NamedPipeClientStream(".", alias + "-reply", PipeDirection.InOut)) {
                    main.Connect(1000); reply.Connect(1000);
                    uint mainPid, replyPid;
                    return GetNamedPipeServerProcessId(main.SafePipeHandle, out mainPid)
                        && GetNamedPipeServerProcessId(reply.SafePipeHandle, out replyPid)
                        && mainPid == serverPid && replyPid == serverPid;
                }
            } catch { return false; }
        }
        static async Task Control(string control, string source, int serverPid, NamedPipeServerStream listener) {
            var aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { source };
            while (true) {
                using (var request = listener) {
                    try {
                        await request.WaitForConnectionAsync().ConfigureAwait(false);
                        listener = Listen(control, false);
                        int length = BitConverter.ToInt32(Read(request, 4), 0);
                        if (length < 1 || length > 65536) throw new InvalidDataException();
                        string alias = Encoding.UTF8.GetString(Read(request, length));
                        if (!String.Equals(Path.GetDirectoryName(alias), Path.GetDirectoryName(source), StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException();
                        if (!aliases.Contains(alias)) {
                            try {
                                var main = Listen(alias, true);
                                NamedPipeServerStream reply;
                                try { reply = Listen(alias + "-reply", true); }
                                catch { main.Dispose(); throw; }
                                Observe(Forward(alias, source, main, false));
                                Observe(Forward(alias + "-reply", source + "-reply", reply, true));
                            } catch {
                                // A future Zellij may rebind its own pipes on
                                // rename. Accept only that same server's pair;
                                // never forward to a different session owner.
                                if (!NativeAlias(alias, serverPid)) throw;
                            }
                            aliases.Add(alias);
                        }
                        request.WriteByte(0);
                        request.Flush();
                    } catch {
                        try { request.WriteByte(1); request.Flush(); } catch {}
                        if (listener == request) {
                            try { listener = Listen(control, false); } catch { return; }
                        }
                    }
                }
            }
        }
        public static void Run(int serverPid, string started, string source, string control) {
            using (var server = Process.GetProcessById(serverPid)) {
                if (server.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) != started)
                    throw new InvalidOperationException("Zellij server has changed");
                var security = new PipeSecurity();
                security.SetAccessRuleProtection(true, false);
                using (var identity = WindowsIdentity.GetCurrent()) {
                    security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
                }
                descriptor = security.GetSecurityDescriptorBinaryForm();
                var listener = Listen(control, true);
                Observe(Control(control, source, serverPid, listener));
                Console.WriteLine("READY");
                Console.Out.Flush();
                server.WaitForExit();
                // Thread-pool tasks and all pipe handles exit with this helper.
            }
        }
    }
}
