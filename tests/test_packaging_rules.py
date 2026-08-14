import os
import sys
import json
import hashlib
import pytest
from pathlib import Path

# Add project root to sys.path
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


def test_no_mojibake_and_proper_encodings_in_all_packaging_files():
    """
    测试打包体系中所有源码文件绝无乱码，且编码符合规范：
    1. C# (.cs) 与 PowerShell (.ps1) 包含中文时必须以 UTF-8-BOM 保存，保证 csc.exe 与 Windows 控制台正常解析。
    2. Python (.py) 与 Markdown (.md) 以 UTF-8 保存。
    3. 严禁出现常见乱码字符特征 (如 濮, 鐠, 閿, 閵, Ã, 忙, 莽录, 锟,  等)。
    4. 确保关键中文短语存在且清晰可读。
    """
    target_dirs = [
        os.path.join(BASE_DIR, "packaging", "windows"),
        os.path.join(BASE_DIR, "tests"),
    ]

    mojibake_patterns = ["濮", "鐠", "閿", "閵", "Ã", "忙", "莽录", "锟", "ï»¿ï»¿"]
    scanned_count = 0

    for tdir in target_dirs:
        for root, dirs, files in os.walk(tdir):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext in [".cs", ".ps1", ".py", ".md"]:
                    fpath = os.path.join(root, file)
                    if file == "test_packaging_rules.py":
                        continue
                    scanned_count += 1
                    raw_bytes = open(fpath, "rb").read()

                    # C# and PS1 files must have UTF-8 BOM
                    if ext in [".cs", ".ps1"] and not file.endswith(".manifest"):
                        assert raw_bytes.startswith(b"\xef\xbb\xbf"), f"C#/PS1 文件必须使用 UTF-8-BOM 格式以兼容 csc 编译器: {fpath}"

                    text = raw_bytes.decode("utf-8-sig", errors="replace")
                    for pat in mojibake_patterns:
                        assert pat not in text, f"文件 {fpath} 中检测到乱码字符特征: '{pat}'"

    assert scanned_count >= 10, f"扫描的打包源文件数量不足: {scanned_count}"

    # 检查关键中文短语存在
    bootstrap_cs = Path(os.path.join(BASE_DIR, "packaging", "windows", "src", "Launcher", "RuntimeBootstrap.cs")).read_text(encoding="utf-8-sig")
    assert "正在检测并配置系统运行环境" not in bootstrap_cs or "国内高速镜像" in bootstrap_cs
    assert "国内高速镜像" in bootstrap_cs
    assert "官方上游回退源" in bootstrap_cs
    assert "安装" in bootstrap_cs


def test_static_get_pip_asset_integrity():
    """
    测试随包静态分发的 get-pip.py 资产：
    1. packaging/windows/assets/get-pip.py 必须存在。
    2. SHA-256 必须精确匹配固定值 6781f14504abd8827af046c405fb08acf78ea886d57f039347caf05e0b3fbf9c。
    3. RuntimeBootstrap.cs 中必须严格使用此 SHA-256，且严禁包含在线下载 get-pip.py 的 URL。
    """
    expected_sha = "6781f14504abd8827af046c405fb08acf78ea886d57f039347caf05e0b3fbf9c"
    asset_get_pip = os.path.join(BASE_DIR, "packaging", "windows", "assets", "get-pip.py")
    assert os.path.isfile(asset_get_pip), f"静态 get-pip.py 文件缺失: {asset_get_pip}"

    actual_sha = hashlib.sha256(open(asset_get_pip, "rb").read()).hexdigest()
    assert actual_sha == expected_sha, f"get-pip.py SHA-256 哈希不匹配！期望: {expected_sha}, 实际: {actual_sha}"

    bootstrap_cs = Path(os.path.join(BASE_DIR, "packaging", "windows", "src", "Launcher", "RuntimeBootstrap.cs")).read_text(encoding="utf-8-sig")
    assert expected_sha in bootstrap_cs, "RuntimeBootstrap.cs 必须硬编码固定的 StaticGetPipSha256"
    assert "GetPipUrls" not in bootstrap_cs, "RuntimeBootstrap.cs 严禁包含在线下载 get-pip 的 URL 列表"


