import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from backend.database import Base, SessionLocal, engine
from backend.services.query_service import QueryService


def run_phase3_test() -> None:
    """离线验证关键词模式与 1688/淘宝/京东三平台闭环。"""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        result = QueryService().execute_inquiry(
            db=db,
            query_brand="",
            query_model="",
            query_mode="keyword",
            query_keyword="SKF 轴承",
            quantity=1,
            platforms=["1688", "taobao", "jd"],
            force_mock=True,
        )
        assert result["query_mode"] == "keyword"
        assert result["total_count"] == 6
        assert set(result["platform_statuses"]) == {"1688", "taobao", "jd"}
        assert all(row["match_level"] == "HIGH" for row in result["exact_matches"])
        print("阶段3离线闭环通过：关键词模式 + 1688/淘宝/京东共 6 条样本结果。")
    finally:
        db.close()


if __name__ == "__main__":
    run_phase3_test()
