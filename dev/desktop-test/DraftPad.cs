// A tiny WinForms app that is only ever used by Glitch's own desktop-control
// tests (dev/desktop-check.mjs): buttons, a notes box, a file list to drag
// from and a folder list to drop on. It writes what happened to a status file
// so a test can check it without looking at the screen.
//
//   csc /target:winexe /out:DraftPad.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll DraftPad.cs
//   DraftPad.exe <status-file> [x y w h]
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

static class Program
{
    static string statusFile;
    static Label status;

    static void Say(string s)
    {
        status.Text = s;
        try { File.WriteAllText(statusFile, s); } catch { }
    }

    [STAThread]
    static void Main(string[] a)
    {
        statusFile = a.Length > 0 ? a[0] : Path.Combine(Path.GetTempPath(), "draftpad-status.txt");
        int x = a.Length > 4 ? int.Parse(a[1]) : 300, y = a.Length > 4 ? int.Parse(a[2]) : 120;
        int w = a.Length > 4 ? int.Parse(a[3]) : 900, h = a.Length > 4 ? int.Parse(a[4]) : 520;
        Application.EnableVisualStyles();
        var f = new Form { Text = "DraftPad Test Bench", StartPosition = FormStartPosition.Manual, Location = new Point(x, y), Size = new Size(w, h) };
        var font = new Font("Segoe UI", 11f);
        f.Font = font;

        var notes = new TextBox { Multiline = true, Location = new Point(20, 20), Size = new Size(380, 150), AccessibleName = "Notes box" };
        var save = new Button { Text = "Save", Location = new Point(20, 190), Size = new Size(110, 38), AccessibleName = "Save" };
        var bold = new Button { Text = "Bold", Location = new Point(145, 190), Size = new Size(110, 38), AccessibleName = "Bold" };
        var close = new Button { Text = "Close", Location = new Point(270, 190), Size = new Size(110, 38), AccessibleName = "Close" };
        var files = new ListBox { Location = new Point(20, 260), Size = new Size(250, 130), AccessibleName = "Files" };
        files.Items.AddRange(new object[] { "Photo A.png", "Photo B.png", "Notes.txt" });
        var folders = new ListBox { Location = new Point(420, 260), Size = new Size(250, 130), AccessibleName = "Folders", AllowDrop = true };
        folders.Items.AddRange(new object[] { "Folder X", "Folder Y" });
        status = new Label { Location = new Point(420, 30), Size = new Size(440, 60), AccessibleName = "Status", Text = "Ready" };
        var tick = new CheckBox { Text = "Remember me", Location = new Point(420, 110), Size = new Size(200, 30), AccessibleName = "Remember me" };

        save.Click += (s, e) => Say("Saved");
        bold.Click += (s, e) => Say("Bold on");
        close.Click += (s, e) => { Say("Closing"); f.Close(); };
        tick.CheckedChanged += (s, e) => Say(tick.Checked ? "Remember on" : "Remember off");
        files.MouseDown += (s, e) =>
        {
            int i = files.IndexFromPoint(e.Location);
            if (i >= 0) { files.SelectedIndex = i; files.DoDragDrop(files.Items[i].ToString(), DragDropEffects.Move); }
        };
        folders.DragEnter += (s, e) => e.Effect = e.Data.GetDataPresent(DataFormats.Text) ? DragDropEffects.Move : DragDropEffects.None;
        folders.DragDrop += (s, e) =>
        {
            var p = folders.PointToClient(new Point(e.X, e.Y));
            int i = folders.IndexFromPoint(p);
            if (i < 0) return;
            string item = (string)e.Data.GetData(DataFormats.Text);
            files.Items.Remove(item);
            Say("Dropped " + item + " onto " + folders.Items[i]);
        };
        folders.DoubleClick += (s, e) => Say("Opened folder");
        f.Controls.AddRange(new Control[] { notes, save, bold, close, files, folders, status, tick });
        Say("Ready");
        Application.Run(f);
    }
}
