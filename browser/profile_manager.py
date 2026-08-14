import os
import glob
import json
import shutil
import subprocess
import sys
import time
from typing import Optional

def get_base_dir() -> str:
    override = os.getenv("BIJIA_APP_ROOT")
    if override:
        return os.path.abspath(override)
    return os.path.dirname(os.path.dirname(__file__))

def get_profiles_dir() -> str:
    override = os.getenv("BIJIA_PROFILES_DIR")
    if override:
        return os.path.abspath(override)
    data_dir = os.getenv("BIJIA_DATA_DIR")
    if data_dir:
        return os.path.join(os.path.abspath(data_dir), "browser_profiles")
    return os.path.join(get_base_dir(), "browser_profiles")

def get_cookies_dir() -> str:
    override = os.getenv("BIJIA_COOKIES_DIR")
    if override:
        return os.path.abspath(override)
    data_dir = os.getenv("BIJIA_DATA_DIR")
    if data_dir:
        return os.path.join(os.path.abspath(data_dir), "cookies")
    return os.path.join(get_base_dir(), "cookies")

BASE_DIR = get_base_dir()
PROFILES_DIR = get_profiles_dir()
COOKIES_DIR = get_cookies_dir()
os.makedirs(PROFILES_DIR, exist_ok=True)
os.makedirs(COOKIES_DIR, exist_ok=True)

