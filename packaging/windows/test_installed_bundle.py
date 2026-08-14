import os
import sys
import json
import time
import shutil
import socket
import zipfile
import hashlib
import subprocess
import urllib.request
import urllib.error

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RELEASE_EXE = os.path.join(PROJECT_ROOT, "release", "Bijia-Setup-20260814.exe")
TEST_EXTRACT_DIR = os.path.join(PROJECT_ROOT, "packaging", ".test_extracted_bundle")
TEST_USER_DATA = os.path.join(PROJECT_ROOT, "packaging", ".test_user_data")
EXPECTED_GET_PIP_SHA256 = "6781f14504abd8827af046c405fb08acf78ea886d57f039347caf05e0b3fbf9c"


def find_free_port(start_port: int = 8970) -> int:
    for port in range(start_port, start_port + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("无法找到可用本地端口")


def test_thin_bundle_end_to_end():
    print(f"\n[1/7] 正在检查轻量化单文件安装包: {RELEASE_EXE}")
    sys.stdout.flush()
    assert os.path.exists(RELEASE_EXE), f"安装包 {RELEASE_EXE} 不存在！"
    
    exe_size_bytes = os.path.getsize(RELEASE_EXE)
    exe_size_mb = round(exe_size_bytes / (1024 * 1024), 2)
    exe_size_kb = round(exe_size_bytes / 1024, 2)
    print(f"  安装包体积: {exe_size_mb} MB ({exe_size_kb} KB)")
    
    # 严格断言：轻量化安装包体积必须小于 10 MB
    assert exe_size_mb < 10, f"安装包体积超标 ({exe_size_mb} MB >= 10 MB)！"
    print("  [OK] 安装包体积符合轻量化规范 (< 10 MB)。")

    print("\n[2/7] 正在从轻量化单文件安装包提取内嵌载荷...")
    sys.stdout.flush()
    with open(RELEASE_EXE, "rb") as f:
        data = f.read()

    zip_offset = data.find(b"PK\x03\x04")
    assert zip_offset != -1, "在安装包中未找到 ZIP PK 载荷特征头！"

    eocd_offset = data.rfind(b"PK\x05\x06")
    assert eocd_offset != -1, "在安装包中未找到 ZIP EOCD 结束签名！"
    comment_len = int.from_bytes(data[eocd_offset + 20:eocd_offset + 22], "little")
    zip_end = eocd_offset + 22 + comment_len

    zip_bytes = data[zip_offset:zip_end]
    temp_zip = os.path.join(PROJECT_ROOT, "packaging", ".temp_payload_test.zip")
    with open(temp_zip, "wb") as f:
        f.write(zip_bytes)

    if os.path.exists(TEST_EXTRACT_DIR):
        shutil.rmtree(TEST_EXTRACT_DIR, ignore_errors=True)
    os.makedirs(TEST_EXTRACT_DIR, exist_ok=True)

    with zipfile.ZipFile(temp_zip, "r") as zf:
        zf.extractall(TEST_EXTRACT_DIR)
    os.remove(temp_zip)

    print("\n[3/7] 正在校验轻量化文件结构、静态资源与禁止内嵌项...")
    sys.stdout.flush()
    expected_files = [
        "Bijia.exe",
        "Uninstall.exe",
        "app.ico",
        os.path.join("app_src", "run_server.py"),
        os.path.join("app_src", "backend", "main.py"),
        os.path.join("app_src", "backend", "requirements-runtime.txt"),
        os.path.join("app_src", "bootstrap", "get-pip.py"),
        os.path.join("app_src", "vendor", "1688-cli", "dist", "cli.js"),
        os.path.join("app_src", "vendor", "1688-cli", "package.json"),
        os.path.join("app_src", "vendor", "1688-cli", "package-lock.json"),
    ]

    for ef in expected_files:
        p = os.path.join(TEST_EXTRACT_DIR, ef)
        assert os.path.exists(p), f"缺少关键应用文件: {ef}"
        print(f"  [OK] 存在: {ef}")

    # 验证静态 get-pip.py SHA-256 完整性
    get_pip_extracted = os.path.join(TEST_EXTRACT_DIR, "app_src", "bootstrap", "get-pip.py")
    extracted_get_pip_hash = hashlib.sha256(open(get_pip_extracted, "rb").read()).hexdigest()
    assert extracted_get_pip_hash == EXPECTED_GET_PIP_SHA256, "解包出的 get-pip.py SHA-256 校验失败！"
    print(f"  [OK] 静态 get-pip.py 校验通过 (SHA-256: {extracted_get_pip_hash[:16]}...)")

    # 严禁内嵌 bulky 运行时目录
    prohibited_dirs = [
        os.path.join(TEST_EXTRACT_DIR, "runtime"),
        os.path.join(TEST_EXTRACT_DIR, "runtime", "python"),
        os.path.join(TEST_EXTRACT_DIR, "runtime", "node"),
        os.path.join(TEST_EXTRACT_DIR, "runtime", "playwright_browsers"),
        os.path.join(TEST_EXTRACT_DIR, "app_src", "vendor", "1688-cli", "node_modules"),
        os.path.join(TEST_EXTRACT_DIR, "app_src", ".venv"),
    ]
    for pd in prohibited_dirs:
        assert not os.path.exists(pd), f"轻量化规则违规：禁止在安装包中内嵌目录: {pd}"
    print("  [OK] 轻量化校验通过：未内嵌 Python、Node、Playwright Chromium 或 node_modules！")

    print("\n[4/7] 正在严格扫描解包内容是否包含敏感文件...")
    sys.stdout.flush()
    forbidden_hits = []
    for root, dirs, files in os.walk(TEST_EXTRACT_DIR):
        for file in files:
            full_p = os.path.join(root, file)
            rel_p = os.path.relpath(full_p, TEST_EXTRACT_DIR).replace("\\", "/").lower()
            name_lower = file.lower()
            ext_lower = os.path.splitext(name_lower)[1]
            parts = rel_p.split("/")

            if name_lower in [".env", "taobao.json", "bijia.db", "id_rsa", "id_ed25519"]:
                forbidden_hits.append(rel_p)
            elif ext_lower in [".db", ".sqlite", ".sqlite3", ".log", ".cookie", ".session", ".token"]:
                forbidden_hits.append(rel_p)
            elif parts[0] == "app_src" and len(parts) > 1 and parts[1] in ["cookies", "browser_profiles", "data"]:
                if name_lower != ".gitkeep":
                    forbidden_hits.append(rel_p)
            elif parts[0] == "app_src" and ext_lower in [".key", ".pem"]:
                forbidden_hits.append(rel_p)

    assert len(forbidden_hits) == 0, f"解包检测到敏感残留文件: {forbidden_hits}"
    print("  [OK] 隐私扫描通过：零敏感凭据、零数据库残留！")

    print("\n[5/7] 正在测试本机系统浏览器检测逻辑 (Chrome / Edge 优先复用)...")
    sys.stdout.flush()
    sys.path.insert(0, os.path.join(TEST_EXTRACT_DIR, "app_src"))
    from browser.profile_manager import ProfileManager
    detected_browser = ProfileManager.find_system_browser()
    assert detected_browser is not None, "未检测到本机已安装的 Chrome 或 Edge 浏览器！"
    assert os.path.isfile(detected_browser), f"浏览器路径无效: {detected_browser}"
    print(f"  [OK] 成功复用本机已安装浏览器: {detected_browser}")

    print("\n[6/7] 正在执行全链路服务拉起、探活与数据隔离测试...")
    sys.stdout.flush()
    test_port = find_free_port(8970)
    print(f"  分配测试端口: {test_port}")

    if os.path.exists(TEST_USER_DATA):
        shutil.rmtree(TEST_USER_DATA, ignore_errors=True)
    os.makedirs(TEST_USER_DATA, exist_ok=True)

    test_data_dir = os.path.join(TEST_USER_DATA, "data")
    test_profiles_dir = os.path.join(TEST_USER_DATA, "browser_profiles")
    test_cookies_dir = os.path.join(TEST_USER_DATA, "cookies")
    test_logs_dir = os.path.join(TEST_USER_DATA, "logs")
    test_1688_dir = os.path.join(TEST_USER_DATA, "1688")

    for d in [test_data_dir, test_profiles_dir, test_cookies_dir, test_logs_dir, test_1688_dir]:
        os.makedirs(d, exist_ok=True)

    app_src_dir = os.path.join(TEST_EXTRACT_DIR, "app_src")
    run_server_py = os.path.join(app_src_dir, "run_server.py")
    server_log_path = os.path.join(test_logs_dir, "server.log")

    # 使用包含依赖的 Python 解释器运行解包出的源码（离线集成测试）
    venv_py = os.path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
    active_python = venv_py if os.path.exists(venv_py) else sys.executable
    venv_sp = os.path.join(PROJECT_ROOT, ".venv", "Lib", "site-packages")

    test_env = os.environ.copy()
    test_env["BIJIA_APP_ROOT"] = app_src_dir
    test_env["BIJIA_DATA_DIR"] = test_data_dir
    test_env["BIJIA_PROFILES_DIR"] = test_profiles_dir
    test_env["BIJIA_COOKIES_DIR"] = test_cookies_dir
    test_env["BIJIA_LOGS_DIR"] = test_logs_dir
    test_env["BB1688_HOME"] = test_1688_dir
    test_env["CHROME_PATH"] = detected_browser
    test_env["CHROME_BIN"] = detected_browser
    test_env["EDGE_PATH"] = detected_browser
    test_env["PYTHONUNBUFFERED"] = "1"
    test_env["PYTHONIOENCODING"] = "utf-8"
    
    python_paths = [app_src_dir, os.path.join(app_src_dir, "vendor", "cn-scraper-mcp", "src")]
    if os.path.exists(venv_sp):
        python_paths.append(venv_sp)
    test_env["PYTHONPATH"] = os.pathsep.join(python_paths)

    log_handle = open(server_log_path, "w", encoding="utf-8")
    server_cmd = [
        active_python,
        run_server_py,
        "--port", str(test_port),
        "--host", "127.0.0.1",
        "--no-browser"
    ]
    proc = subprocess.Popen(
        server_cmd,
        cwd=app_src_dir,
        env=test_env,
        stdout=log_handle,
        stderr=subprocess.STDOUT
    )

    try:
        health_url = f"http://127.0.0.1:{test_port}/api/health"
        root_url = f"http://127.0.0.1:{test_port}/"
        print(f"  正在轮询探活接口: {health_url}")
        sys.stdout.flush()

        health_ok = False
        start_time = time.time()
        while time.time() - start_time < 30:
            try:
                req = urllib.request.Request(health_url, headers={"User-Agent": "BijiaThinTest/1.0"})
                with urllib.request.urlopen(req, timeout=2) as response:
                    if response.status == 200:
                        body_raw = response.read().decode("utf-8")
                        body = json.loads(body_raw)
                        if body.get("status") in ("ok", "healthy") or "status" in body:
                            health_ok = True
                            print(f"  [OK] 服务健康检查响应成功 (耗时 {round(time.time() - start_time, 2)}s): {body}")
                            break
            except Exception:
                pass
            time.sleep(0.5)

        if not health_ok:
            log_handle.flush()
            if os.path.exists(server_log_path):
                with open(server_log_path, "r", encoding="utf-8", errors="replace") as lf:
                    print("=== 服务启动失败日志 ===")
                    print(lf.read())
            raise AssertionError("服务启动或 /api/health 健康探活超时失败！")

        print(f"  正在请求前端静态主页: {root_url}")
        sys.stdout.flush()
        req_ui = urllib.request.Request(root_url, headers={"User-Agent": "BijiaThinTest/1.0"})
        with urllib.request.urlopen(req_ui, timeout=5) as response:
            assert response.status == 200, f"前端根路由返回状态码: {response.status}"
            html_text = response.read().decode("utf-8", errors="replace")
            assert "<!DOCTYPE html>" in html_text or "<html" in html_text or "比价" in html_text or "title" in html_text, "前端未正确渲染 HTML 首页！"
            print("  [OK] 前端静态 Web UI 页面加载成功！")

        print("  正在检查用户隔离目录写入状态...")
        db_file = os.path.join(test_data_dir, "bijia.db")
        assert os.path.exists(db_file), f"SQLite 数据库未在指定数据目录生成: {db_file}"
        assert os.path.exists(test_1688_dir), "1688 数据隔离目录不存在！"
        print("  [OK] 数据与登录状态隔离目录写入校验通过！")

    finally:
        print("\n[7/7] 正在停止服务进程并清理测试环境...")
        sys.stdout.flush()
        try:
            log_handle.close()
        except Exception:
            pass
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass

        shutil.rmtree(TEST_EXTRACT_DIR, ignore_errors=True)
        shutil.rmtree(TEST_USER_DATA, ignore_errors=True)
        print("  [OK] 测试环境与临时进程已清理干净。")

    print("\n==================================================")
    print(" 轻量化在线引导式安装包全链路端到端验收测试 100% 通过！")
    print("==================================================")
    sys.stdout.flush()


if __name__ == "__main__":
    test_thin_bundle_end_to_end()
