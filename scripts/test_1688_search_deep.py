import os
import sys
import json
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

os.environ["HTTP_PROXY"] = ""
os.environ["HTTPS_PROXY"] = ""
os.environ["http_proxy"] = ""
os.environ["https_proxy"] = ""

from playwright.sync_api import sync_playwright
from browser.profile_manager import ProfileManager

def deep_test_1688():
    pdir = ProfileManager.get_profile_dir("1688")
    keyword = "SKF 6205"
    encoded_kw = urllib.parse.quote(keyword)
    url = f"https://s.1688.com/selloffer/offer_search.htm?keywords={encoded_kw}"

    print(f"=== 正在深度诊断 1688 真实搜索页面数据提取 ===")
    print(f"目标 URL: {url}")
    print(f"Profile 目录: {pdir}")

    with sync_playwright() as p:
        # 使用 stealth args + headful 或 stealth Chromium
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ]
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1440, "height": 900}
        )
        page = context.new_page()

        # 避免 navigator.webdriver 被检测
        page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        """)

        # 打开页面
        res = page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)
        
        print(f"页面响应 Code: {res.status if res else 'None'}")
        print(f"最终 Page Title: {page.title()}")

        # 检查是否含卡片
        html = page.content()
        print(f"HTML 源码长度: {len(html)}")

        # 保存临时 html 进行调试
        debug_html_path = os.path.join(os.path.dirname(__file__), "debug_1688_page.html")
        with open(debug_html_path, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"调试 HTML 已写入: {debug_html_path}")

        # 尝试使用 1688 的新版 CSS 选择器
        selectors = [
            ".sm-offer-item",
            ".offer-list-item",
            ".search-offer-item",
            "[data-offer-id]",
            ".common-offer-card",
            ".offer-card-item",
            ".space-offer-card",
            "div[data-tracker='offer']"
        ]
        
        found = False
        for s in selectors:
            elems = page.query_selector_all(s)
            if elems:
                print(f" 匹配选择器 '{s}' 成功，提取到 {len(elems)} 个商品节点！")
                found = True
                for i, el in enumerate(elems[:3], 1):
                    print(f"   [{i}] 节点文本: {el.inner_text()[:100]}...")
                break

        if not found:
            print(" 未匹配到常规选择器，尝试抓取所有 a 标签包含 '6205' 或 'SKF' 的链接...")
            anchors = page.query_selector_all("a[href*='detail.1688.com']")
            print(f" 找到包含 detail.1688.com 的商品链接数量: {len(anchors)}")
            for idx, a in enumerate(anchors[:5], 1):
                txt = a.inner_text().strip() or a.get_attribute("title") or "无标题"
                href = a.get_attribute("href")
                print(f"   [{idx}] {txt} -> {href}")

        browser.close()

if __name__ == "__main__":
    deep_test_1688()