class ProfileManager:
    """
    专用浏览器 Profile 管理器
    实现人工扫码登录与 Cookie/Session 本地持久化隔离存储
    """
    @staticmethod
    def find_system_browser() -> Optional[str]:
        """
        自动探测本机已安装的 Chrome 或 Edge 浏览器，避免下载庞大的 Playwright Chromium。
        优先级：
        1. 环境变量 (CHROME_PATH / CHROME_BIN / EDGE_PATH / BROWSER_PATH)
        2. Google Chrome (系统安装目录 / 用户目录)
        3. Microsoft Edge (Windows 10/11 预装浏览器)
        4. 应用专属运行时下载的 Chrome for Testing
        5. PATH 查找
        """
        for env_k in ("CHROME_PATH", "CHROME_BIN", "EDGE_PATH", "BROWSER_PATH"):
            v = os.environ.get(env_k)
            if v and os.path.isfile(v):
                return os.path.abspath(v)

        prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        prog_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local_app_data = os.environ.get("LOCALAPPDATA", "")

        candidates = [
            # Google Chrome
            os.path.join(prog_files, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(prog_files_x86, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(local_app_data, "Google", "Chrome", "Application", "chrome.exe"),
            # Microsoft Edge (Windows 默认预装)
            os.path.join(prog_files_x86, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(prog_files, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(local_app_data, "Microsoft", "Edge", "Application", "msedge.exe"),
            # App-owned runtime fallback
            os.path.join(local_app_data, "EFMAT", "Bijia", "runtime", "browser", "chrome.exe"),
            os.path.join(local_app_data, "EFMAT", "Bijia", "runtime", "browser", "chrome-win64", "chrome.exe"),
        ]

        for c in candidates:
            if c and os.path.isfile(c):
                return os.path.abspath(c)

        for candidate_name in ("chrome", "google-chrome", "msedge", "chromium"):
            found = shutil.which(candidate_name)
            if found:
                return os.path.abspath(found)

        return None

    @staticmethod
    def get_profile_dir(platform: str) -> str:
        profiles_dir = get_profiles_dir()
        pdir = os.path.join(profiles_dir, f"{platform.lower()}_profile")
        os.makedirs(pdir, exist_ok=True)
        return pdir

    @staticmethod
    def launch_login_browser(platform: str) -> Optional[str]:
        upstream_1688 = os.path.join(BASE_DIR, "vendor", "1688-cli")
        cli_js = os.path.join(upstream_1688, "dist", "cli.js")

        print("==================================================")
        print(f" 正在为平台 [{platform}] 启动专用登录浏览器...")
        print(f" 请在弹出的浏览器窗口中扫码或输入密码完成登录。")
        print("==================================================")

        if platform.lower() == "1688" and os.path.exists(cli_js):
            try:
                cli_env = os.environ.copy()
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    cli_env.pop(key, None)
                if "BB1688_HOME" not in cli_env:
                    base_data = os.environ.get("BIJIA_DATA_DIR")
                    if base_data:
                        bb_home = os.path.join(os.path.dirname(os.path.abspath(base_data)), "1688")
                        os.makedirs(bb_home, exist_ok=True)
                        cli_env["BB1688_HOME"] = bb_home

                subprocess.run(
                    ["node", cli_js, "daemon", "stop", "--profile", "default"],
                    cwd=upstream_1688,
                    env=cli_env,
                    shell=False,
                )
                login_res = subprocess.run(
                    [
                        "node", cli_js, "login", "--profile", "default", "--headed", "--force",
                        "--timeout", "300", "--no-daemon",
                    ],
                    cwd=upstream_1688,
                    env=cli_env,
                    shell=False,
                )
                if login_res.returncode == 0:
                    subprocess.run(
                        ["node", cli_js, "daemon", "start", "--profile", "default"],
                        cwd=upstream_1688,
                        env=cli_env,
                        shell=False,
                    )
                    return "SUCCESS"
                print(f"1688-cli login 失败，退出码: {login_res.returncode}")
                return None
            except Exception as e:
                print(f"1688-cli login 异常: {e}")
                return None

        if platform.lower() == "taobao":
            return ProfileManager._launch_taobao_login(pdir=ProfileManager.get_profile_dir(platform))

        if platform.lower() == "jd":
            return ProfileManager._launch_jd_login(pdir=ProfileManager.get_profile_dir(platform))

        if platform.lower() == "misumi":
            return ProfileManager._launch_misumi_login(pdir=ProfileManager.get_profile_dir(platform))

        # 备用 Playwright 窗口模式
        pdir = ProfileManager.get_profile_dir(platform)
        try:
            from playwright.sync_api import sync_playwright
            target_url = "https://login.1688.com/member/signin.htm" if platform.lower() == "1688" else "https://www.taobao.com"
            browser_exe = ProfileManager.find_system_browser()
            launch_args = {
                "user_data_dir": pdir,
                "headless": False,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--window-size=1200,800",
                ]
            }
            if browser_exe:
                launch_args["executable_path"] = browser_exe

            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(**launch_args)
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(target_url)
                context.wait_for_event("close", timeout=0)
            return "SUCCESS"
        except Exception as e:
            print(f"启动登录浏览器出错: {e}")
            return None

    @staticmethod
    def _launch_taobao_login(pdir: str, timeout_seconds: int = 300) -> Optional[str]:
        """打开淘宝登录页，并把当前用户自己的 Cookie 保存给 MTOP 引擎。"""
        cookie_path = os.path.join(get_cookies_dir(), "taobao.json")
        try:
            from playwright.sync_api import sync_playwright

            browser_exe = ProfileManager.find_system_browser()
            launch_args = {
                "user_data_dir": pdir,
                "headless": False,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--window-size=1200,800",
                ],
            }
            if browser_exe:
                launch_args["executable_path"] = browser_exe

            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(**launch_args)
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(
                    "https://login.taobao.com/member/login.jhtml",
                    wait_until="domcontentloaded",
                    timeout=30000,
                )
                print(" 请在浏览器中完成淘宝/天猫登录，登录态会自动保存。")

                deadline = time.time() + timeout_seconds
                warmed_up = False
                while time.time() < deadline and context.pages:
                    cookies = context.cookies()
                    cookie_dict = {
                        item["name"]: item["value"]
                        for item in cookies
                        if item.get("name") and item.get("value")
                    }

                    if "_m_h5_tk" in cookie_dict:
                        ProfileManager._write_cookie_file(cookie_path, cookie_dict)
                        print(f" 成功捕获淘宝/天猫 Cookie: {cookie_path}")

                        if not warmed_up and "_m_h5_tk" in cookie_dict:
                            try:
                                page.goto(
                                    "https://s.taobao.com/search?q=%E6%B5%8B%E8%AF%95",
                                    wait_until="domcontentloaded",
                                    timeout=10000,
                                )
                                warmed_up = True
                            except Exception:
                                pass

                        print(" 登录完成，您可以关闭该浏览器窗口。")
                        time.sleep(2)
                        return "SUCCESS"

                    time.sleep(1)

                return "SUCCESS" if os.path.exists(cookie_path) else None
        except Exception as exc:
            print(f"启动淘宝登录浏览器出错: {exc}")
            return None

    @staticmethod
    def _launch_jd_login(pdir: str) -> Optional[str]:
        """打开京东可视化浏览器并持久化独立 Profile。"""
        try:
            from cn_scraper_mcp.engines.cdp import launch_chrome

            process = launch_chrome(
                port=9222,
                user_data_dir=pdir,
                headless=False,
                url="https://passport.jd.com/new/login.aspx",
            )
            if process is None:
                print("京东登录浏览器未能启动。")
                return None
            print(" 请在京东窗口中完成登录，登录后直接关闭该窗口。")
            process.wait()
            print(" 京东登录窗口已关闭，Profile 登录态已保存。")
            return "SUCCESS"
        except Exception as exc:
            print(f"启动京东登录浏览器出错: {exc}")
            return None

    @staticmethod
    def _launch_misumi_login(pdir: str) -> Optional[str]:
        """打开米思米官网登录入口并持久化独立 Profile。"""
        try:
            from playwright.sync_api import sync_playwright

            browser_exe = ProfileManager.find_system_browser()
            launch_args = {
                "user_data_dir": pdir,
                "headless": False,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--no-proxy-server",
                    "--window-size=1280,900",
                ],
            }
            if browser_exe:
                launch_args["executable_path"] = browser_exe

            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(**launch_args)
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(
                    "https://www.misumi.com.cn/",
                    wait_until="domcontentloaded",
                    timeout=30000,
                )
                try:
                    page.get_by_text("登录", exact=True).first.click(timeout=10000)
                except Exception:
                    pass
                print(" 请在米思米窗口中完成登录，登录后直接关闭该窗口。")
                context.wait_for_event("close", timeout=0)
            return "SUCCESS"
        except Exception as exc:
            print(f"启动米思米登录浏览器出错: {exc}")
            return None

    @staticmethod
    def _write_cookie_file(path: str, cookies: dict) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temp_path = f"{path}.tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(cookies, handle, ensure_ascii=False)
        os.replace(temp_path, path)
