# 工业标准品多平台询价与供应商比价系统 Windows 轻量化在线引导安装包

## 1. 交付目标与架构概览

本项目采用**轻量化在线引导安装包 (Thin Online Bootstrap Installer)** 架构，最终交付体积约 **2.5 MB**（低于 10 MB 硬性上限）的单文件 Windows 10/11 64 位安装程序（`release/Bijia-Setup-20260814.exe`）。

### 核心特性与架构优势：

1. **单文件极速分发 (体积 ~3 MB)**：
   - 安装包内仅包含系统核心业务源码、内置静态 `get-pip.py` 引导脚本（约 2.7 MB）、原生 C# 启动器 (`Bijia.exe`)、安全卸载向导 (`Uninstall.exe`)、应用图标与依赖引导管理器 (`RuntimeBootstrap.cs`)。
   - **绝不内嵌** 庞大的 Python 全量标准库、Node.js 运行时、Playwright Chromium 浏览器（约 250MB）或 50MB 的 `node_modules`。
   - 默认安装至当前用户目录 `%LOCALAPPDATA%\Programs\Bijia`，**无需管理员 UAC 提权**。

2. **智能本地依赖探测与系统浏览器复用 (Zero-Download on Supported PCs)**：
   - **浏览器优先复用**：启动时自动优先探测本机已安装的 **Google Chrome** 或 **Microsoft Edge**（Windows 10/11 默认预装），通过 `executable_path` 驱动 Playwright，**默认无需下载任何 Playwright Chromium**。仅当机器完全没有 Chrome 和 Edge 时，才从国内镜像下载固定的 Chrome for Testing 便携版。
   - **Node.js 探测与版本校验**：优先复用本机 PATH 或 `%LOCALAPPDATA%\EFMAT\Bijia\runtime\node\node.exe`，严格校验 64 位且版本 >= 18。若缺失则从国内镜像下载固定的 Node.js 22 LTS 便携版并自动校验 SHA-256。
   - **Python 探测与应用专属隔离 venv**：优先复用本机 64 位 Python 3.10~3.12 并在 `%LOCALAPPDATA%\EFMAT\Bijia\runtime\venv` 创建应用专属虚拟环境；若无系统 Python 则下载官方 Python 3.11.9 embeddable，配置 `Lib\site-packages` 并直接运行（不执行 `-m venv`）。仅安装 `backend/requirements-runtime.txt` 中的最小锁定依赖（全量使用 `==` 固定版本）。

3. **内置离线 pip 引导与零脚本下载**：
   - `get-pip.py` 内封装 PyPI 官方 `pip 24.0` wheel；wheel 的官方 SHA-256 为 `ba0d021a166865d2265246961bec0152ff124de910c5cc39f1156ce3fa7c69dc`，脚本自身 SHA-256 为 `6781f14504abd8827af046c405fb08acf78ea886d57f039347caf05e0b3fbf9c`。
   - 启动器先校验脚本，脚本解码后再校验 wheel，双重校验通过才安装 pip；运行时不从网络下载任何引导脚本。

4. **国内 HTTPS 镜像源优先与官方上游自动回退 (Mirror-First + SHA-256 Pinning)**：
   - **Node.js 22 LTS**：优先 `npmmirror.com`，回退 `nodejs.org`（固定 SHA-256: `7c1eaee81aee348638977a4c7e600552b49c00b0e517865c3bbef4c9973fc7bc`）。
   - **Python 3.11.9**：优先 `npmmirror.com`，回退 `python.org`（固定 SHA-256: `28e6789b7e780775d79e56ef37d42cfdffebaece4eb721fe6387063c6cfc2f01`）。
   - **Chrome for Testing**：优先 `npmmirror.com`，回退 `storage.googleapis.com`（固定 SHA-256: `64a595cb0d6d5efce182b84cf829f0dae6bf1cb2196f7c9e078f4a7c156f4d2f`）。
   - **PyPI 依赖包安装**：优先清华大学镜像 (`pypi.tuna.tsinghua.edu.cn`) + 阿里云镜像 (`mirrors.aliyun.com`)，回退官方源 (`pypi.org`)。
   - **1688 npm 依赖安装**：携带 `package-lock.json`，使用 `npm ci --omit=dev`，优先 `registry.npmmirror.com`，回退官方源 (`registry.npmjs.org`)。

