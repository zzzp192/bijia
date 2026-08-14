using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Text;
using System.Collections.Generic;
using System.Threading;

namespace Bijia.Launcher
{
    public static class RuntimeBootstrap
    {
        // 固定的 Node.js 22.14.0 LTS x64 (国内镜像优先 + 官方兜底)
        public static readonly string[] NodeUrls = new string[]
        {
            "https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-win-x64.zip",
            "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip"
        };
        public const string NodeSha256 = "7c1eaee81aee348638977a4c7e600552b49c00b0e517865c3bbef4c9973fc7bc";

        // 固定的 Python 3.11.9 Embeddable x64 (国内镜像优先 + 官方兜底)
        public static readonly string[] PythonEmbedUrls = new string[]
        {
            "https://npmmirror.com/mirrors/python/3.11.9/python-3.11.9-embed-amd64.zip",
            "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
        };
        public const string PythonEmbedSha256 = "28e6789b7e780775d79e56ef37d42cfdffebaece4eb721fe6387063c6cfc2f01";

        // 内置随安装包分发的静态 get-pip.py 固定 SHA-256 校验码 (严禁网络下载)
        public const string StaticGetPipSha256 = "6781f14504abd8827af046c405fb08acf78ea886d57f039347caf05e0b3fbf9c";

        // 固定的 Chrome for Testing 123.0.6312.122 win64 (仅当本机无 Chrome 和 Edge 时下载)
        public static readonly string[] ChromeForTestingUrls = new string[]
        {
            "https://npmmirror.com/mirrors/chrome-for-testing/123.0.6312.122/win64/chrome-win64.zip",
            "https://storage.googleapis.com/chrome-for-testing-public/123.0.6312.122/win64/chrome-win64.zip"
        };
        public const string ChromeForTestingSha256 = "64a595cb0d6d5efce182b84cf829f0dae6bf1cb2196f7c9e078f4a7c156f4d2f";

        // PyPI 国内镜像与官方源重试列表
        public static readonly string[] PyPiIndexUrls = new string[]
        {
            "https://pypi.tuna.tsinghua.edu.cn/simple",
            "https://mirrors.aliyun.com/pypi/simple/",
            "https://pypi.org/simple"
        };

        // npm registry 镜像与官方源重试列表
        public static readonly string[] NpmRegistries = new string[]
        {
            "https://registry.npmmirror.com",
            "https://registry.npmjs.org"
        };

        public delegate void ProgressCallback(int percent, string message, string currentSource);

        private class TimeoutWebClient : WebClient
        {
            public int TimeoutMs { get; set; }
            public int ReadWriteTimeoutMs { get; set; }

            public TimeoutWebClient(int timeoutMs = 15000, int readWriteTimeoutMs = 120000)
            {
                TimeoutMs = timeoutMs;
                ReadWriteTimeoutMs = readWriteTimeoutMs;
            }

            protected override WebRequest GetWebRequest(Uri address)
            {
                var request = base.GetWebRequest(address);
                if (request != null)
                {
                    request.Timeout = TimeoutMs;
                    var httpRequest = request as HttpWebRequest;
                    if (httpRequest != null)
                    {
                        httpRequest.ReadWriteTimeout = ReadWriteTimeoutMs;
                        httpRequest.AllowAutoRedirect = true;
                    }
                }
                return request;
            }
        }

        public static string ComputeFileSha256(string filePath)
        {
            if (!File.Exists(filePath)) return string.Empty;
            using (var sha256 = SHA256.Create())
            {
                using (var stream = File.OpenRead(filePath))
                {
                    byte[] hash = sha256.ComputeHash(stream);
                    var sb = new StringBuilder();
                    for (int i = 0; i < hash.Length; i++)
                    {
                        sb.Append(hash[i].ToString("x2"));
                    }
                    return sb.ToString();
                }
            }
        }

        public static bool VerifyFileHash(string filePath, string expectedSha256)
        {
            if (!File.Exists(filePath)) return false;
            string actual = ComputeFileSha256(filePath);
            return string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase);
        }

