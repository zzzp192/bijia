from sqlalchemy import Column, Integer, String, Float, Boolean, Text, DateTime
from datetime import datetime
from backend.database import Base

class QueryHistoryRecord(BaseModel := Base):
    __tablename__ = "query_history"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    query_brand = Column(String(100), nullable=False)
    query_model = Column(String(200), nullable=False)
    query_mode = Column(String(20), nullable=False, default="model")
    query_keyword = Column(String(300), nullable=True)
    quantity = Column(Integer, default=1)
    platforms = Column(String(200), default="1688")
    status = Column(String(50), default="COMPLETED")
    created_at = Column(DateTime, default=datetime.now)

class QueryResultRecord(BaseModel):
    __tablename__ = "query_results"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    history_id = Column(Integer, index=True, nullable=False)
    platform = Column(String(50), nullable=False)
    
    query_brand = Column(String(100))
    query_model = Column(String(200))
    normalized_brand = Column(String(100))
    normalized_model = Column(String(200))
    
    title = Column(Text, nullable=False)
    detected_brand = Column(String(100))
    detected_model = Column(String(200))
    sku_name = Column(Text)
    sku_id = Column(String(100))
    
    supplier_name = Column(String(250))
    legal_company_name = Column(String(250))
    shop_name = Column(String(250))
    supplier_location = Column(String(100))
    supplier_years = Column(Integer)
    supplier_type = Column(String(50))
    official_store = Column(Boolean, default=False)
    authorized_supplier = Column(Boolean, default=False)
    original_or_replacement = Column(String(50), default="UNKNOWN")
    
    currency = Column(String(10), default="CNY")
    displayed_price = Column(Float, default=0.0)
    sku_price = Column(Float)
    unit_price = Column(Float, default=0.0)
    quantity = Column(Integer, default=1)
    min_order_quantity = Column(Integer, default=1)
    tier_prices_json = Column(Text, default="[]")
    tax_included = Column(Boolean, nullable=True)
    shipping_fee = Column(Float, default=0.0)
    
    stock_status = Column(String(50), default="UNKNOWN")
    stock_quantity = Column(Integer, nullable=True)
    delivery_time = Column(String(100))
    
    product_url = Column(Text, nullable=False)
    shop_url = Column(Text)
    fetched_at = Column(String(50))
    
    match_score = Column(Float, default=0.0)
    match_level = Column(String(50), default="UNKNOWN")
    mismatch_reasons_json = Column(Text, default="[]")
    manual_review_required = Column(Boolean, default=True)
    user_note = Column(Text, default="")
