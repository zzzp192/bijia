from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base
import os

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
os.makedirs(DB_DIR, exist_ok=True)
DB_PATH = os.path.join(DB_DIR, "bijia.db")

SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def ensure_schema_columns() -> None:
    """为现有 SQLite 数据库补充轻量字段，不破坏已有询价记录。"""
    with engine.begin() as connection:
        columns = {
            column["name"] for column in inspect(connection).get_columns("query_history")
        }
        if "query_mode" not in columns:
            connection.execute(text(
                "ALTER TABLE query_history ADD COLUMN query_mode VARCHAR(20) "
                "NOT NULL DEFAULT 'model'"
            ))
        if "query_keyword" not in columns:
            connection.execute(text(
                "ALTER TABLE query_history ADD COLUMN query_keyword VARCHAR(300)"
            ))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
