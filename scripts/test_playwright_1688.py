import os
os.environ["HTTP_PROXY"] = ""
os.environ["HTTPS_PROXY"] = ""
os.environ["http_proxy"] = ""
os.environ["https_proxy"] = ""

from playwright.sync_api import sync_playwright

def run():
    print("正在通过 Playwright 启动 Chrome 抓取 1688 真实页面...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        url = "https://s.1688.com/selloffer/offer_search.htm?keywords=SKF%206205"
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        title = page.title()
        print(f"页面标题: {title}")
        items = page.query_selector_all(".sm-offer-item, .offer-list-item, [data-offer-id]")
        print(f"提取到的商品节点数量: {len(items)}")
        browser.close()

if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"Playwright 错误: {e}")
