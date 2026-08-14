import os
os.environ["HTTP_PROXY"] = ""
os.environ["HTTPS_PROXY"] = ""
os.environ["http_proxy"] = ""
os.environ["https_proxy"] = ""

import requests
import urllib.parse

def fetch_1688_live(keyword: str):
    encoded_kw = urllib.parse.quote(keyword)
    url = f"https://s.1688.com/selloffer/offer_search.htm?keywords={encoded_kw}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9"
    }
    print(f"请求真实 1688 页面 (绕过本地未开启的代理): {url}")
    session = requests.Session()
    session.trust_env = False  # Ignore system proxies
    try:
        resp = session.get(url, headers=headers, timeout=10)
        print(f"HTTP Status: {resp.status_code}, Response Length: {len(resp.text)}")
        if "offer" in resp.text or "product" in resp.text:
            print("成功接收到 1688 页面 HTML 内容！")
        return resp.text
    except Exception as e:
        print(f"Fetch Error: {e}")
        return None

if __name__ == "__main__":
    fetch_1688_live("SKF 6205")
