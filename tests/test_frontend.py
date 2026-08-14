from pathlib import Path


def test_result_sort_controls_and_fields_are_present():
    html = (
        Path(__file__).parent.parent / "frontend" / "public" / "index.html"
    ).read_text(encoding="utf-8")

    assert 'id="sortField"' in html
    assert 'value="confidence"' in html
    assert 'value="platform"' in html
    assert 'value="price"' in html
    assert "function sortResultItems" in html
    assert 'class="platform-check" value="misumi"' in html
    assert "triggerLogin('misumi')" in html
    assert 'id="resultMode"' in html
    assert 'value="per_platform"' in html
    assert 'value="global"' in html
    assert 'id="resultLimit"' in html
    assert 'id="platformStatusList"' in html