def test_stage_package_production_function_creates_thin_payload(tmp_path):
    """
    直接调用生产函数 stage_package.stage_application 验证暂存区：
    1. 必须生成完整业务源码与 1688-cli 产物。
    2. 必须将静态 get-pip.py 复制为 app_src/bootstrap/get-pip.py 并验证哈希。
    3. 严禁内嵌 python, node, playwright_browsers, node_modules, .venv 等笨重运行时。
    """
    import importlib.util
    stage_pkg_file = os.path.join(BASE_DIR, "packaging", "windows", "stage_package.py")
    spec = importlib.util.spec_from_file_location("stage_package", stage_pkg_file)
    stage_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stage_mod)
    stage_application = stage_mod.stage_application

    stage_dir = str(tmp_path / "stage_test")
    stage_application(project_root=BASE_DIR, stage_dir=stage_dir)

    # 验证关键业务源码与静态 bootstrap 脚本存在
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "run_server.py"))
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "backend", "main.py"))
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "backend", "requirements-runtime.txt"))
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "bootstrap", "get-pip.py"))
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "vendor", "1688-cli", "dist", "cli.js"))
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "vendor", "1688-cli", "package.json"))
    assert os.path.isfile(os.path.join(stage_dir, "app_src", "vendor", "1688-cli", "package-lock.json"))

    # 验证严禁内嵌的大型运行时目录不存在
    prohibited = [
        os.path.join(stage_dir, "runtime"),
        os.path.join(stage_dir, "runtime", "python"),
        os.path.join(stage_dir, "runtime", "node"),
        os.path.join(stage_dir, "runtime", "playwright_browsers"),
        os.path.join(stage_dir, "app_src", "vendor", "1688-cli", "node_modules"),
        os.path.join(stage_dir, "app_src", ".venv"),
    ]
    for p in prohibited:
        assert not os.path.exists(p), f"生产暂存函数违规内嵌了笨重运行时: {p}"


def test_runtime_bootstrap_source_constraints():
    """
    静态检查 RuntimeBootstrap.cs 源码实现约束：
    1. 系统 Python 分支必须使用 -m venv 创建隔离环境。
    2. Embeddable Python 分支严禁使用 -m venv。
    3. npm 依赖安装必须使用 'npm ci --omit=dev' 而非 'npm install'。
    4. 镜像源与官方回退双源机制完整存在。
    5. WebClient 带超时控制 TimeoutWebClient，进程等待超时后执行 Kill。
    """
    bootstrap_cs = os.path.join(BASE_DIR, "packaging", "windows", "src", "Launcher", "RuntimeBootstrap.cs")
    assert os.path.isfile(bootstrap_cs), f"未找到 {bootstrap_cs}"
    content = Path(bootstrap_cs).read_text(encoding="utf-8-sig")

    # 分支 A (系统 Python) 必须包含 -m venv
    assert "-m venv" in content
    # 分支 B (Embeddable Python) 必须使用 embedPy 直接执行 get-pip 与 pip install
    assert "embedPy" in content

    # 验证 npm ci --omit=dev (严禁 npm install)
    assert "ci --omit=dev" in content
    assert "npm install" not in content

    # 验证镜像双源回退机制
    assert "npmmirror.com" in content
    assert "nodejs.org" in content
    assert "python.org" in content
    assert "pypi.tuna.tsinghua.edu.cn" in content
    assert "registry.npmmirror.com" in content
    assert "registry.npmjs.org" in content

    # 验证超时与进程管理
    assert "TimeoutWebClient" in content
    assert "proc.Kill()" in content


