import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

from matching.engine import evaluate_model_match, normalize_brand, normalize_model
from matching.schemas import UnifiedQueryResult


BASE_DIR = os.path.dirname(os.path.dirname(__file__))


class JDAdapter:
    """京东搜索适配器：复用浏览器签名 API，并对高相关商品补充详情。"""

    def __init__(self, use_mock_on_failure: bool = True):
        self.use_mock_on_failure = use_mock_on_failure
        self.profile_dir = os.path.join(BASE_DIR, "browser_profiles", "jd_profile")
        self.fixture_path = os.path.join(BASE_DIR, "fixtures", "jd_sample.json")
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

        engine = None
        login_error = ()
        captcha_error = ()
        try:
            engine_class, login_error, captcha_error = self._load_upstream_engine()
            # 登录由单独的可见窗口完成；日常搜索与详情必须在后台运行。
            engine = engine_class(profile_dir=self.profile_dir, headless=True)
            keyword = f"{query_brand} {query_model}".strip()
            payload = engine.search(keyword, limit=20)
            if payload.get("error"):
                raise RuntimeError(payload["error"])
            items = payload.get("items") or []
            items = self._enrich_relevant_details(
                engine, items, query_brand, query_model, limit=5
            )
            results = self._transform_items(items, query_brand, query_model, quantity)
            self.last_login_status = "LOGGED_IN"
            self.last_data_source = "LIVE_JD_DETAIL" if any(
                item.get("detail_confirmed") for item in items
            ) else "LIVE_JD_SEARCH"
            if not results:
                self.last_error_code = "NO_RESULTS"
                self.last_error_message = "京东实时查询未返回商品"
            return results
        except login_error as exc:
            self.last_login_status = "LOGIN_REQUIRED"
            self.last_error_code = "JD_LOGIN_REQUIRED"
            self.last_error_message = str(exc).splitlines()[0]
        except captcha_error as exc:
            self.last_login_status = "RISK_CONTROL"
            self.last_error_code = "JD_CAPTCHA"
            self.last_error_message = str(exc).splitlines()[0]
        except ModuleNotFoundError as exc:
            self.last_login_status = "DEPENDENCY_ERROR"
            self.last_error_code = "DEPENDENCY_MISSING"
            self.last_error_message = f"京东查询依赖未安装: {exc.name}"
        except Exception as exc:
            self.last_login_status = "ERROR"
            self.last_error_code = "JD_ERROR"
            self.last_error_message = str(exc).splitlines()[0] or type(exc).__name__
        finally:
            if engine is not None:
                try:
                    engine.close_chrome()
                except Exception:
                    pass

        return self._fallback(query_brand, query_model, quantity)

    @staticmethod
    def _load_upstream_engine():
        upstream_src = os.path.join(BASE_DIR, "vendor", "cn-scraper-mcp", "src")
        if upstream_src not in sys.path:
            sys.path.insert(0, upstream_src)
        from cn_scraper_mcp.engines.jd import (
            JDCaptchaError,
            JDEngine,
            JDLoginWallError,
        )
        return JDEngine, JDLoginWallError, JDCaptchaError

    def _enrich_relevant_details(
        self,
        engine: Any,
        items: List[Dict[str, Any]],
        query_brand: str,
        query_model: str,
        limit: int,
    ) -> List[Dict[str, Any]]:
        ranked = []
        for index, source in enumerate(items):
            item = dict(source)
            level, score, _, _ = evaluate_model_match(
                query_brand, query_model, str(item.get("name") or "")
            )
            priority = 0 if level in {"EXACT", "HIGH", "POSSIBLE"} else 1
            ranked.append((priority, -score, index, item))

        detail_indices = {
            index for _, _, index, _ in sorted(ranked)[: max(0, limit)]
        }
        enriched: List[Dict[str, Any]] = []
        for index, source in enumerate(items):
            item = dict(source)
            sku = str(item.get("sku") or "").strip()
            if index in detail_indices and sku:
                detail = engine.get_product(sku)
                if detail and not detail.get("error") and detail.get("name"):
                    item.update(detail)
                    item["detail_confirmed"] = True
            enriched.append(item)
        return enriched

    def _transform_items(
        self,
        items: List[Dict[str, Any]],
        query_brand: str,
        query_model: str,
        quantity: int,
    ) -> List[UnifiedQueryResult]:
        results: List[UnifiedQueryResult] = []
        for item in items:
            title = self._clean_text(item.get("name"))
            if not title:
                continue
            sku = str(item.get("sku") or "").strip()
            displayed_price = self._clean_price(item.get("price"))
            detail_confirmed = bool(item.get("detail_confirmed"))
            shop = self._clean_text(item.get("shop")) or "京东店铺待详情确认"
            specs = self._clean_text(item.get("specs"))
            level, score, reasons, manual = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=title,
                detected_brand=None,
                detected_model=None,
                sku_name=specs,
            )
            if item.get("ad"):
                reasons.append("京东搜索结果标记为广告商品")
                manual = True
            if not detail_confirmed:
                reasons.append("店铺与详情价格尚未核验")
                manual = True

            self_operated = "自营" in f"{shop} {title}"
            official = "官方旗舰店" in shop
            supplier_type = (
                "京东自营" if self_operated
                else "京东第三方店" if shop != "京东店铺待详情确认"
                else "店铺类型待确认"
            )
            results.append(UnifiedQueryResult(
                platform="jd",
                query_brand=query_brand,
                query_model=query_model,
                normalized_brand=normalize_brand(query_brand),
                normalized_model=normalize_model(query_model),
                title=title,
                sku_name=None,
                sku_id=sku or None,
                supplier_name=shop,
                shop_name=shop,
                supplier_type=supplier_type,
                official_store=official,
                displayed_price=displayed_price,
                sku_price=displayed_price if detail_confirmed else None,
                unit_price=displayed_price,
                quantity=quantity,
                min_order_quantity=1,
                product_url=item.get("url") or (
                    f"https://item.jd.com/{sku}.html" if sku else "https://search.jd.com"
                ),
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
            return self._transform_items(
                json.load(handle), query_brand, query_model, quantity
            )

    @staticmethod
    def _clean_text(value: Any) -> str:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", str(value or ""))).strip()

    @staticmethod
    def _clean_price(value: Any) -> float:
        match = re.search(r"\d+(?:\.\d+)?", str(value or "").replace(",", ""))
        return float(match.group(0)) if match else 0.0
