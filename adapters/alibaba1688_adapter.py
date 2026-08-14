import os
import json
import urllib.parse
import subprocess
from typing import List, Dict, Any, Optional
from bs4 import BeautifulSoup

from matching.schemas import UnifiedQueryResult, TierPrice
from matching.engine import evaluate_model_match, normalize_brand, normalize_model
from browser.profile_manager import ProfileManager

class Alibaba1688Adapter:
    def __init__(self, use_mock_on_failure: bool = True):
        self.use_mock_on_failure = use_mock_on_failure
        self.upstream_cli_dir = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "vendor", "1688-cli"
        )
        self.fixture_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "fixtures", "1688_sample.json"
        )
        self.last_login_status = "UNKNOWN"
        self.last_data_source = "NONE"
        self.last_error_code: Optional[str] = None
        self.last_error_message: Optional[str] = None

    def _reset_status(self) -> None:
        self.last_login_status = "UNKNOWN"
        self.last_data_source = "NONE"
        self.last_error_code = None
        self.last_error_message = None

    def _record_cli_error(self, stderr: str, fallback_code: str = "CLI_ERROR") -> None:
        """Parse the 1688 CLI JSON error envelope into safe status metadata."""
        code = fallback_code
        message = stderr.strip() or "1688 CLI 未返回可用结果"
        try:
            payload = json.loads(stderr.strip())
            if isinstance(payload, dict):
                code = str(payload.get("code") or code)
                message = str(payload.get("message") or message)
        except (TypeError, ValueError):
            pass

        self.last_error_code = code
        self.last_error_message = message
        if code == "NOT_LOGGED_IN":
            self.last_login_status = "LOGIN_REQUIRED"
        elif code == "DAEMON_PAUSED":
            self.last_login_status = "PAUSED"
        elif code in {"RISK_CONTROL", "SLIDER_REQUIRED"}:
            self.last_login_status = "RISK_CONTROL"

    def search_and_parse(
        self,
        query_brand: str,
        query_model: str,
        quantity: int = 1,
        force_mock: bool = False
    ) -> List[UnifiedQueryResult]:
        self._reset_status()

        if force_mock:
            self.last_login_status = "MOCK"
            self.last_data_source = "MOCK"
            return self._load_fixture_data(query_brand, query_model, quantity)

        # Windows 下不能配合 shell=True，否则超时后 shell 的子进程仍可能
        # 持有 stdout/stderr 管道，让一次请求拖到前端 30 秒超时之后。
        cli_js = os.path.join(self.upstream_cli_dir, "dist", "cli.js")
        if os.path.exists(cli_js):
            try:
                cmd = ["node", cli_js, "search", f"{query_brand} {query_model}", "--json"]
                cli_env = os.environ.copy()
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    cli_env.pop(key, None)
                res = subprocess.run(
                    cmd,
                    cwd=self.upstream_cli_dir,
                    env=cli_env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=15,
                    shell=False,
                )
                if res.stdout.strip():
                    try:
                        data_json = json.loads(res.stdout.strip())
                        if isinstance(data_json, dict) and data_json.get("code") == "NOT_LOGGED_IN":
                            self.last_login_status = "LOGIN_REQUIRED"
                        elif isinstance(data_json, dict) and "offers" in data_json:
                            self.last_login_status = "LOGGED_IN"
                            parsed = self._transform_cli_offers(data_json["offers"], query_brand, query_model, quantity)
                            if parsed:
                                self.last_data_source = "LIVE_CLI"
                                return parsed
                        elif isinstance(data_json, list):
                            self.last_login_status = "LOGGED_IN"
                            parsed = self._transform_raw_1688_data(data_json, query_brand, query_model, quantity)
                            if parsed:
                                self.last_data_source = "LIVE_CLI"
                                return parsed
                    except (TypeError, ValueError, KeyError) as exc:
                        self.last_error_code = "INVALID_CLI_RESPONSE"
                        self.last_error_message = f"1688 CLI 返回格式无法解析: {exc}"
                if res.returncode != 0:
                    self._record_cli_error(res.stderr)
                elif not res.stdout.strip():
                    self._record_cli_error(res.stderr, "EMPTY_CLI_RESPONSE")
            except subprocess.TimeoutExpired:
                self.last_error_code = "CLI_TIMEOUT"
                self.last_error_message = "1688 实时查询超过 15 秒"
            except (OSError, subprocess.SubprocessError) as exc:
                self.last_error_code = "CLI_UNAVAILABLE"
                self.last_error_message = f"1688 CLI 启动失败: {exc}"

        # 登录失效、风控或 daemon 暂停时继续无头重试只会拖慢请求，并加重风控。
        if self.last_login_status not in {"LOGIN_REQUIRED", "PAUSED", "RISK_CONTROL"}:
            live_playwright = self._fetch_via_persistent_profile(query_brand, query_model, quantity)
            if live_playwright:
                self.last_login_status = "LOGGED_IN"
                self.last_data_source = "LIVE_BROWSER"
                return live_playwright

        # 保留离线兜底，但明确标记来源，避免把样本数据伪装成实时结果。
        if self.use_mock_on_failure:
            self.last_data_source = "MOCK_FALLBACK"
            return self._load_fixture_data(query_brand, query_model, quantity)
        return []

    def _transform_cli_offers(
        self, offers: List[Dict[str, Any]], query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        results = []
        for offer in offers:
            title = offer.get("title", "")
            displayed_price = self._to_float(offer.get("price", {}).get("min"))
            supplier_info = offer.get("supplier", {})
            supplier_name = supplier_info.get("name") or "1688供应商"
            years = supplier_info.get("years")
            
            location_info = offer.get("location", {})
            loc_str = f"{location_info.get('province') or ''} {location_info.get('city') or ''}".strip()

            level, score, reasons, manual = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=title,
                # 搜索词不是页面检测结果。把输入直接回填到检测字段会让所有
                # 搜索卡片都被错误判为 EXACT。
                detected_brand=None,
                detected_model=None,
            )

            verified = offer.get("verified") or {}
            supplier_type = (
                "超级工厂" if verified.get("superFactory") else
                "工厂" if verified.get("factory") else
                "企业" if verified.get("business") else
                offer.get("bizType") or "未知"
            )

            res = UnifiedQueryResult(
                platform="1688",
                query_brand=query_brand,
                query_model=query_model,
                normalized_brand=normalize_brand(query_brand),
                normalized_model=normalize_model(query_model),
                title=title,
                supplier_name=supplier_name,
                shop_name=supplier_name,
                shop_url=supplier_info.get("shopUrl"),
                supplier_location=loc_str,
                supplier_years=years,
                supplier_type=supplier_type,
                displayed_price=displayed_price,
                unit_price=displayed_price,
                quantity=quantity,
                product_url=offer.get("url") or "https://detail.1688.com",
                match_score=score,
                match_level=level,
                mismatch_reasons=reasons,
                manual_review_required=manual
            )
            results.append(res)
        return results

    def _fetch_via_persistent_profile(
        self, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        keyword = f"{query_brand} {query_model}".strip()
        encoded_kw = urllib.parse.quote(keyword)
        url = f"https://s.1688.com/selloffer/offer_search.htm?keywords={encoded_kw}"
        pdir = ProfileManager.get_profile_dir("1688")

        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(
                    user_data_dir=pdir,
                    headless=True,
                    args=["--disable-blink-features=AutomationControlled"]
                )
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=4000)
                page.wait_for_timeout(1000)
                html = page.content()
                context.close()
                return self._parse_1688_html(html, query_brand, query_model, quantity)
        except Exception:
            return []

    def _parse_1688_html(
        self, html: str, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        soup = BeautifulSoup(html, "html.parser")
        results = []

        cards = soup.select(".sm-offer-item, .offer-list-item, .search-offer-item, [data-offer-id], .common-offer-card")
        for card in cards:
            title_el = card.select_one(".title, .offer-title, a[title], .sm-offer-title")
            title = title_el.text.strip() if title_el else ""
            if not title or len(title) < 2:
                continue

            price_el = card.select_one(".price, .offer-price, .sm-offer-price, .sm-offer-priceNum")
            price_text = price_el.text.strip() if price_el else "0"
            displayed_price = self._clean_price(price_text)

            supplier_el = card.select_one(".company-name, .shop-name, .company, .sm-offer-companyName")
            supplier_name = supplier_el.text.strip() if supplier_el else "1688供应商"

            link_el = card.select_one("a[href]")
            product_url = link_el["href"] if link_el else "https://s.1688.com"
            if product_url.startswith("//"):
                product_url = "https:" + product_url

            level, score, reasons, manual = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=title,
                detected_brand=query_brand,
                detected_model=query_model
            )

            res = UnifiedQueryResult(
                platform="1688",
                query_brand=query_brand,
                query_model=query_model,
                normalized_brand=normalize_brand(query_brand),
                normalized_model=normalize_model(query_model),
                title=title,
                detected_brand=query_brand,
                detected_model=query_model,
                supplier_name=supplier_name,
                displayed_price=displayed_price,
                unit_price=displayed_price,
                quantity=quantity,
                min_order_quantity=1,
                product_url=product_url,
                match_score=score,
                match_level=level,
                mismatch_reasons=reasons,
                manual_review_required=manual
            )
            results.append(res)
        return results

    def _transform_raw_1688_data(
        self,
        raw_items: List[Dict[str, Any]],
        query_brand: str,
        query_model: str,
        quantity: int
    ) -> List[UnifiedQueryResult]:
        results = []
        for item in raw_items:
            title = item.get("title", "")
            detected_brand = item.get("brand") or item.get("company_name", "")
            detected_model = item.get("model") or ""
            displayed_price = float(item.get("price", 0.0))
            
            raw_tiers = item.get("tier_prices", [])
            tier_prices = []
            calculated_unit_price = displayed_price
            
            for t in raw_tiers:
                min_q = int(t.get("min", 1))
                max_q = int(t.get("max")) if t.get("max") else None
                price = float(t.get("price", displayed_price))
                tier_prices.append(TierPrice(min_quantity=min_q, max_quantity=max_q, unit_price=price))
                if min_q <= quantity and (max_q is None or quantity <= max_q):
                    calculated_unit_price = price

            level, score, reasons, manual_review = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=title,
                detected_brand=detected_brand,
                detected_model=detected_model,
                sku_name=item.get("sku_name")
            )

            res = UnifiedQueryResult(
                platform="1688",
                query_brand=query_brand,
                query_model=query_model,
                normalized_brand=normalize_brand(query_brand),
                normalized_model=normalize_model(query_model),
                title=title,
                detected_brand=detected_brand,
                detected_model=detected_model,
                sku_name=item.get("sku_name"),
                supplier_name=item.get("company_name", "1688供应商"),
                legal_company_name=item.get("company_name"),
                shop_name=item.get("shop_name"),
                supplier_location=item.get("location"),
                supplier_years=item.get("years"),
                supplier_type=item.get("supplier_type", "未知"),
                displayed_price=displayed_price,
                sku_price=item.get("sku_price", displayed_price),
                unit_price=calculated_unit_price,
                quantity=quantity,
                min_order_quantity=item.get("moq", 1),
                tier_prices=tier_prices,
                product_url=item.get("url", "https://detail.1688.com"),
                match_score=score,
                match_level=level,
                mismatch_reasons=reasons,
                manual_review_required=manual_review
            )
            results.append(res)
        return results

    @staticmethod
    def _to_float(value: Any, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def _clean_price(self, price_str: str) -> float:
        import re
        nums = re.findall(r"\d+\.?\d*", price_str)
        if nums:
            return float(nums[0])
        return 0.0

    def _load_fixture_data(
        self, query_brand: str, query_model: str, quantity: int
    ) -> List[UnifiedQueryResult]:
        if not os.path.exists(self.fixture_path):
            return []
        with open(self.fixture_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        results = []
        for d in data:
            d["query_brand"] = query_brand
            d["query_model"] = query_model
            d["normalized_brand"] = normalize_brand(query_brand)
            d["normalized_model"] = normalize_model(query_model)
            d["quantity"] = quantity

            displayed_price = d.get("displayed_price", 0.0)
            tiers = d.get("tier_prices", [])
            unit_price = displayed_price
            for t in tiers:
                min_q = t["min_quantity"]
                max_q = t.get("max_quantity")
                if min_q <= quantity and (max_q is None or quantity <= max_q):
                    unit_price = t["unit_price"]

            d["unit_price"] = unit_price
            
            level, score, reasons, manual = evaluate_model_match(
                query_brand=query_brand,
                query_model=query_model,
                title=d["title"],
                detected_brand=d.get("detected_brand"),
                detected_model=d.get("detected_model"),
                sku_name=d.get("sku_name")
            )
            d["match_level"] = level
            d["match_score"] = score
            d["mismatch_reasons"] = reasons
            d["manual_review_required"] = manual

            results.append(UnifiedQueryResult(**d))
        return results
