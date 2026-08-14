import os
import json
import subprocess
import sys
import time
from typing import Optional

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
PROFILES_DIR = os.path.join(BASE_DIR, "browser_profiles")
COOKIES_DIR = os.path.join(BASE_DIR, "cookies")
os.makedirs(PROFILES_DIR, exist_ok=True)
os.makedirs(COOKIES_DIR, exist_ok=True)

class ProfileManager:
    """
    专用浏览器 Profile 管理器
    实现人工扫码登录与 Cookie/Session 本地持久化隔离存储
    """
    @staticmethod
    def get_profile_dir(platform: str) -> str:
        pdir = os.path.join(PROFILES_DIR, f"{platform.lower()}_profile")
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

                # daemon 持有同一个 Profile 时，登录浏览器无法可靠取得锁；同时
                # daemon 的缓存身份可能已经过期。先停 daemon，再强制进行真实
                # headed 登录，避免命令因“缓存显示已登录”而瞬间退出。
                print(" 正在停止旧的 1688 后台会话...")
                subprocess.run(
                    ["node", cli_js, "daemon", "stop", "--profile", "default"],
                    cwd=upstream_1688,
                    env=cli_env,
                    shell=False,
                    check=False,
                )

                print(" 正在打开 1688 登录浏览器（最长等待 5 分钟）...")
                cmd = [
                    "node", cli_js, "login",
                    "--profile", "default",
                    "--headed",
                    "--force",
                    "--timeout", "300",
                    "--no-daemon",
                ]
                result = subprocess.run(
                    cmd,
                    cwd=upstream_1688,
                    env=cli_env,
                    shell=False,
                    check=False,
                )
                if result.returncode == 0:
                    print(" 登录成功，正在重新启动 1688 后台会话...")
                    daemon_result = subprocess.run(
                        ["node", cli_js, "daemon", "start", "--profile", "default"],
                        cwd=upstream_1688,
                        env=cli_env,
                        shell=False,
                        check=False,
                    )
                    if daemon_result.returncode != 0:
                        print(" 登录态已保存，但后台会话启动失败；首次查询时会自动重试。")
                    return "SUCCESS"
                print(f"1688-cli login 失败，退出码: {result.returncode}")
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
            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(
                    user_data_dir=pdir,
                    headless=False,
                    args=["--disable-blink-features=AutomationControlled"]
                )
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
        cookie_path = os.path.join(COOKIES_DIR, "taobao.json")
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=pdir,
                    headless=False,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--window-size=1200,800",
                    ],
                )
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
                        if item.get("value") and (
                            item.get("domain", "").endswith("taobao.com")
                            or item.get("domain", "").endswith("tmall.com")
                        )
                    }
                    # cookie2 可能在匿名会话中出现；必须同时看到明确身份 Cookie，
                    # 才能把本次操作判定为用户已完成登录。
                    logged_in = bool(cookie_dict.get("cookie2")) and any(
                        cookie_dict.get(name)
                        for name in ("unb", "tracknick", "lgc", "_nk_")
                    )
                    if logged_in and not warmed_up:
                        warmed_up = True
                        try:
                            page.goto(
                                "https://h5.m.taobao.com/",
                                wait_until="domcontentloaded",
                                timeout=15000,
                            )
                        except Exception:
                            pass
                        time.sleep(1)
                        continue
                    if logged_in and warmed_up:
                        cookies = context.cookies()
                        cookie_dict = {
                            item["name"]: item["value"]
                            for item in cookies
                            if item.get("value") and (
                                item.get("domain", "").endswith("taobao.com")
                                or item.get("domain", "").endswith("tmall.com")
                            )
                        }
                        ProfileManager._write_cookie_file(cookie_path, cookie_dict)
                        print(" 淘宝/天猫登录成功，登录态已保存。")
                        context.close()
                        return "SUCCESS"
                    time.sleep(1)

                try:
                    context.close()
                except Exception:
                    pass
                print(" 淘宝/天猫登录未完成或已超时。")
                return None
        except Exception as exc:
            print(f"启动淘宝登录浏览器出错: {exc}")
            return None

    @staticmethod
    def _launch_jd_login(pdir: str) -> Optional[str]:
        """使用与京东查询引擎完全相同的 Chrome Profile 完成人工登录。"""
        upstream_src = os.path.join(BASE_DIR, "vendor", "cn-scraper-mcp", "src")
        if upstream_src not in sys.path:
            sys.path.insert(0, upstream_src)
        try:
            from cn_scraper_mcp.engines.cdp import launch_chrome
            from cn_scraper_mcp.engines.jd import JD_PORT

            process = launch_chrome(
                JD_PORT,
                pdir,
                url="https://passport.jd.com/new/login.aspx",
                headless=False,
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

            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=pdir,
                    headless=False,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-proxy-server",
                        "--window-size=1280,900",
                    ],
                )
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