        public static string DetectBrowser(string runtimeDir)
        {
            // 1. 环境变量优先指定
            string envChrome = Environment.GetEnvironmentVariable("CHROME_PATH") ?? Environment.GetEnvironmentVariable("CHROME_BIN");
            if (!string.IsNullOrEmpty(envChrome) && File.Exists(envChrome)) return envChrome;

            string envEdge = Environment.GetEnvironmentVariable("EDGE_PATH");
            if (!string.IsNullOrEmpty(envEdge) && File.Exists(envEdge)) return envEdge;

            // 2. Google Chrome (最高优先级)
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

            string[] chromeCandidates = new string[]
            {
                Path.Combine(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(progFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe")
            };
            foreach (var c in chromeCandidates)
            {
                if (File.Exists(c)) return c;
            }

            // 3. Microsoft Edge (Windows 10/11 系统默认回退)
            string[] edgeCandidates = new string[]
            {
                Path.Combine(progFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(progFiles, "Microsoft", "Edge", "Application", "msedge.exe")
            };
            foreach (var e in edgeCandidates)
            {
                if (File.Exists(e)) return e;
            }

            // 4. 已下载的应用独立便携版 Chrome for Testing
            if (!string.IsNullOrEmpty(runtimeDir))
            {
                string downloadedChrome = Path.Combine(runtimeDir, "browser", "chrome-win64", "chrome.exe");
                if (File.Exists(downloadedChrome)) return downloadedChrome;
            }

            return null;
        }

        public static string DetectNodeExe(string runtimeDir)
        {
            // 1. 应用专属 runtime/node
            if (!string.IsNullOrEmpty(runtimeDir))
            {
                string appNode = Path.Combine(runtimeDir, "node", "node.exe");
                if (File.Exists(appNode)) return appNode;
                string appNodeSub = Path.Combine(runtimeDir, "node", "node-v22.14.0-win-x64", "node.exe");
                if (File.Exists(appNodeSub)) return appNodeSub;
            }

            // 2. 系统 PATH Node (必须严格验证 x64 与版本 >= 18)
            string[] pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
            foreach (var dir in pathDirs)
            {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                string candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate))
                {
                    if (ValidateSystemNode(candidate))
                    {
                        return candidate;
                    }
                }
            }

            // 默认安装路径
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string defaultNode = Path.Combine(progFiles, "nodejs", "node.exe");
            if (File.Exists(defaultNode) && ValidateSystemNode(defaultNode))
            {
                return defaultNode;
            }

            return null;
        }

        public static bool ValidateSystemNode(string nodeExePath)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = nodeExePath,
                    Arguments = "-p \"process.arch + ':' + process.versions.node\"",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var proc = Process.Start(psi))
                {
                    bool exited = proc.WaitForExit(4000);
                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        return false;
                    }

