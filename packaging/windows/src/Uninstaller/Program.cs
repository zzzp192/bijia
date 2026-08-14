using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Bijia.Common;

namespace Bijia.Uninstaller
{
    static class Program
    {
        private const string AppTitle = "工业标准品多平台比价系统 - 卸载向导";

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string exeDir = AppDomain.CurrentDomain.BaseDirectory;

            string errorMsg;
            if (!PathSecurityValidator.ValidateUninstallPath(exeDir, out errorMsg))
            {
                MessageBox.Show(
                    "卸载安全防御拒绝执行：\r\n" + errorMsg + "\r\n\r\n为防止误删非本程序文件，系统已自动阻断递归删除。",
                    AppTitle + " - 安全拦截",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            var dialogResult = MessageBox.Show(
                "确定要从计算机中完全卸载「工业标准品多平台比价系统」吗？\r\n\r\n安装路径: " + exeDir + "\r\n\r\n注意：用户自定义的比价历史与登录状态保存在 AppData 目录，将予以安全保留。",
                AppTitle,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );

            if (dialogResult != DialogResult.Yes)
            {
                return;
            }

            try
            {
                // Kill running Bijia instance
                foreach (var proc in Process.GetProcessesByName("Bijia"))
                {
                    try { proc.Kill(); } catch { }
                }

                // Remove Desktop Shortcut
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string shortcut = Path.Combine(desktop, "工业标准品比价系统.lnk");
                if (File.Exists(shortcut))
                {
                    try { File.Delete(shortcut); } catch { }
                }

                // Remove Registry entry
                try
                {
                    Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\EFMAT_Bijia", false);
                }
                catch { }

                // Schedule self deletion
                string tempBat = Path.Combine(Path.GetTempPath(), "bijia_uninstall_" + Guid.NewGuid().ToString("N") + ".bat");
                string batContent = string.Format(
                    "@echo off\r\n" +
                    "ping 127.0.0.1 -n 3 > nul\r\n" +
                    "if exist \"{0}\\.bijia_install_marker\" (\r\n" +
                    "    rmdir /s /q \"{0}\"\r\n" +
                    ")\r\n" +
                    "del \"%~f0\"\r\n",
                    exeDir.TrimEnd('\\', '/')
                );

                File.WriteAllText(tempBat, batContent, Encoding.Default);

                Process.Start(new ProcessStartInfo
                {
                    FileName = tempBat,
                    CreateNoWindow = true,
                    UseShellExecute = false
                });

                MessageBox.Show(
                    "「工业标准品多平台比价系统」已成功从计算机中卸载。",
                    AppTitle,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "卸载过程中发生错误: " + ex.Message,
                    AppTitle + " - 卸载失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
    }
}
