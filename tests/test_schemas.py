import pytest
from matching.schemas import UnifiedQueryResult, TierPrice

def test_tier_price_model():
    tp = TierPrice(min_quantity=1, max_quantity=9, unit_price=120.5)
    assert tp.min_quantity == 1
    assert tp.max_quantity == 9
    assert tp.unit_price == 120.5

def test_unified_query_result_schema():
    res = UnifiedQueryResult(
        platform="1688",
        query_brand="SKF",
        query_model="6205-2Z/C3",
        normalized_brand="SKF",
        normalized_model="6205-2Z/C3",
        title="SKF 进口深沟球轴承 6205-2Z/C3",
        detected_brand="SKF",
        detected_model="6205-2Z/C3",
        supplier_name="上海精密轴承有限公司",
        displayed_price=15.0,
        unit_price=15.0,
        quantity=10,
        product_url="https://detail.1688.com/offer/12345678.html"
    )
    assert res.platform == "1688"
    assert res.currency == "CNY"
    assert res.manual_review_required is True
