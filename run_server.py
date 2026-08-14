import socket
import uvicorn
import webbrowser
import os

def find_available_port(start_port: int = 8000, max_attempts: int = 20) -> int:
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
    port = find_available_port(8000)
    url = f"http://127.0.0.1:{port}"
    print("==================================================")
    print(" 工业标准品多平台询价与供应商比价系统 启动中...")
    print(f" 浏览器打开: {url}")
    print(f" API 文档地址: {url}/docs")
    print("==================================================")
    
    # 自动打开浏览器
    try:
        webbrowser.open(url)
    except Exception:
        pass

    uvicorn.run("backend.main:app", host="127.0.0.1", port=port, reload=False)