5. **可视化中文配置向导与秒级离线二次启动**：
   - 依赖缺失时弹出中文 WinForms 配置窗口，实时展示当前下载阶段、当前镜像源、进度百分比及诊断日志；提供重试与复制日志按钮，无黑框或静默终端弹窗。
   - 首次配置完成后，所有运行时缓存于 `%LOCALAPPDATA%\EFMAT\Bijia\runtime\`，**后续再次启动无需联网，1 秒内直接离线唤起**。

6. **破坏性卸载安全防御与用户数据隔离**：
   - **安装认证标记 (`.bijia_install_marker`)**：安装时在根目录写入产品 ID `EFMAT_Bijia`。
   - **严格禁止非法与危险路径**：拒绝安装/卸载至磁盘根目录、用户主目录、桌面、文档、下载、系统目录、Program Files、UNC 共享路径或带命令行元字符的路径。
   - **卸载 Fail-Closed 机制**：卸载时严格验证标记与路径，未通过校验绝不执行任何递归删除。
   - **用户数据专属持久化**：
     - 数据与数据库：`%LOCALAPPDATA%\EFMAT\Bijia\data\bijia.db`
     - 淘宝/天猫 Cookie：`%LOCALAPPDATA%\EFMAT\Bijia\cookies\taobao.json`
     - 京东/米思米 Profile：`%LOCALAPPDATA%\EFMAT\Bijia\browser_profiles\`
     - 1688 CLI 状态：`%LOCALAPPDATA%\EFMAT\Bijia\1688\`（通过 `BB1688_HOME` 强隔离）
     - 运行时缓存：`%LOCALAPPDATA%\EFMAT\Bijia\runtime\`
     - 运行日志：`%LOCALAPPDATA%\EFMAT\Bijia\logs\server.log`

---

## 2. 目录结构

```text
packaging/windows/
├── assets/
│   ├── app.ico                       # 高清应用图标 (16x16 ~ 256x256)
│   ├── generate_icon.py              # 图标生成脚本
│   └── get-pip.py                    # 内置静态 get-pip.py 引导脚本 (SHA-256 锁定)
├── src/
│   ├── Common/
│   │   └── PathSecurityValidator.cs  # 安装标记校验、保护目录拦截与路径安全
│   ├── Launcher/
│   │   ├── Program.cs                # 启动器入口、Mutex防多开、端口探测、托盘
│   │   ├── JobObject.cs              # Win32 JobObject 内核进程绑定
│   │   ├── RuntimeBootstrap.cs       # 依赖探测、镜像下载、SHA-256校验、venv/embed配置
│   │   ├── BootstrapForm.cs          # 中文依赖配置与下载进度对话框
│   │   └── App.manifest              # DPI感知与权限清单
│   ├── Installer/
│   │   ├── Program.cs                # 单文件轻量化安装向导
│   │   └── App.manifest
│   └── Uninstaller/
│       ├── Program.cs                # 安全卸载向导 (Fail-Closed)
│       └── App.manifest
├── stage_package.py                  # 轻量化暂存、严格排除规则与载荷压缩
├── build_windows_exe.ps1             # 自动化构建脚本 (PowerShell)
├── test_installed_bundle.py          # 轻量化安装包解包、体积、浏览器检测与端到端服务探活验收
└── README.md                         # 本说明文档
```

---

## 3. 构建与打包命令

在项目根目录下执行：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\windows\build_windows_exe.ps1
```

构建流水线将：
1. 运行全量自动化测试套件与安全约束测试。
2. 暂存轻量化业务源码（集成静态 `get-pip.py`）并执行敏感文件与重型运行时排除扫描。
3. 编译原生启动器 (`Bijia.exe`，集成 `RuntimeBootstrap.cs` 与 `BootstrapForm.cs`)、安全卸载器 (`Uninstall.exe`) 并生成压缩载荷（~2.2 MB）。
4. 编译单文件轻量化安装程序 `release/Bijia-Setup-20260814.exe`（体积约 2.3 MB，远低于 10 MB）。

---

## 4. 自动化测试与验收

```powershell
# 1. 运行全量单元测试与打包规则校验
.venv\Scripts\python.exe -m pytest

# 2. 运行轻量化安装包解包、体积检查 (<10MB)、浏览器探测与端到端服务探活验收
py -3 packaging/windows/test_installed_bundle.py
```

---

## 5. 代码签名与 Windows SmartScreen 说明

> [!WARNING]
> 本单文件分发包属于开源交付版本，未附加商业 EV/OV 代码签名证书。
> 在全新 Windows 机器上首次运行时可能出现 **「Windows 已保护你的电脑」 (SmartScreen)** 提示。
> **正常运行方式**：
> 点击窗口中的 **「更多信息」 (More info)** -> 点击 **「仍要运行」 (Run anyway)** 即可继续。
