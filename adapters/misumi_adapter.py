import json
import os
import re
import urllib.parse
from typing import Any, Dict, List, Optional

from matching.engine import evaluate_model_match, normalize_brand, normalize_model, normalize_text
from matching.schemas import UnifiedQueryResult


BASE_DIR = os.path.dirname(os.path.dirname(__file__))


class MisumiAdapter:
    """米思米中国目录搜索适配器（后台 Playwright）。"""

    def __init__(self, use_mock_on_failure: bool = True):
        self.use_mock_on_failure = use_mock_on_failure
        self.profile_dir = os.path.join(BASE_DIR, "browser_profiles", "misumi_profile")
        self.fixture_path = os.path.join(BASE_DIR, "fixtures", "misumi_sample.json")
        self.last_login_status = "UNKNOWN"
        self.last_data_source = "NONE"
        self.last_error_code: Optional[str] = None
        self.last_error_message: Optional[str] = None

    def _reset_status(self) -> None:
        self.last_login_status = "UNKNOWN"
        self.last_data_source = "NONE"
        self.last_error_code = None
        self.last_error_message = None

    def search_and_parse(
        self,
        query_brand: str,
        query_model: str,
        quantity: int = 1,
        force_mock: bool = False,
    ) -> List[UnifiedQueryResult]:
        self._reset_status()
        if force_mock:
            self.last_login_status = "MOCK"
            self.last_data_source = "MOCK"
            return self._load_fixture_data(query_brand, query_model, quantity)

        try:
            items = self._search_live(f"{query_brand} {query_model}".strip(), limit=20)
            results = self._transform_items(items, query_brand, query_model, quantity)
            self.last_data_source = "LIVE_MISUMI_BROWSER"
            if not results:
                self.last_login_status = "PUBLIC_OR_LOGGED_IN"
                self.last_error_code = "NO_RESULTS"
                self.last_error_message = "米思米实时查询未返回相关目录商品"
            elif all(result.displayed_price <= 0 for result in results):
                self.last_login_status = "LOGIN_REQUIRED_FOR_PRICE"
                self.last_error_code = "MISUMI_PRICE_LOGIN_REQUIRED"
                self.last_error_message = "目录商品已找到；登录米思米后可查看价格"
            else:
                self.last_login_status = "PUBLIC_OR_LOGGED_IN"
            return results
        except ModuleNotFoundError as exc:
            self.last_login_status = "DEPENDENCY_ERROR"
            self.last_error_code = "DEPENDENCY_MISSING"
            self.last_error_message = f"米思米查询依赖未安装: {exc.name}"
        except TimeoutError as exc:
            self.last_login_status = "RISK_CONTROL"
            self.last_error_code = "MISUMI_WAF_OR_TIMEOUT"
            self.last_error_message = str(exc)
        except Exception as exc:
            self.last_login_status = "ERROR"
            self.last_error_code = "MISUMI_ERROR"
            self.last_error_message = str(exc).splitlines()[0] or type(exc).__name__
        return self._fallback(query_brand, query_model, quantity)

    def _search_live(self, keyword: str, limit: int) -> List[Dict[str, Any]]:
        from playwright.sync_api import sync_playwright

        url = (
            "https://www.misumi.com.cn/vona2/result/?Keyword="
            + urllib.parse.quote(keyword)
        )
        os.makedirs(self.profile_dir, exist_ok=True)
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=self.profile_dir,
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-proxy-server",
                ],
            )
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(5000)
                if page.locator("li.photo-item").count() == 0:
                    page.wait_for_timeout(8000)
                if page.locator("li.photo-item").count() == 0:
                    body = page.content()
                    if "aliyun_waf" in body or "renderData" in body:
                        raise TimeoutError("米思米页面仍处于安全验证，请稍后重试")
                    return []

                return page.locator("li.photo-item").evaluate_all(
                    r"""
                    (elements, limit) => elements.slice(0, limit).map(element => {
                      const nameLink = element.querySelector('.goods-name-text');
                      const priceText = element.querySelector('.p-goods-yprice')?.innerText
                        || element.querySelector('.p-goods-UnitPrice')?.innerText || '';
                      const href = nameLink?.href || '';
                      const idMatch = href.match(/\/detail\/(\d+)/);
                      return {
                        id: idMatch ? idMatch[1] : '',
                        name: (nameLink?.innerText || '').trim(),
                        brand: (element.querySelector('.goods-brand')?.innerText || '').trim(),
                        price: priceText.trim(),
                        delivery: (element.querySelector('.ship-date-value')?.innerText || '').trim(),
                        url: href,
                        tax_included: !element.innerText.includes('未税') ? null : false
                      };
                    })
                    """,
                    limit,
                )
            finally:
                context.close()

    def _transform_items(
        self,
        items: List[Dict[str, Any]],
        query_brand: str,
        query_model: str,
        quantity: int,
    ) -> List[UnifiedQueryResult]:
        results: List[UnifiedQueryResult] = []
        normalized_query_brand = normalize_brand(query_brand)
        for item in items:
            name = self._clean_text(item.get("name"))
            brand = self._clean_text(item.get("brand"))
            if not name:
                continue
            combined_title = f"{brand} {name}".strip()
            brand_matches = bool(
                normalized_query_brand
                and normalized_query_brand in normalize_text(combined_title)
            )
            if query_brand and not brand_matches:
                continue

            level, score, reasons, manual = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=combined_title,
                detected_brand=None,
                detected_model=None,
            )
            series_warning = "米思米搜索结果为产品系列，完整订购型号及对应价格需进入智能选型确认"
            if level in {"MISMATCH", "UNKNOWN"} and brand_matches:
                level, score, reasons, manual = "POSSIBLE", 65.0, [series_warning], True
            elif series_warning not in reasons:
                reasons.append(series_warning)
                manual = True

            displayed_price = self._clean_price(item.get("price"))
            if displayed_price <= 0:
                reasons.append("目录页未公开价格，登录米思米后可查看账户价/目录价")
                manual = True
            results.append(UnifiedQueryResult(
                platform="misumi",
                query_brand=query_brand,
                query_model=query_model,
                normalized_brand=normalize_brand(query_brand),
                normalized_model=normalize_model(query_model),
                title=combined_title,
                detected_brand=brand or None,
                sku_id=str(item.get("id") or "") or None,
                supplier_name="米思米中国",
                shop_name="米思米中国",
                supplier_type="工业品目录平台",
                displayed_price=displayed_price,
                sku_price=None,
                unit_price=displayed_price,
                quantity=quantity,
                min_order_quantity=1,
                tax_included=item.get("tax_included"),
                delivery_time=(
                    f"{item.get('delivery')}起" if item.get("delivery") and not str(item.get("delivery")).endswith("起")
                    else item.get("delivery")
                ),
                product_url=item.get("url") or "https://www.misumi.com.cn/",
                match_score=score,
                match_level=level,
                mismatch_reasons=reasons,
                manual_review_required=manual,
            ))
        return results

    def _fallback(
        self, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        if not self.use_mock_on_failure:
            return []
        self.last_data_source = "MOCK_FALLBACK"
        return self._load_fixture_data(query_brand, query_model, quantity)

    def _load_fixture_data(
        self, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        if not os.path.exists(self.fixture_path):
            return []
        with open(self.fixture_path, "r", encoding="utf-8") as handle:
            return self._transform_items(json.load(handle), query_brand, query_model, quantity)

    @staticmethod
    def _clean_text(value: Any) -> str:
        return re.sub(r"\s+", " ", str(value or "")).strip()

    @staticmethod
    def _clean_price(value: Any) -> float:
        match = re.search(r"\d[\d,]*(?:\.\d+)?", str(value or ""))
        return float(match.group(0).replace(",", "")) if match else 0.0
