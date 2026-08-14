using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Bijia.Launcher
{
    static class Program
    {
        private const string AppTitle = "工业标准品多平台比价系统";
        private const string MutexName = "EFMAT_Bijia_SingleInstance_Mutex";
        private static Mutex _appMutex;
        private static Process _serverProcess;
        private static NotifyIcon _trayIcon;
        private static ContextMenuStrip _trayMenu;
        private static string _appUrl = "http://127.0.0.1:8000";
        private static int _activePort = 8000;
        private static JobObject _jobObject;
        private static string _logFilePath;
        private static string _userDataDir;

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool createdNew;
            _appMutex = new Mutex(true, MutexName, out createdNew);
            if (!createdNew)
            {
                MessageBox.Show(
                    "工业标准品比价系统已在运行中。\r\n请查看系统托盘图标以打开界面。",
                    AppTitle,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }

            try
            {
                RunApplication();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "程序启动遇到未捕获异常:\r\n" + ex.Message + "\r\n\r\n详细日志已记录至: " + _logFilePath,
                    AppTitle + " - 启动异常",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                Cleanup();
            }
        }

        private static void RunApplication()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            _userDataDir = Path.Combine(localAppData, "EFMAT", "Bijia");

            string dataDir = Path.Combine(_userDataDir, "data");
            string profilesDir = Path.Combine(_userDataDir, "browser_profiles");
            string cookiesDir = Path.Combine(_userDataDir, "cookies");
            string logsDir = Path.Combine(_userDataDir, "logs");
            string bb1688Dir = Path.Combine(_userDataDir, "1688");

            Directory.CreateDirectory(_userDataDir);
            Directory.CreateDirectory(dataDir);
            Directory.CreateDirectory(profilesDir);
            Directory.CreateDirectory(cookiesDir);
            Directory.CreateDirectory(logsDir);
            Directory.CreateDirectory(bb1688Dir);

            _logFilePath = Path.Combine(logsDir, "server.log");

            // Locate application source directory
            string appSrcDir = Path.Combine(exeDir, "app_src");
            if (!Directory.Exists(appSrcDir))
            {
                if (Directory.Exists(Path.Combine(exeDir, "backend")))
                {
                    appSrcDir = exeDir;
                }
                else
                {
                    var parentDir = Directory.GetParent(exeDir);
                    if (parentDir != null && Directory.Exists(Path.Combine(parentDir.FullName, "backend")))
                    {
                        appSrcDir = parentDir.FullName;
                    }
                }
            }

            string runtimeDir = Path.Combine(_userDataDir, "runtime");
            Directory.CreateDirectory(runtimeDir);

            string activePy;
            string activeNode;
            string activeBrowser;

            bool isReady = RuntimeBootstrap.AreDependenciesReady(appSrcDir, runtimeDir, out activePy, out activeNode, out activeBrowser);
            if (!isReady)
            {
                Icon appIcon = null;
                try
                {
                    string iconPath = Path.Combine(exeDir, "app.ico");
                    if (File.Exists(iconPath)) appIcon = new Icon(iconPath);
                }
                catch { }

                using (var bootstrapForm = new BootstrapForm(appSrcDir, runtimeDir, _logFilePath, appIcon))
                {
                    var result = bootstrapForm.ShowDialog();
                    if (result != DialogResult.OK)
                    {
                        return;
                    }
                }

                activePy = RuntimeBootstrap.DetectPythonExe(appSrcDir, runtimeDir);
                activeNode = RuntimeBootstrap.DetectNodeExe(runtimeDir);
                activeBrowser = RuntimeBootstrap.DetectBrowser(runtimeDir);
            }

            if (string.IsNullOrEmpty(activePy) || !File.Exists(activePy))
            {
                MessageBox.Show(
                    "未能定位可用的 Python 运行环境。\r\n请确认依赖初始化是否完整。",
                    AppTitle + " - 启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            _activePort = FindAvailablePort(8000, 50);
            _appUrl = "http://127.0.0.1:" + _activePort;

            _jobObject = new JobObject();

            string runServerScript = Path.Combine(appSrcDir, "run_server.py");
            if (!File.Exists(runServerScript))
            {
                MessageBox.Show(
                    "未找到核心运行脚本: " + runServerScript + "\r\n请确认程序完整性。",
                    AppTitle + " - 启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = activePy,
                Arguments = string.Format("\"{0}\" --port {1} --host 127.0.0.1 --no-browser", runServerScript, _activePort),
                WorkingDirectory = appSrcDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            startInfo.EnvironmentVariables["BIJIA_APP_ROOT"] = appSrcDir;
            startInfo.EnvironmentVariables["BIJIA_DATA_DIR"] = dataDir;
            startInfo.EnvironmentVariables["BIJIA_PROFILES_DIR"] = profilesDir;
            startInfo.EnvironmentVariables["BIJIA_COOKIES_DIR"] = cookiesDir;
            startInfo.EnvironmentVariables["BIJIA_LOGS_DIR"] = logsDir;
            startInfo.EnvironmentVariables["BB1688_HOME"] = bb1688Dir;
            startInfo.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            startInfo.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";

            if (!string.IsNullOrEmpty(activeBrowser) && File.Exists(activeBrowser))
            {
                startInfo.EnvironmentVariables["CHROME_PATH"] = activeBrowser;
                startInfo.EnvironmentVariables["CHROME_BIN"] = activeBrowser;
                startInfo.EnvironmentVariables["EDGE_PATH"] = activeBrowser;
                startInfo.EnvironmentVariables["BROWSER_PATH"] = activeBrowser;
            }

            string existingPath = startInfo.EnvironmentVariables["PATH"] ?? Environment.GetEnvironmentVariable("PATH") ?? "";
            string customPaths = "";
            if (!string.IsNullOrEmpty(activeNode) && File.Exists(activeNode))
            {
                string nodeDir = Path.GetDirectoryName(activeNode);
                customPaths += nodeDir + ";";
            }
            string pythonDir = Path.GetDirectoryName(activePy);
            if (!string.IsNullOrEmpty(pythonDir) && Directory.Exists(pythonDir))
            {
                customPaths += pythonDir + ";" + Path.Combine(pythonDir, "Scripts") + ";";
            }
            startInfo.EnvironmentVariables["PATH"] = customPaths + existingPath;

            string pythonPath = appSrcDir;
            string cnScraperSrc = Path.Combine(appSrcDir, "vendor", "cn-scraper-mcp", "src");
            if (Directory.Exists(cnScraperSrc))
            {
                pythonPath += ";" + cnScraperSrc;
            }
            startInfo.EnvironmentVariables["PYTHONPATH"] = pythonPath;

            try
            {
                File.WriteAllText(_logFilePath, string.Format("=== {0} 启动日志 [{1:yyyy-MM-dd HH:mm:ss}] ===\r\n", AppTitle, DateTime.Now), Encoding.UTF8);
            }
            catch { }

            try
            {
                _serverProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
                _serverProcess.OutputDataReceived += (s, e) => AppendLog(e.Data);
                _serverProcess.ErrorDataReceived += (s, e) => AppendLog(e.Data);
                _serverProcess.Exited += (s, e) =>
                {
                    AppendLog(string.Format("[服务退出] 进程结束，退出码: {0}", _serverProcess != null ? _serverProcess.ExitCode.ToString() : "未知"));
                };

                _serverProcess.Start();
                _serverProcess.BeginOutputReadLine();
                _serverProcess.BeginErrorReadLine();

                _jobObject.AddProcess(_serverProcess.Handle);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动核心服务进程失败:\r\n" + ex.Message,
                    AppTitle + " - 启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            bool healthy = WaitForServerHealth(_appUrl + "/api/health", 30);
            if (!healthy)
            {
                MessageBox.Show(
                    "比价服务在规定时间内未响应健康检查。\r\n请查看运行日志: " + _logFilePath,
                    AppTitle + " - 服务启动超时",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
            }

            SetupTrayIcon(exeDir);
            OpenWebBrowser(_appUrl);
            Application.Run();
        }

        private static void SetupTrayIcon(string exeDir)
        {
            _trayMenu = new ContextMenuStrip();
            _trayMenu.Items.Add("打开比价界面", null, (s, e) => OpenWebBrowser(_appUrl));
            _trayMenu.Items.Add("平台登录管理", null, (s, e) => OpenWebBrowser(_appUrl + "/#login-section"));
            _trayMenu.Items.Add("-");
            _trayMenu.Items.Add("查看运行日志", null, (s, e) => OpenLogFile());
            _trayMenu.Items.Add("打开数据目录", null, (s, e) => OpenUserDataDir());
            _trayMenu.Items.Add("-");
            _trayMenu.Items.Add("退出程序", null, (s, e) => ExitApplication());

            _trayIcon = new NotifyIcon
            {
                Text = AppTitle + " (端口: " + _activePort + ")",
                ContextMenuStrip = _trayMenu,
                Visible = true
            };

            try
            {
                string iconPath = Path.Combine(exeDir, "app.ico");
                if (File.Exists(iconPath))
                {
                    _trayIcon.Icon = new Icon(iconPath);
                }
                else
                {
                    _trayIcon.Icon = SystemIcons.Application;
                }
            }
            catch
            {
                _trayIcon.Icon = SystemIcons.Application;
            }

            _trayIcon.DoubleClick += (s, e) => OpenWebBrowser(_appUrl);
        }

        private static void OpenWebBrowser(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                AppendLog("打开默认浏览器失败: " + ex.Message);
            }
        }

        private static void OpenLogFile()
        {
            try
            {
                if (File.Exists(_logFilePath))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = _logFilePath,
                        UseShellExecute = true
                    });
                }
            }
            catch { }
        }

        private static void OpenUserDataDir()
        {
            try
            {
                if (Directory.Exists(_userDataDir))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = _userDataDir,
                        UseShellExecute = true
                    });
                }
            }
            catch { }
        }

        private static bool WaitForServerHealth(string healthUrl, int timeoutSeconds)
        {
            var stopwatch = Stopwatch.StartNew();
            while (stopwatch.Elapsed.TotalSeconds < timeoutSeconds)
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(healthUrl);
                    request.Timeout = 1500;
                    request.UserAgent = "BijiaLauncher/1.0";
                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        if (response.StatusCode == HttpStatusCode.OK)
                        {
                            return true;
                        }
                    }
                }
                catch
                {
                }
                Thread.Sleep(500);
            }
            return false;
        }

        private static int FindAvailablePort(int startPort, int maxScan)
        {
            for (int port = startPort; port < startPort + maxScan; port++)
            {
                if (IsPortAvailable(port))
                {
                    return port;
                }
            }
            return startPort;
        }

        private static bool IsPortAvailable(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (listener != null)
                {
                    try { listener.Stop(); } catch { }
                }
            }
        }

        private static void AppendLog(string message)
        {
            if (string.IsNullOrEmpty(message)) return;
            try
            {
                string line = string.Format("[{0:HH:mm:ss}] {1}\r\n", DateTime.Now, message);
                File.AppendAllText(_logFilePath, line, Encoding.UTF8);
            }
            catch { }
        }

        private static void ExitApplication()
        {
            Cleanup();
            Application.Exit();
        }

        private static void Cleanup()
        {
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
                _trayIcon = null;
            }

            if (_serverProcess != null && !_serverProcess.HasExited)
            {
                try
                {
                    _serverProcess.Kill();
                    _serverProcess.WaitForExit(3000);
                }
                catch { }
                finally
                {
                    _serverProcess.Dispose();
                    _serverProcess = null;
                }
            }

            if (_jobObject != null)
            {
                _jobObject.Dispose();
                _jobObject = null;
            }

            if (_appMutex != null)
            {
                try
                {
                    _appMutex.ReleaseMutex();
                }
                catch { }
                _appMutex.Dispose();
                _appMutex = null;
            }
        }
    }
}
