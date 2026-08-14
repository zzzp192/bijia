import os
import sys

# Ensure root directory in python path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from backend.database import SessionLocal, Base, engine
from backend.services.query_service import QueryService
from backend.services.excel_service import generate_inquiry_excel

def test_phase1_end_to_end():
    print("=== 运行 阶段1 (1688单平台) 端到端集成测试 ===")
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    query_service = QueryService()

    try:
        brand = "SKF"
        model = "6205-2Z/C3"
        qty = 10
        print(f"询价输入: 品牌={brand}, 型号={model}, 数量={qty}")

        res = query_service.execute_inquiry(
            db=db,
            query_brand=brand,
            query_model=model,
            quantity=qty,
            platforms=["1688"],
            force_mock=True
        )

        print(f"查询完成！History ID: {res['history_id']}")
        print(f"总计结果数: {res['total_count']}")
        print(f" - 精确匹配数 (EXACT/HIGH): {len(res['exact_matches'])}")
        print(f" - 替代/待确认数 (POSSIBLE/REPLACEMENT): {len(res['replacement_matches'] + res['possible_matches'])}")

        assert res['total_count'] > 0, "结果数应大于 0"
        assert len(res['exact_matches']) > 0, "应包含精确匹配项"

        # 测试 Excel 导出
        from matching.schemas import UnifiedQueryResult
        results_schema = [UnifiedQueryResult(**r) for r in res['exact_matches'] + res['replacement_matches']]
        excel_bytes = generate_inquiry_excel(brand, model, qty, results_schema)
        
        output_excel = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "test_inquiry_1688.xlsx")
        with open(output_excel, "wb") as f:
            f.write(excel_bytes)
        
        print(f"Excel 导出成功! 文件路径: {output_excel} ({len(excel_bytes)} 字节)")
        print("=== 阶段1 测试全部通过！ ===")

    finally:
        db.close()

if __name__ == "__main__":
    test_phase1_end_to_end()
