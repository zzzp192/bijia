import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, BASE_DIR)

os.environ["HTTP_PROXY"] = ""
os.environ["HTTPS_PROXY"] = ""
os.environ["http_proxy"] = ""
os.environ["https_proxy"] = ""

from browser.profile_manager import ProfileManager

def open_login_gui(platform: str = "1688"):
    print("==================================================")
    print(f" 正在为平台 [{platform}] 打开专属可视化登录浏览器...")
    print(" 请在弹出的 Chrome 窗口中扫码或输入密码登录。")
    print(" 登录完成后，直接关闭 Chrome 窗口即可自动保存登录态！")
    print("==================================================")

    result = ProfileManager.launch_login_browser(platform)
    if result == "SUCCESS":
        print(f"{platform} 登录完成，窗口可以安全关闭。")
        return
    print(f"{platform} 登录未完成。请查看上方错误信息后重试。")
    if sys.stdin and sys.stdin.isatty():
        try:
            input("按回车键关闭此窗口...")
        except (EOFError, KeyboardInterrupt):
            pass

if __name__ == "__main__":
    plat = sys.argv[1] if len(sys.argv) > 1 else "1688"
    open_login_gui(plat)
