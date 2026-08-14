using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace Bijia.Launcher
{
    public class BootstrapForm : Form
    {
        private readonly string _appSrcDir;
        private readonly string _runtimeDir;
        private readonly string _logFilePath;

        private Label _lblHeader;
        private Label _lblStage;
        private Label _lblSource;
        private ProgressBar _progressBar;
        private Label _lblPercent;
        private TextBox _txtLogs;
        private Button _btnAction;
        private Button _btnCopyLog;
        private BackgroundWorker _worker;
        private StringBuilder _logBuffer;
        private bool _isFailed = false;

        public BootstrapForm(string appSrcDir, string runtimeDir, string logFilePath, Icon appIcon)
        {
            _appSrcDir = appSrcDir;
            _runtimeDir = runtimeDir;
            _logFilePath = logFilePath;
            _logBuffer = new StringBuilder();

            InitializeUi(appIcon);
            InitializeWorker();
        }

        private void InitializeUi(Icon appIcon)
        {
            this.Text = "工业标准品多平台询价与供应商比价系统 - 环境配置";
            this.Size = new Size(580, 420);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = true;
            this.BackColor = Color.FromArgb(248, 250, 252);
            this.Font = new Font("Microsoft YaHei", 9f);
            if (appIcon != null) this.Icon = appIcon;

            // Top Header Panel
            var headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 65,
                BackColor = Color.FromArgb(15, 23, 42)
            };
            this.Controls.Add(headerPanel);

            _lblHeader = new Label
            {
                Text = "正在检测并配置系统运行环境",
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 12f, FontStyle.Bold),
                Location = new Point(20, 12),
                AutoSize = true
            };
            headerPanel.Controls.Add(_lblHeader);

            var lblSub = new Label
            {
                Text = "首次启动将自动配置轻量级本地运行时，后续启动将直接秒级离线唤起",
                ForeColor = Color.FromArgb(148, 163, 184),
                Font = new Font("Microsoft YaHei", 8.5f),
                Location = new Point(20, 38),
                AutoSize = true
            };
            headerPanel.Controls.Add(lblSub);

            // Stage Label
            _lblStage = new Label
            {
                Text = "正在准备环境检测...",
                Location = new Point(20, 80),
                Size = new Size(440, 22),
                Font = new Font("Microsoft YaHei", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 41, 59)
            };
            this.Controls.Add(_lblStage);

            // Percentage Label
            _lblPercent = new Label
            {
                Text = "0%",
                Location = new Point(480, 80),
                Size = new Size(70, 22),
                TextAlign = ContentAlignment.MiddleRight,
                Font = new Font("Microsoft YaHei", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(37, 99, 235)
            };
            this.Controls.Add(_lblPercent);

            // Progress Bar
            _progressBar = new ProgressBar
            {
                Location = new Point(20, 106),
                Size = new Size(525, 14),
                Style = ProgressBarStyle.Continuous,
                Minimum = 0,
                Maximum = 100,
                Value = 0
            };
            this.Controls.Add(_progressBar);

            // Source/Mirror Label
            _lblSource = new Label
            {
                Text = "当前检测源: 本地系统环境",
                Location = new Point(20, 125),
                Size = new Size(525, 20),
                Font = new Font("Microsoft YaHei", 8.5f),
                ForeColor = Color.FromArgb(100, 116, 139)
            };
            this.Controls.Add(_lblSource);

            // Diagnostic Log Box
            var lblLogHeader = new Label
            {
                Text = "实时配置日志与诊断输出:",
                Location = new Point(20, 150),
                Size = new Size(300, 18),
                Font = new Font("Microsoft YaHei", 8.5f),
                ForeColor = Color.FromArgb(71, 85, 105)
            };
            this.Controls.Add(lblLogHeader);

            _txtLogs = new TextBox
            {
                Location = new Point(20, 172),
                Size = new Size(525, 150),
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(241, 245, 249),
                ForeColor = Color.FromArgb(30, 41, 59),
                Font = new Font("Consolas", 8.5f)
            };
            this.Controls.Add(_txtLogs);

            // Action Button (Cancel / Retry)
            _btnAction = new Button
            {
                Text = "取消",
                Location = new Point(445, 332),
                Size = new Size(100, 32),
                Font = new Font("Microsoft YaHei", 9f),
                BackColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnAction.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            _btnAction.Click += BtnAction_Click;
            this.Controls.Add(_btnAction);

            // Copy Log Button
            _btnCopyLog = new Button
            {
                Text = "复制日志",
                Location = new Point(335, 332),
                Size = new Size(100, 32),
                Font = new Font("Microsoft YaHei", 9f),
                BackColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnCopyLog.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            _btnCopyLog.Click += (s, e) =>
            {
                try
                {
                    Clipboard.SetText(_logBuffer.ToString());
                    MessageBox.Show("日志已成功复制到剪贴板！", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch { }
            };
            this.Controls.Add(_btnCopyLog);
        }

        private void InitializeWorker()
        {
            _worker = new BackgroundWorker
            {
                WorkerReportsProgress = true,
                WorkerSupportsCancellation = false
            };

            _worker.DoWork += Worker_DoWork;
            _worker.RunWorkerCompleted += Worker_RunWorkerCompleted;

            this.Shown += (s, e) => StartBootstrap();
        }

        private void StartBootstrap()
        {
            _isFailed = false;
            _btnAction.Text = "取消";
            _btnAction.BackColor = Color.White;
            _btnAction.ForeColor = Color.Black;
            _progressBar.Value = 0;
            _lblPercent.Text = "0%";
            _worker.RunWorkerAsync();
        }

        private void Worker_DoWork(object sender, DoWorkEventArgs e)
        {
            RuntimeBootstrap.RunBootstrap(
                _appSrcDir,
                _runtimeDir,
                (percent, message, source) =>
                {
                    this.BeginInvoke((Action)(() =>
                    {
                        int p = Math.Min(100, Math.Max(0, percent));
                        _progressBar.Value = p;
                        _lblPercent.Text = p.ToString() + "%";
                        _lblStage.Text = message;
                        if (!string.IsNullOrEmpty(source))
                        {
                            _lblSource.Text = "当前源: " + source;
                        }
                    }));
                },
                logMsg =>
                {
                    this.BeginInvoke((Action)(() =>
                    {
                        AppendLog(logMsg);
                    }));
                }
            );
        }

        private void Worker_RunWorkerCompleted(object sender, RunWorkerCompletedEventArgs e)
        {
            if (e.Error != null)
            {
                _isFailed = true;
                _lblStage.Text = "环境配置失败！";
                _lblStage.ForeColor = Color.Red;
                _btnAction.Text = "重试";
                _btnAction.BackColor = Color.FromArgb(220, 38, 38);
                _btnAction.ForeColor = Color.White;
                AppendLog("【错误详情】: " + e.Error.Message);
                AppendLog("\r\n建议解决方案：\r\n1. 请检查网络连接是否通畅\r\n2. 点击右下方「重试」重新尝试从镜像源下载\r\n3. 或手动安装 Python 3.11 与 Node.js 后重试。");
            }
            else
            {
                _progressBar.Value = 100;
                _lblPercent.Text = "100%";
                _lblStage.Text = "配置完成，正在启动系统...";
                _lblStage.ForeColor = Color.FromArgb(22, 101, 52);
                AppendLog("环境就绪，准备进入主程序...");
                
                var timer = new Timer { Interval = 800 };
                timer.Tick += (ts, te) =>
                {
                    timer.Stop();
                    timer.Dispose();
                    this.DialogResult = DialogResult.OK;
                    this.Close();
                };
                timer.Start();
            }
        }

        private void BtnAction_Click(object sender, EventArgs e)
        {
            if (_isFailed)
            {
                _isFailed = false;
                _lblStage.ForeColor = Color.FromArgb(30, 41, 59);
                _lblStage.Text = "正在重新配置运行环境...";
                AppendLog("\r\n--- 用户点击重试 ---");
                StartBootstrap();
            }
            else
            {
                this.DialogResult = DialogResult.Cancel;
                this.Close();
            }
        }

        private void AppendLog(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            string timeStamp = DateTime.Now.ToString("HH:mm:ss");
            string line = string.Format("[{0}] {1}\r\n", timeStamp, message);
            _logBuffer.Append(line);
            _txtLogs.AppendText(line);

            try
            {
                File.AppendAllText(_logFilePath, line, Encoding.UTF8);
            }
            catch { }
        }
    }
}
