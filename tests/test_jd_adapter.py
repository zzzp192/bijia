from adapters.jd_adapter import JDAdapter


def test_jd_mock_adapter_maps_self_operated_and_replacement():
    adapter = JDAdapter(use_mock_on_failure=True)
    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 2, force_mock=True)

    assert len(results) == 2
    assert results[0].platform == "jd"
    assert results[0].supplier_type == "京东自营"
    assert results[0].sku_price == 32.8
    assert results[0].match_level == "HIGH"
    assert results[1].match_level == "REPLACEMENT"
    assert adapter.last_data_source == "MOCK"


def test_jd_live_search_enriches_relevant_product(monkeypatch):
    calls = []

    class FakeEngine:
        def __init__(self, profile_dir, headless):
            assert profile_dir.endswith("jd_profile")
            assert headless is True

        def search(self, keyword, limit):
            assert keyword == "SKF 6205-2Z/C3"
            assert limit == 20
            return {"state": "ok", "items": [{
                "sku": "123", "name": "SKF 6205-2Z/C3 轴承", "price": 20,
                "url": "https://item.jd.com/123.html", "ad": False,
            }]}

        def get_product(self, sku):
            assert sku == "123"
            return {
                "sku": sku, "name": "SKF 6205-2Z/C3 原装轴承",
                "price": "25.80", "shop": "京东工业品自营专区",
                "specs": "品牌: SKF; 型号: 6205-2Z/C3",
                "url": "https://item.jd.com/123.html",
            }

        def close_chrome(self):
            calls.append("closed")

    class FakeLoginError(Exception):
        pass

    class FakeCaptchaError(Exception):
        pass

    adapter = JDAdapter(use_mock_on_failure=False)
    monkeypatch.setattr(
        adapter, "_load_upstream_engine",
        lambda: (FakeEngine, FakeLoginError, FakeCaptchaError),
    )
    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 3)

    assert len(results) == 1
    assert results[0].supplier_name == "京东工业品自营专区"
    assert results[0].unit_price == 25.8
    assert results[0].sku_price == 25.8
    assert results[0].match_level == "HIGH"
    assert adapter.last_data_source == "LIVE_JD_DETAIL"
    assert calls == ["closed"]


def test_jd_login_wall_uses_marked_fallback(monkeypatch):
    class FakeLoginError(Exception):
        pass

    class FakeCaptchaError(Exception):
        pass

    class FakeEngine:
        def __init__(self, profile_dir, headless):
            pass

        def search(self, keyword, limit):
            raise FakeLoginError("请登录京东")

        def close_chrome(self):
            pass

    adapter = JDAdapter(use_mock_on_failure=True)
    monkeypatch.setattr(
        adapter, "_load_upstream_engine",
        lambda: (FakeEngine, FakeLoginError, FakeCaptchaError),
    )
    results = adapter.search_and_parse("SKF", "6205-2Z/C3")

    assert results
    assert adapter.last_login_status == "LOGIN_REQUIRED"
    assert adapter.last_error_code == "JD_LOGIN_REQUIRED"
    assert adapter.last_data_source == "MOCK_FALLBACK"
