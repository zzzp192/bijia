using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Bijia.Common;

namespace Bijia.Installer
{
    static class Program
    {
        private const string AppTitle = "工业标准品多平台比价系统 - 安装向导";
        private const string DefaultFolder = "Bijia";
        private static string _targetInstallDir;
        private static bool _createDesktopShortcut = true;
        private static bool _launchAfterInstall = true;
        private static ProgressBar _progressBar;
        private static Label _statusLabel;
        private static Button _installButton;
        private static Button _browseButton;
        private static TextBox _pathTextBox;
        private static CheckBox _chkShortcut;
        private static CheckBox _chkLaunch;
        private static Form _mainForm;

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string defaultRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                DefaultFolder
            );
            _targetInstallDir = defaultRoot;

            BuildInstallerForm();
            Application.Run(_mainForm);
        }

        private static void BuildInstallerForm()
        {
            _mainForm = new Form
            {
                Text = AppTitle,
                Size = new Size(540, 360),
                StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = true,
                BackColor = Color.FromArgb(248, 250, 252),
                Font = new Font("Microsoft YaHei", 9f)
            };

            try
            {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AppIcon"))
                {
                    if (stream != null)
                    {
                        _mainForm.Icon = new Icon(stream);
                    }
                }
            }
            catch { }

            var headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 70,
                BackColor = Color.FromArgb(15, 23, 42)
            };
            _mainForm.Controls.Add(headerPanel);

            var lblHeaderTitle = new Label
            {
                Text = "工业标准品多平台询价与比价系统",
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 12f, FontStyle.Bold),
                Location = new Point(20, 12),
                AutoSize = true
            };
            headerPanel.Controls.Add(lblHeaderTitle);

            var lblHeaderDesc = new Label
            {
                Text = "在线引导式轻量化单文件安装向导 (支持 1688 / 淘宝 / 京东 / 米思米)",
                ForeColor = Color.FromArgb(148, 163, 184),
                Font = new Font("Microsoft YaHei", 8.5f),
                Location = new Point(20, 38),
                AutoSize = true
            };
            headerPanel.Controls.Add(lblHeaderDesc);

            var lblPath = new Label
            {
                Text = "安装目标路径 (推荐当前用户目录，免 UAC 管理员提权):",
                Location = new Point(20, 85),
                AutoSize = true,
                ForeColor = Color.FromArgb(51, 65, 85)
            };
            _mainForm.Controls.Add(lblPath);

            _pathTextBox = new TextBox
            {
                Text = _targetInstallDir,
                Location = new Point(20, 108),
                Size = new Size(390, 26),
                Font = new Font("Microsoft YaHei", 9f)
            };
            _pathTextBox.TextChanged += (s, e) => _targetInstallDir = _pathTextBox.Text;
            _mainForm.Controls.Add(_pathTextBox);

            _browseButton = new Button
            {
                Text = "浏览...",
                Location = new Point(420, 106),
                Size = new Size(85, 28),
                BackColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _browseButton.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            _browseButton.Click += (s, e) =>
            {
                using (var fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "请选择系统安装目标文件夹";
                    fbd.SelectedPath = _targetInstallDir;
                    if (fbd.ShowDialog() == DialogResult.OK)
                    {
                        _pathTextBox.Text = fbd.SelectedPath;
                    }
                }
            };
            _mainForm.Controls.Add(_browseButton);

            _chkShortcut = new CheckBox
            {
                Text = "创建桌面快捷方式",
                Checked = _createDesktopShortcut,
                Location = new Point(20, 145),
                AutoSize = true
            };
            _chkShortcut.CheckedChanged += (s, e) => _createDesktopShortcut = _chkShortcut.Checked;
            _mainForm.Controls.Add(_chkShortcut);

            _chkLaunch = new CheckBox
            {
                Text = "安装完成后立即启动系统",
                Checked = _launchAfterInstall,
                Location = new Point(170, 145),
                AutoSize = true
            };
            _chkLaunch.CheckedChanged += (s, e) => _launchAfterInstall = _chkLaunch.Checked;
            _mainForm.Controls.Add(_chkLaunch);

            _progressBar = new ProgressBar
            {
                Location = new Point(20, 185),
                Size = new Size(485, 20),
                Style = ProgressBarStyle.Continuous,
                Minimum = 0,
                Maximum = 100,
                Value = 0,
                Visible = false
            };
            _mainForm.Controls.Add(_progressBar);

            _statusLabel = new Label
            {
                Text = "准备就绪，点击「立即安装」开始部署。",
                Location = new Point(20, 215),
                Size = new Size(485, 40),
                ForeColor = Color.FromArgb(100, 116, 139)
            };
            _mainForm.Controls.Add(_statusLabel);

            _installButton = new Button
            {
                Text = "立即安装",
                Location = new Point(385, 265),
                Size = new Size(120, 36),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 9.5f, FontStyle.Bold),
                FlatStyle = FlatStyle.Flat
            };
            _installButton.FlatAppearance.BorderSize = 0;
            _installButton.Click += (s, e) => StartInstallation();
            _mainForm.Controls.Add(_installButton);
        }

        private static void StartInstallation()
        {
            string canonical;
            string errorMsg;
            if (!PathSecurityValidator.ValidateInstallPath(_targetInstallDir, out canonical, out errorMsg))
            {
                MessageBox.Show(errorMsg, "安装路径安全检查未通过", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            _targetInstallDir = canonical;
            _installButton.Enabled = false;
            _browseButton.Enabled = false;
            _pathTextBox.Enabled = false;
            _chkShortcut.Enabled = false;
            _chkLaunch.Enabled = false;
            _progressBar.Visible = true;

            var thread = new Thread(() => ExecuteExtraction(canonical))
            {
                IsBackground = true
            };
            thread.Start();
        }

        private static void ExecuteExtraction(string targetDir)
        {
            try
            {
                UpdateStatus(10, "正在准备安装目录...");
                Directory.CreateDirectory(targetDir);

                UpdateStatus(20, "正在验证并解压应用运行载荷...");
                string targetDirWithSep = targetDir.EndsWith(Path.DirectorySeparatorChar.ToString())
                    ? targetDir
                    : targetDir + Path.DirectorySeparatorChar;

                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PayloadResource"))
                {
                    if (stream == null)
                    {
                        throw new InvalidOperationException("未能在安装包中找到内嵌 PayloadResource 资源！");
                    }

                    using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
                    {
                        int total = archive.Entries.Count;
                        int current = 0;

                        foreach (var entry in archive.Entries)
                        {
                            current++;
                            string destPath = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                            if (!PathSecurityValidator.IsSafeExtractionPath(targetDirWithSep, destPath))
                            {
                                throw new InvalidOperationException("安全防护拦截：检测到 Zip-Slip 越界路径攻击 -> " + entry.FullName);
                            }

                            if (string.IsNullOrEmpty(entry.Name))
                            {
                                Directory.CreateDirectory(destPath);
                            }
                            else
                            {
                                Directory.CreateDirectory(Path.GetDirectoryName(destPath));
                                entry.ExtractToFile(destPath, true);
                            }

                            int pct = 20 + (int)((current / (double)total) * 60);
                            UpdateStatus(pct, string.Format("正在解压核心文件 ({0}/{1})...", current, total));
                        }
                    }
                }

                UpdateStatus(85, "正在写入安装认证标记...");
                PathSecurityValidator.CreateInstallMarker(targetDir, "20260814");

                if (_createDesktopShortcut)
                {
                    UpdateStatus(90, "正在创建桌面快捷方式...");
                    CreateDesktopShortcut(targetDir);
                }

                UpdateStatus(95, "正在注册卸载信息...");
                RegisterUninstall(targetDir);

                UpdateStatus(100, "安装圆满完成！");

                _mainForm.BeginInvoke((Action)(() =>
                {
                    if (_launchAfterInstall)
                    {
                        string launcherExe = Path.Combine(targetDir, "Bijia.exe");
                        if (File.Exists(launcherExe))
                        {
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = launcherExe,
                                WorkingDirectory = targetDir
                            });
                        }
                    }
                    else
                    {
                        MessageBox.Show("工业标准品比价系统已成功安装至:\r\n" + targetDir, "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    _mainForm.Close();
                }));
            }
            catch (Exception ex)
            {
                _mainForm.BeginInvoke((Action)(() =>
                {
                    MessageBox.Show("安装过程中发生错误:\r\n" + ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    _installButton.Enabled = true;
                    _browseButton.Enabled = true;
                    _pathTextBox.Enabled = true;
                    _chkShortcut.Enabled = true;
                    _chkLaunch.Enabled = true;
                }));
            }
        }

        private static void UpdateStatus(int percent, string message)
        {
            if (_mainForm.IsDisposed) return;
            _mainForm.BeginInvoke((Action)(() =>
            {
                _progressBar.Value = Math.Min(100, Math.Max(0, percent));
                _statusLabel.Text = message;
            }));
        }

        private static void CreateDesktopShortcut(string targetDir)
        {
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string shortcutPath = Path.Combine(desktop, "工业标准品比价系统.lnk");
                string targetExe = Path.Combine(targetDir, "Bijia.exe");
                string iconPath = Path.Combine(targetDir, "app.ico");

                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType);
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = targetExe;
                    shortcut.WorkingDirectory = targetDir;
                    shortcut.Description = "工业标准品多平台比价系统 (1688/淘宝/京东/米思米)";
                    if (File.Exists(iconPath))
                    {
                        shortcut.IconLocation = iconPath + ",0";
                    }
                    shortcut.Save();
                }
            }
            catch { }
        }

        private static void RegisterUninstall(string targetDir)
        {
            try
            {
                string uninstallExe = Path.Combine(targetDir, "Uninstall.exe");
                string iconPath = Path.Combine(targetDir, "app.ico");
                string keyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\EFMAT_Bijia";

                using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(keyPath))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "工业标准品多平台询价与供应商比价系统");
                        key.SetValue("DisplayVersion", "20260814");
                        key.SetValue("Publisher", "EFMAT Team");
                        key.SetValue("UninstallString", string.Format("\"{0}\"", uninstallExe));
                        key.SetValue("InstallLocation", targetDir);
                        if (File.Exists(iconPath))
                        {
                            key.SetValue("DisplayIcon", iconPath);
                        }
                        key.SetValue("NoModify", 1);
                        key.SetValue("NoRepair", 1);
                    }
                }
            }
            catch { }
        }
    }
}
