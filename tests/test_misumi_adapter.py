from adapters.misumi_adapter import MisumiAdapter


def test_misumi_mock_returns_catalog_series_as_possible():
    adapter = MisumiAdapter(use_mock_on_failure=True)

    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 10, force_mock=True)

    assert len(results) == 2
    assert {result.platform for result in results} == {"misumi"}
    assert {result.match_level for result in results} == {"POSSIBLE"}
    assert results[0].supplier_name == "米思米中国"
    assert results[0].supplier_type == "工业品目录平台"
    assert results[0].displayed_price == 28.4
    assert results[0].tax_included is False
    assert any("产品系列" in reason for reason in results[0].mismatch_reasons)


def test_misumi_live_result_status(monkeypatch):
    adapter = MisumiAdapter(use_mock_on_failure=False)
    monkeypatch.setattr(adapter, "_search_live", lambda keyword, limit: [{
        "id": "42",
        "name": "深沟球轴承 6205-2Z/C3",
        "brand": "斯凯孚(SKF)",
        "price": "￥35.60起",
        "delivery": "当天起",
        "url": "https://www.misumi.com.cn/vona2/detail/42/",
        "tax_included": False,
    }])

    results = adapter.search_and_parse("SKF", "6205-2Z/C3")

    assert len(results) == 1
    assert results[0].match_level == "HIGH"
    assert results[0].unit_price == 35.6
    assert adapter.last_data_source == "LIVE_MISUMI_BROWSER"
    assert adapter.last_login_status == "PUBLIC_OR_LOGGED_IN"


def test_misumi_waf_timeout_uses_marked_fallback(monkeypatch):
    adapter = MisumiAdapter(use_mock_on_failure=True)

    def fail(keyword, limit):
        raise TimeoutError("仍处于安全验证")

    monkeypatch.setattr(adapter, "_search_live", fail)
    results = adapter.search_and_parse("SKF", "6205-2Z/C3")

    assert results
    assert adapter.last_login_status == "RISK_CONTROL"
    assert adapter.last_error_code == "MISUMI_WAF_OR_TIMEOUT"
    assert adapter.last_data_source == "MOCK_FALLBACK"


def test_misumi_missing_public_price_reports_login_requirement(monkeypatch):
    adapter = MisumiAdapter(use_mock_on_failure=False)
    monkeypatch.setattr(adapter, "_search_live", lambda keyword, limit: [{
        "id": "42", "name": "滚珠轴承 深沟球型", "brand": "斯凯孚(SKF)",
        "price": "", "delivery": "当天起", "url": "https://example.test/42",
        "tax_included": None,
    }])

    results = adapter.search_and_parse("SKF", "6205-2Z/C3")

    assert results[0].displayed_price == 0
    assert adapter.last_login_status == "LOGIN_REQUIRED_FOR_PRICE"
    assert adapter.last_error_code == "MISUMI_PRICE_LOGIN_REQUIRED"
    assert any("登录米思米" in reason for reason in results[0].mismatch_reasons)
