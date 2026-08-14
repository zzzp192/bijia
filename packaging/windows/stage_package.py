import os
import sys
import shutil
import zipfile
import hashlib
import argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

EXPECTED_GET_PIP_SHA256 = "6781f14504abd8827af046c405fb08acf78ea886d57f039347caf05e0b3fbf9c"


def compute_sha256(file_path: str) -> str:
    with open(file_path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def stage_application(project_root: str, stage_dir: str):
    print(f"=== [1/4] 正在准备轻量化 (Thin) 打包暂存区: {stage_dir} ===")
    if os.path.exists(stage_dir):
        shutil.rmtree(stage_dir, ignore_errors=True)
    os.makedirs(stage_dir, exist_ok=True)

    app_src_dir = os.path.join(stage_dir, "app_src")
    os.makedirs(app_src_dir, exist_ok=True)

    # 1. Check 1688 CLI requirements
    v1688_src = os.path.join(project_root, "vendor", "1688-cli")
    v1688_cli_js = os.path.join(v1688_src, "dist", "cli.js")
    if not os.path.isfile(v1688_cli_js):
        raise RuntimeError(f"构建失败：未找到 1688 CLI 编译产物: {v1688_cli_js}")

    # Copy application source trees (excluding bulky tests, venv, cache, database, logs)
    source_dirs = ["adapters", "backend", "browser", "fixtures", "frontend", "matching"]
    for sdir in source_dirs:
        src = os.path.join(project_root, sdir)
        dst = os.path.join(app_src_dir, sdir)
        if os.path.exists(src):
            shutil.copytree(
                src,
                dst,
                ignore=shutil.ignore_patterns(
                    "__pycache__", "*.pyc", "*.pyo", ".pytest_cache", ".git*", "*.db", "*.sqlite*", "*.log"
                )
            )

    # Copy scripts/open_login_browser.py
    os.makedirs(os.path.join(app_src_dir, "scripts"), exist_ok=True)
    shutil.copy2(
        os.path.join(project_root, "scripts", "open_login_browser.py"),
        os.path.join(app_src_dir, "scripts", "open_login_browser.py")
    )

    # Copy vendor dependencies without node_modules
    # 1688-cli: dist, package.json, package-lock.json, LICENSE
    v1688_dst = os.path.join(app_src_dir, "vendor", "1688-cli")
    os.makedirs(v1688_dst, exist_ok=True)
    for item in ["dist", "package.json", "package-lock.json", "LICENSE"]:
        src_item = os.path.join(v1688_src, item)
        dst_item = os.path.join(v1688_dst, item)
        if os.path.isdir(src_item):
            shutil.copytree(src_item, dst_item, ignore=shutil.ignore_patterns(".git*", "__pycache__"))
        elif os.path.isfile(src_item):
            shutil.copy2(src_item, dst_item)

    # cn-scraper-mcp: src only
    vcn_src = os.path.join(project_root, "vendor", "cn-scraper-mcp", "src")
    vcn_dst = os.path.join(app_src_dir, "vendor", "cn-scraper-mcp", "src")
    if os.path.exists(vcn_src):
        shutil.copytree(vcn_src, vcn_dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    # Copy static get-pip.py into app_src/bootstrap/get-pip.py (Zero runtime download)
    bootstrap_dir = os.path.join(app_src_dir, "bootstrap")
    os.makedirs(bootstrap_dir, exist_ok=True)
    get_pip_src = os.path.join(project_root, "packaging", "windows", "assets", "get-pip.py")
    if not os.path.isfile(get_pip_src):
        raise RuntimeError(f"构建失败：未找到静态 get-pip.py 资源文件: {get_pip_src}")

    get_pip_dst = os.path.join(bootstrap_dir, "get-pip.py")
    shutil.copy2(get_pip_src, get_pip_dst)

    # Verify SHA-256 of bundled get-pip.py
    actual_hash = compute_sha256(get_pip_dst)
    if actual_hash.lower() != EXPECTED_GET_PIP_SHA256.lower():
        raise RuntimeError(
            f"构建失败：get-pip.py SHA-256 哈希校验不匹配！期望: {EXPECTED_GET_PIP_SHA256}, 实际: {actual_hash}"
        )
    print(f"静态 get-pip.py 封装并校验通过 (SHA-256: {actual_hash[:16]}...)")

    # Copy root application files
    root_files = [
        "run_server.py", "README.md", "README_FIRST.txt",
        "CHANGELOG.md", "THIRD_PARTY.md", ".gitignore"
    ]
    for rf in root_files:
        src_f = os.path.join(project_root, rf)
        if os.path.exists(src_f):
            shutil.copy2(src_f, os.path.join(app_src_dir, rf))

    # 2. Strict Security, Privacy & Thin-Payload Verification
    print("=== [2/4] 执行严格安全、隐私与轻量化规则校验 ===")
    forbidden_violations = []
    bulky_violations = []

    for root, dirs, files in os.walk(stage_dir):
        for d in dirs:
            if d in ["python", "node", "playwright_browsers", "node_modules", ".venv"]:
                rel_d = os.path.relpath(os.path.join(root, d), stage_dir).replace("\\", "/")
                bulky_violations.append(rel_d)

        for f in files:
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, stage_dir).replace("\\", "/").lower()
            parts = rel_path.split("/")
            name_lower = f.lower()
            ext_lower = os.path.splitext(name_lower)[1]

            if name_lower in [".env", "taobao.json", "bijia.db", "id_rsa", "id_ed25519"]:
                forbidden_violations.append(rel_path)
            elif ext_lower in [".db", ".sqlite", ".sqlite3", ".log", ".cookie", ".session", ".token"]:
                forbidden_violations.append(rel_path)
            elif parts[0] == "app_src" and len(parts) > 1 and parts[1] in ["cookies", "browser_profiles", "data"]:
                if name_lower != ".gitkeep":
                    forbidden_violations.append(rel_path)
            elif parts[0] == "app_src" and ext_lower in [".key", ".pem"]:
                forbidden_violations.append(rel_path)

    if bulky_violations:
        raise RuntimeError(f"轻量化规则拦截：禁止在安装包中内嵌笨重运行时目录: {bulky_violations}")

    if forbidden_violations:
        raise RuntimeError(f"安全扫描检测到敏感运行时文件进入发布暂存区: {forbidden_violations}")

    print("安全与轻量化校验通过：零 Cookie、零数据库、零内嵌重型运行时！")
    sys.stdout.flush()


def create_payload_zip(stage_dir: str, zip_output_path: str):
    print(f"=== [3/4] 正在生成轻量化载荷压缩包: {zip_output_path} ===")
    os.makedirs(os.path.dirname(zip_output_path), exist_ok=True)
    if os.path.exists(zip_output_path):
        os.remove(zip_output_path)

    with zipfile.ZipFile(zip_output_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(stage_dir):
            for file in files:
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, stage_dir)
                zf.write(abs_path, rel_path)

    zip_size_mb = round(os.path.getsize(zip_output_path) / (1024 * 1024), 2)
    zip_size_kb = round(os.path.getsize(zip_output_path) / 1024, 2)
    print(f"轻量化载荷压缩完成！文件大小: {zip_size_kb} KB ({zip_size_mb} MB)")
    if zip_size_mb > 10:
        raise RuntimeError(f"轻量化压缩包体积超标 ({zip_size_mb} MB > 10 MB)！")
    sys.stdout.flush()


def cleanup_paths(*paths: str):
    for p in paths:
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", action="store_true", help="执行轻量化应用暂存")
    parser.add_argument("--zip", action="store_true", help="执行轻量化载荷压缩")
    parser.add_argument("--clean", action="store_true", help="清理临时文件")
    parser.add_argument("--project-root", default=os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
    parser.add_argument("--stage-dir", default="")
    parser.add_argument("--zip-path", default="")
    args = parser.parse_args()

    if args.stage:
        stage_application(
            project_root=os.path.abspath(args.project_root),
            stage_dir=os.path.abspath(args.stage_dir)
        )
    elif args.zip:
        create_payload_zip(
            stage_dir=os.path.abspath(args.stage_dir),
            zip_output_path=os.path.abspath(args.zip_path)
        )
    elif args.clean:
        cleanup_paths(os.path.abspath(args.stage_dir), os.path.abspath(args.zip_path))
