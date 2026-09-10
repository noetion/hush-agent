using System;
using System.Runtime.InteropServices;

public static class HushGlass {
    [StructLayout(LayoutKind.Sequential)] struct Accent {
        public int State, Flags; public uint Color; public int Animation;
    }
    [StructLayout(LayoutKind.Sequential)] struct Attribute {
        public int Kind; public IntPtr Data; public int Size;
    }
    [DllImport("user32.dll")] static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref Attribute data);

    public static bool Apply(IntPtr hwnd) {
        // Windows 10 compositor blur. ABGR tint, not whole-window opacity:
        // text and controls stay fully opaque. This is an undocumented API.
        var accent = new Accent { State = 3, Flags = 0, Color = 0 };
        IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(accent));
        try {
            Marshal.StructureToPtr(accent, memory, false);
            var data = new Attribute { Kind = 19, Data = memory, Size = Marshal.SizeOf(accent) };
            if (SetWindowCompositionAttribute(hwnd, ref data) == 0) return false;
            return true;
        } finally { Marshal.FreeHGlobal(memory); }
    }
}


