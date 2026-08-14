import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from backend.database import Base, SessionLocal, engine
from backend.services.query_service import QueryService


def run_phase4_test() -> None:
    """离线验证四平台工业品牌+完整型号闭环。"""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        result = QueryService().execute_inquiry(
            db=db,
            query_brand="SKF",
            query_model="6205-2Z/C3",
            quantity=10,
            platforms=["1688", "taobao", "jd", "misumi"],
            force_mock=True,
        )
        assert result["total_count"] == 8
        assert set(result["platform_statuses"]) == {
            "1688", "taobao", "jd", "misumi"
        }
        assert result["platform_statuses"]["misumi"]["result_count"] == 2
        print("阶段4离线闭环通过：1688/淘宝/京东/米思米共 8 条样本结果。")
    finally:
        db.close()


if __name__ == "__main__":
    run_phase4_test()
