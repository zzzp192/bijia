import html as html_lib
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from matching.engine import evaluate_model_match, normalize_brand, normalize_model
from matching.schemas import UnifiedQueryResult


BASE_DIR = os.path.dirname(os.path.dirname(__file__))


class TaobaoAdapter:
    """淘宝/天猫搜索、详情补全及统一 Schema 适配器。"""

    def __init__(self, use_mock_on_failure: bool = True):
        self.use_mock_on_failure = use_mock_on_failure
        self.cookies_path = os.path.join(BASE_DIR, "cookies", "taobao.json")
        self.fixture_path = os.path.join(BASE_DIR, "fixtures", "taobao_sample.json")
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

        if not os.path.exists(self.cookies_path):
            self.last_login_status = "LOGIN_REQUIRED"
            self.last_error_code = "COOKIE_MISSING"
            self.last_error_message = "未找到淘宝登录态，请先点击“登录淘宝/天猫”"
            return self._fallback(query_brand, query_model, quantity)

        auth_error = ()
        api_error = ()
        try:
            engine_class, auth_error, api_error = self._load_upstream_engine()
            engine = engine_class(cookies_path=self.cookies_path)
            payload = engine.search(f"{query_brand} {query_model}".strip(), limit=20)
            items = self._enrich_items_from_detail(
                engine, payload.get("items") or [], query_model
            )
            results = self._transform_items(items, query_brand, query_model, quantity)
            self.last_login_status = "LOGGED_IN"
            self.last_data_source = "LIVE_MTOP_DETAIL"
            if not results:
                self.last_error_code = "NO_RESULTS"
                self.last_error_message = "淘宝/天猫实时查询未返回商品"
            return results
        except FileNotFoundError as exc:
            self.last_login_status = "LOGIN_REQUIRED"
            self.last_error_code = "COOKIE_MISSING"
            self.last_error_message = str(exc).splitlines()[0]
        except auth_error as exc:
            self.last_login_status = "LOGIN_REQUIRED"
            self.last_error_code = "SESSION_EXPIRED"
            self.last_error_message = str(exc).splitlines()[0]
        except api_error as exc:
            self.last_login_status = "API_ERROR"
            self.last_error_code = "MTOP_API_ERROR"
            self.last_error_message = str(exc).splitlines()[0]
        except ModuleNotFoundError as exc:
            self.last_login_status = "DEPENDENCY_ERROR"
            self.last_error_code = "DEPENDENCY_MISSING"
            self.last_error_message = f"淘宝查询依赖未安装: {exc.name}"
        except Exception as exc:
            self.last_login_status = "ERROR"
            self.last_error_code = "TAOBAO_ERROR"
            self.last_error_message = str(exc).splitlines()[0] or type(exc).__name__

        return self._fallback(query_brand, query_model, quantity)

    @staticmethod
    def _load_upstream_engine():
        upstream_src = os.path.join(BASE_DIR, "vendor", "cn-scraper-mcp", "src")
        if upstream_src not in sys.path:
            sys.path.insert(0, upstream_src)
        from cn_scraper_mcp.engines.taobao import (
            TaobaoAPIError,
            TaobaoAuthError,
            TaobaoEngine,
        )

        return TaobaoEngine, TaobaoAuthError, TaobaoAPIError

    def _fallback(
        self, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        if not self.use_mock_on_failure:
            return []
        self.last_data_source = "MOCK_FALLBACK"
        return self._load_fixture_data(query_brand, query_model, quantity)

    def _enrich_items_from_detail(
        self, engine: Any, items: List[Dict[str, Any]], query_model: str
    ) -> List[Dict[str, Any]]:
        """用商品详情补齐搜索接口缺失的店铺、店型和目标 SKU 数据。"""
        session = getattr(engine, "session", None)
        if session is None:
            return [dict(item, title=self._repair_mojibake(item.get("title"))) for item in items]

        def enrich_one(source: Dict[str, Any]) -> Dict[str, Any]:
            item = dict(source)
            item["title"] = self._repair_mojibake(item.get("title"))
            item_id = str(item.get("id") or "").strip()
            if not item_id:
                return item

            try:
                response = session.get(
                    f"https://item.taobao.com/item.htm?id={item_id}", timeout=15
                )
                if response.status_code == 200 and response.text:
                    item.update(self._parse_detail_page(response.text, query_model))
            except Exception:
                # 单个详情失败不应丢掉整条搜索结果。
                pass
            return item

        # 保持结果原顺序；并发数受控，兼顾页面响应时间与平台请求压力。
        with ThreadPoolExecutor(max_workers=min(6, len(items) or 1)) as executor:
            return list(executor.map(enrich_one, items))

    @classmethod
    def _parse_detail_page(cls, body: str, query_model: str) -> Dict[str, Any]:
        detail: Dict[str, Any] = {}

        title_match = re.search(
            r'<span[^>]*class="[^"]*mainTitle--[^"]*"[^>]*title="([^"]+)"',
            body,
            re.IGNORECASE,
        )
        if title_match:
            detail["title"] = html_lib.unescape(title_match.group(1)).strip()

        shop = cls._extract_json_string(body, "shopName")
        if shop:
            detail["shop"] = shop
        seller_type = cls._extract_json_string(body, "sellerType").upper()
        if seller_type in {"B", "C"}:
            detail["seller_type"] = seller_type
        shop_url = cls._extract_json_string(body, "shopUrl")
        if shop_url:
            detail["shop_url"] = shop_url.replace("\\/", "/")

        sku_base = cls._extract_json_object(body, "skuBase")
        sku_core = cls._extract_json_object(body, "skuCore")
        sku = cls._resolve_target_sku(sku_base, sku_core, query_model)
        if sku:
            detail.update(sku)
        return detail

    @staticmethod
    def _extract_json_string(body: str, key: str) -> str:
        match = re.search(
            rf'"{re.escape(key)}"\s*:\s*"((?:\\.|[^"\\])*)"', body
        )
        if not match:
            return ""
        try:
            return json.loads(f'"{match.group(1)}"').strip()
        except (json.JSONDecodeError, AttributeError):
            return html_lib.unescape(match.group(1)).strip()

    @staticmethod
    def _extract_json_object(body: str, key: str) -> Dict[str, Any]:
        marker = re.search(rf'"{re.escape(key)}"\s*:', body)
        if not marker:
            return {}
        start = body.find("{", marker.end())
        if start < 0:
            return {}

        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(body)):
            char = body[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(body[start:index + 1])
                        return value if isinstance(value, dict) else {}
                    except json.JSONDecodeError:
                        return {}
        return {}

    @classmethod
    def _resolve_target_sku(
        cls, sku_base: Dict[str, Any], sku_core: Dict[str, Any], query_model: str
    ) -> Dict[str, Any]:
        if not sku_base or not sku_core or not query_model:
            return {}
        target = normalize_model(query_model)
        matched_values: Dict[str, str] = {}
        for prop in sku_base.get("props") or []:
            if not isinstance(prop, dict):
                continue
            for value in prop.get("values") or []:
                if not isinstance(value, dict):
                    continue
                name = cls._clean_title(value.get("name"))
                normalized_name = normalize_model(name)
                if target and target in normalized_name:
                    matched_values[str(value.get("vid") or "")] = name

        matched_values.pop("", None)
        if not matched_values:
            return {}

        sku2info = sku_core.get("sku2info") or {}
        candidates: List[Dict[str, Any]] = []
        for sku in sku_base.get("skus") or []:
            if not isinstance(sku, dict):
                continue
            prop_path = str(sku.get("propPath") or "")
            path_values = {part.rsplit(":", 1)[-1] for part in prop_path.split(";")}
            matching_vids = path_values.intersection(matched_values)
            if not matching_vids:
                continue
            sku_id = str(sku.get("skuId") or sku.get("sku_id") or "")
            info = sku2info.get(sku_id) or {}
            price_obj = info.get("price") or {}
            price_value = (
                price_obj.get("priceText")
                if isinstance(price_obj, dict)
                else price_obj
            )
            price = cls._clean_price(price_value)
            if price <= 0:
                continue
            quantity_value = info.get("quantity")
            try:
                stock_quantity = int(quantity_value)
            except (TypeError, ValueError):
                stock_quantity = None
            candidates.append({
                "sku_id": sku_id,
                "sku_name": matched_values[next(iter(matching_vids))],
                "sku_price": price,
                "stock_quantity": stock_quantity,
                "delivery_time": info.get("logisticsTime") or None,
            })

        if not candidates:
            return {}
        unique_prices = {candidate["sku_price"] for candidate in candidates}
        if len(unique_prices) != 1:
            # 同一型号还有颜色/包装等组合且价格不同，不能冒充唯一目标价。
            return {}
        selected = candidates[0]
        stock = selected.get("stock_quantity")
        selected["stock_status"] = (
            "IN_STOCK" if stock is not None and stock > 0
            else "OUT_OF_STOCK" if stock == 0
            else "UNKNOWN"
        )
        selected["sku_confirmed"] = True
        return selected

    def _transform_items(
        self,
        items: List[Dict[str, Any]],
        query_brand: str,
        query_model: str,
        quantity: int,
    ) -> List[UnifiedQueryResult]:
        results: List[UnifiedQueryResult] = []
        for item in items:
            title = self._clean_title(self._repair_mojibake(item.get("title")))
            if not title:
                continue
            shop = self._clean_title(self._repair_mojibake(item.get("shop")))
            if not shop:
                shop = "店铺名称待确认"
            displayed_price = self._clean_price(item.get("price"))
            sku_confirmed = bool(item.get("sku_confirmed"))
            sku_price = self._clean_price(item.get("sku_price")) if sku_confirmed else None
            unit_price = sku_price if sku_price is not None else displayed_price
            item_id = str(item.get("id") or "").strip()
            url = item.get("url") or (
                f"https://item.taobao.com/item.htm?id={item_id}"
                if item_id else "https://s.taobao.com"
            )

            level, score, reasons, manual = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=title,
                detected_brand=None,
                detected_model=query_model if sku_confirmed else None,
                sku_name=item.get("sku_name"),
            )
            if not sku_confirmed:
                reasons.append("搜索列表价可能对应其他规格，目标SKU价格尚未从详情确认")
                manual = True

            seller_type = str(item.get("seller_type") or "").upper()
            if seller_type == "B":
                supplier_type = "天猫店"
            elif seller_type == "C":
                supplier_type = "淘宝店"
            else:
                supplier_type = "平台类型待确认"
            official = seller_type == "B" and "官方旗舰店" in shop

            results.append(UnifiedQueryResult(
                platform="taobao",
                query_brand=query_brand,
                query_model=query_model,
                normalized_brand=normalize_brand(query_brand),
                normalized_model=normalize_model(query_model),
                title=title,
                sku_name=item.get("sku_name"),
                sku_id=item.get("sku_id") or item_id or None,
                supplier_name=shop,
                shop_name=shop,
                shop_url=item.get("shop_url"),
                supplier_type=supplier_type,
                official_store=official,
                displayed_price=displayed_price,
                sku_price=sku_price,
                unit_price=unit_price,
                quantity=quantity,
                min_order_quantity=1,
                stock_status=item.get("stock_status") or "UNKNOWN",
                stock_quantity=item.get("stock_quantity"),
                delivery_time=item.get("delivery_time"),
                product_url=str(url),
                match_score=score,
                match_level=level,
                mismatch_reasons=reasons,
                manual_review_required=manual,
            ))
        return results

    def _load_fixture_data(
        self, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        if not os.path.exists(self.fixture_path):
            return []
        with open(self.fixture_path, "r", encoding="utf-8") as handle:
            items = json.load(handle)
        return self._transform_items(items, query_brand, query_model, quantity)

    @classmethod
    def _repair_mojibake(cls, value: Any) -> str:
        text = str(value or "")
        try:
            repaired = text.encode("latin1").decode("gb18030")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return text
        return repaired if cls._cjk_count(repaired) > cls._cjk_count(text) else text

    @staticmethod
    def _cjk_count(value: str) -> int:
        return sum("\u3400" <= char <= "\u9fff" for char in value)

    @staticmethod
    def _clean_title(value: Any) -> str:
        text = re.sub(r"<[^>]+>", "", str(value or ""))
        return re.sub(r"\s+", " ", text).strip()

    @staticmethod
    def _clean_price(value: Any) -> float:
        match = re.search(r"\d+(?:\.\d+)?", str(value or "").replace(",", ""))
        return float(match.group(0)) if match else 0.0