                    if (proc.ExitCode == 0)
                    {
                        string output = proc.StandardOutput.ReadToEnd().Trim();
                        string[] parts = output.Split(':');
                        if (parts.Length == 2)
                        {
                            string arch = parts[0].Trim().ToLower();
                            string ver = parts[1].Trim().TrimStart('v');
                            if (arch == "x64")
                            {
                                string[] verParts = ver.Split('.');
                                if (verParts.Length > 0)
                                {
                                    int major;
                                    if (int.TryParse(verParts[0], out major) && major >= 18)
                                    {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        public static string DetectPythonExe(string appSrcDir, string runtimeDir)
        {
            // 1. 系统 Python 创建的专属虚拟环境 venv
            if (!string.IsNullOrEmpty(runtimeDir))
            {
                string venvPy = Path.Combine(runtimeDir, "venv", "Scripts", "python.exe");
                if (File.Exists(venvPy)) return venvPy;
            }

            // 2. 应用下载的独立 embeddable Python
            if (!string.IsNullOrEmpty(runtimeDir))
            {
                string embedPy = Path.Combine(runtimeDir, "python", "python.exe");
                if (File.Exists(embedPy)) return embedPy;
            }

            // 3. 系统兼容的 Python 3.10 ~ 3.12 x64
            string sysPy = FindSystemPythonBase();
            if (!string.IsNullOrEmpty(sysPy))
            {
                return sysPy;
            }

            return null;
        }

        public static string FindSystemPythonBase()
        {
            List<string> candidates = new List<string>();

            string[] pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
            foreach (var dir in pathDirs)
            {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                string py = Path.Combine(dir.Trim(), "python.exe");
                if (File.Exists(py)) candidates.Add(py);
            }

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);

            candidates.Add(Path.Combine(localAppData, "Programs", "Python", "Python311", "python.exe"));
            candidates.Add(Path.Combine(localAppData, "Programs", "Python", "Python312", "python.exe"));
            candidates.Add(Path.Combine(localAppData, "Programs", "Python", "Python310", "python.exe"));
            candidates.Add(Path.Combine(progFiles, "Python311", "python.exe"));
            candidates.Add(Path.Combine(progFiles, "Python312", "python.exe"));
            candidates.Add(Path.Combine(progFiles, "Python310", "python.exe"));

            foreach (var py in candidates)
            {
                if (File.Exists(py) && ValidateSystemPython(py))
                {
                    return py;
                }
            }

            return null;
        }

        public static bool ValidateSystemPython(string pythonExePath)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = pythonExePath,
                    Arguments = "-c \"import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}:{sys.maxsize > 2**32}')\"",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var proc = Process.Start(psi))
                {
                    bool exited = proc.WaitForExit(4000);
                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        return false;
                    }

                    if (proc.ExitCode == 0)
                    {
                        string output = proc.StandardOutput.ReadToEnd().Trim();
                        string[] parts = output.Split(':');
                        if (parts.Length == 2)
                        {
                            string ver = parts[0].Trim();
                            bool is64 = parts[1].Trim().Equals("True", StringComparison.OrdinalIgnoreCase);
                            if (is64 && (ver == "3.10" || ver == "3.11" || ver == "3.12"))
                            {
                                return true;
                            }
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        public static bool Is1688NodeModulesReady(string appSrcDir)
        {
            string nm = Path.Combine(appSrcDir, "vendor", "1688-cli", "node_modules");
            if (!Directory.Exists(nm)) return false;
            string pwDir = Path.Combine(nm, "playwright");
            string pwCoreDir = Path.Combine(nm, "playwright-core");
            return Directory.Exists(pwDir) || Directory.Exists(pwCoreDir);
        }

        public static bool AreDependenciesReady(
            string appSrcDir,
            string runtimeDir,
            out string activePy,
            out string activeNode,
            out string activeBrowser)
        {
            activeBrowser = DetectBrowser(runtimeDir);
            activeNode = DetectNodeExe(runtimeDir);
            activePy = DetectPythonExe(appSrcDir, runtimeDir);

            if (string.IsNullOrEmpty(activeBrowser) || !File.Exists(activeBrowser)) return false;
            if (string.IsNullOrEmpty(activeNode) || !File.Exists(activeNode)) return false;
            if (string.IsNullOrEmpty(activePy) || !File.Exists(activePy)) return false;

            // 检查核心 Python 依赖是否可导入
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = activePy,
                    Arguments = "-c \"import fastapi, uvicorn, pydantic, sqlalchemy, playwright, openpyxl, requests, bs4, curl_cffi, websockets, dotenv; print('DEPS_OK')\"",
                    WorkingDirectory = appSrcDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var proc = Process.Start(psi))
                {
                    bool exited = proc.WaitForExit(5000);
                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        return false;
                    }
                    if (proc.ExitCode != 0 || !proc.StandardOutput.ReadToEnd().Contains("DEPS_OK"))
                    {
                        return false;
                    }
                }
            }
            catch
            {
                return false;
            }

            if (!Is1688NodeModulesReady(appSrcDir))
            {
                return false;
            }

            return true;
        }

        public static void DownloadFileWithFallback(
            string[] urls,
            string targetPath,
            string expectedSha256,
            ProgressCallback progress,
            string itemDescription)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(targetPath));

            if (File.Exists(targetPath))
            {
                if (VerifyFileHash(targetPath, expectedSha256))
                {
                    if (progress != null) progress(100, itemDescription + " 本地缓存哈希校验通过", "本地缓存");
                    return;
                }
                else
                {
                    try { File.Delete(targetPath); } catch { }
                }
            }

            Exception lastEx = null;
            for (int i = 0; i < urls.Length; i++)
            {
                string url = urls[i];
                string sourceLabel = (i == 0) ? "国内高速镜像 (" + new Uri(url).Host + ")" : "官方上游回退源 (" + new Uri(url).Host + ")";

                if (progress != null) progress(5, "正在从 " + sourceLabel + " 下载 " + itemDescription + "...", sourceLabel);

                try
                {
                    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                    using (var client = new TimeoutWebClient(15000, 120000))
                    {
                        client.Headers.Add("User-Agent", "BijiaBootstrap/1.0 (Windows NT 10.0; Win64; x64)");
                        client.DownloadProgressChanged += (s, e) =>
                        {
                            if (progress != null)
                            {
                                int pct = Math.Min(95, Math.Max(5, e.ProgressPercentage));
                                progress(pct, string.Format("正在下载 {0}: {1}% ({2:F1} MB / {3:F1} MB)",
                                    itemDescription, pct, e.BytesReceived / 1048576.0, e.TotalBytesToReceive / 1048576.0), sourceLabel);
                            }
                        };

                        Exception downloadError = null;
                        bool downloadCancelled = false;
                        using (var downloadFinished = new ManualResetEvent(false))
                        {
                            client.DownloadFileCompleted += (s, e) =>
                            {
                                downloadError = e.Error;
                                downloadCancelled = e.Cancelled;
                                downloadFinished.Set();
                            };
                            client.DownloadFileAsync(new Uri(url), targetPath);

                            // ReadWriteTimeout only covers stalled socket reads. This hard limit also
                            // prevents a continuously responding but unusably slow mirror from hanging.
                            if (!downloadFinished.WaitOne(300000))
                            {
                                client.CancelAsync();
                                downloadFinished.WaitOne(5000);
                                throw new TimeoutException("下载超过 5 分钟，已切换到下一个可用源。");
                            }
                        }

                        if (downloadError != null) throw downloadError;
                        if (downloadCancelled) throw new OperationCanceledException("下载已取消。");
                    }

                    if (VerifyFileHash(targetPath, expectedSha256))
                    {
                        if (progress != null) progress(100, itemDescription + " 下载完成并已通过 SHA-256 完整性校验！", sourceLabel);
                        return;
                    }
                    else
                    {
                        string actualHash = ComputeFileSha256(targetPath);
                        try { File.Delete(targetPath); } catch { }
                        throw new InvalidOperationException(string.Format("SHA-256 校验失败！期望: {0}, 实际: {1}", expectedSha256, actualHash));
                    }
                }
                catch (Exception ex)
                {
                    lastEx = ex;
                    try { if (File.Exists(targetPath)) File.Delete(targetPath); } catch { }
                    if (progress != null) progress(5, string.Format("{0} 下载失败: {1}，正在切换回退源...", itemDescription, ex.Message), sourceLabel);
                }
            }

            throw new InvalidOperationException(string.Format("下载 {0} 失败，所有配置源均不可用。最后错误: {1}", itemDescription, lastEx != null ? lastEx.Message : "未知错误"));
        }

