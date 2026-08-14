import json

from adapters.taobao_adapter import TaobaoAdapter


def test_taobao_adapter_mock_groups_exact_and_replacement():
    adapter = TaobaoAdapter(use_mock_on_failure=True)
    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 10, force_mock=True)

    assert len(results) == 2
    assert {result.platform for result in results} == {"taobao"}
    assert {result.match_level for result in results} == {"HIGH", "REPLACEMENT"}
    assert results[0].official_store is True
    assert results[0].manual_review_required is True
    assert any("目标SKU价格" in reason for reason in results[0].mismatch_reasons)
    assert results[0].supplier_type == "天猫店"
    assert results[1].supplier_type == "淘宝店"
    assert adapter.last_data_source == "MOCK"


def test_taobao_missing_cookies_uses_marked_fallback(tmp_path):
    adapter = TaobaoAdapter(use_mock_on_failure=True)
    adapter.cookies_path = str(tmp_path / "missing.json")

    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 10)

    assert results
    assert adapter.last_login_status == "LOGIN_REQUIRED"
    assert adapter.last_data_source == "MOCK_FALLBACK"
    assert adapter.last_error_code == "COOKIE_MISSING"


def test_taobao_live_engine_results_are_transformed(tmp_path, monkeypatch):
    cookie_file = tmp_path / "taobao.json"
    cookie_file.write_text(json.dumps({"cookie2": "test"}), encoding="utf-8")

    class FakeEngine:
        def __init__(self, cookies_path):
            assert cookies_path == str(cookie_file)
            self.session = FakeSession()

        def search(self, keyword, limit):
            assert keyword == "SKF 6205-2Z/C3"
            assert limit == 20
            return {"items": [{
                "id": "123",
                "title": "<span>SKF 6205-2Z/C3 原装轴承</span>",
                "price": "¥19.90",
                "shop": "SKF官方旗舰店",
                "url": "https://item.taobao.com/item.htm?id=123",
            }]}

    class FakeResponse:
        status_code = 200
        text = r'''
            <span class="mainTitle--abc" title="SKF 6205-2Z/C3 原装轴承"></span>
            <script>{"shopName":"SKF工业品官方旗舰店","sellerType":"B",
            "skuBase":{"props":[{"name":"型号","values":[
              {"name":"6205-2Z/C3【SKF/斯凯孚】","vid":"v1"}
            ]}],"skus":[{"skuId":"sku-1","propPath":"1627207:v1"}]},
            "skuCore":{"sku2info":{"sku-1":{"price":{"priceText":"18.80"},
              "quantity":36,"logisticsTime":"48小时内发货"}}}}</script>
        '''

    class FakeSession:
        def get(self, url, timeout):
            assert url.endswith("id=123")
            assert timeout == 15
            return FakeResponse()

    class FakeAuthError(Exception):
        pass

    class FakeApiError(Exception):
        pass

    adapter = TaobaoAdapter(use_mock_on_failure=False)
    adapter.cookies_path = str(cookie_file)
    monkeypatch.setattr(
        adapter,
        "_load_upstream_engine",
        lambda: (FakeEngine, FakeAuthError, FakeApiError),
    )

    results = adapter.search_and_parse("SKF", "6205-2Z/C3", 10)

    assert len(results) == 1
    assert results[0].title == "SKF 6205-2Z/C3 原装轴承"
    assert results[0].supplier_name == "SKF工业品官方旗舰店"
    assert results[0].supplier_type == "天猫店"
    assert results[0].unit_price == 18.8
    assert results[0].displayed_price == 19.9
    assert results[0].stock_quantity == 36
    assert results[0].match_level == "EXACT"
    assert results[0].manual_review_required is False
    assert adapter.last_data_source == "LIVE_MTOP_DETAIL"


def test_detail_parser_distinguishes_taobao_and_handles_ambiguous_sku_prices():
    body = r'''
      {"shopName":"上海轴承店","sellerType":"C",
       "skuBase":{"props":[{"values":[
         {"name":"6205-2Z/C3","vid":"target"}
       ]}],"skus":[
         {"skuId":"a","propPath":"1:target;2:red"},
         {"skuId":"b","propPath":"1:target;2:blue"}
       ]},
       "skuCore":{"sku2info":{
         "a":{"price":{"priceText":"12.00"},"quantity":1},
         "b":{"price":{"priceText":"13.00"},"quantity":2}
       }}}
    '''

    detail = TaobaoAdapter._parse_detail_page(body, "6205-2Z/C3")

    assert detail["shop"] == "上海轴承店"
    assert detail["seller_type"] == "C"
    assert "sku_confirmed" not in detail


def test_repair_search_api_gbk_mojibake():
    original = "SKF 6205-2Z/C3轴承"
    mojibake = original.encode("gb18030").decode("latin1")

    assert TaobaoAdapter._repair_mojibake(mojibake) == original
