import os
import sys
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

os.environ["HTTP_PROXY"] = ""
os.environ["HTTPS_PROXY"] = ""
os.environ["http_proxy"] = ""
os.environ["https_proxy"] = ""

from playwright.sync_api import sync_playwright
from browser.profile_manager import ProfileManager

def test_extract_1688_json():
    pdir = ProfileManager.get_profile_dir("1688")
    url = "https://s.1688.com/selloffer/offer_search.htm?keywords=SKF%206205"
    print("=== 尝试提取 1688 页面 JS 全局变量数据 ===")
    
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=pdir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"]
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)

        # 尝试提取 JavaScript 中的全局变量
        data = page.evaluate("""() => {
            return window.__INITIAL_DATA__ || window.__INIT_DATA__ || window.__CONTAINER_DATA__ || null;
        }""")

        if data:
            print("【成功找到 1688 JS 全局数据对象！】")
            print(f"数据 Keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
        else:
            print("未直接在 window 下查找到预置全局变量，分析 页面 text 与 a 标签...")
            links = page.evaluate("""() => {
                const anchors = Array.from(document.querySelectorAll('a[title]'));
                return anchors.map(a => ({ title: a.getAttribute('title'), href: a.href }));
            }""")
            print(f"找到含 title 属性的 a 标签数量: {len(links)}")
            for l in links[:5]:
                print(f" - 商品: {l['title']} | 链接: {l['href']}")

        context.close()

if __name__ == "__main__":
    test_extract_1688_json()