        public static void RunBootstrap(
            string appSrcDir,
            string runtimeDir,
            ProgressCallback progress,
            Action<string> logCallback)
        {
            Directory.CreateDirectory(runtimeDir);
            string downloadsDir = Path.Combine(runtimeDir, "downloads");
            Directory.CreateDirectory(downloadsDir);

            // ==========================================
            // Step 1: 探测并准备浏览器 (Chrome / Edge)
            // ==========================================
            if (progress != null) progress(5, "正在检测本地浏览器 (Chrome / Edge)...", "本地探测");
            string activeBrowser = DetectBrowser(runtimeDir);
            if (string.IsNullOrEmpty(activeBrowser) || !File.Exists(activeBrowser))
            {
                if (logCallback != null) logCallback("未检测到本地 Google Chrome 或 Microsoft Edge，正在下载 Chrome for Testing 便携版...");
                string cftZip = Path.Combine(downloadsDir, "chrome-win64.zip");
                DownloadFileWithFallback(ChromeForTestingUrls, cftZip, ChromeForTestingSha256, progress, "Chrome for Testing 浏览器");

                string browserExtractDir = Path.Combine(runtimeDir, "browser");
                if (Directory.Exists(browserExtractDir))
                {
                    try { Directory.Delete(browserExtractDir, true); } catch { }
                }
                Directory.CreateDirectory(browserExtractDir);
                if (progress != null) progress(15, "正在解压 Chrome 运行时...", "本地解压");
                ZipFile.ExtractToDirectory(cftZip, browserExtractDir);
                activeBrowser = DetectBrowser(runtimeDir);
            }
            else
            {
                if (logCallback != null) logCallback("成功探测并复用本地浏览器: " + activeBrowser);
            }

            // ==========================================
            // Step 2: 探测并准备 Node.js 运行时
            // ==========================================
            if (progress != null) progress(20, "正在检测 Node.js 运行时 (需 >= 18 x64)...", "本地探测");
            string activeNode = DetectNodeExe(runtimeDir);
            if (string.IsNullOrEmpty(activeNode) || !File.Exists(activeNode))
            {
                if (logCallback != null) logCallback("未检测到兼容的 Node.js 18+ x64，正在下载 Node.js 22 LTS 便携版...");
                string nodeZip = Path.Combine(downloadsDir, "node-v22.14.0-win-x64.zip");
                DownloadFileWithFallback(NodeUrls, nodeZip, NodeSha256, progress, "Node.js 22 LTS x64 运行环境");

                string nodeExtractDir = Path.Combine(runtimeDir, "node");
                if (Directory.Exists(nodeExtractDir))
                {
                    try { Directory.Delete(nodeExtractDir, true); } catch { }
                }
                Directory.CreateDirectory(nodeExtractDir);
                if (progress != null) progress(35, "正在解压 Node.js 运行时...", "本地解压");
                ZipFile.ExtractToDirectory(nodeZip, nodeExtractDir);

                string subDir = Path.Combine(nodeExtractDir, "node-v22.14.0-win-x64");
                if (Directory.Exists(subDir))
                {
                    string subExe = Path.Combine(subDir, "node.exe");
                    if (File.Exists(subExe))
                    {
                        File.Copy(subExe, Path.Combine(nodeExtractDir, "node.exe"), true);
                    }
                }
                activeNode = DetectNodeExe(runtimeDir);
            }
            else
            {
                if (logCallback != null) logCallback("成功探测并复用 Node.js 运行时: " + activeNode);
            }

            // ==========================================
            // Step 3: 安装 1688-cli 依赖 (npm ci --omit=dev)
            // ==========================================
            if (!Is1688NodeModulesReady(appSrcDir))
            {
                if (progress != null) progress(45, "正在准备 1688 适配器依赖 (npm ci --omit=dev)...", "npmmirror 镜像源");
                string v1688Dir = Path.Combine(appSrcDir, "vendor", "1688-cli");
                string nodeDir = Path.GetDirectoryName(activeNode);

                bool npmOk = false;
                foreach (var registry in NpmRegistries)
                {
                    string regHost = new Uri(registry).Host;
                    if (logCallback != null) logCallback(string.Format("正在通过 {0} 执行 npm ci --omit=dev ...", regHost));

                    string npmCmd = Path.Combine(nodeDir, "npm.cmd");
                    if (!File.Exists(npmCmd))
                    {
                        string subDir = Path.Combine(nodeDir, "node-v22.14.0-win-x64");
                        if (File.Exists(Path.Combine(subDir, "npm.cmd")))
                        {
                            npmCmd = Path.Combine(subDir, "npm.cmd");
                        }
                        else
                        {
                            npmCmd = "npm";
                        }
                    }

                    var psi = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = string.Format("/c \"\"{0}\" ci --omit=dev --registry={1}\"", npmCmd, registry),
                        WorkingDirectory = v1688Dir,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true
                    };
                    string existingPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                    psi.EnvironmentVariables["PATH"] = nodeDir + ";" + existingPath;

                    using (var proc = Process.Start(psi))
                    {
                        proc.OutputDataReceived += (s, e) => { if (e.Data != null && logCallback != null) logCallback(e.Data); };
                        proc.ErrorDataReceived += (s, e) => { if (e.Data != null && logCallback != null) logCallback(e.Data); };
                        proc.BeginOutputReadLine();
                        proc.BeginErrorReadLine();
                        
                        bool exited = proc.WaitForExit(120000);
                        if (!exited)
                        {
                            try { proc.Kill(); } catch { }
                            if (logCallback != null) logCallback("npm ci 执行超时 (120 秒)，已终止进程。");
                        }
                        else if (proc.ExitCode == 0 && Is1688NodeModulesReady(appSrcDir))
                        {
                            npmOk = true;
                            if (logCallback != null) logCallback("1688 适配器依赖通过 npm ci 安装成功！");
                            break;
                        }
                    }
                }

                if (!npmOk && !Is1688NodeModulesReady(appSrcDir))
                {
                    throw new InvalidOperationException("1688 适配器 npm ci 依赖安装失败，请检查网络连接。");
                }
            }

