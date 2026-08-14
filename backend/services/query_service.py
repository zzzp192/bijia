import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any
from sqlalchemy.orm import Session
from backend.models import QueryHistoryRecord, QueryResultRecord
from adapters.alibaba1688_adapter import Alibaba1688Adapter
from adapters.taobao_adapter import TaobaoAdapter
from adapters.jd_adapter import JDAdapter
from adapters.misumi_adapter import MisumiAdapter
from matching.engine import evaluate_keyword_match
from matching.schemas import UnifiedQueryResult

class QueryService:
    def __init__(self):
        # 适配器会记录一次查询的来源/登录状态，因此每次请求单独创建，避免
        # FastAPI 并发请求之间互相覆盖状态。
        self.use_mock_on_failure = True

    def execute_inquiry(
        self,
        db: Session,
        query_brand: str,
        query_model: str,
        quantity: int = 1,
        platforms: List[str] = None,
        force_mock: bool = False,
        query_mode: str = "model",
        query_keyword: str = "",
        result_mode: str = "per_platform",
        result_limit: int = 10,
    ) -> Dict[str, Any]:
        if not platforms:
            platforms = ["1688"]

        keyword = (query_keyword or query_model).strip() if query_mode == "keyword" else ""
        effective_brand = "" if query_mode == "keyword" else query_brand
        effective_model = keyword if query_mode == "keyword" else query_model

        # 1. 记录查询历史
        history = QueryHistoryRecord(
            query_brand=effective_brand,
            query_model=effective_model,
            query_mode=query_mode,
            query_keyword=keyword or None,
            quantity=quantity,
            platforms=",".join(platforms),
            status="RUNNING"
        )
        db.add(history)
        db.commit()
        db.refresh(history)

        all_results: List[UnifiedQueryResult] = []

        # 2. 执行平台适配器查询。每个平台保留独立状态，避免一个平台失败
        #    掩盖另一个平台的实时结果。
        adapter_factories = {
            "1688": Alibaba1688Adapter,
            "taobao": TaobaoAdapter,
            "jd": JDAdapter,
            "misumi": MisumiAdapter,
        }
        adapters = {}
        for platform in platforms:
            factory = adapter_factories.get(platform)
            if not factory:
                continue
            adapters[platform] = factory(use_mock_on_failure=self.use_mock_on_failure)

        if adapters:
            with ThreadPoolExecutor(max_workers=len(adapters)) as executor:
                futures = {
                    executor.submit(
                        adapter.search_and_parse,
                        query_brand=effective_brand,
                        query_model=effective_model,
                        quantity=quantity,
                        force_mock=force_mock,
                    ): platform
                    for platform, adapter in adapters.items()
                }
                for future in as_completed(futures):
                    platform = futures[future]
                    try:
                        all_results.extend(future.result())
                    except Exception as exc:
                        adapter = adapters[platform]
                        adapter.last_data_source = "NONE"
                        adapter.last_login_status = "ERROR"
                        adapter.last_error_code = "ADAPTER_ERROR"
                        adapter.last_error_message = str(exc).splitlines()[0]

        if query_mode == "keyword":
            for result in all_results:
                level, score, reasons, manual = evaluate_keyword_match(
                    keyword, result.title
                )
                preserved = [
                    reason for reason in result.mismatch_reasons
                    if "广告商品" in reason or "店铺与详情价格尚未核验" in reason
                ]
                result.match_level = level
                result.match_score = score
                result.mismatch_reasons = reasons + preserved
                result.manual_review_required = manual or bool(preserved)
                if result.platform == "taobao":
                    # 关键词发现没有唯一目标型号，不能把偶然命中的规格当目标 SKU。
                    result.sku_name = None
                    result.sku_price = None
                    result.unit_price = result.displayed_price

        raw_result_counts = {
            platform: sum(1 for result in all_results if result.platform == platform)
            for platform in adapters
        }
        all_results = self._select_results(
            all_results, platforms, result_mode, result_limit
        )

        # 3. 存储查询结果到数据库
        for r in all_results:
            tier_json = json.dumps([t.model_dump() for t in r.tier_prices], ensure_ascii=False)
            reasons_json = json.dumps(r.mismatch_reasons, ensure_ascii=False)
            rec = QueryResultRecord(
                history_id=history.id,
                platform=r.platform,
                query_brand=r.query_brand,
                query_model=r.query_model,
                normalized_brand=r.normalized_brand,
                normalized_model=r.normalized_model,
                title=r.title,
                detected_brand=r.detected_brand,
                detected_model=r.detected_model,
                sku_name=r.sku_name,
                sku_id=r.sku_id,
                supplier_name=r.supplier_name,
                legal_company_name=r.legal_company_name,
                shop_name=r.shop_name,
                supplier_location=r.supplier_location,
                supplier_years=r.supplier_years,
                supplier_type=r.supplier_type,
                official_store=r.official_store,
                authorized_supplier=r.authorized_supplier,
                original_or_replacement=r.original_or_replacement,
                currency=r.currency,
                displayed_price=r.displayed_price,
                sku_price=r.sku_price,
                unit_price=r.unit_price,
                quantity=r.quantity,
                min_order_quantity=r.min_order_quantity,
                tier_prices_json=tier_json,
                tax_included=r.tax_included,
                shipping_fee=r.shipping_fee,
                stock_status=r.stock_status,
                stock_quantity=r.stock_quantity,
                delivery_time=r.delivery_time,
                product_url=r.product_url,
                shop_url=r.shop_url,
                fetched_at=r.fetched_at,
                match_score=r.match_score,
                match_level=r.match_level,
                mismatch_reasons_json=reasons_json,
                manual_review_required=r.manual_review_required
            )
            db.add(rec)

        platform_statuses = {
            platform: {
                "data_source": adapter.last_data_source,
                "login_status": adapter.last_login_status,
                "error_code": adapter.last_error_code,
                "error_message": adapter.last_error_message,
                "result_count": sum(1 for r in all_results if r.platform == platform),
                "raw_result_count": raw_result_counts.get(platform, 0),
                "selected_count": sum(1 for r in all_results if r.platform == platform),
            }
            for platform, adapter in adapters.items()
        }
        if len(platform_statuses) == 1:
            only_status = next(iter(platform_statuses.values()))
            data_source = only_status["data_source"]
            login_status = only_status["login_status"]
            error_code = only_status["error_code"]
            error_message = only_status["error_message"]
        else:
            data_source = "MULTI_PLATFORM"
            login_status = "MIXED"
            error_code = None
            error_message = None

        fallback_platforms = [
            platform for platform, status in platform_statuses.items()
            if status["data_source"] == "MOCK_FALLBACK"
        ]
        manual_mock_platforms = [
            platform for platform, status in platform_statuses.items()
            if status["data_source"] == "MOCK"
        ]
        platform_labels = {
            "1688": "1688", "taobao": "淘宝/天猫",
            "jd": "京东", "misumi": "米思米中国",
        }
        fallback_labels = [platform_labels.get(p, p) for p in fallback_platforms]
        manual_mock_labels = [platform_labels.get(p, p) for p in manual_mock_platforms]
        warning_parts = []
        if fallback_labels:
            warning_parts.append(
                f"{', '.join(fallback_labels)} 实时查询不可用，展示的是离线样本数据"
            )
        if manual_mock_labels:
            warning_parts.append(
                f"{', '.join(manual_mock_labels)} 当前为手动选择的离线测试数据"
            )
        zero_result_messages = []
        for platform, status in platform_statuses.items():
            if status["raw_result_count"] == 0:
                label = platform_labels.get(platform, platform)
                reason = status.get("error_message") or "未返回候选商品"
                zero_result_messages.append(f"{label} 0条：{reason}")
        if zero_result_messages:
            warning_parts.append("；".join(zero_result_messages))

        history.status = "COMPLETED_MOCK" if fallback_platforms or manual_mock_platforms else "COMPLETED"
        db.commit()

        # 分组划分结果
        exact_matches = [r for r in all_results if r.match_level in ["EXACT", "HIGH"]]
        possible_matches = [r for r in all_results if r.match_level == "POSSIBLE"]
        replacement_matches = [r for r in all_results if r.match_level == "REPLACEMENT"]
        other_matches = [r for r in all_results if r.match_level in ["MISMATCH", "UNKNOWN"]]

        return {
            "history_id": history.id,
            "query_mode": query_mode,
            "query_keyword": keyword or None,
            "query_brand": effective_brand,
            "query_model": effective_model,
            "quantity": quantity,
            "result_mode": result_mode,
            "result_limit": result_limit,
            "total_count": len(all_results),
            "data_source": data_source,
            "login_status": login_status,
            "platform_statuses": platform_statuses,
            "warning": (
                "；".join(warning_parts)
                + ("；离线样本不代表真实报价。" if fallback_labels or manual_mock_labels else "")
                if warning_parts else None
            ),
            "error_code": error_code,
            "error_message": error_message,
            "exact_matches": [r.model_dump() for r in exact_matches],
            "possible_matches": [r.model_dump() for r in possible_matches],
            "replacement_matches": [r.model_dump() for r in replacement_matches],
            "other_matches": [r.model_dump() for r in other_matches]
        }

    @staticmethod
    def _select_results(
        results: List[UnifiedQueryResult],
        platforms: List[str],
        result_mode: str,
        result_limit: int,
    ) -> List[UnifiedQueryResult]:
        """按置信分选择候选，同时用原始顺序保证排序稳定。"""
        indexed = list(enumerate(results))
        rank = lambda pair: (-pair[1].match_score, pair[0])
        if result_mode == "global":
            return [result for _, result in sorted(indexed, key=rank)[:result_limit]]

        selected: List[UnifiedQueryResult] = []
        for platform in platforms:
            platform_rows = [pair for pair in indexed if pair[1].platform == platform]
            selected.extend(
                result for _, result in sorted(platform_rows, key=rank)[:result_limit]
            )
        return selected
