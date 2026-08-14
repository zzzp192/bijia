import os
import sys
import argparse
import socket
import webbrowser
import uvicorn

# Ensure application root and vendor modules are on sys.path
_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
_CN_SCRAPER = os.path.join(_ROOT, "vendor", "cn-scraper-mcp", "src")
if os.path.isdir(_CN_SCRAPER) and _CN_SCRAPER not in sys.path:
    sys.path.insert(1, _CN_SCRAPER)


def find_available_port(start_port: int = 8000, max_attempts: int = 50) -> int:
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    # Fallback to system assigned random free port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="工业标准品多平台询价与供应商比价系统")
    parser.add_argument("--port", type=int, default=None, help="指定监听端口")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="指定监听主机")
    parser.add_argument("--no-browser", action="store_true", help="启动时不自动打开默认浏览器")
    args = parser.parse_args()

    port = args.port or find_available_port(8000)
    url = f"http://{args.host}:{port}"
    print("==================================================")
    print(" 工业标准品多平台询价与供应商比价系统 启动中...")
    print(f" 浏览器打开: {url}")
    print(f" API 文档地址: {url}/docs")
    print("==================================================")
    sys.stdout.flush()

    # 自动打开浏览器 (如果未禁用)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    uvicorn.run("backend.main:app", host=args.host, port=port, reload=False, app_dir=_ROOT)
