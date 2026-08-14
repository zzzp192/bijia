import pytest
import json
from types import SimpleNamespace
from adapters.alibaba1688_adapter import Alibaba1688Adapter

def test_1688_adapter_mock():
    adapter = Alibaba1688Adapter(use_mock_on_failure=True)
    results = adapter.search_and_parse(
        query_brand="SKF",
        query_model="6205-2Z/C3",
        quantity=10,
        force_mock=True
    )
    assert len(results) >= 2
    
    # 查找精确匹配与替代品
    exact = [r for r in results if r.match_level == "EXACT"]
    replacement = [r for r in results if r.match_level == "REPLACEMENT"]

    assert len(exact) > 0
    assert len(replacement) > 0
    assert exact[0].platform == "1688"
    assert exact[0].unit_price == 16.0  # qty 10 matches tier 5..19 -> 16.0
    assert adapter.last_data_source == "MOCK"

def test_cli_search_does_not_forge_detected_model(monkeypatch):
    adapter = Alibaba1688Adapter(use_mock_on_failure=False)
    payload = {
        "offers": [{
            "title": "SKF 6205-2Z/C3 深沟球轴承",
            "price": {"min": 16.0},
            "supplier": {"name": "测试供应商", "years": 3},
            "location": {"province": "江苏", "city": "无锡"},
            "url": "https://detail.1688.com/offer/1.html"
        }]
    }

    def fake_run(*args, **kwargs):
        assert kwargs["shell"] is False
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr("adapters.alibaba1688_adapter.subprocess.run", fake_run)
    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 10)

    assert len(results) == 1
    assert results[0].match_level == "HIGH"
    assert results[0].detected_model is None
    assert adapter.last_data_source == "LIVE_CLI"

def test_cli_pause_skips_browser_retry_and_marks_fallback(monkeypatch):
    adapter = Alibaba1688Adapter(use_mock_on_failure=True)
    paused = {"ok": False, "code": "DAEMON_PAUSED", "message": "paused"}
    monkeypatch.setattr(
        "adapters.alibaba1688_adapter.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=9, stdout="", stderr=json.dumps(paused)
        )
    )
    monkeypatch.setattr(
        adapter,
        "_fetch_via_persistent_profile",
        lambda *args: pytest.fail("paused login state must not retry Playwright")
    )

    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 10)

    assert results
    assert adapter.last_login_status == "PAUSED"
    assert adapter.last_data_source == "MOCK_FALLBACK"
    assert adapter.last_error_code == "DAEMON_PAUSED"
