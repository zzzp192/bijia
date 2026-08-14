import pytest
from matching.engine import evaluate_keyword_match, evaluate_model_match, normalize_text, normalize_model

def test_normalize_text():
    assert normalize_text(" ＳＫＦ（中国） ") == "SKF(中国)"
    assert normalize_text("CDQ2B32-50DMZ") == "CDQ2B32-50DMZ"

def test_exact_matching():
    level, score, reasons, manual = evaluate_model_match(
        query_brand="SKF",
        query_model="6205-2Z/C3",
        title="SKF 6205-2Z/C3 进口高精密深沟球轴承",
        detected_brand="SKF",
        detected_model="6205-2Z/C3"
    )
    assert level == "EXACT"
    assert score == 100.0
    assert manual is False

def test_replacement_detection():
    level, score, reasons, manual = evaluate_model_match(
        query_brand="SKF",
        query_model="6205-2Z/C3",
        title="适用 SKF 6205-2Z 国产替代精品轴承",
        detected_brand="国产",
        detected_model="6205-2Z"
    )
    assert level == "REPLACEMENT"
    assert manual is True

def test_keyword_match_uses_token_coverage_without_model_rules():
    level, score, reasons, manual = evaluate_keyword_match(
        "SKF 轴承", "SKF 6205 高速深沟球轴承"
    )
    assert level == "HIGH"
    assert score == 90.0
    assert manual is False

    partial = evaluate_keyword_match("SKF 传感器", "SKF 工业轴承")
    assert partial[0] == "POSSIBLE"
    assert partial[3] is True

def test_partial_suffix_mismatch():
    level, score, reasons, manual = evaluate_model_match(
        query_brand="SKF",
        query_model="6205-2Z/C3",
        title="SKF 6205 轴承",
        detected_brand="SKF",
        detected_model="6205"
    )
    assert level == "POSSIBLE"
    assert manual is True