            // ==========================================
            // Step 4: Python 运行环境初始化与依赖安装
            // ==========================================
            if (progress != null) progress(60, "正在配置 Python 运行环境...", "Python 初始化");
            string sysPyBase = FindSystemPythonBase();
            string reqFile = Path.Combine(appSrcDir, "backend", "requirements-runtime.txt");

            if (!string.IsNullOrEmpty(sysPyBase) && File.Exists(sysPyBase))
            {
                // 分支 A: 检测到兼容的 64 位系统 Python 3.10~3.12 -> 创建专属隔离 venv
                if (logCallback != null) logCallback("检测到兼容的 64 位系统 Python 3.10~3.12: " + sysPyBase + "，正在创建隔离虚拟环境...");
                string venvDir = Path.Combine(runtimeDir, "venv");
                string venvPy = Path.Combine(venvDir, "Scripts", "python.exe");

                if (!File.Exists(venvPy))
                {
                    if (Directory.Exists(venvDir))
                    {
                        try { Directory.Delete(venvDir, true); } catch { }
                    }

                    var psi = new ProcessStartInfo
                    {
                        FileName = sysPyBase,
                        Arguments = string.Format("-m venv \"{0}\"", venvDir),
                        WorkingDirectory = appSrcDir,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true
                    };
                    using (var proc = Process.Start(psi))
                    {
                        bool exited = proc.WaitForExit(45000);
                        if (!exited)
                        {
                            try { proc.Kill(); } catch { }
                            throw new TimeoutException("创建 Python 虚拟环境超时 (45 秒)。");
                        }
                    }
                }

                if (File.Exists(venvPy))
                {
                    InstallPipRequirements(venvPy, reqFile, progress, logCallback);
                }
                else
                {
                    throw new InvalidOperationException("创建 Python 虚拟环境失败: " + venvDir);
                }
            }
            else
            {
                // 分支 B: 未检测到兼容系统 Python -> 下载官方固定 Python 3.11.9 Embeddable
                if (logCallback != null) logCallback("未检测到兼容的 64 位系统 Python 3.10~3.12，正在下载官方 Python 3.11.9 便携版...");
                string pyEmbedZip = Path.Combine(downloadsDir, "python-3.11.9-embed-amd64.zip");
                DownloadFileWithFallback(PythonEmbedUrls, pyEmbedZip, PythonEmbedSha256, progress, "Python 3.11.9 嵌入式运行环境");

                string pyEmbedDir = Path.Combine(runtimeDir, "python");
                if (!File.Exists(Path.Combine(pyEmbedDir, "python.exe")))
                {
                    if (Directory.Exists(pyEmbedDir))
                    {
                        try { Directory.Delete(pyEmbedDir, true); } catch { }
                    }
                    Directory.CreateDirectory(pyEmbedDir);
                    if (progress != null) progress(70, "正在解压 Python 运行时...", "本地解压");
                    ZipFile.ExtractToDirectory(pyEmbedZip, pyEmbedDir);
                }

                // 配置 python311._pth 启用 Lib\site-packages
                string pthFile = Path.Combine(pyEmbedDir, "python311._pth");
                string pthContent = "python311.zip\r\n.\r\nLib\r\nLib\\site-packages\r\nimport site\r\n";
                File.WriteAllText(pthFile, pthContent, Encoding.ASCII);
                Directory.CreateDirectory(Path.Combine(pyEmbedDir, "Lib", "site-packages"));

                string embedPy = Path.Combine(pyEmbedDir, "python.exe");

                // 使用内置随包分发的静态 get-pip.py 并进行严格 SHA-256 校验 (严禁网络下载)
                string getPipPy = Path.Combine(appSrcDir, "bootstrap", "get-pip.py");
                if (!File.Exists(getPipPy))
                {
                    // 兼容开发路径
                    string altGetPip = Path.Combine(appSrcDir, "..", "packaging", "windows", "assets", "get-pip.py");
                    if (File.Exists(altGetPip)) getPipPy = altGetPip;
                }

                if (!File.Exists(getPipPy))
                {
                    throw new FileNotFoundException("未在安装包中找到内置的 get-pip.py 初始化脚本: " + getPipPy);
                }

                if (!VerifyFileHash(getPipPy, StaticGetPipSha256))
                {
                    throw new InvalidOperationException("内置 get-pip.py 脚本的 SHA-256 校验未通过，已被安全拦截！");
                }

                // 将 pip 模块解包初始化至 embeddable Python
                if (progress != null) progress(80, "正在初始化 Python pip 模块...", "pip 静态初始化");
                var psiPip = new ProcessStartInfo
                {
                    FileName = embedPy,
                    Arguments = string.Format("\"{0}\"", getPipPy),
                    WorkingDirectory = pyEmbedDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var proc = Process.Start(psiPip))
                {
                    proc.OutputDataReceived += (s, e) => { if (e.Data != null && logCallback != null) logCallback(e.Data); };
                    proc.ErrorDataReceived += (s, e) => { if (e.Data != null && logCallback != null) logCallback(e.Data); };
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    bool exited = proc.WaitForExit(60000);
                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        throw new TimeoutException("pip 模块初始化超时 (60 秒)。");
                    }
                }