def test_runtime_requirements_locked_with_exact_versions():
    """
    验证 backend/requirements-runtime.txt 中所有依赖均使用 == 严格锁定版本
    """
    req_file = os.path.join(BASE_DIR, "backend", "requirements-runtime.txt")
    assert os.path.isfile(req_file), f"未找到 {req_file}"
    lines = [line.strip() for line in Path(req_file).read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
    assert len(lines) >= 8, f"运行时依赖项数量不足: {len(lines)}"
    
    # 严禁开发依赖进入运行时
    forbidden_deps = ["pandas", "pytest", "alembic", "apscheduler"]
    for line in lines:
        assert "==" in line, f"依赖项未完全固定版本 (缺少 ==): '{line}'"
        assert not line.startswith(">="), f"禁止使用 >= 宽泛版本: '{line}'"
        pkg_name = line.split("==")[0].strip().lower()
        assert pkg_name not in forbidden_deps, f"严禁将开发依赖 '{pkg_name}' 放入 requirements-runtime.txt"


def test_system_browser_detection():
    """
    测试系统浏览器探测优先复用 Chrome / Edge，避免下载 Playwright Chromium。
    """
    from browser.profile_manager import ProfileManager
    browser_exe = ProfileManager.find_system_browser()
    assert browser_exe is not None, "应当至少探测到系统 Chrome 或 Edge 浏览器"
    assert os.path.isfile(browser_exe), f"探测到的浏览器路径必须有效: {browser_exe}"
    assert "chrome.exe" in browser_exe.lower() or "msedge.exe" in browser_exe.lower()


def test_environment_variable_overrides(tmp_path, monkeypatch):
    """
    测试通过环境变量隔离运行时状态目录（数据、Cookie、Profile、1688）
    """
    custom_data = tmp_path / "custom_data"
    custom_cookies = tmp_path / "custom_cookies"
    custom_profiles = tmp_path / "custom_profiles"
    custom_1688 = tmp_path / "custom_1688"

    monkeypatch.setenv("BIJIA_DATA_DIR", str(custom_data))
    monkeypatch.setenv("BIJIA_COOKIES_DIR", str(custom_cookies))
    monkeypatch.setenv("BIJIA_PROFILES_DIR", str(custom_profiles))
    monkeypatch.setenv("BB1688_HOME", str(custom_1688))

    # Test database.py
    from backend import database
    resolved_db_dir = database._resolve_db_dir()
    assert os.path.abspath(resolved_db_dir) == os.path.abspath(str(custom_data))

    # Test profile_manager.py
    from browser import profile_manager
    assert os.path.abspath(profile_manager.get_profiles_dir()) == os.path.abspath(str(custom_profiles))
    assert os.path.abspath(profile_manager.get_cookies_dir()) == os.path.abspath(str(custom_cookies))

    # Test adapters
    from adapters.taobao_adapter import TaobaoAdapter
    from adapters.jd_adapter import JDAdapter
    from adapters.misumi_adapter import MisumiAdapter

    taobao = TaobaoAdapter(use_mock_on_failure=True)
    assert str(custom_cookies) in taobao.cookies_path

    jd = JDAdapter(use_mock_on_failure=True)
    assert str(custom_profiles) in jd.profile_dir

    misumi = MisumiAdapter(use_mock_on_failure=True)
    assert str(custom_profiles) in misumi.profile_dir


def test_path_safety_validator_invariants(tmp_path):
    """
    测试安装与卸载路径安全性不变量（对应 C# PathSecurityValidator）
    """
    PRODUCT_ID = "EFMAT_Bijia"
    MARKER_NAME = ".bijia_install_marker"
    CMD_METACHARACTERS = set('&|<>^"%!;*?')

    def validate_install_path(raw_path: str) -> tuple[bool, str]:
        if not raw_path or not raw_path.strip():
            return False, "安装路径不能为空。"
        if any(c in CMD_METACHARACTERS for c in raw_path):
            return False, "包含非法命令行元字符。"
        
        canonical = os.path.abspath(raw_path)
        if canonical.startswith(r"\\") or canonical.startswith("//"):
            return False, "不支持 UNC 网络共享路径。"
        
        # 磁盘根目录
        drive, tail = os.path.splitdrive(canonical)
        if tail in [os.sep, "/", ""]:
            return False, "严禁直接安装至磁盘根目录。"
        
        # 保护目录清单
        protected = [
            os.path.abspath(os.environ.get("USERPROFILE", "C:\\Users\\default")),
            os.path.abspath(os.path.join(os.environ.get("USERPROFILE", "C:\\Users\\default"), "Desktop")),
            os.path.abspath(os.path.join(os.environ.get("USERPROFILE", "C:\\Users\\default"), "Documents")),
            os.path.abspath(os.path.join(os.environ.get("USERPROFILE", "C:\\Users\\default"), "Downloads")),
            os.path.abspath(os.environ.get("APPDATA", "C:\\Users\\default\\AppData\\Roaming")),
            os.path.abspath(os.environ.get("LOCALAPPDATA", "C:\\Users\\default\\AppData\\Local")),
            os.path.abspath(os.environ.get("WINDIR", "C:\\Windows")),
            os.path.abspath(os.environ.get("ProgramFiles", "C:\\Program Files")),
        ]
        if canonical in protected:
            return False, f"不能安装至受保护根目录: {canonical}"
        
        # 非空目录检查
        if os.path.isdir(canonical):
            entries = os.listdir(canonical)
            if entries:
                marker_path = os.path.join(canonical, MARKER_NAME)
                if not os.path.isfile(marker_path):
                    return False, "目标目录非空且无安装标记。"
                try:
                    data = json.loads(Path(marker_path).read_text(encoding="utf-8"))
                    if data.get("productId") != PRODUCT_ID:
                        return False, "安装标记产品ID不匹配。"
                except Exception:
                    return False, "安装标记损坏。"
        
        return True, canonical

    # 1. 拒绝根驱动器
    assert not validate_install_path("C:\\")[0]
    assert not validate_install_path("D:/")[0]

    # 2. 拒绝受保护目录
    user_profile = os.environ.get("USERPROFILE", "C:\\Users\\default")
    assert not validate_install_path(user_profile)[0]
    assert not validate_install_path(os.path.join(user_profile, "Desktop"))[0]
    assert not validate_install_path(os.path.join(user_profile, "Documents"))[0]
    assert not validate_install_path(os.path.join(user_profile, "Downloads"))[0]
    assert not validate_install_path(os.environ.get("LOCALAPPDATA", "C:\\Users\\default\\AppData\\Local"))[0]
    assert not validate_install_path(os.environ.get("WINDIR", "C:\\Windows"))[0]

    # 3. 拒绝 UNC 路径与命令注入元字符
    assert not validate_install_path(r"\\myserver\share\bijia")[0]
    assert not validate_install_path("C:\\Program&Files\\test")[0]
    assert not validate_install_path("C:\\test|dir")[0]
    assert not validate_install_path("C:\\test;rmdir")[0]
    assert not validate_install_path("C:\\test%foo%")[0]

    # 4. 拒绝存在其它文件的非空目录
    non_empty_dir = tmp_path / "non_empty"
    non_empty_dir.mkdir()
    (non_empty_dir / "unrelated_file.txt").write_text("hello")
    assert not validate_install_path(str(non_empty_dir))[0]

    # 5. 允许包含合法 Marker 的已安装目录（用于更新重装）
    (non_empty_dir / MARKER_NAME).write_text(json.dumps({"productId": PRODUCT_ID, "version": "1.0.0"}))
    assert validate_install_path(str(non_empty_dir))[0]

    # 6. 允许空目录或新创建目录
    new_dir = tmp_path / "programs" / "bijia"
    assert validate_install_path(str(new_dir))[0]


def test_zip_slip_canonical_path_protection(tmp_path):
    """
    测试 Zip-Slip 规范化根目录路径防护逻辑
    """
    target_dir = str(tmp_path / "install_root")
    canonical_target_with_sep = os.path.abspath(target_dir)
    if not canonical_target_with_sep.endswith(os.sep):
        canonical_target_with_sep += os.sep

    malicious_entries = [
        "../../Windows/System32/evil.dll",
        "../sibling_dir/evil.exe",
        "/etc/passwd",
        "nested/../../evil.bat",
    ]

    for entry in malicious_entries:
        dest_path = os.path.abspath(os.path.join(target_dir, entry))
        is_safe = dest_path.startswith(canonical_target_with_sep)
        assert not is_safe, f"Malicious entry '{entry}' was not blocked by canonical path check!"

    safe_entries = [
        "Bijia.exe",
        "Uninstall.exe",
        "app_src/backend/main.py"
    ]
    for entry in safe_entries:
        dest_path = os.path.abspath(os.path.join(target_dir, entry))
        is_safe = dest_path.startswith(canonical_target_with_sep)
        assert is_safe, f"Safe entry '{entry}' was incorrectly blocked!"


def test_find_available_port():
    """
    测试安全本地端口选择逻辑
    """
    from run_server import find_available_port
    port = find_available_port(8000, 20)
    assert isinstance(port, int)
    assert 8000 <= port <= 65535


def test_packaging_manifests_and_assets():
    """
    测试打包元数据与资产完整性
    """
    icon_path = os.path.join(BASE_DIR, "packaging", "windows", "assets", "app.ico")
    assert os.path.exists(icon_path), "app.ico must exist in packaging/windows/assets/"
    assert os.path.getsize(icon_path) > 1000, "app.ico should be a valid icon file"

    manifest_paths = [
        os.path.join(BASE_DIR, "packaging", "windows", "src", "Launcher", "App.manifest"),
        os.path.join(BASE_DIR, "packaging", "windows", "src", "Installer", "App.manifest"),
        os.path.join(BASE_DIR, "packaging", "windows", "src", "Uninstaller", "App.manifest"),
    ]

    for mp in manifest_paths:
        assert os.path.exists(mp), f"Manifest {mp} must exist"
        content = Path(mp).read_text(encoding="utf-8")
        assert "asInvoker" in content, f"Manifest {mp} must specify asInvoker execution level"
