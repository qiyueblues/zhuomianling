using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Installer-only child surface. Reads the owning NSIS progress control; it
// cannot download, install, launch the app, or access application/user files.
internal sealed class UpdateProgress : Form
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, IntPtr data, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] private static extern bool SystemParametersInfo(uint action, uint parameter, out int value, uint flags);

    private readonly IntPtr installer;
    private readonly IntPtr progress;
    private readonly uint installerProcess;
    private readonly Timer timer = new Timer();
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    private readonly Color track = Color.FromArgb(230, 237, 247);
    private readonly Color blue = Color.FromArgb(0, 122, 255);
    private double completed;
    private bool motion;
    private long checkedMotionAt = -1000;

    private UpdateProgress(IntPtr installer, IntPtr progress, uint process)
    {
        this.installer = installer;
        this.progress = progress;
        installerProcess = process;
        // Keep WinForms from restoring top-level styles after SetParent.
        // The surface must stay a child in the progress bar's coordinates.
        TopLevel = false;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = track;
        TabStop = false;
        AutoScaleMode = AutoScaleMode.None;
        AccessibleRole = AccessibleRole.None;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
            ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        timer.Interval = 33;
        timer.Tick += delegate { RefreshProgress(); };
        Rect bounds;
        if (GetClientRect(progress, out bounds)) SetBounds(0, 0, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    private bool HasOwner()
    {
        uint outerProcess, progressProcess;
        return IsWindow(installer) && IsWindow(progress) &&
            GetWindowThreadProcessId(installer, out outerProcess) != 0 &&
            GetWindowThreadProcessId(progress, out progressProcess) != 0 &&
            outerProcess == installerProcess && progressProcess == installerProcess &&
            GetAncestor(progress, 2) == installer;
    }

    protected override void OnHandleCreated(EventArgs args)
    {
        base.OnHandleCreated(args);
        SetParent(Handle, progress);
        SetWindowLong(Handle, -16, (GetWindowLong(Handle, -16) & ~unchecked((int)0x80000000)) | 0x40000000);
        SetWindowLong(progress, -16, GetWindowLong(progress, -16) | 0x02000000);
    }

    protected override void OnShown(EventArgs args)
    {
        base.OnShown(args);
        RefreshProgress();
        if (!IsDisposed) timer.Start();
    }

    private bool ReadProgress(uint message, int parameter, out long value)
    {
        UIntPtr result;
        bool ok = SendMessageTimeout(progress, message, new IntPtr(parameter), IntPtr.Zero,
            0x2, 50, out result) != IntPtr.Zero;
        value = unchecked((int)result.ToUInt32());
        return ok;
    }

    private void RefreshProgress()
    {
        try
        {
            Rect bounds;
            long position, minimum, maximum;
            if (!HasOwner() || !GetClientRect(progress, out bounds) ||
                !ReadProgress(0x408, 0, out position) || !ReadProgress(0x407, 1, out minimum) ||
                !ReadProgress(0x407, 0, out maximum) || maximum <= minimum)
            {
                Close();
                return;
            }
            completed = Math.Max(0, Math.Min(1, (double)(position - minimum) / (maximum - minimum)));
            SetBounds(0, 0, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
            if (elapsed.ElapsedMilliseconds - checkedMotionAt >= 1000)
            {
                int enabled;
                motion = SystemParametersInfo(0x1042, 0, out enabled, 0) && enabled != 0;
                checkedMotionAt = elapsed.ElapsedMilliseconds;
            }
            Invalidate();
        }
        catch { Close(); } // The native NSIS bar remains underneath as fallback.
    }

    protected override void OnPaint(PaintEventArgs args)
    {
        Graphics graphics = args.Graphics;
        graphics.Clear(track);
        float filled = (float)(ClientSize.Width * completed);
        if (filled <= 0 || ClientSize.Height <= 0) return;
        RectangleF fill = new RectangleF(0, 0, filled, ClientSize.Height);
        using (SolidBrush brush = new SolidBrush(blue)) graphics.FillRectangle(brush, fill);
        if (!motion) return;
        float glowWidth = Math.Max(48, ClientSize.Width * 0.22f);
        float travel = filled + glowWidth * 2;
        float x = (float)(elapsed.Elapsed.TotalSeconds * ClientSize.Width * 0.3 % travel) - glowWidth;
        RectangleF glow = new RectangleF(x, 0, glowWidth, ClientSize.Height);
        using (LinearGradientBrush brush = new LinearGradientBrush(glow, blue, blue, 0f))
        {
            brush.InterpolationColors = new ColorBlend
            {
                Colors = new[] { blue, Color.FromArgb(65, 157, 255), Color.FromArgb(173, 217, 255), Color.FromArgb(65, 157, 255), blue },
                Positions = new[] { 0f, 0.25f, 0.5f, 0.75f, 1f }
            };
            GraphicsState state = graphics.Save();
            graphics.SetClip(fill, CombineMode.Intersect);
            graphics.FillRectangle(brush, glow);
            graphics.Restore(state);
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
        base.WndProc(ref message);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { timer.Stop(); timer.Dispose(); }
        base.Dispose(disposing);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        uint outer, bar, process;
        if (args.Length != 3 || !uint.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out outer) ||
            !uint.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out bar) ||
            !uint.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out process)) return;
        try
        {
            using (UpdateProgress surface = new UpdateProgress(new IntPtr(unchecked((int)outer)), new IntPtr(unchecked((int)bar)), process))
            {
                if (!surface.HasOwner()) return;
                Application.Run(surface);
            }
        }
        catch { } // Keep failures local; installation is always owned by NSIS.
    }
}