                // 安装锁定版本依赖
                InstallPipRequirements(embedPy, reqFile, progress, logCallback);
            }

            if (progress != null) progress(100, "所有运行环境与依赖组件准备完毕！", "就绪");
            if (logCallback != null) logCallback("依赖初始化全部完成！");
        }

        private static void InstallPipRequirements(
            string pythonExe,
            string reqFile,
            ProgressCallback progress,
            Action<string> logCallback)
        {
            if (!File.Exists(reqFile)) return;

            bool pipOk = false;
            foreach (var mirror in PyPiIndexUrls)
            {
                string host = new Uri(mirror).Host;
                if (progress != null) progress(85, "正在安装 Python 核心依赖 (源: " + host + ")...", host);
                if (logCallback != null) logCallback(string.Format("正在通过 PyPI 镜像 {0} 安装最小锁定依赖...", mirror));

                var psi = new ProcessStartInfo
                {
                    FileName = pythonExe,
                    Arguments = string.Format("-m pip install -r \"{0}\" -i {1} --trusted-host {2} --timeout 60", reqFile, mirror, host),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var proc = Process.Start(psi))
                {
                    proc.OutputDataReceived += (s, e) => { if (e.Data != null && logCallback != null) logCallback(e.Data); };
                    proc.ErrorDataReceived += (s, e) => { if (e.Data != null && logCallback != null) logCallback(e.Data); };
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    
                    bool exited = proc.WaitForExit(180000);
                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        if (logCallback != null) logCallback(string.Format("PyPI 源 {0} 安装超时 (180 秒)，已终止进程。", host));
                    }
                    else if (proc.ExitCode == 0)
                    {
                        pipOk = true;
                        if (logCallback != null) logCallback("Python 核心依赖包安装成功！");
                        break;
                    }
                }
            }

            if (!pipOk)
            {
                throw new InvalidOperationException("Python 运行时依赖安装失败，请检查网络或镜像源连接。");
            }
        }
    }
}
