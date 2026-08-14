import os
import sys


UPSTREAM_SRC = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "vendor", "cn-scraper-mcp", "src"
)
if UPSTREAM_SRC not in sys.path:
    sys.path.insert(0, UPSTREAM_SRC)

from cn_scraper_mcp.engines import cdp
from cn_scraper_mcp.engines.jd import JDEngine


def test_windows_chrome_executable_path_is_normalized(monkeypatch, tmp_path):
    captured = []

    class FakeProcess:
        pid = 123

        def poll(self):
            return None

        def terminate(self):
            pass

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(
        cdp, "find_chrome",
        lambda: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    )
    monkeypatch.setattr(cdp, "_port_in_use", lambda port: False)
    monkeypatch.setattr(cdp, "is_chrome_running", lambda port: True)
    monkeypatch.setattr(
        cdp.subprocess, "Popen",
        lambda args, **kwargs: captured.append(args) or FakeProcess(),
    )

    cdp.launch_chrome(19247, str(tmp_path), url="about:blank")

    assert captured[0][0] == os.path.normpath(
        "C:/Program Files/Google/Chrome/Application/chrome.exe"
    )
    cdp.close_browser(19247)


def test_jd_frequent_access_page_is_risk_control_not_empty():
    assert JDEngine._detect_page_state(
        "https://search.jd.com/Search?keyword=SKF",
        "抱歉由于访问频繁导致无法搜索，请稍后再试！",
        0,
    ) == "captcha"
