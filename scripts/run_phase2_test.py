import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from backend.database import Base, SessionLocal, engine
from backend.services.query_service import QueryService


def run_phase2_test() -> None:
    """离线验证 1688 + 淘宝/天猫多平台最小闭环。"""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        result = QueryService().execute_inquiry(
            db=db,
            query_brand="SKF",
            query_model="6205-2Z/C3",
            quantity=10,
            platforms=["1688", "taobao"],
            force_mock=True,
        )
        assert result["total_count"] == 4
        assert set(result["platform_statuses"]) == {"1688", "taobao"}
        assert result["platform_statuses"]["1688"]["result_count"] == 2
        assert result["platform_statuses"]["taobao"]["result_count"] == 2
        assert any(item["platform"] == "taobao" for item in result["exact_matches"])
        print("阶段2离线闭环通过：1688 + 淘宝/天猫共 4 条样本结果。")
    finally:
        db.close()


if __name__ == "__main__":
    run_phase2_test()
